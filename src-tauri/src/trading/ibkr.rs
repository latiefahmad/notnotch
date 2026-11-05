//! Interactive Brokers through the Flex Web Service: read-only by design, a token and a query id
//! created in Client Portal (Performance & Reports → Flex Queries). The query must be an
//! Activity Flex Query with the sections "Open Positions" and "Cash Report" and the period
//! "Last Business Day"; the statement is end of day, so the caller caches it for 30 minutes.
//!
//! The Client Portal Web API is not used: it needs a local Java gateway and a browser login.

use std::time::Duration;

use quick_xml::events::Event;

use super::{is_fiat, Account, Holding};
use crate::secrets;

const SEND: &str = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest";

pub async fn fetch(client: &reqwest::Client) -> Result<Account, String> {
    let token = secrets::read("ibkr.token").ok_or("no-key")?;
    let query = secrets::read("ibkr.query").ok_or("no-key")?;
    let (token, query) = (token.trim(), query.trim());

    let reply = text(client.get(format!("{SEND}?t={}&q={}&v=3", safe(token), safe(query)))).await?;
    check(&reply)?;
    let reference = tag(&reply, "ReferenceCode").ok_or("network:no reference code")?;
    // The token only goes to IB's own host.
    let url = tag(&reply, "Url").filter(|u| ib_host(u)).unwrap_or_else(|| SEND.replace("SendRequest", "GetStatement"));

    // The statement is generated on demand; IB answers 1019 until it is ready.
    for attempt in 0..8 {
        let statement = text(client.get(format!("{url}?t={}&q={}&v=3", safe(token), safe(&reference)))).await?;
        if statement.contains("<FlexQueryResponse") {
            return Ok(parse(&statement));
        }
        if tag(&statement, "ErrorCode").as_deref() != Some("1019") {
            check(&statement)?;
            return Err("network:unexpected statement".into());
        }
        tokio::time::sleep(Duration::from_millis(1500 + 500 * attempt)).await;
    }
    Err("rate".into())
}

/// Tokens, query ids and reference codes are digits; anything else is dropped from the URL.
fn safe(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// An https URL on interactivebrokers.com or a subdomain, with no query of its own.
fn ib_host(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|u| {
        u.scheme() == "https" && u.query().is_none() && u.host_str().is_some_and(|h| h == "interactivebrokers.com" || h.ends_with(".interactivebrokers.com"))
    })
}

/// Errors never carry the URL: the token is in its query.
async fn text(req: reqwest::RequestBuilder) -> Result<String, String> {
    let res = req.send().await.map_err(super::net)?;
    if !res.status().is_success() {
        return Err(format!("network:HTTP {}", res.status().as_u16()));
    }
    res.text().await.map_err(super::net)
}

/// Maps a Flex error reply to the shared codes.
fn check(reply: &str) -> Result<(), String> {
    match tag(reply, "ErrorCode").as_deref() {
        None => Ok(()),
        Some("1012" | "1015") => Err("unauthorized".into()),
        Some("1018") => Err("rate".into()),
        Some(code) => Err(format!("api:{code} {}", tag(reply, "ErrorMessage").unwrap_or_default())),
    }
}

/// Text of the first `<name>…</name>`.
fn tag(xml: &str, name: &str) -> Option<String> {
    let start = xml.find(&format!("<{name}>"))? + name.len() + 2;
    let end = xml[start..].find(&format!("</{name}>"))? + start;
    Some(xml[start..end].trim().to_string())
}

