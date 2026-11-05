//! Romanisation of lyric lines, offline: Korean by the Revised Romanization rules, Chinese as pinyin with tone marks
//! (the `pinyin` crate), Japanese kana by table (Hepburn) and kanji through a reading dictionary that is downloaded on
//! demand into the app data folder, never bundled.
//!
//! The dictionary is the common-words part of JMdict (EDRDG, CC BY-SA 4.0) as published by jmdict-simplified, pinned to
//! one release and checked against its SHA-256. It is turned into a small table of word -> reading on download; kanji are
//! read by longest match against it, so a reading can differ from the sung one. Without it kanji stay as they are.

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::AppHandle;

const DICT_URL: &str = "https://github.com/scriptin/jmdict-simplified/releases/download/3.6.2%2B20261026175559/jmdict-eng-common-3.6.2%2B20261026175559.json.zip";
const DICT_SHA256: &str = "a6b049ec605fa1135f02fa772edee6a71cffcbe6f7e321143667946f93b32dde";
/// The pinned archive is 1.4 MB; the cap only guards against a wrong answer.
const DICT_MAX_DOWNLOAD: usize = 8 * 1024 * 1024;
const DICT_FILE: &str = "ja-readings.tsv";
/// Lines starting with this are stems: a verb or adjective without its kana ending (駆 -> か from 駆ける -> かける).
const STEM: char = '~';

static DICT: Mutex<Option<Arc<JaDict>>> = Mutex::new(None);

fn dict_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::portable::app_data_dir(app).map_err(|e| e.to_string())?.join("lyrics").join(DICT_FILE))
}

/// Romanised lines, "" where a line has nothing to romanise. Japanese when any line has kana, Chinese otherwise.
#[tauri::command]
pub async fn lyrics_romanize(lines: Vec<String>, app: AppHandle) -> Vec<String> {
    let path = dict_path(&app).ok();
    tauri::async_runtime::spawn_blocking(move || {
        let japanese = lines.iter().any(|l| l.chars().any(is_kana));
        let dict = if japanese { path.and_then(|p| loaded(&p)) } else { None };
        lines.iter().map(|l| romanize(l, japanese, dict.as_deref())).collect()
    })
    .await
    .unwrap_or_default()
}

/// Size in bytes of the downloaded dictionary, 0 without one.
#[tauri::command]
pub fn lyrics_dict_status(app: AppHandle) -> u64 {
    dict_path(&app).ok().and_then(|p| std::fs::metadata(p).ok()).map_or(0, |m| m.len())
}

