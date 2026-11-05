//! Lyrics from the sources besides LRCLIB (which the webview asks itself): Kugou and NetEase Cloud Music. Both are
//! unofficial APIs without an account; they are asked only when the user turns them on in Settings, with the cleaned
//! title, artist and length, and only while a lyrics surface is on (the webview decides when to ask).
//!
//! Every answer becomes LRC text, so the webview parses all sources the same way: enhanced LRC (`<mm:ss.xx>` before each
//! word) when the source has word timing, and the translation and romanisation as LRC with the same line stamps.
//! Errors: "unavailable" (network, refused, unreadable answer), "unknown-source".

use std::io::Read;
use std::time::Duration;

use base64::Engine;
use reqwest::Url;
use serde::Serialize;
use serde_json::Value;

const UNAVAILABLE: &str = "unavailable";
/// A search result of another recording would drift; the same limit as for LRCLIB (lrc.ts MAX_DRIFT).
const MAX_DRIFT_MS: f64 = 5000.0;
/// Answers are a few KB; anything far bigger is not lyrics.
const MAX_BODY: usize = 2 * 1024 * 1024;

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct Found {
    lrc: Option<String>,
    instrumental: bool,
    translation: Option<String>,
    roman: Option<String>,
}

/// Lyrics of a song from `source` ("kugou" or "netease"); None when the source has none.
#[tauri::command]
pub async fn lyrics_fetch(source: String, title: String, artist: String, duration: f64) -> Result<Option<Found>, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(8)).user_agent("NotNotch").build().map_err(|_| UNAVAILABLE)?;
    let keyword = format!("{} {}", artist.trim(), title.trim()).trim().to_string();
    match source.as_str() {
        "kugou" => kugou(&client, &keyword, &title, duration).await,
        "netease" => netease(&client, &keyword, &title, duration).await,
        _ => Err("unknown-source".into()),
    }
}

async fn get(client: &reqwest::Client, url: Url, referer: Option<&str>) -> Result<Vec<u8>, String> {
    let mut req = client.get(url);
    if let Some(r) = referer {
        req = req.header(reqwest::header::REFERER, r);
    }
    let r = req.send().await.map_err(|_| UNAVAILABLE)?;
    if !r.status().is_success() || r.content_length().is_some_and(|n| n as usize > MAX_BODY) {
        return Err(UNAVAILABLE.into());
    }
    let body = r.bytes().await.map_err(|_| UNAVAILABLE)?;
    if body.len() > MAX_BODY {
        return Err(UNAVAILABLE.into());
    }
    Ok(body.to_vec())
}

async fn get_json(client: &reqwest::Client, url: Url, referer: Option<&str>) -> Result<Value, String> {
    serde_json::from_slice(&get(client, url, referer).await?).map_err(|_| UNAVAILABLE.into())
}

fn url(base: &str, params: &[(&str, &str)]) -> Url {
    Url::parse_with_params(base, params).expect("static base url")
}

/// Letters and digits only, lower case: "Yellow (Remastered)" still matches "yellow".
fn simplified(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// A result is the song when one title contains the other and the length is within MAX_DRIFT_MS.
fn same_song(found_title: &str, found_ms: f64, title: &str, duration: f64) -> bool {
    let (a, b) = (simplified(found_title), simplified(title));
    !a.is_empty() && !b.is_empty() && (a.contains(&b) || b.contains(&a)) && (found_ms - duration * 1000.0).abs() <= MAX_DRIFT_MS
}

// Kugou: search, then the KRC download (word timing, translation and romanisation in one file).

async fn kugou(client: &reqwest::Client, keyword: &str, title: &str, duration: f64) -> Result<Option<Found>, String> {
    let ms = format!("{}", (duration * 1000.0).round() as u64);
    let search = get_json(client, url("https://lyrics.kugou.com/search", &[("ver", "1"), ("man", "yes"), ("client", "pc"), ("keyword", keyword), ("duration", &ms)]), None).await?;
    let Some((id, key)) = kugou_pick(&search, title, duration) else { return Ok(None) };
    let params = [("ver", "1"), ("client", "pc"), ("fmt", "krc"), ("charset", "utf8"), ("id", id.as_str()), ("accesskey", key.as_str())];
    let download = get_json(client, url("https://lyrics.kugou.com/download", &params), None).await?;
    let Some(content) = download.get("content").and_then(Value::as_str) else { return Ok(None) };
    Ok(decode_krc(content).as_deref().and_then(krc_to_found))
}

/// Id and access key of the first candidate that is the song (Kugou sorts them by its own score).
fn kugou_pick(search: &Value, title: &str, duration: f64) -> Option<(String, String)> {
    search.get("candidates")?.as_array()?.iter().find_map(|c| {
        let song = c.get("song")?.as_str()?;
        let ms = c.get("duration")?.as_f64()?;
        if !same_song(song, ms, title, duration) {
            return None;
        }
        Some((c.get("id")?.as_str()?.to_string(), c.get("accesskey")?.as_str()?.to_string()))
    })
}

/// KRC as served: base64 of "krc1" and a zlib stream XORed with a fixed key.
const KRC_KEY: [u8; 16] = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];

