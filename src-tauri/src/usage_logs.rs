// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/LogReader.cs.
//! Token counts from the session logs Claude Code and the Codex CLI keep on this PC
//! (`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/*.jsonl` and `archived_sessions`).
//! Only the usage counters, model names and times are read, never message content.
//!
//! Logs only grow at the end, so each file remembers where its last complete line ended, a
//! hash of the 64 bytes before it (a rewrite that grew is read again from the start) and the
//! Codex parser's state. A refresh parses only what was written since, and the state lives
//! on disk too (usage-logs.json), so after a restart only appended bytes are read. Records
//! are deduplicated per file at parse time (streaming lines repeat a message id) and again
//! across files (forks copy history). The WebView gets aggregates: one bucket per model,
//! quarter hour and prompt band, so it can group by local day itself.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use super::{home, now_ms, parse_iso_ms};

/// Days of history kept. The model page offers up to 30 local days; one more covers time zones.
pub const SCAN_DAYS: u64 = 31;
const QUARTER: u64 = 15 * 60_000;
const DAY: u64 = 86_400_000;
const TAIL: u64 = 64;
/// Bumped when the disk format changes; another version is ignored and the logs read again.
const DISK_VERSION: u32 = 1;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Claude,
    Codex,
}

/// One request's usage as the parsers return it. Categories are disjoint: `input` excludes cache reads and writes.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub key: String,
    pub at: u64,
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cache_write_1h: u64,
}

/// The same, stored: time, model index (see `Models`), prompt band (0: up to 100K prompt tokens,
/// 1: up to 200K, 2: above), then input, output, cache read, cache write, one-hour cache write.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
struct Rec(u64, u32, u8, [u32; 5]);

impl Rec {
    fn total(&self) -> u64 {
        self.3.iter().map(|&n| u64::from(n)).sum()
    }
}

/// Model names, each stored once.
#[derive(Default)]
struct Models {
    list: Vec<String>,
    index: HashMap<String, u32>,
}

impl Models {
    fn intern(&mut self, name: &str) -> u32 {
        if let Some(&i) = self.index.get(name) {
            return i;
        }
        let i = self.list.len() as u32;
        self.list.push(name.to_string());
        self.index.insert(name.to_string(), i);
        i
    }
    fn from_list(list: Vec<String>) -> Self {
        let index = list.iter().enumerate().map(|(i, m)| (m.clone(), i as u32)).collect();
        Models { list, index }
    }
}

/// FNV-1a 64: stable across runs and Rust versions, unlike the std hasher, so keys survive on disk.
pub fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, &b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3))
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    /// Start of the quarter hour, Unix ms.
    pub at: u64,
    pub model: String,
    pub band: u8,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cache_write_1h: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolTokens {
    /// "claude" or "codex", the same ids as the quota cards.
    pub id: &'static str,
    /// The tool's log folder exists.
    pub found: bool,
    pub files: usize,
    /// Lines with usage that could not be read.
    pub unreadable: usize,
    pub buckets: Vec<Bucket>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenReport {
    /// Unix ms of the oldest data that can be in the report (a quarter-hour start).
    pub since: u64,
    pub tools: Vec<ToolTokens>,
}

/// Parser state per file.
#[derive(Default, Serialize, Deserialize)]
struct FileItem {
    len: u64,
    /// Unix ms.
    mtime: u64,
    /// End of the last complete line read.
    offset: u64,
    /// fnv of the 64 bytes before `offset`.
    tail: u64,
    errors: usize,
    /// Codex: model of the current turn, and the last cumulative totals seen.
    model: String,
    last_total: String,
    /// One record per message key (fnv of the key), the fullest one seen.
    recs: HashMap<u64, Rec>,
}

#[derive(Default)]
pub struct Cache {
    models: Models,
    /// By path.
    files: HashMap<String, FileItem>,
    loaded: bool,
    /// The last report and the window start it was made for.
    last: Option<TokenReport>,
}

#[derive(Serialize)]
struct DiskRef<'a> {
    v: u32,
    models: &'a [String],
    files: &'a HashMap<String, FileItem>,
}

#[derive(Deserialize)]
struct Disk {
    v: u32,
    models: Vec<String>,
    files: HashMap<String, FileItem>,
}