#[tauri::command]
pub async fn lyrics_dict_download(app: AppHandle) -> Result<u64, String> {
    let path = dict_path(&app)?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(60)).user_agent("NotNotch").build().map_err(|_| "unavailable")?;
    let r = client.get(DICT_URL).send().await.map_err(|_| "unavailable")?;
    if !r.status().is_success() {
        return Err("unavailable".into());
    }
    let zip = r.bytes().await.map_err(|_| "unavailable")?;
    if zip.len() > DICT_MAX_DOWNLOAD || format!("{:x}", Sha256::digest(&zip)) != DICT_SHA256 {
        return Err("checksum".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let table = table_from_zip(&zip)?;
        std::fs::create_dir_all(path.parent().ok_or("failed")?).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &table).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        *DICT.lock().unwrap() = None;
        Ok(table.len() as u64)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn lyrics_dict_remove(app: AppHandle) -> Result<(), String> {
    *DICT.lock().unwrap() = None;
    match std::fs::remove_file(dict_path(&app)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

fn loaded(path: &PathBuf) -> Option<Arc<JaDict>> {
    let mut slot = DICT.lock().unwrap();
    if slot.is_none() {
        *slot = std::fs::read_to_string(path).ok().map(|t| Arc::new(JaDict::parse(&t)));
    }
    slot.clone()
}

#[derive(Deserialize)]
struct Jmdict {
    words: Vec<JmWord>,
}
#[derive(Deserialize)]
struct JmWord {
    kanji: Vec<JmForm>,
    kana: Vec<JmKana>,
}
#[derive(Deserialize)]
struct JmForm {
    text: String,
    common: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JmKana {
    text: String,
    common: bool,
    applies_to_kanji: Vec<String>,
}

fn table_from_zip(zip: &[u8]) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip)).map_err(|e| e.to_string())?;
    let mut json = String::new();
    archive.by_index(0).map_err(|e| e.to_string())?.take(64 * 1024 * 1024).read_to_string(&mut json).map_err(|e| e.to_string())?;
    let dict: Jmdict = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(table(&dict))
}

/// `word\treading` lines, common spellings first so they win; then the stems.
fn table(dict: &Jmdict) -> String {
    let mut words: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for common in [true, false] {
        for w in &dict.words {
            for k in w.kanji.iter().filter(|k| k.common == common) {
                let applies = |r: &&JmKana| r.applies_to_kanji.iter().any(|a| a == "*" || *a == k.text);
                let reading = w.kana.iter().filter(applies).find(|r| r.common).or_else(|| w.kana.iter().find(applies));
                if let Some(r) = reading {
                    if seen.insert(k.text.clone()) {
                        words.push((k.text.clone(), r.text.clone()));
                    }
                }
            }
        }
    }
    let mut out = String::new();
    for (word, reading) in &words {
        out.push_str(&format!("{word}\t{reading}\n"));
    }
    // Stems: `~stem\treading\tfirst kana of the ending`, the first word with that stem wins.
    let mut stems = std::collections::HashSet::new();
    for (word, reading) in &words {
        let ending: String = word.chars().rev().take_while(|c| is_kana(*c)).collect::<Vec<_>>().into_iter().rev().collect();
        let stem = &word[..word.len() - ending.len()];
        let Some(first) = ending.chars().next() else { continue };
        if stem.is_empty() || !reading.ends_with(&ending) || !stems.insert(stem.to_string()) {
            continue;
        }
        out.push_str(&format!("{STEM}{stem}\t{}\t{first}\n", &reading[..reading.len() - ending.len()]));
    }
    out
}

/// Kana a godan ending turns into when the verb is conjugated (会う -> 会った, 書く -> 書いて).
const GODAN: [&str; 9] = ["うわいえおっ", "くかきけこい", "ぐがぎげごい", "すさしせそ", "つたちてとっ", "ぬなにねのん", "ぶばびべぼん", "むまみめもん", "るらりれろっ"];

/// Whether `next` can follow a stem whose dictionary ending starts with `ending`.
fn continues(ending: char, next: char) -> bool {
    ending == next || GODAN.iter().any(|g| g.starts_with(ending) && g.contains(next))
}

struct JaDict {
    words: HashMap<String, String>,
    stems: HashMap<String, (String, char)>,
}

impl JaDict {
    fn parse(text: &str) -> Self {
        let (mut words, mut stems) = (HashMap::new(), HashMap::new());
        for line in text.lines() {
            let mut cols = line.split('\t');
            let (Some(k), Some(v)) = (cols.next(), cols.next()) else { continue };
            match (k.strip_prefix(STEM), cols.next().and_then(|e| e.chars().next())) {
                (Some(stem), Some(ending)) => {
                    stems.insert(stem.to_string(), (v.to_string(), ending));
                }
                (Some(_), None) => {}
                (None, _) => {
                    words.insert(k.to_string(), v.to_string());
                }
            }
        }
        JaDict { words, stems }
    }

    /// Reading of the longest word at the start of `chars` (which starts with a kanji), and how many chars it covers. A
    /// stem of the kanji run wins when the kana after it carry on its ending (分かった is 分かる, not 分 + かった), and
    /// stands in when no word matches.
    fn lookup(&self, chars: &[char]) -> Option<(String, usize)> {
        let key = |n: usize| chars[..n].iter().collect::<String>();
        let run = chars.iter().take_while(|c| is_han(**c)).count();
        let word = (1..=chars.len().min(12)).rev().find_map(|n| self.words.get(&key(n)).map(|r| (r.clone(), n)));
        let stem = (1..=run).rev().find_map(|n| self.stems.get(&key(n)).map(|s| (s, n)));
        match (word, stem) {
            (Some((_, wn)), Some(((reading, ending), sn))) if sn >= wn && chars.get(sn).is_some_and(|c| continues(*ending, *c)) => Some((reading.clone(), sn)),
            (Some(w), _) => Some(w),
            (None, s) => s.map(|((reading, _), n)| (reading.clone(), n)),
        }
    }
}

fn is_han(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}' | '\u{F900}'..='\u{FAFF}' | '々')
}
fn is_kana(c: char) -> bool {
    matches!(c, '\u{3041}'..='\u{3096}' | '\u{30A1}'..='\u{30FA}' | 'ー')
}
fn is_hangul(c: char) -> bool {
    matches!(c, '\u{AC00}'..='\u{D7A3}')
}