fn decode_krc(b64: &str) -> Option<String> {
    let raw = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
    let body = raw.strip_prefix(b"krc1")?;
    let plain: Vec<u8> = body.iter().enumerate().map(|(i, b)| b ^ KRC_KEY[i % KRC_KEY.len()]).collect();
    let mut text = String::new();
    flate2::read::ZlibDecoder::new(plain.as_slice()).take(MAX_BODY as u64).read_to_string(&mut text).ok()?;
    Some(text)
}

/// `mm:ss.xx` from milliseconds.
fn stamp(ms: u64) -> String {
    format!("{:02}:{:02}.{:02}", ms / 60_000, ms / 1000 % 60, ms % 1000 / 10)
}

/// LRC lines from (start ms, text) pairs, empty texts left out.
fn lrc_of(lines: impl Iterator<Item = (u64, String)>) -> Option<String> {
    let out: String = lines.filter(|(_, t)| !t.trim().is_empty()).map(|(at, t)| format!("[{}]{}\n", stamp(at), t.trim())).collect();
    (!out.is_empty()).then_some(out)
}

/// KRC text to enhanced LRC. Lines are `[start,length]` then `<offset,length,0>word` with offsets from the line start;
/// `[language:base64]` holds JSON with one entry per line: type 1 the translation, type 0 the romanisation per word.
fn krc_to_found(text: &str) -> Option<Found> {
    let (mut lrc, mut starts, mut language) = (String::new(), Vec::new(), None::<Value>);
    for raw in text.lines() {
        let line = raw.trim_start_matches('\u{feff}').trim();
        if let Some(b64) = line.strip_prefix("[language:").and_then(|r| r.strip_suffix(']')) {
            language = base64::engine::general_purpose::STANDARD.decode(b64).ok().and_then(|j| serde_json::from_slice(&j).ok());
            continue;
        }
        let Some((head, mut rest)) = line.strip_prefix('[').and_then(|l| l.split_once(']')) else { continue };
        let Some(Ok(start)) = head.split_once(',').map(|(s, _)| s.trim().parse::<u64>()) else { continue };
        lrc.push_str(&format!("[{}]", stamp(start)));
        if !rest.contains('<') {
            lrc.push_str(rest);
        } else {
            let mut end = start;
            while let Some(open) = rest.find('<') {
                let Some(close) = rest[open..].find('>').map(|c| open + c) else { break };
                let mut nums = rest[open + 1..close].split(',').map(|n| n.trim().parse::<u64>());
                let after = &rest[close + 1..];
                let next = after.find('<').unwrap_or(after.len());
                if let (Some(Ok(offset)), Some(Ok(length))) = (nums.next(), nums.next()) {
                    lrc.push_str(&format!("<{}>{}", stamp(start + offset), &after[..next]));
                    end = end.max(start + offset + length);
                }
                rest = &after[next..];
            }
            lrc.push_str(&format!("<{}>", stamp(end)));
        }
        lrc.push('\n');
        starts.push(start);
    }
    if starts.is_empty() {
        return None;
    }
    let part = |kind: i64| -> Option<String> {
        let item = language.as_ref()?.get("content")?.as_array()?.iter().find(|c| c.get("type").and_then(Value::as_i64) == Some(kind))?;
        let rows = item.get("lyricContent")?.as_array()?;
        let text = |row: &Value| row.as_array().map(|w| w.iter().filter_map(Value::as_str).collect::<String>()).unwrap_or_default();
        lrc_of(starts.iter().zip(rows).map(|(at, row)| (*at, text(row))))
    };
    Some(Found { lrc: Some(lrc), instrumental: false, translation: part(1), roman: part(0) })
}

// NetEase Cloud Music: search, then the lyric endpoint (line timing, translation and romanisation as LRC).

const NETEASE_REFERER: &str = "https://music.163.com/";
/// NetEase's own text for a song without vocals.
const NETEASE_INSTRUMENTAL: &str = "纯音乐，请欣赏";

async fn netease(client: &reqwest::Client, keyword: &str, title: &str, duration: f64) -> Result<Option<Found>, String> {
    let search = get_json(client, url("https://music.163.com/api/search/get", &[("type", "1"), ("limit", "10"), ("s", keyword)]), Some(NETEASE_REFERER)).await?;
    let Some(id) = netease_pick(&search, title, duration) else { return Ok(None) };
    let id = id.to_string();
    let params = [("id", id.as_str()), ("lv", "-1"), ("tv", "-1"), ("rv", "-1")];
    let lyric = get_json(client, url("https://music.163.com/api/song/lyric", &params), Some(NETEASE_REFERER)).await?;
    Ok(netease_found(&lyric))
}

