//! Portfolio across brokers and exchanges. Read-only: no provider module calls an order,
//! transfer or any other write endpoint, and the keys should be created read-only.
//!
//! Each provider module turns its API into the same `Account` shape (holdings with optional
//! value and cost, plus trades where the API has no cost basis). Pricing, currency conversion
//! and P&L happen in the frontend (src/features/trading/portfolio.ts), so they are pure and tested.
//!
//! History: the APIs have no value history, so one snapshot per day is stored (the day's last
//! value) plus intraday points every 2 min while the portfolio is open, per scope (all accounts
//! or one account) and base currency.

mod binance;
mod bitpanda;
mod coinbase;
mod etoro;
mod ibkr;
mod kraken;
mod prices;
mod sign;
mod t212;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

use crate::now_ms;
use crate::secrets;
pub use prices::Rates;

const KEEP_DAYS: usize = 120;
const INTRADAY_STEP_MS: u64 = 2 * 60 * 1000;

#[derive(Default)]
pub struct TradingState {
    /// By "provider:env:key fingerprint", so a changed key never serves the old account.
    accounts: Mutex<HashMap<String, (Instant, Account)>>,
    /// One fetch per provider at a time (Kraken nonces, rate limits).
    inflight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    prices: tokio::sync::Mutex<prices::Cache>,
}

/// Credential Manager entries of each provider.
fn secret_names(provider: &str) -> &'static [&'static str] {
    match provider {
        "t212" => &["t212.key", "t212.secret"],
        "kraken" => &["kraken.key", "kraken.secret"],
        "coinbase" => &["coinbase.key", "coinbase.secret"],
        "binance" => &["binance.key", "binance.secret"],
        "bitpanda" => &["bitpanda.key"],
        "etoro" => &["etoro.key", "etoro.user"],
        "ibkr" => &["ibkr.token", "ibkr.query"],
        _ => &[],
    }
}

/// Short hash of the provider's keys (never the keys themselves).
pub fn fingerprint(provider: &str) -> String {
    let mut h = Sha256::new();
    for name in secret_names(provider) {
        h.update(secrets::read(name).unwrap_or_default().as_bytes());
        h.update([0]);
    }
    sign::hex(&h.finalize()[..8])
}

/// One account as the provider reports it. Amounts are in `Holding::currency` (or priced later).
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub holdings: Vec<Holding>,
    /// Only where the API has no cost basis (Kraken): used for average cost.
    pub trades: Vec<Trade>,
    pub realized: Option<Money>,
    /// The trade history is still being loaded, so cost and P&L are incomplete.
    pub partial: bool,
    /// "key-can-trade" when the provider says the key has more than read rights.
    pub warning: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct Money {
    pub amount: f64,
    pub currency: String,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
    pub symbol: String,
    pub name: String,
    /// "crypto", "fiat" or "stock".
    pub kind: &'static str,
    pub quantity: f64,
    /// Price per unit as the provider shows it (display only).
    pub price: Option<f64>,
    pub price_currency: Option<String>,
    /// Current value and cost basis in `currency`, when the provider computes them.
    pub value: Option<f64>,
    pub cost: Option<f64>,
    pub currency: Option<String>,
}

impl Holding {
    /// A balance of a coin or a currency that the frontend prices.
    pub fn balance(symbol: &str, quantity: f64) -> Self {
        Holding {
            symbol: symbol.to_string(),
            name: String::new(),
            kind: if is_fiat(symbol) { "fiat" } else { "crypto" },
            quantity,
            ..Default::default()
        }
    }

    /// Cash in a currency, valued by the provider.
    pub fn cash(currency: &str, amount: f64) -> Self {
        Holding {
            symbol: currency.to_string(),
            kind: "fiat",
            quantity: amount,
            value: Some(amount),
            currency: Some(currency.to_string()),
            ..Default::default()
        }
    }
}

