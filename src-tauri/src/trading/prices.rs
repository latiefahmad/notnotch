//! Public prices without keys: CoinGecko for crypto (by symbol, the coin with the largest
//! market cap wins when a symbol is shared) and Frankfurter (ECB reference rates) for currencies.
//! Cached per symbol for a minute, so asking again as accounts arrive only fetches what is new.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::send_json;

const FRESH: Duration = Duration::from_secs(60);
/// Symbols CoinGecko does not know are not asked for again for a while.
const MISS: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Default, Serialize)]
pub struct Rates {
    pub base: String,
    /// Price of one coin in `base`, by upper-case symbol.
    pub crypto: HashMap<String, f64>,
    /// Units of a currency per one `base` (as the ECB publishes them).
    pub fx: HashMap<String, f64>,
    /// The ECB day `fx` is from ("2026-10-31"); None until rates arrived once.
    pub date: Option<String>,
    /// Sources that failed ("coingecko", "frankfurter"); the rest is still returned.
    pub failed: Vec<String>,
}

#[derive(Default)]
pub struct Cache {
    base: String,
    crypto: HashMap<String, (Instant, Option<f64>)>,
    fx: Option<(Instant, String, HashMap<String, f64>)>,
}

pub async fn fetch(client: &reqwest::Client, cache: &mut Cache, base: &str, crypto: &[String], fiats: &[String]) -> Result<Rates, String> {
    let base = base.to_uppercase();
    if cache.base != base {
        *cache = Cache { base: base.clone(), ..Default::default() };
    }
    let mut failed = Vec::new();

    let wanted: Vec<String> = crypto.iter().map(|s| s.to_uppercase()).filter(|s| s.chars().all(|c| c.is_ascii_alphanumeric())).collect();
    let stale: Vec<String> = wanted
        .iter()
        .filter(|s| match cache.crypto.get(*s) {
            Some((at, Some(_))) => at.elapsed() > FRESH,
            Some((at, None)) => at.elapsed() > MISS,
            None => true,
        })
        .cloned()
        .collect();
    let vs = base.to_lowercase();
    for chunk in stale.chunks(80) {
        let symbols: Vec<String> = chunk.iter().map(|s| s.to_lowercase()).collect();
        let url = format!("https://api.coingecko.com/api/v3/simple/price?symbols={}&vs_currencies={vs}", symbols.join(","));
        match send_json::<HashMap<String, HashMap<String, f64>>>(client.get(url)).await {
            Ok(map) => {
                let now = Instant::now();
                for s in chunk {
                    let price = map.get(&s.to_lowercase()).and_then(|p| p.get(&vs)).copied();
                    cache.crypto.insert(s.clone(), (now, price));
                }
            }
            Err(_) => failed.push("coingecko".to_string()),
        }
    }

    let needs_fx = fiats.iter().any(|f| !f.eq_ignore_ascii_case(&base));
    if needs_fx && cache.fx.as_ref().is_none_or(|(at, _, _)| at.elapsed() > FRESH) {
        #[derive(serde::Deserialize)]
        struct Latest {
            date: String,
            rates: HashMap<String, f64>,
        }
        match send_json::<Latest>(client.get(format!("https://api.frankfurter.dev/v1/latest?base={base}"))).await {
            Ok(latest) => cache.fx = Some((Instant::now(), latest.date, latest.rates)),
            Err(_) => failed.push("frankfurter".to_string()),
        }
    }

    // On failure the older cached values still answer.
    Ok(Rates {
        crypto: wanted.iter().filter_map(|s| cache.crypto.get(s).and_then(|(_, p)| *p).map(|p| (s.clone(), p))).collect(),
        fx: cache.fx.as_ref().map(|(_, _, fx)| fx.clone()).unwrap_or_default(),
        date: cache.fx.as_ref().map(|(_, date, _)| date.clone()),
        base,
        failed,
    })
}