fn netease_pick(search: &Value, title: &str, duration: f64) -> Option<u64> {
    search.get("result")?.get("songs")?.as_array()?.iter().find_map(|s| {
        let ok = same_song(s.get("name")?.as_str()?, s.get("duration")?.as_f64()?, title, duration);
        ok.then(|| s.get("id")?.as_u64()).flatten()
    })
}

fn netease_found(lyric: &Value) -> Option<Found> {
    let text = |key: &str| lyric.get(key)?.get("lyric")?.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let lrc = text("lrc");
    if lyric.get("nolyric").and_then(Value::as_bool) == Some(true) || lrc.as_deref().is_some_and(|l| l.contains(NETEASE_INSTRUMENTAL)) {
        return Some(Found { instrumental: true, ..Found::default() });
    }
    Some(Found { lrc: Some(lrc?), instrumental: false, translation: text("tlyric"), roman: text("romalrc") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn encode_krc(text: &str) -> String {
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        z.write_all(text.as_bytes()).unwrap();
        let packed: Vec<u8> = z.finish().unwrap().iter().enumerate().map(|(i, b)| b ^ KRC_KEY[i % 16]).collect();
        base64::engine::general_purpose::STANDARD.encode([b"krc1".as_slice(), &packed].concat())
    }

    #[test]
    fn krc_becomes_enhanced_lrc_with_translation_and_romanisation() {
        let language = json!({ "content": [
            { "type": 1, "language": 0, "lyricContent": [["Like sinking"], [" "]] },
            { "type": 0, "language": 0, "lyricContent": [["shi zu ", "mu ", "yo u ni"], ["la"]] },
        ] });
        let b64 = base64::engine::general_purpose::STANDARD.encode(language.to_string());
        let krc = format!("\u{feff}[ti:Song, with comma]\n[offset:0]\n[language:{b64}]\n[1671,1767]<0,469,0>沈<469,365,0>む<834,933,0>ように\n[65000,1000]la la\n");
        let text = decode_krc(&encode_krc(&krc)).unwrap();
        assert_eq!(text, krc);
        let found = krc_to_found(&text).unwrap();
        assert_eq!(found.lrc.as_deref(), Some("[00:01.67]<00:01.67>沈<00:02.14>む<00:02.50>ように<00:03.43>\n[01:05.00]la la\n"));
        assert_eq!(found.translation.as_deref(), Some("[00:01.67]Like sinking\n"));
        assert_eq!(found.roman.as_deref(), Some("[00:01.67]shi zu mu yo u ni\n[01:05.00]la\n"));
        assert!(decode_krc("bm90IGtyYw==").is_none());
        assert!(krc_to_found("[ar:Someone]\n").is_none());
    }

    #[test]
    fn picks_only_the_same_song() {
        let search = json!({ "candidates": [
            { "song": "Other", "duration": 200000, "id": "1", "accesskey": "a" },
            { "song": "Yellow (Live)", "duration": 280000, "id": "2", "accesskey": "b" },
            { "song": "Yellow", "duration": 268500, "id": "3", "accesskey": "c" },
        ] });
        assert_eq!(kugou_pick(&search, "Yellow", 266.0), Some(("3".into(), "c".into())));
        assert_eq!(kugou_pick(&search, "Blue", 266.0), None);
        let songs = json!({ "result": { "songs": [{ "name": "夜に駆ける", "duration": 261013, "id": 84072830 }] } });
        assert_eq!(netease_pick(&songs, "夜に駆ける", 261.0), Some(84072830));
        assert_eq!(netease_pick(&songs, "夜に駆ける", 240.0), None);
        assert_eq!(netease_pick(&json!({ "code": -462 }), "x", 1.0), None);
    }

    #[test]
    fn netease_answers() {
        let both = json!({ "lrc": { "lyric": "[00:01.43]沈むように\n" }, "tlyric": { "lyric": "" }, "romalrc": { "lyric": "[00:01.430]shizumu youni" } });
        assert_eq!(netease_found(&both), Some(Found { lrc: Some("[00:01.43]沈むように".into()), instrumental: false, translation: None, roman: Some("[00:01.430]shizumu youni".into()) }));
        assert!(netease_found(&json!({ "nolyric": true })).unwrap().instrumental);
        assert!(netease_found(&json!({ "lrc": { "lyric": "[00:00.00] 纯音乐，请欣赏" } })).unwrap().instrumental);
        assert_eq!(netease_found(&json!({ "code": 200 })), None);
    }
}