/// A trade as signed balance changes (net of fees), e.g. [-1002.6 EUR, +0.01 BTC].
#[derive(Clone, Serialize, Deserialize)]
pub struct Trade {
    /// Unix seconds.
    pub time: f64,
    pub legs: Vec<Leg>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Leg {
    pub asset: String,
    pub fiat: bool,
    pub net: f64,
}

/// Currencies treated as cash. Stablecoins are crypto (priced by CoinGecko).
const FIAT: &[&str] = &[
    "EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "BGN", "ISK", "TRY", "BRL", "MXN",
    "ZAR", "SGD", "HKD", "KRW", "INR", "ILS", "CNY", "IDR", "MYR", "PHP", "THB", "AED", "ARS", "UAH",
];

pub fn is_fiat(code: &str) -> bool {
    FIAT.contains(&code)
}

/// Cache lifetime per provider (their rate limits and how often the data changes).
fn ttl(provider: &str) -> Duration {
    Duration::from_secs(match provider {
        "t212" => 6,
        "kraken" => 60,
        "ibkr" => 30 * 60,
        _ => 30,
    })
}

/// Errors are short codes the frontend translates: no-key, unauthorized, forbidden, rate,
/// unknown-provider, network:…, api:… (the provider's own message).
#[tauri::command]
pub async fn portfolio_fetch(provider: String, env: String, app: AppHandle, state: State<'_, TradingState>) -> Result<Account, String> {
    let gate = state.inflight.lock().unwrap().entry(provider.clone()).or_default().clone();
    // A second call waits for the running one and then usually hits the cache.
    let _running = gate.lock().await;
    let cache_key = format!("{provider}:{env}:{}", fingerprint(&provider));
    if let Some((at, account)) = state.accounts.lock().unwrap().get(&cache_key) {
        if at.elapsed() < ttl(&provider) {
            return Ok(account.clone());
        }
    }
    let client = client()?;
    let account = match provider.as_str() {
        "t212" => t212::fetch(&client, &env).await?,
        "kraken" => kraken::fetch(&client, &app).await?,
        "coinbase" => coinbase::fetch(&client).await?,
        "binance" => binance::fetch(&client).await?,
        "bitpanda" => bitpanda::fetch(&client).await?,
        "etoro" => etoro::fetch(&client).await?,
        "ibkr" => ibkr::fetch(&client).await?,
        _ => return Err("unknown-provider".into()),
    };
    let mut cache = state.accounts.lock().unwrap();
    // Entries of an older key of this provider go.
    cache.retain(|k, _| !k.starts_with(&format!("{provider}:{env}:")));
    cache.insert(cache_key, (Instant::now(), account.clone()));
    Ok(account)
}

/// Crypto prices in `base` and FX rates (units of a currency per 1 `base`). Public, no keys.
/// Cached per symbol, so asking again as more accounts arrive only fetches what is new.
#[tauri::command]
pub async fn portfolio_prices(base: String, crypto: Vec<String>, fiats: Vec<String>, state: State<'_, TradingState>) -> Result<Rates, String> {
    let mut cache = state.prices.lock().await;
    prices::fetch(&client()?, &mut cache, &base, &crypto, &fiats).await
}

/// The key of `provider` was deleted: drop its cache, its Kraken ledger and its history files.
#[tauri::command]
pub async fn portfolio_forget(provider: String, app: AppHandle, state: State<'_, TradingState>) -> Result<(), String> {
    // Only real provider ids, so "all" or any other string deletes nothing.
    if secret_names(&provider).is_empty() {
        return Ok(());
    }
    // Wait for a running fetch, so it cannot write the ledger again after the delete.
    let gate = state.inflight.lock().unwrap().entry(provider.clone()).or_default().clone();
    let _running = gate.lock().await;
    state.accounts.lock().unwrap().retain(|k, _| !k.starts_with(&format!("{provider}:")));
    let Ok(dir) = crate::portable::app_data_dir(&app) else { return Ok(()) };
    if provider == "kraken" {
        let _ = std::fs::remove_file(dir.join("kraken-ledger.json"));
    }
    if provider == "t212" {
        // The old files would seed the history of a new key's account.
        for env in ["live", "demo"] {
            let _ = std::fs::remove_file(dir.join(format!("trading-history-{env}.json")));
            let _ = std::fs::remove_file(dir.join(format!("trading-intraday-{env}.json")));
        }
    }
    let scopes: Vec<String> = if provider == "t212" { vec!["t212-live".into(), "t212-demo".into()] } else { vec![provider.clone()] };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(()) };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let ours = scopes.iter().any(|s| name.starts_with(&format!("portfolio-history-{s}-")) || name.starts_with(&format!("portfolio-intraday-{s}-")));
        if ours && name.ends_with(".json") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        // Interactive Brokers rejects requests without a User-Agent.
        .user_agent("NotNotch")
        .build()
        .map_err(|e| format!("network:{e}"))
}

/// Error text without the URL: query strings carry tokens and signatures.
pub fn net(e: reqwest::Error) -> String {
    format!("network:{}", e.without_url())
}

/// Sends a request and maps the status to the shared error codes.
pub async fn send_json<T: for<'de> Deserialize<'de>>(req: reqwest::RequestBuilder) -> Result<T, String> {
    let res = req.send().await.map_err(net)?;
    match res.status().as_u16() {
        200..=299 => res.json::<T>().await.map_err(|e| format!("network:unreadable response ({})", e.without_url())),
        401 => Err("unauthorized".into()),
        403 => Err("forbidden".into()),
        429 => Err("rate".into()),
        code => Err(format!("network:HTTP {code}")),
    }
}

pub fn num(s: &str) -> f64 {
    s.trim().parse().unwrap_or(0.0)
}

// ---------- History ----------

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    /// Unix ms.
    t: u64,
    value: f64,
    pnl: f64,
    /// Value of holdings without a cost basis (Coinbase, Binance, coins without trades):
    /// its change counts in "today" and the chart next to the P&L change.
    #[serde(default)]
    no_cost: f64,
}