/// Open positions (summary rows) and cash per currency, across all accounts in the statement.
fn parse(xml: &str) -> Account {
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut holdings: Vec<Holding> = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = AsRef::<str>::as_ref(&e.local_name()).to_string();
                if name != "OpenPosition" && name != "CashReportCurrency" {
                    continue;
                }
                let attr = |key: &str| -> Option<String> {
                    e.attributes()
                        .flatten()
                        .find(|a| AsRef::<str>::as_ref(&a.key.local_name()) == key)
                        .and_then(|a| a.normalized_value(quick_xml::XmlVersion::Implicit1_0).ok().map(|v| v.trim().to_string()))
                        .filter(|v| !v.is_empty())
                };
                // A missing or unreadable number is unknown, never 0.
                let number = |key: &str| attr(key).and_then(|v| v.parse::<f64>().ok());
                if name == "OpenPosition" {
                    if attr("levelOfDetail").is_some_and(|d| d != "SUMMARY") {
                        continue;
                    }
                    let (Some(symbol), Some(quantity)) = (attr("symbol"), number("position")) else { continue };
                    let currency = attr("currency");
                    holdings.push(Holding {
                        symbol,
                        name: attr("description").unwrap_or_default(),
                        kind: if attr("assetCategory").as_deref() == Some("CRYPTO") { "crypto" } else { "stock" },
                        quantity,
                        price: number("markPrice"),
                        price_currency: currency.clone(),
                        value: number("positionValue"),
                        cost: number("costBasisMoney"),
                        currency,
                    });
                } else if let (Some(currency), Some(cash)) = (attr("currency"), number("endingCash")) {
                    if is_fiat(&currency) && cash.abs() > 0.005 {
                        holdings.push(Holding::cash(&currency, cash));
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    Account { holdings, ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_flex_reply_and_statement() {
        let reply = "<FlexStatementResponse timestamp=\"x\"><Status>Success</Status><ReferenceCode>123</ReferenceCode><Url>https://h/GetStatement</Url></FlexStatementResponse>";
        assert_eq!(tag(reply, "ReferenceCode").as_deref(), Some("123"));
        assert!(check(reply).is_ok());
        assert_eq!(check("<ErrorCode>1015</ErrorCode>"), Err("unauthorized".into()));

        let xml = r#"<FlexQueryResponse><FlexStatements count="1"><FlexStatement accountId="U1">
            <OpenPositions>
              <OpenPosition symbol="AAPL" description="APPLE INC" currency="USD" assetCategory="STK" position="10" markPrice="200" positionValue="2000" costBasisMoney="1500" levelOfDetail="SUMMARY" />
              <OpenPosition symbol="AAPL" description="APPLE INC" currency="USD" assetCategory="STK" position="10" markPrice="200" positionValue="2000" costBasisMoney="1500" levelOfDetail="LOT" />
              <OpenPosition symbol="M&amp;G" description="M&amp;G PLC" currency="GBP" assetCategory="STK" position="5" markPrice="2" positionValue="10" costBasisMoney="12" />
            </OpenPositions>
            <CashReport>
              <CashReportCurrency currency="BASE_SUMMARY" endingCash="900" />
              <CashReportCurrency currency="EUR" endingCash="400" />
            </CashReport>
        </FlexStatement></FlexStatements></FlexQueryResponse>"#;
        let account = parse(xml);
        assert_eq!(account.holdings.len(), 3);
        assert_eq!(account.holdings[0].symbol, "AAPL");
        assert_eq!(account.holdings[0].cost, Some(1500.0));
        assert_eq!(account.holdings[1].symbol, "M&G");
        assert_eq!(account.holdings[2].kind, "fiat");
        assert_eq!(account.holdings[2].value, Some(400.0));
    }

    #[test]
    fn missing_attributes_are_unknown() {
        let xml = r#"<FlexQueryResponse><OpenPosition symbol="VWRL" currency="GBP" position="3" /><OpenPosition currency="USD" position="1" /></FlexQueryResponse>"#;
        let account = parse(xml);
        assert_eq!(account.holdings.len(), 1);
        assert_eq!(account.holdings[0].value, None);
        assert_eq!(account.holdings[0].cost, None);
        assert_eq!(account.holdings[0].price, None);
    }

    #[test]
    fn statement_url_must_be_ib() {
        assert!(ib_host("https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement"));
        assert!(!ib_host("https://interactivebrokers.com.evil.example/x"));
        assert!(!ib_host("https://evil.example/?h=.interactivebrokers.com"));
        assert!(!ib_host("http://gdcdyn.interactivebrokers.com/x"));
        assert!(!ib_host("https://user@evilinteractivebrokers.com/x"));
    }
}