/// The report for the AI usage tool. `disk` is the cache file: read on the first call, written
/// (tmp + rename) after a scan that parsed new bytes.
pub fn report(cache: &mut Cache, disk: Option<&Path>) -> TokenReport {
    if !cache.loaded {
        cache.loaded = true;
        if let Some(path) = disk {
            load(cache, path);
        }
    }
    let home = home();
    let claude = [home.join(".claude").join("projects")];
    let codex = [home.join(".codex").join("sessions"), home.join(".codex").join("archived_sessions")];
    let (report, parsed) = scan(cache, &claude, &codex, now_ms());
    if parsed {
        if let Some(path) = disk {
            save(cache, path);
        }
    }
    report
}

fn load(cache: &mut Cache, path: &Path) {
    let Some(disk) = std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<Disk>(&b).ok()) else { return };
    if disk.v != DISK_VERSION {
        return;
    }
    cache.models = Models::from_list(disk.models);
    let count = cache.models.list.len() as u32;
    // A record pointing past the model list would be a broken file: drop that file's state.
    cache.files = disk.files.into_iter().filter(|(_, f)| f.recs.values().all(|r| r.1 < count)).collect();
}

fn save(cache: &Cache, path: &Path) {
    let Ok(bytes) = serde_json::to_vec(&DiskRef { v: DISK_VERSION, models: &cache.models.list, files: &cache.files }) else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, bytes).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// Reads what changed under the roots. Returns the report and whether new bytes were parsed.
fn scan(cache: &mut Cache, claude: &[PathBuf], codex: &[PathBuf], now: u64) -> (TokenReport, bool) {
    let since = now.saturating_sub(SCAN_DAYS * DAY);
    let since = since - since % QUARTER;
    let mut parsed = false;
    let mut changed = false;
    let mut visited = HashSet::new();
    let mut tools = Vec::new();
    for (tool, roots) in [(Tool::Claude, claude), (Tool::Codex, codex)] {
        let mut paths = Vec::new();
        let mut found = false;
        for root in roots {
            if root.is_dir() {
                found = true;
                walk(root, &mut paths);
            }
        }
        let mut keys = Vec::new();
        let mut unreadable = 0;
        for path in paths {
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            let mtime = meta.modified().ok().and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
            if mtime < since {
                continue;
            }
            let key = path.to_string_lossy().into_owned();
            visited.insert(key.clone());
            let item = cache.files.entry(key.clone()).or_default();
            let len = meta.len();
            if len != item.len || mtime != item.mtime {
                changed = true;
                match read_new(&path, tool, item, &mut cache.models, since) {
                    Ok(read) => {
                        parsed |= read;
                        item.len = len;
                        item.mtime = mtime;
                    }
                    Err(_) => {
                        cache.files.remove(&key);
                        unreadable += 1;
                        continue;
                    }
                }
            }
            unreadable += cache.files[&key].errors;
            keys.push(key);
        }
        tools.push((tool, found, keys, unreadable));
    }
    let before = cache.files.len();
    cache.files.retain(|k, _| visited.contains(k));
    if cache.files.len() != before {
        changed = true;
        parsed = true;
    }
    if let Some(last) = &cache.last {
        if !changed && last.since == since {
            return (last.clone(), parsed);
        }
    }
    let tools = tools
        .into_iter()
        .map(|(tool, found, keys, unreadable)| {
            // Forks copy history into a new file: keep each message once, the fullest copy.
            let mut best: HashMap<u64, Rec> = HashMap::new();
            for key in &keys {
                for (&k, &r) in &cache.files[key].recs {
                    if r.0 < since || r.total() == 0 {
                        continue;
                    }
                    let slot = best.entry(k).or_insert(r);
                    if r.total() > slot.total() {
                        *slot = r;
                    }
                }
            }
            let id = if tool == Tool::Claude { "claude" } else { "codex" };
            ToolTokens { id, found, files: keys.len(), unreadable, buckets: aggregate(best.into_values(), &cache.models.list) }
        })
        .collect();
    let report = TokenReport { since, tools };
    cache.last = Some(report.clone());
    (report, parsed)
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            walk(&path, out);
        } else if kind.is_file() && path.extension().is_some_and(|e| e == "jsonl") {
            out.push(path);
        }
    }
}

