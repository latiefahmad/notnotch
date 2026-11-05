//! Binance spot account balances (`GET /api/v3/account`, signed, USER_DATA).
//!
//! The key needs only "Enable Reading". `apiRestrictions` tells whether it could also trade or
//! withdraw; then the account carries a warning. Binance gives no cost basis. The timestamp
//! comes from Binance's clock, so a PC clock that is off does not break the signature.

use serde::Deserialize;

use super::{num, send_json, sign, Account, Holding};
use crate::secrets;

const API: &str = "https://api.binance.com";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerTime {
    server_time: u64,
}

#[derive(Deserialize)]
struct ApiAccount {
    balances: Vec<Balance>,
}

#[derive(Deserialize)]
struct Balance {
    asset: String,
    free: String,
    locked: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Restrictions {
    #[serde(default)]
    enable_spot_and_margin_trading: bool,
    #[serde(default)]
    enable_withdrawals: bool,
    #[serde(default)]
    enable_futures: bool,
    #[serde(default)]
    enable_margin: bool,
    #[serde(default)]
    enable_internal_transfer: bool,
    #[serde(default)]
    permits_universal_transfer: bool,
}

pub async fn fetch(client: &reqwest::Client) -> Result<Account, String> {
    let key = secrets::read("binance.key").ok_or("no-key")?;
    let secret = secrets::read("binance.secret").ok_or("no-key")?;
    let time: ServerTime = send_json(client.get(format!("{API}/api/v3/time"))).await?;
    let signed = |path: &str, params: &str| {
        let query = format!("{params}{}recvWindow=10000&timestamp={}", if params.is_empty() { "" } else { "&" }, time.server_time);
        let signature = sign::binance(&query, &secret);
        client.get(format!("{API}{path}?{query}&signature={signature}")).header("X-MBX-APIKEY", key.trim())
    };

    let account: ApiAccount = send_json(signed("/api/v3/account", "omitZeroBalances=true")).await.map_err(binance_error)?;
    let holdings = account
        .balances
        .into_iter()
        .map(|b| (b.asset, num(&b.free) + num(&b.locked)))
        .filter(|(_, q)| q.abs() > 1e-12)
        .map(|(asset, q)| Holding::balance(&asset, q))
        .collect();

    let warning = match send_json::<Restrictions>(signed("/sapi/v1/account/apiRestrictions", "")).await {
        Ok(r)
            if r.enable_spot_and_margin_trading
                || r.enable_withdrawals
                || r.enable_futures
                || r.enable_margin
                || r.enable_internal_transfer
                || r.permits_universal_transfer =>
        {
            Some("key-can-trade".to_string())
        }
        _ => None,
    };
    Ok(Account { holdings, warning, ..Default::default() })
}

/// Binance answers a bad key or signature with HTTP 400/401 (codes -2014, -2015, -1022).
fn binance_error(e: String) -> String {
    if e == "network:HTTP 400" {
        "unauthorized".into()
    } else {
        e
    }
}