#[derive(Default, Serialize, Deserialize)]
struct Intraday {
    date: String,
    points: Vec<Point>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    date: String,
    /// Value including cash.
    value: f64,
    invested: f64,
    /// Total profit (realized + unrealized). The change vs. yesterday is the daily change,
    /// independent of deposits and purchases.
    #[serde(default)]
    pnl: f64,
    #[serde(default)]
    no_cost: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordEntry {
    scope: String,
    value: f64,
    pnl: f64,
    invested: f64,
    #[serde(default)]
    no_cost: f64,
    /// Trading 212 env whose old files (in the account currency) seed this scope once.
    seed: Option<String>,
}

#[derive(Serialize)]
pub struct Recorded {
    history: Vec<Snapshot>,
    intraday: Vec<Point>,
}

/// Records today's value for each scope and returns its history. `today`: local "YYYY-MM-DD".
#[tauri::command]
pub fn portfolio_record(base: String, today: String, entries: Vec<RecordEntry>, app: AppHandle) -> HashMap<String, Recorded> {
    let dir = crate::portable::app_data_dir(&app).ok().filter(|d| std::fs::create_dir_all(d).is_ok());
    let base: String = base.chars().filter(|c| c.is_ascii_alphabetic()).collect();
    entries
        .into_iter()
        .map(|e| {
            let point = Point { t: now_ms(), value: e.value, pnl: e.pnl, no_cost: e.no_cost };
            let snapshot = Snapshot { date: today.clone(), value: e.value, invested: e.invested, pnl: e.pnl, no_cost: e.no_cost };
            let recorded = match &dir {
                Some(dir) => {
                    let scope: String = e.scope.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
                    let history = dir.join(format!("portfolio-history-{scope}-{base}.json"));
                    let intraday = dir.join(format!("portfolio-intraday-{scope}-{base}.json"));
                    if let Some(env) = e.seed.as_deref().filter(|env| *env == "live" || *env == "demo") {
                        seed(&history, &dir.join(format!("trading-history-{env}.json")));
                        seed(&intraday, &dir.join(format!("trading-intraday-{env}.json")));
                    }
                    Recorded { intraday: record_point(&intraday, &today, point), history: record_snapshot(&history, snapshot) }
                }
                None => Recorded { history: vec![snapshot], intraday: vec![point] },
            };
            (e.scope, recorded)
        })
        .collect()
}

/// Copies the old Trading 212 file once, so the chart keeps its past.
fn seed(target: &PathBuf, legacy: &PathBuf) {
    if !target.exists() && legacy.exists() {
        let _ = std::fs::copy(legacy, target);
    }
}

/// Reads a stored file. `None` when it exists but can't be read or parsed: then it must not be written over.
fn read_stored<T: serde::de::DeserializeOwned + Default>(path: &PathBuf) -> Option<T> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).ok(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(T::default()),
        Err(_) => None,
    }
}

fn write_stored(path: &PathBuf, value: &impl Serialize) -> std::io::Result<()> {
    crate::write_atomic(path, &serde_json::to_vec(value)?)
}

/// Adds an intraday point (at most every 2 min, otherwise the last one is replaced).
fn record_point(path: &PathBuf, today: &str, point: Point) -> Vec<Point> {
    // Only today's points: a broken file is simply started again.
    let mut day: Intraday = read_stored(path).unwrap_or_default();
    if day.date != today {
        day = Intraday { date: today.to_string(), points: vec![] };
    }
    // The last point is always the current value; a new one is only added once the
    // one before it is at least INTRADAY_STEP_MS old.
    let n = day.points.len();
    if n >= 2 && point.t.saturating_sub(day.points[n - 2].t) < INTRADAY_STEP_MS {
        day.points[n - 1] = point;
    } else {
        day.points.push(point);
    }
    let _ = write_stored(path, &day);
    day.points
}

/// Stores today's value (overwrites the day's entry) and returns the history.
fn record_snapshot(path: &PathBuf, snapshot: Snapshot) -> Vec<Snapshot> {
    // The brokers have no value history to fetch again: an unreadable file is left alone.
    let Some(mut history) = read_stored::<Vec<Snapshot>>(path) else { return vec![snapshot] };
    match history.last_mut() {
        Some(last) if last.date == snapshot.date => *last = snapshot,
        _ => history.push(snapshot),
    }
    if history.len() > KEEP_DAYS {
        history.drain(..history.len() - KEEP_DAYS);
    }
    let _ = write_stored(path, &history);
    history
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(date: &str) -> Snapshot {
        Snapshot { date: date.into(), value: 100.0, invested: 90.0, pnl: 10.0, no_cost: 0.0 }
    }

    #[test]
    fn history_survives_a_cut_file_and_appends_to_a_good_one() {
        let dir = std::env::temp_dir().join(format!("notnotch-history-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.json");

        // Missing: starts the history.
        assert_eq!(record_snapshot(&path, day("2026-11-01")).len(), 1);
        assert_eq!(record_snapshot(&path, day("2026-11-02")).len(), 2);
        assert_eq!(record_snapshot(&path, day("2026-11-02")).len(), 2);

        // Cut short by a crash: left as it is, not replaced by today alone.
        let cut = br#"[{"date":"2026-11-01","value":100"#;
        std::fs::write(&path, cut).unwrap();
        assert_eq!(record_snapshot(&path, day("2026-11-03")).len(), 1);
        assert_eq!(std::fs::read(&path).unwrap(), cut);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