/// fnv of the up to 64 bytes before `offset`.
fn tail_hash(file: &mut File, offset: u64) -> std::io::Result<u64> {
    let start = offset.saturating_sub(TAIL);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0; (offset - start) as usize];
    file.read_exact(&mut buf)?;
    Ok(fnv(&buf))
}

/// Reads complete lines after the remembered offset; a line still being written waits for the
/// next refresh. A file that shrank below the offset, or whose bytes before it changed, is read
/// from the start. Returns whether anything was parsed.
fn read_new(path: &Path, tool: Tool, item: &mut FileItem, models: &mut Models, since: u64) -> std::io::Result<bool> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let mut reset = false;
    if item.offset > 0 && (len < item.offset || tail_hash(&mut file, item.offset)? != item.tail) {
        *item = FileItem::default();
        reset = true;
    }
    file.seek(SeekFrom::Start(item.offset))?;
    let start = item.offset;
    // shortcut: a single line is read whole however long it is (the longest seen is 1.4 MB), fine for logs of this size.
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        if n == 0 || line.last() != Some(&b'\n') {
            break;
        }
        item.offset += n as u64;
        parse_line(&line, tool, item, models, since);
    }
    if item.offset != start {
        item.tail = tail_hash(reader.get_mut(), item.offset)?;
    }
    Ok(reset || item.offset != start)
}

fn parse_line(bytes: &[u8], tool: Tool, item: &mut FileItem, models: &mut Models, since: u64) {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let Ok(line) = std::str::from_utf8(bytes) else { return };
    let result = match tool {
        Tool::Claude => {
            if !line.contains("\"usage\"") || !line.contains("\"assistant\"") {
                return;
            }
            parse_claude(line)
        }
        Tool::Codex => {
            if !line.contains("\"token_count\"") && !line.contains("\"turn_context\"") {
                return;
            }
            parse_codex(line, &mut item.model, &mut item.last_total)
        }
    };
    match result {
        Ok(Some(e)) if e.at >= since => {
            let small = |n: u64| u32::try_from(n).unwrap_or(u32::MAX);
            let prompt = e.input + e.cache_read + e.cache_write + e.cache_write_1h;
            let band = if prompt <= 100_000 { 0 } else if prompt <= 200_000 { 1 } else { 2 };
            let rec = Rec(e.at, models.intern(&e.model), band, [small(e.input), small(e.output), small(e.cache_read), small(e.cache_write), small(e.cache_write_1h)]);
            // Streaming Claude lines repeat a message id with growing usage: keep the fullest.
            let slot = item.recs.entry(fnv(e.key.as_bytes())).or_insert(rec);
            if rec.total() > slot.total() {
                *slot = rec;
            }
        }
        Ok(_) => {}
        Err(()) => item.errors += 1,
    }
}

#[derive(Deserialize)]
struct ClaudeLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    uuid: Option<String>,
    message: Option<ClaudeMessage>,
}

#[derive(Deserialize)]
struct ClaudeMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<ClaudeUsage>,
}

#[derive(Deserialize)]
struct ClaudeUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_creation: Option<CacheCreation>,
}

#[derive(Deserialize)]
struct CacheCreation {
    ephemeral_1h_input_tokens: Option<u64>,
}

/// One Claude Code line → its usage, if it is an assistant message with usage. Err = unreadable.
pub fn parse_claude(line: &str) -> Result<Option<Entry>, ()> {
    let l: ClaudeLine = serde_json::from_str(line).map_err(|_| ())?;
    if l.kind.as_deref() != Some("assistant") {
        return Ok(None);
    }
    let (Some(at), Some(message)) = (l.timestamp.as_deref().and_then(parse_iso_ms), l.message) else { return Ok(None) };
    let Some(u) = message.usage else { return Ok(None) };
    let creation = u.cache_creation_input_tokens.unwrap_or(0);
    let hour = u.cache_creation.and_then(|c| c.ephemeral_1h_input_tokens).unwrap_or(0).min(creation);
    let id = message.id.filter(|s| !s.is_empty()).or(l.uuid).unwrap_or_else(|| format!("{at}"));
    Ok(Some(Entry {
        key: format!("claude:{id}"),
        at,
        model: message.model.filter(|m| !m.is_empty()).unwrap_or_else(|| "unknown".into()),
        input: u.input_tokens.unwrap_or(0),
        output: u.output_tokens.unwrap_or(0),
        cache_read: u.cache_read_input_tokens.unwrap_or(0),
        cache_write: creation - hour,
        cache_write_1h: hour,
    }))
}

