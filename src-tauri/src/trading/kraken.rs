//! Kraken spot (REST, private endpoints are POST but read-only): Balance and Ledgers.
//!
//! Key rights needed: "Query Funds" and "Query Ledger Entries", nothing else.
//! Kraken has no cost basis, so the ledger entries that swap coins against money (trades, and
//! the spend/receive pairs of Buy Crypto and Convert) are kept on disk and turned into trades
//! for the average cost in the frontend. Kraken returns 50 entries per call and limits calls,
//! so a first load reads at most `PAGES` pages per refresh and marks the account partial.
//! Spend/receive cannot be filtered server side, so the full ledger is read and filtered here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use super::{is_fiat, now_ms, num, sign, Account, Holding, Leg, Trade};
use crate::secrets;

const API: &str = "https://api.kraken.com";
/// Each Ledgers call costs 2 of the 15 points of the starter tier; Balance costs 1.
const PAGES: usize = 5;
const PAGE_SIZE: usize = 50;
/// Ledger types that swap coins against money or other coins.
const COST_TYPES: &[&str] = &["trade", "spend", "receive"];
/// Bumped when the cache shape or the kept types change, so old files are read again.
const CACHE_VERSION: u32 = 2;

#[derive(Deserialize)]
struct Reply<T> {
    #[serde(default)]
    error: Vec<String>,
    result: Option<T>,
}

#[derive(Deserialize)]
struct LedgerPage {
    #[serde(default)]
    ledger: HashMap<String, Entry>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    refid: String,
    time: f64,
    #[serde(default, rename = "type")]
    kind: String,
    asset: String,
    amount: String,
    fee: String,
}

/// Ledger entries already read, for one key.
#[derive(Default, Serialize, Deserialize)]
struct LedgerCache {
    #[serde(default)]
    version: u32,
    key: String,
    entries: HashMap<String, Entry>,
    /// Offset of the first full read (newest first, counting every entry type).
    ofs: usize,
    complete: bool,
    /// A read of newer entries in progress: its start time (exclusive) and offset.
    #[serde(default)]
    scan: Option<(f64, usize)>,
    /// Time of the newest entry of any type seen (staking rewards included), so the scan for
    /// newer entries does not read the same rewards again.
    #[serde(default)]
    newest: f64,
}

pub async fn fetch(client: &reqwest::Client, app: &AppHandle) -> Result<Account, String> {
    let key = secrets::read("kraken.key").ok_or("no-key")?;
    let secret = secrets::read("kraken.secret").ok_or("no-key")?;

    let balances: HashMap<String, String> = call(client, &key, &secret, "Balance", "").await?;
    let mut merged: HashMap<String, f64> = HashMap::new();
    for (code, amount) in balances {
        let symbol = asset(&code);
        if symbol != "KFEE" {
            *merged.entry(symbol).or_default() += num(&amount);
        }
    }
    let mut holdings: Vec<Holding> = merged.into_iter().filter(|(_, q)| q.abs() > 1e-12).map(|(s, q)| Holding::balance(&s, q)).collect();
    holdings.sort_by(|a, b| a.symbol.cmp(&b.symbol));

    let path = crate::portable::app_data_dir(app).ok().map(|d| d.join("kraken-ledger.json"));
    let fingerprint = super::sign::hex(&Sha256::digest(key.as_bytes())[..8]);
    let mut cache: LedgerCache = path.as_ref().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    if cache.key != fingerprint || cache.version != CACHE_VERSION {
        cache = LedgerCache { key: fingerprint, version: CACHE_VERSION, ..Default::default() };
    }
    match read_ledger(client, &key, &secret, &mut cache).await {
        // Without "Query Ledger Entries" the balances still show, with cost unknown.
        Err(e) if e == "forbidden" => return Ok(Account { holdings, warning: Some("ledger-forbidden".into()), ..Default::default() }),
        // A rate limit while reading keeps what was read; the next refresh goes on.
        _ => {}
    }
    if let Some(p) = &path {
        let _ = std::fs::write(p, serde_json::to_vec(&cache).unwrap_or_default());
    }

    Ok(Account { holdings, trades: trades(cache.entries.values()), partial: !cache.complete, ..Default::default() })
}

async fn read_ledger(client: &reqwest::Client, key: &str, secret: &str, cache: &mut LedgerCache) -> Result<(), String> {
    for _ in 0..PAGES {
        // First the full history page by page; after that only what is newer than the newest
        // entry (one second earlier and de-duplicated, since both legs of a trade share the
        // time), page by page until a short page, also across refreshes.
        let params = if cache.complete {
            let (start, ofs) = *cache.scan.get_or_insert_with(|| ((cache.newest - 1.0).max(0.0).floor(), 0));
            format!("start={start}&ofs={ofs}&without_count=true")
        } else {
            format!("ofs={}&without_count=true", cache.ofs)
        };
        let page: LedgerPage = call(client, key, secret, "Ledgers", &params).await?;
        let n = page.ledger.len();
        cache.newest = page.ledger.values().map(|e| e.time).fold(cache.newest, f64::max);
        cache.entries.extend(page.ledger.into_iter().filter(|(_, e)| COST_TYPES.contains(&e.kind.as_str())));
        if cache.complete {
            match &mut cache.scan {
                Some((_, ofs)) if n == PAGE_SIZE => *ofs += n,
                _ => {
                    cache.scan = None;
                    break;
                }
            }
        } else {
            cache.ofs += n;
            if n < PAGE_SIZE {
                cache.complete = true;
                break;
            }
        }
    }
    Ok(())
}


