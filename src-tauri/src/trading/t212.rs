//! Trading 212 (public API v0, read-only).
//!
//! - Auth: HTTP Basic from API key + secret (Credential Manager). Without a secret the
//!   old header mode (key only) is tried.
//! - Rate limits: summary 1/5 s, positions 1/1 s; the caller caches for 6 s.

use base64::Engine;
use serde::Deserialize;

use super::{send_json, Account, Holding, Money};
use crate::secrets;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    currency: String,
    total_value: f64,
    cash: SummaryCash,
    investments: SummaryInvestments,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryCash {
    available_to_trade: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryInvestments {
    current_value: f64,
    realized_profit_loss: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiPosition {
    current_price: f64,
    quantity: f64,
    instrument: ApiInstrument,
    wallet_impact: ApiWallet,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiInstrument {
    ticker: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    currency: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiWallet {
    current_value: f64,
    total_cost: f64,
}

/// `env`: "live" or "demo".
pub async fn fetch(client: &reqwest::Client, env: &str) -> Result<Account, String> {
    let key = secrets::read("t212.key").ok_or("no-key")?;
    let auth = match secrets::read("t212.secret") {
        Some(secret) => format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{key}:{secret}"))),
        None => key,
    };
    let base = if env == "demo" { "https://demo.trading212.com" } else { "https://live.trading212.com" };

    let summary: Summary = send_json(client.get(format!("{base}/api/v0/equity/account/summary")).header("Authorization", &auth)).await?;
    let positions: Vec<ApiPosition> = send_json(client.get(format!("{base}/api/v0/equity/positions")).header("Authorization", &auth)).await?;

    let mut holdings: Vec<Holding> = positions
        .into_iter()
        .map(|p| Holding {
            symbol: short_ticker(&p.instrument.ticker),
            name: p.instrument.name,
            kind: "stock",
            quantity: p.quantity,
            price: Some(p.current_price),
            price_currency: Some(p.instrument.currency),
            value: Some(p.wallet_impact.current_value),
            cost: Some(p.wallet_impact.total_cost),
            currency: Some(summary.currency.clone()),
        })
        .collect();
    holdings.push(Holding::cash(&summary.currency, summary.cash.available_to_trade));
    // Cash in pies or reserved for pending orders, so the total matches the app.
    let other = summary.total_value - summary.investments.current_value - summary.cash.available_to_trade;
    if other.abs() > 0.005 {
        holdings.push(Holding { name: "Reserved".into(), ..Holding::cash(&summary.currency, other) });
    }

    Ok(Account {
        holdings,
        realized: Some(Money { amount: summary.investments.realized_profit_loss, currency: summary.currency }),
        ..Default::default()
    })
}

/// "AAPL_US_EQ" → "AAPL", "VUSAl_EQ" → "VUSA".
fn short_ticker(ticker: &str) -> String {
    let base = ticker.split('_').next().unwrap_or(ticker);
    base.trim_end_matches(|c: char| c.is_ascii_lowercase()).to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn short_ticker() {
        assert_eq!(super::short_ticker("AAPL_US_EQ"), "AAPL");
        assert_eq!(super::short_ticker("VUSAl_EQ"), "VUSA");
    }
}
