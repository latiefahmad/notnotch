//! Coinbase Advanced Trade: accounts (balances per currency) with a CDP API key.
//!
//! The key needs only the "View" permission. `key_permissions` tells whether the key could
//! also trade or transfer; then the account carries a warning. Coinbase gives no cost basis.

use serde::Deserialize;

use super::{num, send_json, sign, Account, Holding};
use crate::secrets;

const HOST: &str = "api.coinbase.com";

#[derive(Deserialize)]
struct Accounts {
    #[serde(default)]
    accounts: Vec<ApiAccount>,
    #[serde(default)]
    has_next: bool,
    #[serde(default)]
    cursor: String,
}

#[derive(Deserialize)]
struct ApiAccount {
    currency: String,
    #[serde(default)]
    name: String,
    available_balance: Amount,
    hold: Option<Amount>,
}

#[derive(Deserialize)]
struct Amount {
    value: String,
}

#[derive(Deserialize)]
struct Permissions {
    #[serde(default)]
    can_trade: bool,
    #[serde(default)]
    can_transfer: bool,
}

pub async fn fetch(client: &reqwest::Client) -> Result<Account, String> {
    let key_name = secrets::read("coinbase.key").ok_or("no-key")?;
    let pem = secrets::read("coinbase.secret").ok_or("no-key")?;
    let get = |path: &str, query: &str| -> Result<reqwest::RequestBuilder, String> {
        let now = super::now_ms() / 1000;
        let jwt = sign::coinbase_jwt(key_name.trim(), &pem, &format!("GET {HOST}{path}"), now, &sign::random_hex(16)?)?;
        Ok(client.get(format!("https://{HOST}{path}{query}")).bearer_auth(jwt))
    };

    let mut holdings = Vec::new();
    let mut cursor = String::new();
    // 250 per page; a few pages at most even for wide accounts.
    for _ in 0..8 {
        let query = if cursor.is_empty() { "?limit=250".to_string() } else { format!("?limit=250&cursor={cursor}") };
        let page: Accounts = send_json(get("/api/v3/brokerage/accounts", &query)?).await?;
        for a in page.accounts {
            let quantity = num(&a.available_balance.value) + a.hold.map(|h| num(&h.value)).unwrap_or(0.0);
            if quantity.abs() > 1e-12 {
                holdings.push(Holding { name: a.name, ..Holding::balance(&a.currency, quantity) });
            }
        }
        if !page.has_next || page.cursor.is_empty() {
            break;
        }
        cursor = page.cursor;
    }

    let warning = match send_json::<Permissions>(get("/api/v3/brokerage/key_permissions", "")?).await {
        Ok(p) if p.can_trade || p.can_transfer => Some("key-can-trade".to_string()),
        _ => None,
    };
    Ok(Account { holdings, warning, ..Default::default() })
}