fn romanize(line: &str, japanese: bool, dict: Option<&JaDict>) -> String {
    let chars: Vec<char> = line.chars().collect();
    if !chars.iter().any(|c| is_han(*c) || is_kana(*c) || is_hangul(*c)) {
        return String::new();
    }
    let run = |from: usize, f: fn(char) -> bool| from + chars[from..].iter().take_while(|c| f(**c)).count();
    let mut parts: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if is_hangul(c) {
            let end = run(i, is_hangul);
            parts.push(hangul(&chars[i..end]));
            i = end;
        } else if is_han(c) && !japanese {
            parts.push(pinyin_of(c));
            i += 1;
        } else if is_han(c) {
            match dict.and_then(|d| d.lookup(&chars[i..])) {
                Some((reading, n)) => {
                    parts.push(kana(&reading));
                    i += n;
                }
                None => {
                    parts.push(c.to_string());
                    i += 1;
                }
            }
        } else if is_kana(c) {
            let end = run(i, is_kana);
            parts.push(kana(&chars[i..end].iter().collect::<String>()));
            i = end;
        } else {
            let end = run(i, |c| !is_han(c) && !is_kana(c) && !is_hangul(c));
            let other: String = chars[i..end].iter().collect();
            if !other.trim().is_empty() {
                parts.push(other.trim().to_string());
            }
            i = end;
        }
    }
    parts.join(" ")
}

fn pinyin_of(c: char) -> String {
    use pinyin::ToPinyin;
    c.to_pinyin().map_or_else(|| c.to_string(), |p| p.with_tone().to_string())
}

// Kana, Hepburn: U+3041 to U+3096 in code point order; katakana are read as their hiragana.
const KANA: [&str; 86] = [
    "a", "a", "i", "i", "u", "u", "e", "e", "o", "o", "ka", "ga", "ki", "gi", "ku", "gu", "ke", "ge", "ko", "go", "sa", "za", "shi", "ji", "su", "zu",
    "se", "ze", "so", "zo", "ta", "da", "chi", "ji", "", "tsu", "zu", "te", "de", "to", "do", "na", "ni", "nu", "ne", "no", "ha", "ba", "pa", "hi", "bi",
    "pi", "fu", "bu", "pu", "he", "be", "pe", "ho", "bo", "po", "ma", "mi", "mu", "me", "mo", "ya", "ya", "yu", "yu", "yo", "yo", "ra", "ri", "ru", "re",
    "ro", "wa", "wa", "i", "e", "o", "n", "vu", "ka", "ke",
];

fn kana(s: &str) -> String {
    let mut out = String::new();
    let mut double = false;
    for c in s.chars() {
        let h = if ('\u{30A1}'..='\u{30F6}').contains(&c) { char::from_u32(c as u32 - 0x60).unwrap_or(c) } else { c };
        let ends_in_syllable = |out: &String| out.len() >= 2 && !out[..out.len() - 1].ends_with(['a', 'e', 'i', 'o', 'u']);
        match h {
            'っ' => double = true,
            'ー' => {
                if let Some(v) = out.chars().rev().find(|c| "aeiou".contains(*c)) {
                    out.push(v);
                }
            }
            // Small ya, yu, yo after an i syllable: kya, sha, cha, ja.
            'ゃ' | 'ゅ' | 'ょ' if out.ends_with('i') && ends_in_syllable(&out) => {
                out.pop();
                if !(out.ends_with("sh") || out.ends_with("ch") || out.ends_with('j')) {
                    out.push('y');
                }
                out.push_str(&KANA[h as usize - 0x3041][1..]);
            }
            // Small vowels replace the vowel before: fa, ti, she, va.
            'ぁ' | 'ぃ' | 'ぅ' | 'ぇ' | 'ぉ' if out.ends_with(['a', 'e', 'i', 'o', 'u']) && ends_in_syllable(&out) => {
                out.pop();
                out.push_str(KANA[h as usize - 0x3041]);
            }
            '\u{3041}'..='\u{3096}' => {
                let r = KANA[h as usize - 0x3041];
                if std::mem::take(&mut double) && !r.is_empty() {
                    out.push(if r.starts_with("ch") { 't' } else { r.as_bytes()[0] as char });
                }
                out.push_str(r);
            }
            _ => out.push(c),
        }
    }
    out
}

// Hangul, Revised Romanization. Shortcut: only linking (a final before a vowel moves over) and ㄹㄹ -> ll are applied, not
// nasalisation or aspiration across syllables; enough to read along, upgrade if users ask for strict spelling.
const INITIAL: [&str; 19] = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const MEDIAL: [&str; 21] = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
/// Per final: spelling at the end or before a consonant; before a vowel, the part that stays and the part that moves on.
const FINAL: [(&str, &str, &str); 28] = [
    ("", "", ""), ("k", "", "g"), ("k", "", "kk"), ("k", "k", "s"), ("n", "", "n"), ("n", "n", "j"), ("n", "n", ""), ("t", "", "d"),
    ("l", "", "r"), ("k", "l", "g"), ("m", "l", "m"), ("l", "l", "b"), ("l", "l", "s"), ("l", "l", "t"), ("p", "l", "p"), ("l", "l", ""),
    ("m", "", "m"), ("p", "", "b"), ("p", "p", "s"), ("t", "", "s"), ("t", "", "ss"), ("ng", "ng", ""), ("t", "", "j"), ("t", "", "ch"),
    ("k", "", "k"), ("t", "", "t"), ("p", "", "p"), ("t", "", ""),
];
const SILENT_INITIAL: usize = 11;
const RIEUL_INITIAL: usize = 5;
const RIEUL_FINAL: usize = 8;

