//! Bitpanda public API (api.public.bitpanda.com, the successor of the legacy api.bitpanda.com
//! that is switched off on 31 January 2027).
//!
//! `GET /v1/portfolio` lists every fiat and asset wallet with balance, current value and
//! invested amount, so no trade history is needed for P&L. Asset and currency ids are resolved
//! through `/v1/assets` and `/v1/currencies`. The key needs only the "Balances" scope.

use std::collections::HashMap;

use serde::Deserialize;

use super::{num, send_json, Account, Holding};
use crate::secrets;

const API: &str = "https://api.public.bitpanda.com/v1";

#[derive(Deserialize)]
struct List<T> {
    #[serde(default = "Vec::new")]
    data: Vec<T>,
    #[serde(default)]
    has_next_page: bool,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct Item {
    asset_id: String,
    currency_id: String,
    balance: Option<Value>,
    invested_amount: Option<Value>,
    currency_balance: Option<Value>,
}

#[derive(Deserialize)]
struct Value {
    value: String,
}

#[derive(Deserialize)]
struct Asset {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    symbol: String,
    #[serde(default, rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct Currency {
    id: String,
    symbol: String,
}

pub async fn fetch(client: &reqwest::Client) -> Result<Account, String> {
    let key = secrets::read("bitpanda.key").ok_or("no-key")?;
    let key = key.trim();

    let portfolio: Vec<Item> = all(client, key, &format!("{API}/portfolio")).await?;
    let currencies: Vec<Currency> = all(client, key, &format!("{API}/currencies")).await?;
    let currency: HashMap<String, String> = currencies.into_iter().map(|c| (c.id, c.symbol)).collect();

    let mut ids: Vec<&str> = portfolio.iter().map(|i| i.asset_id.as_str()).filter(|id| !currency.contains_key(*id)).collect();
    ids.sort();
    ids.dedup();
    let mut assets: HashMap<String, Asset> = HashMap::new();
    for chunk in ids.chunks(50) {
        let page: Vec<Asset> = all(client, key, &format!("{API}/assets?page_size=100&id={}", chunk.join(","))).await?;
        assets.extend(page.into_iter().map(|a| (a.id.clone(), a)));
    }

    let mut holdings = Vec::new();
    for item in portfolio {
        let quantity = item.balance.as_ref().map(|v| num(&v.value)).unwrap_or(0.0);
        if quantity.abs() < 1e-12 {
            continue;
        }
        let money = currency.get(&item.currency_id).cloned();
        if let Some(fiat) = currency.get(&item.asset_id) {
            holdings.push(Holding::cash(fiat, quantity));
            continue;
        }
        let value = item.currency_balance.as_ref().map(|v| num(&v.value));
        let cost = item.invested_amount.as_ref().map(|v| num(&v.value));
        holdings.push(match assets.get(&item.asset_id) {
            Some(asset) => Holding {
                symbol: asset.symbol.clone(),
                name: asset.name.clone(),
                kind: if asset.kind.eq_ignore_ascii_case("CRYPTO") { "crypto" } else { "stock" },
                quantity,
                value,
                cost,
                currency: money,
                ..Default::default()
            },
            // Not in the asset list: still listed by its id, with Bitpanda's value. The name is a
            // code the frontend translates.
            None => Holding {
                symbol: item.asset_id.chars().take(8).collect(),
                name: "unknown-asset".into(),
                kind: "stock",
                quantity,
                value,
                cost,
                currency: money,
                ..Default::default()
            },
        });
    }
    Ok(Account { holdings, ..Default::default() })
}

/// Every page of a list, following `next_cursor` while `has_next_page`.
async fn all<T: for<'de> Deserialize<'de>>(client: &reqwest::Client, key: &str, url: &str) -> Result<Vec<T>, String> {
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    // A bound against a server that keeps handing out the same cursor.
    for _ in 0..50 {
        let mut page_url = reqwest::Url::parse(url).map_err(|e| format!("network:{e}"))?;
        if let Some(c) = &cursor {
            // Percent-encoded by the URL type.
            page_url.query_pairs_mut().append_pair("cursor", c);
        }
        let page: List<T> = send_json(client.get(page_url).header("x-api-key", key)).await?;
        out.extend(page.data);
        match page.next_cursor.filter(|c| page.has_next_page && !c.is_empty() && Some(c) != cursor.as_ref()) {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    Ok(out)
}