#[derive(Deserialize)]
struct CodexLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    payload: Option<CodexPayload>,
}

#[derive(Deserialize)]
struct CodexPayload {
    #[serde(rename = "type")]
    kind: Option<String>,
    model: Option<String>,
    info: Option<CodexInfo>,
}

#[derive(Deserialize)]
struct CodexInfo {
    total_token_usage: Option<CodexUsage>,
    last_token_usage: Option<CodexUsage>,
}

#[derive(Deserialize)]
struct CodexUsage {
    input_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

/// One Codex line. `turn_context` sets the model for the token counts that follow; a
/// `token_count` whose cumulative totals equal the previous one is a repeat and skipped.
pub fn parse_codex(line: &str, model: &mut String, last_total: &mut String) -> Result<Option<Entry>, ()> {
    let l: CodexLine = serde_json::from_str(line).map_err(|_| ())?;
    let Some(payload) = l.payload else { return Ok(None) };
    match l.kind.as_deref() {
        Some("turn_context") => {
            if let Some(m) = payload.model.filter(|m| !m.is_empty()) {
                *model = m;
            }
            return Ok(None);
        }
        Some("event_msg") if payload.kind.as_deref() == Some("token_count") => {}
        _ => return Ok(None),
    }
    let Some(at) = l.timestamp.as_deref().and_then(parse_iso_ms) else { return Ok(None) };
    let Some(info) = payload.info else { return Ok(None) };
    let identity = info.total_token_usage.as_ref().map(|t| {
        format!("{}:{}:{}:{}", t.input_tokens.unwrap_or(0), t.cached_input_tokens.unwrap_or(0), t.output_tokens.unwrap_or(0), t.total_tokens.unwrap_or(0))
    });
    if let Some(id) = &identity {
        if id == last_total {
            return Ok(None);
        }
        last_total.clone_from(id);
    }
    let Some(u) = info.last_token_usage else { return Ok(None) };
    let input = u.input_tokens.unwrap_or(0);
    let cached = u.cached_input_tokens.unwrap_or(0).min(input);
    let output = u.output_tokens.unwrap_or(0);
    Ok(Some(Entry {
        // Time + cumulative totals tell a fork's copied history apart from new turns.
        key: format!("codex:{at}:{}:{input}:{cached}:{output}", identity.unwrap_or_default()),
        at,
        model: if model.is_empty() { "unknown".into() } else { model.clone() },
        input: input - cached,
        output,
        cache_read: cached,
        cache_write: 0,
        cache_write_1h: 0,
    }))
}

/// Sums records per quarter hour, model and prompt band, oldest first.
fn aggregate(recs: impl IntoIterator<Item = Rec>, models: &[String]) -> Vec<Bucket> {
    let mut map: HashMap<(u64, u32, u8), [u64; 5]> = HashMap::new();
    for Rec(at, model, band, n) in recs {
        let sums = map.entry((at - at % QUARTER, model, band)).or_default();
        for (s, v) in sums.iter_mut().zip(n) {
            *s += u64::from(v);
        }
    }
    let mut out: Vec<Bucket> = map
        .into_iter()
        .map(|((at, model, band), [input, output, cache_read, cache_write, cache_write_1h])| Bucket {
            at,
            model: models.get(model as usize).cloned().unwrap_or_else(|| "unknown".into()),
            band,
            input,
            output,
            cache_read,
            cache_write,
            cache_write_1h,
        })
        .collect();
    out.sort_by(|a, b| (a.at, &a.model, a.band).cmp(&(b.at, &b.model, b.band)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE: &str = include_str!("../fixtures/usage/claude-code.jsonl");
    const CODEX: &str = include_str!("../fixtures/usage/codex.jsonl");

    fn run(text: &str, tool: Tool) -> (FileItem, Models) {
        let (mut item, mut models) = (FileItem::default(), Models::default());
        for line in text.split_inclusive('\n') {
            parse_line(line.as_bytes(), tool, &mut item, &mut models, 0);
        }
        (item, models)
    }

    fn sorted(item: &FileItem, models: &Models) -> Vec<(String, u8, [u32; 5])> {
        let mut v: Vec<_> = item.recs.values().map(|r| (models.list[r.1 as usize].clone(), r.2, r.3)).collect();
        v.sort();
        v
    }

    #[test]
    fn claude_fixture() {
        let (item, models) = run(CLAUDE, Tool::Claude);
        // A user line, a summary and a line without usage are ignored; one broken line is counted.
        assert_eq!(item.errors, 1);
        // msg_a streams twice: kept once with its fuller usage. Haiku's 150K prompt is band 1.
        assert_eq!(
            sorted(&item, &models),
            [
                ("claude-haiku-5-5".to_string(), 1, [150_000, 10, 0, 0, 0]),
                ("claude-opus-5-5".to_string(), 0, [10, 120, 0, 0, 0]),
                ("claude-sonnet-5-5".to_string(), 0, [3, 40, 2000, 300, 700]),
            ]
        );
        assert_eq!(models.list.len(), 3);
    }

    #[test]
    fn codex_fixture() {
        let (item, models) = run(CODEX, Tool::Codex);
        assert_eq!(item.errors, 0);
        // The second token_count repeats the first one's totals and is skipped; the model follows turn_context.
        assert_eq!(sorted(&item, &models), [("gpt-5-codex".to_string(), 0, [800, 50, 200, 0, 0]), ("gpt-5.1-codex-mini".to_string(), 0, [100, 20, 900, 0, 0])]);
    }

    #[test]
    fn buckets() {
        let (item, models) = run(CLAUDE, Tool::Claude);
        let buckets = aggregate(item.recs.into_values(), &models.list);
        let got: Vec<_> = buckets.iter().map(|b| (b.at % QUARTER, b.model.as_str(), b.band, b.output)).collect();
        assert_eq!(got, [(0, "claude-haiku-5-5", 1, 10), (0, "claude-opus-5-5", 0, 120), (0, "claude-sonnet-5-5", 0, 40)]);
    }

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn temp(name: &str) -> Dir {
        let dir = std::env::temp_dir().join(format!("notnotch-usage-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Dir(dir)
    }

    /// An assistant line with usage, at a given time.
    fn line(id: &str, at: &str, output: u64) -> String {
        format!(r#"{{"type":"assistant","timestamp":"{at}","message":{{"id":"{id}","model":"claude-opus-5-5","usage":{{"input_tokens":1,"output_tokens":{output}}}}}}}"#) + "\n"
    }

    #[test]
    fn partial_last_line_waits() {
        let dir = temp("partial");
        let path = dir.0.join("s.jsonl");
        let full = line("msg_b", "2026-10-30T09:00:00Z", 5);
        std::fs::write(&path, format!("{full}{}", &full[..40])).unwrap();
        let (mut item, mut models) = (FileItem::default(), Models::default());
        assert!(read_new(&path, Tool::Claude, &mut item, &mut models, 0).unwrap());
        assert_eq!(item.recs.len(), 1);
        assert_eq!(item.offset as usize, full.len());
        // The rest of the line arrives: only the new line is parsed.
        std::fs::write(&path, format!("{full}{}", line("msg_z", "2026-10-30T09:01:00Z", 6))).unwrap();
        assert!(read_new(&path, Tool::Claude, &mut item, &mut models, 0).unwrap());
        assert_eq!(item.recs.len(), 2);
        // Nothing new: nothing parsed.
        assert!(!read_new(&path, Tool::Claude, &mut item, &mut models, 0).unwrap());
    }

    fn outputs(r: &TokenReport) -> u64 {
        r.tools[0].buckets.iter().map(|b| b.output).sum()
    }

    #[test]
    fn scan_dedup_window_reset_and_disk() {
        let dir = temp("scan");
        let (root, codex) = (dir.0.join("projects"), dir.0.join("none"));
        std::fs::create_dir_all(root.join("p")).unwrap();
        let now = parse_iso_ms("2026-10-31T12:00:00Z").unwrap();
        let recent = "2026-10-30T09:00:00Z";
        let a = root.join("p").join("a.jsonl");
        let b = root.join("p").join("b.jsonl");
        let old = root.join("old.jsonl");
        // b is a fork of a: msg_1 copied, plus its own msg_3. One line older than the window.
        std::fs::write(&a, line("msg_1", recent, 10) + &line("msg_2", recent, 20) + &line("msg_0", "2026-09-01T00:00:00Z", 1000)).unwrap();
        std::fs::write(&b, line("msg_1", recent, 10) + &line("msg_3", recent, 30)).unwrap();
        // A file not written for 40 days is not read at all.
        std::fs::write(&old, line("msg_9", recent, 5000)).unwrap();
        File::options().write(true).open(&old).unwrap().set_modified(UNIX_EPOCH + std::time::Duration::from_millis(now - 40 * DAY)).unwrap();
        let mut cache = Cache::default();
        let (r, parsed) = scan(&mut cache, std::slice::from_ref(&root), std::slice::from_ref(&codex), now);
        assert!(parsed);
        // msg_1 once, msg_0 before the window left out, the old file skipped.
        assert_eq!(outputs(&r), 60);
        assert_eq!(r.tools[0].files, 2);
        assert!(!r.tools[1].found);
        assert_eq!(r.since % QUARTER, 0);
        // Unchanged: the same report, nothing parsed.
        assert_eq!(scan(&mut cache, std::slice::from_ref(&root), std::slice::from_ref(&codex), now), (r.clone(), false));

        // Disk round trip: a fresh cache from the file reports the same without parsing.
        let disk = dir.0.join("usage-logs.json");
        save(&cache, &disk);
        let mut fresh = Cache::default();
        load(&mut fresh, &disk);
        assert_eq!(fresh.files.len(), 2);
        assert_eq!(scan(&mut fresh, std::slice::from_ref(&root), std::slice::from_ref(&codex), now), (r.clone(), false));

        // b rewritten with other content of the same length: tail hash differs, read from the start.
        std::fs::write(&b, line("msg_1", recent, 10) + &line("msg_4", recent, 40)).unwrap();
        File::options().write(true).open(&b).unwrap().set_modified(UNIX_EPOCH + std::time::Duration::from_millis(now + 1000)).unwrap();
        let (r2, parsed) = scan(&mut fresh, std::slice::from_ref(&root), std::slice::from_ref(&codex), now);
        assert!(parsed);
        assert_eq!(outputs(&r2), 70);
        // b shrinks: read again from 0.
        std::fs::write(&b, line("msg_5", recent, 7)).unwrap();
        let (r3, _) = scan(&mut fresh, std::slice::from_ref(&root), std::slice::from_ref(&codex), now);
        assert_eq!(outputs(&r3), 37);
        // b deleted: dropped from the cache and the report.
        std::fs::remove_file(&b).unwrap();
        let (r4, _) = scan(&mut fresh, std::slice::from_ref(&root), std::slice::from_ref(&codex), now);
        assert_eq!((outputs(&r4), r4.tools[0].files, fresh.files.len()), (30, 1, 1));
    }

    /// Timing on this PC's real logs (read only; the cache goes to a temp file):
    /// `cargo test --lib real_logs -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_logs() {
        let dir = temp("real");
        let disk = dir.0.join("usage-logs.json");
        let t = std::time::Instant::now();
        let mut cache = Cache::default();
        let r = report(&mut cache, Some(&disk));
        let first = t.elapsed();
        let recs: usize = cache.files.values().map(|f| f.recs.len()).sum();
        let buckets: usize = r.tools.iter().map(|x| x.buckets.len()).sum();
        let t = std::time::Instant::now();
        let again = report(&mut cache, Some(&disk));
        let warm = t.elapsed();
        let t = std::time::Instant::now();
        let mut fresh = Cache::default();
        let restarted = report(&mut fresh, Some(&disk));
        let restart = t.elapsed();
        println!(
            "files {} recs {recs} models {} buckets {buckets} | first {first:?}, warm {warm:?}, after restart {restart:?} | disk {} KB",
            cache.files.len(),
            cache.models.list.len(),
            std::fs::metadata(&disk).map(|m| m.len() / 1024).unwrap_or(0)
        );
        assert_eq!(r.tools.len(), again.tools.len());
        assert_eq!(r.tools[0].buckets.len(), restarted.tools[0].buckets.len());
    }
}