fn hangul(syllables: &[char]) -> String {
    let parts: Vec<(usize, usize, usize)> = syllables
        .iter()
        .map(|c| {
            let n = *c as usize - 0xAC00;
            (n / 588, n % 588 / 28, n % 28)
        })
        .collect();
    let mut out = String::new();
    let mut carried: Option<&str> = None;
    for (k, &(i, m, f)) in parts.iter().enumerate() {
        out.push_str(carried.take().unwrap_or(INITIAL[i]));
        out.push_str(MEDIAL[m]);
        match parts.get(k + 1) {
            Some(&(next, _, _)) if next == SILENT_INITIAL && f != 0 => {
                out.push_str(FINAL[f].1);
                carried = Some(FINAL[f].2);
            }
            Some(&(next, _, _)) if next == RIEUL_INITIAL && f == RIEUL_FINAL => {
                out.push('l');
                carried = Some("l");
            }
            _ => out.push_str(FINAL[f].0),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn korean() {
        assert_eq!(romanize("안녕하세요", false, None), "annyeonghaseyo");
        assert_eq!(romanize("한국어 사랑해", false, None), "hangugeo saranghae");
        assert_eq!(romanize("몰라 닭이", false, None), "molla dalgi");
        assert_eq!(romanize("I love you", false, None), "");
    }

    #[test]
    fn chinese() {
        assert_eq!(romanize("我爱你", false, None), "wǒ ài nǐ");
        assert_eq!(romanize("你好, world", false, None), "nǐ hǎo , world");
    }

    #[test]
    fn kana_table() {
        assert_eq!(KANA.len(), 0x3096 - 0x3041 + 1);
        assert_eq!(kana("きょう"), "kyou");
        assert_eq!(kana("しゃしん"), "shashin");
        assert_eq!(kana("ちょっと"), "chotto");
        assert_eq!(kana("まっちゃ"), "matcha");
        assert_eq!(kana("ファイティング"), "faitingu");
        assert_eq!(kana("ラーメン"), "raamen");
        assert_eq!(kana("さよなら!"), "sayonara!");
    }

    #[test]
    fn japanese_with_and_without_the_dictionary() {
        let dict = JaDict::parse("二人\tふたり\n空\tそら\n夜\tよる\n分\tぶん\n~駆\tか\tけ\n~広\tひろ\tが\n~分\tわ\tか\n");
        assert_eq!(romanize("二人だけの空が広がる夜に", true, Some(&dict)), "futari dakeno sora ga hiro garu yoru ni");
        assert_eq!(romanize("夜に駆けて", true, Some(&dict)), "yoru ni ka kete");
        assert_eq!(romanize("分かった", true, Some(&dict)), "wa katta");
        assert_eq!(romanize("分の", true, Some(&dict)), "bun no");
        // Kana only: kanji stay as written.
        assert_eq!(romanize("夜に駆ける", true, None), "夜 ni 駆 keru");
        // A Han-only line of a Japanese song is still read as Japanese.
        assert_eq!(romanize("空", true, Some(&dict)), "sora");
    }

    #[test]
    fn table_from_jmdict() {
        let dict: Jmdict = serde_json::from_str(
            r#"{"words":[
              {"kanji":[{"text":"駆ける","common":true}],"kana":[{"text":"かける","common":true,"appliesToKanji":["*"]}]},
              {"kanji":[{"text":"二人","common":true}],"kana":[{"text":"ににん","common":false,"appliesToKanji":["*"]},{"text":"ふたり","common":true,"appliesToKanji":["*"]}]},
              {"kanji":[{"text":"空","common":false},{"text":"天","common":true}],"kana":[{"text":"そら","common":true,"appliesToKanji":["空"]},{"text":"てん","common":true,"appliesToKanji":["天"]}]}
            ]}"#,
        )
        .unwrap();
        let t = table(&dict);
        assert_eq!(t, "駆ける\tかける\n二人\tふたり\n天\tてん\n空\tそら\n~駆\tか\tけ\n");
        let d = JaDict::parse(&t);
        assert_eq!(d.lookup(&"駆けて".chars().collect::<Vec<_>>()), Some(("か".into(), 1)));
        assert_eq!(d.lookup(&"駆ける".chars().collect::<Vec<_>>()), Some(("かける".into(), 3)));
    }
}
