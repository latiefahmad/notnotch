//! eToro public API (public-api.etoro.com), real account, with a key created with the "Read"
//! permission (Settings → Trading → API Key Management). Two keys: the public API key and the
//! user key. Amounts are in USD (the account currency).
//!
//! The docs show both `instrumentID` and `instrumentId` and a P&L as object or number, so the
//! reply is read leniently.

use std::collections::HashMap;

use serde_json::Value;

use super::{send_json, sign, Account, Holding};
use crate::secrets;

const API: &str = "https://public-api.etoro.com/api/v1";

pub async fn fetch(client: &reqwest::Client) -> Result<Account, String> {
    let api_key = secrets::read("etoro.key").ok_or("no-key")?;
    let user_key = secrets::read("etoro.user").ok_or("no-key")?;
    let get = |url: String| -> Result<reqwest::RequestBuilder, String> {
        Ok(client
            .get(url)
            .header("x-api-key", api_key.trim())
            .header("x-user-key", user_key.trim())
            .header("x-request-id", request_id()?))
    };

    let reply: Value = send_json(get(format!("{API}/trading/info/real/pnl"))?).await?;
    let portfolio = &reply["clientPortfolio"];
    let positions = portfolio["positions"].as_array().cloned().unwrap_or_default();

    let ids: Vec<String> = {
        let mut ids: Vec<i64> = positions.iter().filter_map(|p| field(p, &["instrumentID", "instrumentId"]).as_i64()).collect();
        ids.sort();
        ids.dedup();
        ids.iter().map(|i| i.to_string()).collect()
    };
    let mut names: HashMap<i64, (String, String)> = HashMap::new();
    for chunk in ids.chunks(50) {
        // Names are cosmetic: a failure here still shows the positions by id.
        if let Ok(data) = send_json::<Value>(get(format!("{API}/market-data/instruments?instrumentIds={}", chunk.join(",")))?).await {
            for d in data["instrumentDisplayDatas"].as_array().into_iter().flatten() {
                if let Some(id) = field(d, &["instrumentID", "instrumentId"]).as_i64() {
                    let symbol = d["symbolFull"].as_str().unwrap_or_default().to_string();
                    names.insert(id, (symbol, d["instrumentDisplayName"].as_str().unwrap_or_default().to_string()));
                }
            }
        }
    }

    // Several positions in one instrument become one holding.
    let mut by_id: HashMap<i64, Holding> = HashMap::new();
    for p in &positions {
        let id = field(p, &["instrumentID", "instrumentId"]).as_i64().unwrap_or_default();
        let amount = number(field(p, &["amount"]));
        let units = number(field(p, &["units"]));
        let (symbol, name) = names.get(&id).cloned().unwrap_or_else(|| (format!("#{id}"), String::new()));
        let h = by_id.entry(id).or_insert(Holding { symbol, name, kind: "stock", currency: Some("USD".into()), value: Some(0.0), cost: Some(0.0), ..Default::default() });
        h.quantity += units;
        h.cost = Some(h.cost.unwrap_or(0.0) + amount);
        h.value = Some(h.value.unwrap_or(0.0) + amount + pnl(p));
    }
    let mut holdings: Vec<Holding> = by_id.into_values().collect();

    // Copy trading: one holding per copied trader (free amount plus its open positions).
    for m in portfolio["mirrors"].as_array().into_iter().flatten() {
        let free = number(field(m, &["availableAmount"]));
        let open = m["positions"].as_array().cloned().unwrap_or_default();
        let invested: f64 = open.iter().map(|p| number(field(p, &["amount"]))).sum();
        let value: f64 = open.iter().map(|p| number(field(p, &["amount"])) + pnl(p)).sum();
        let who = m["parentUsername"].as_str().unwrap_or("?");
        holdings.push(Holding {
            symbol: format!("Copy {who}"),
            name: String::new(),
            kind: "stock",
            quantity: 1.0,
            value: Some(free + value),
            cost: Some(free + invested),
            currency: Some("USD".into()),
            ..Default::default()
        });
    }
    holdings.push(Holding::cash("USD", number(field(portfolio, &["credit"]))));
    Ok(Account { holdings, ..Default::default() })
}

fn field<'a>(v: &'a Value, names: &[&str]) -> &'a Value {
    names.iter().map(|n| &v[*n]).find(|x| !x.is_null()).unwrap_or(&Value::Null)
}

fn number(v: &Value) -> f64 {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or(0.0)
}

/// Position P&L: `unrealizedPnL.pnL` per the schema, or a plain `pnL` as in the example.
fn pnl(p: &Value) -> f64 {
    let u = field(p, &["unrealizedPnL", "unrealizedPnl"]);
    if u.is_object() {
        number(field(u, &["pnL", "pnl"]))
    } else if !u.is_null() {
        number(u)
    } else {
        number(field(p, &["pnL", "pnl"]))
    }
}

/// A random UUID v4 per request, as eToro requires.
fn request_id() -> Result<String, String> {
    let h = sign::random_hex(16)?;
    let variant = ["8", "9", "a", "b"][(u8::from_str_radix(&h[16..17], 16).unwrap_or(0) % 4) as usize];
    Ok(format!("{}-{}-4{}-{}{}-{}", &h[0..8], &h[8..12], &h[13..16], variant, &h[17..20], &h[20..32]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_id_is_a_v4_uuid() {
        let id = request_id().unwrap();
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), vec![8, 4, 4, 4, 12]);
        assert!(parts[2].starts_with('4'));
        assert!("89ab".contains(&parts[3][..1]));
    }

    #[test]
    fn pnl_reads_both_documented_shapes() {
        assert_eq!(pnl(&serde_json::json!({ "unrealizedPnL": { "pnL": 12.5 } })), 12.5);
        assert_eq!(pnl(&serde_json::json!({ "pnL": -3.0 })), -3.0);
        assert_eq!(pnl(&serde_json::json!({ "unrealizedPnL": null, "pnL": 2 })), 2.0);
    }
}