async fn call<T: for<'de> Deserialize<'de>>(client: &reqwest::Client, key: &str, secret: &str, method: &str, params: &str) -> Result<T, String> {
    let path = format!("/0/private/{method}");
    let nonce = nonce().to_string();
    let body = if params.is_empty() { format!("nonce={nonce}") } else { format!("nonce={nonce}&{params}") };
    let signature = sign::kraken(&path, &nonce, &body, secret)?;
    let req = client
        .post(format!("{API}{path}"))
        .header("API-Key", key)
        .header("API-Sign", signature)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body);
    let reply: Reply<T> = super::send_json(req).await?;
    if let Some(e) = reply.error.first() {
        return Err(error_code(e));
    }
    reply.result.ok_or_else(|| "network:empty response".to_string())
}

fn error_code(e: &str) -> String {
    match e {
        "EAPI:Invalid key" | "EAPI:Invalid signature" => "unauthorized".into(),
        "EGeneral:Permission denied" => "forbidden".into(),
        "EAPI:Rate limit exceeded" | "EGeneral:Too many requests" => "rate".into(),
        other => format!("api:{other}"),
    }
}

/// Kraken wants a strictly increasing nonce per key.
fn nonce() -> u64 {
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = now_ms();
    let mut last = LAST.load(Ordering::SeqCst);
    loop {
        let next = now.max(last + 1);
        match LAST.compare_exchange(last, next, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return next,
            Err(seen) => last = seen,
        }
    }
}

/// Old four-letter codes with an X (crypto) or Z (fiat) prefix.
const LEGACY: &[&str] = &[
    "XXBT", "XETH", "XLTC", "XXRP", "XXLM", "XXMR", "XZEC", "XETC", "XMLN", "XREP", "XXDG", "XICN", "XNMC", "XXVN", "ZEUR", "ZUSD", "ZGBP", "ZCAD",
    "ZJPY", "ZAUD",
];

/// "XXBT" → "BTC", "ZEUR" → "EUR", "DOT.S" → "DOT", "ETH2.S" → "ETH", "USDC.M" → "USDC".
pub fn asset(code: &str) -> String {
    let base = code.split('.').next().unwrap_or(code);
    let base = if LEGACY.contains(&base) { &base[1..] } else { base };
    match base {
        "XBT" => "BTC",
        "XDG" => "DOGE",
        "ETH2" => "ETH",
        other => other,
    }
    .to_string()
}

/// Groups ledger entries by trade (refid); each leg is the balance change net of fees.
fn trades<'a>(entries: impl Iterator<Item = &'a Entry>) -> Vec<Trade> {
    let mut by_ref: HashMap<&str, Trade> = HashMap::new();
    for e in entries {
        let symbol = asset(&e.asset);
        let trade = by_ref.entry(&e.refid).or_insert(Trade { time: e.time, legs: vec![] });
        trade.legs.push(Leg { fiat: is_fiat(&symbol), asset: symbol, net: num(&e.amount) - num(&e.fee) });
    }
    let mut list: Vec<Trade> = by_ref.into_values().collect();
    list.sort_by(|a, b| a.time.total_cmp(&b.time));
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_codes() {
        assert_eq!(asset("XXBT"), "BTC");
        assert_eq!(asset("XBT.M"), "BTC");
        assert_eq!(asset("ZEUR"), "EUR");
        assert_eq!(asset("XETH"), "ETH");
        assert_eq!(asset("ETH2.S"), "ETH");
        assert_eq!(asset("DOT.S"), "DOT");
        assert_eq!(asset("XXDG"), "DOGE");
        assert_eq!(asset("XTZ"), "XTZ");
        assert_eq!(asset("ZRX"), "ZRX");
        assert_eq!(asset("USDC"), "USDC");
    }

    #[test]
    fn ledger_entries_become_trades_net_of_fees() {
        let e = |refid: &str, time: f64, asset: &str, amount: &str, fee: &str| Entry {
            refid: refid.into(),
            time,
            kind: "trade".into(),
            asset: asset.into(),
            amount: amount.into(),
            fee: fee.into(),
        };
        let entries = [e("T2", 20.0, "XXBT", "-0.0100000000", "0"), e("T1", 10.0, "ZEUR", "-1000.0000", "2.6000"), e("T1", 10.0, "XXBT", "0.0100000000", "0"), e("T2", 20.0, "ZEUR", "1100.0000", "2.8600")];
        let list = trades(entries.iter());
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].time, 10.0);
        let eur = list[0].legs.iter().find(|l| l.asset == "EUR").unwrap();
        assert!(eur.fiat);
        assert!((eur.net + 1002.6).abs() < 1e-9);
        let eur = list[1].legs.iter().find(|l| l.asset == "EUR").unwrap();
        assert!((eur.net - 1097.14).abs() < 1e-9);
    }
}
