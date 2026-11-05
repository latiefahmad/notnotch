//! The notnotch-notify protocol, shared by the app (notices.rs) and the notnotch-notify binary (src/bin/notnotch-notify.rs).
//! One JSON object per line, at most MAX_FRAME bytes; the server answers with one reply line.
//! Each side uses only part of this file.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

pub const MAX_FRAME: usize = 64 * 1024;
pub const MAX_TITLE: usize = 256;
pub const MAX_BODY: usize = 4000;
pub const MAX_FIELD: usize = 128;
pub const RATE_MAX: usize = 200;
pub const RATE_WINDOW_MS: u64 = 10_000;
/// Custom closed-row parts (`notnotch-notify part`): text length, id length and the longest time one stays.
pub const MAX_PART_TEXT: usize = 48;
pub const MAX_PART_ID: usize = 32;
pub const MAX_PART_TTL: u64 = 24 * 60 * 60;
/// `notnotch-notify ask`: buttons per question and the longest wait for an answer, in seconds.
pub const MAX_ASK_OPTIONS: usize = 4;
pub const MAX_ASK_TIMEOUT: u64 = 600;

/// Icons a custom part or a plugin may name; drawn from NotNotch's own set (src/features/plugins/icons.tsx), never loaded from outside.
pub const ICONS: &[&str] = &[
    "puzzle", "star", "heart", "bell", "clock", "timer", "calendar", "cloud", "sun", "moon", "chart", "code", "terminal", "music", "book",
    "quote", "globe", "rocket", "lightning", "check", "warning", "flag", "fire", "coffee", "game", "build", "bug", "branch", "download",
    "upload", "cpu", "battery", "wifi", "money", "cart", "mail", "chat", "user", "home", "leaf",
];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Who sent it ("Build", "Tests"); shown as the app name and used for the per-app rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// A later notice with the same source and key replaces the earlier one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace: Option<String>,
    /// 0 to 100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    /// `notnotch-notify run`: the frontend words the result itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// `notnotch-notify part`: sets or clears a custom closed-row part instead of sending a notice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part: Option<Part>,
    /// `notnotch-notify ask`: a question with buttons; the reply waits for the user's choice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask: Option<Ask>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Ask {
    /// Option ids in button order, each one of [a-z0-9-].
    pub options: Vec<String>,
    /// Seconds NotNotch keeps the question before answering "no choice".
    pub timeout: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// One of ICONS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// 0 to 100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    /// A tool id (`timer`) or a plugin's (`plugin:hello-notnotch`) the notch opens on when the part is clicked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open: Option<String>,
    /// Seconds until the part goes by itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<u64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub clear: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reply {
    /// accepted | rejected | limited | off, and for an ask answered | unanswered
    pub result: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The option id the user picked (`answered`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice: Option<String>,
}

impl Reply {
    pub fn new(result: &str, reason: Option<&str>) -> Self {
        Reply { result: result.into(), reason: reason.map(Into::into), choice: None }
    }
}

/// An option id: 1 to MAX_FIELD of a-z, 0-9 and -.
pub fn option_ok(id: &str) -> bool {
    (1..=MAX_FIELD).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn check_ask(a: &Ask) -> Result<(), &'static str> {
    let unique = a.options.iter().enumerate().all(|(i, o)| !a.options[..i].contains(o));
    if !(1..=MAX_ASK_OPTIONS).contains(&a.options.len()) || !unique || !a.options.iter().all(|o| option_ok(o)) {
        return Err("ask-options");
    }
    if !(1..=MAX_ASK_TIMEOUT).contains(&a.timeout) {
        return Err("ask-timeout");
    }
    Ok(())
}

/// The request as one line, or None when it would not fit in a frame.
pub fn encode<T: Serialize>(value: &T) -> Option<Vec<u8>> {
    let mut line = serde_json::to_vec(value).ok()?;
    line.push(b'\n');
    (line.len() <= MAX_FRAME).then_some(line)
}

#[derive(Debug, PartialEq)]
pub enum Frame {
    /// No newline yet and still within the bound: read more.
    Incomplete,
    /// The line without its newline.
    Line(Vec<u8>),
    /// Over MAX_FRAME without a newline: the connection is dropped.
    TooLong,
}

/// Takes the first line out of what was read so far.
pub fn take_line(buf: &[u8]) -> Frame {
    match buf.iter().position(|&b| b == b'\n') {
        Some(i) if i < MAX_FRAME => Frame::Line(buf[..i].to_vec()),
        Some(_) => Frame::TooLong,
        None if buf.len() >= MAX_FRAME => Frame::TooLong,
        None => Frame::Incomplete,
    }
}

/// Parses and checks one line. Texts are trimmed and cut to their limits; control characters other than newline and
/// tab are removed (they could reorder or hide text in the notch).
pub fn parse(line: &[u8]) -> Result<Request, &'static str> {
    let mut r: Request = serde_json::from_slice(line).map_err(|_| "invalid-json")?;
    r.title = clean(r.title, MAX_TITLE, false);
    r.body = clean(r.body, MAX_BODY, true);
    r.source = clean(r.source, MAX_FIELD, false);
    r.command = clean(r.command, MAX_FIELD, false);
    r.replace = clean(r.replace, MAX_FIELD, false);
    if let Some(part) = r.part.take() {
        r.part = Some(check_part(part)?);
        return Ok(r);
    }
    if let Some(a) = &r.ask {
        check_ask(a)?;
    }
    if r.title.is_none() && r.body.is_none() && r.command.is_none() {
        return Err("empty");
    }
    if let Some(p) = r.progress {
        if !p.is_finite() || !(0.0..=100.0).contains(&p) {
            return Err("progress");
        }
    }
    Ok(r)
}

fn check_part(mut p: Part) -> Result<Part, &'static str> {
    let id_ok = (1..=MAX_PART_ID).contains(&p.id.len()) && p.id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
    if !id_ok {
        return Err("part-id");
    }
    if p.clear {
        return Ok(Part { id: p.id, clear: true, ..Default::default() });
    }
    p.text = clean(p.text, MAX_PART_TEXT, false);
    if p.icon.as_deref().is_some_and(|i| !ICONS.contains(&i)) {
        return Err("part-icon");
    }
    if p.progress.is_some_and(|v| !v.is_finite() || !(0.0..=100.0).contains(&v)) {
        return Err("progress");
    }
    let open_ok = |o: &str| (1..=48).contains(&o.len()) && o.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b':');
    if p.open.as_deref().is_some_and(|o| !open_ok(o)) {
        return Err("part-open");
    }
    if p.ttl.is_some_and(|t| !(1..=MAX_PART_TTL).contains(&t)) {
        return Err("part-ttl");
    }
    if p.text.is_none() && p.progress.is_none() {
        return Err("part-empty");
    }
    Ok(p)
}

pub fn clean(text: Option<String>, max: usize, multiline: bool) -> Option<String> {
    let kept: String = text?
        .chars()
        .map(|c| if c == '\t' || (c == '\n' && !multiline) { ' ' } else { c })
        .filter(|&c| c == '\n' || !c.is_control())
        .filter(|&c| !matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'))
        .collect();
    let trimmed = kept.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(max).collect())
}

/// At most RATE_MAX notices in any RATE_WINDOW_MS, across all senders.
pub struct RateLimiter {
    times: std::collections::VecDeque<u64>,
}

impl RateLimiter {
    pub fn new() -> Self {
        RateLimiter { times: Default::default() }
    }

    /// Counts the notice when it may pass.
    pub fn allow(&mut self, now_ms: u64) -> bool {
        while self.times.front().is_some_and(|&t| now_ms.saturating_sub(t) >= RATE_WINDOW_MS) {
            self.times.pop_front();
        }
        if self.times.len() >= RATE_MAX {
            return false;
        }
        self.times.push_back(now_ms);
        true
    }
}

/// Per logon session and per user: another account's senders cannot reach this NotNotch, and two sessions do not collide.
pub fn pipe_name(session: u32, sid: &str) -> String {
    format!(r"\\.\pipe\notnotch-notify-{session}-{sid}")
}

/// The current user's SID ("S-1-5-21-…") and logon session id.
#[cfg(windows)]
pub fn identity() -> Option<(u32, String)> {
    use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId};
    unsafe {
        let mut session = 0u32;
        ProcessIdToSessionId(GetCurrentProcessId(), &mut session).ok()?;
        Some((session, process_token(GetCurrentProcess())?.0))
    }
}

/// This process's user SID and integrity level (0x2000 medium, 0x3000 high, 0x1000 low).
#[cfg(windows)]
pub fn own_token() -> Option<(String, u32)> {
    unsafe { process_token(windows::Win32::System::Threading::GetCurrentProcess()) }
}

/// Another process's user SID and integrity level, or None when it cannot be opened (another user's process usually
/// cannot).
#[cfg(windows)]
pub fn pid_token(pid: u32) -> Option<(String, u32)> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let token = process_token(process);
        let _ = CloseHandle(process);
        token
    }
}

#[cfg(windows)]
unsafe fn process_token(process: windows::Win32::Foundation::HANDLE) -> Option<(String, u32)> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TokenUser, TOKEN_INFORMATION_CLASS,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::System::Threading::OpenProcessToken;
    let info = |token: HANDLE, class: TOKEN_INFORMATION_CLASS| -> Option<Vec<u64>> {
        let mut size = 0u32;
        let _ = unsafe { GetTokenInformation(token, class, None, 0, &mut size) };
        // u64 keeps the buffer aligned for the structures read from it.
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        unsafe { GetTokenInformation(token, class, Some(buf.as_mut_ptr().cast()), size, &mut size) }.ok()?;
        Some(buf)
    };
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let user = info(token, TokenUser);
        let label = info(token, TokenIntegrityLevel);
        let _ = CloseHandle(token);
        let (user, label) = (user?, label?);
        let user = &*(user.as_ptr() as *const TOKEN_USER);
        let mut text = windows::core::PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text).ok()?;
        let sid = text.to_string().ok();
        let _ = LocalFree(Some(HLOCAL(text.0.cast())));
        let label = &*(label.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let count = *GetSidSubAuthorityCount(label.Label.Sid);
        let level = *GetSidSubAuthority(label.Label.Sid, u32::from(count).checked_sub(1)?);
        Some((sid?, level))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing() {
        assert_eq!(take_line(b"{\"a\":1}"), Frame::Incomplete);
        assert_eq!(take_line(b"{}\nrest"), Frame::Line(b"{}".to_vec()));
        assert_eq!(take_line(&vec![b'x'; MAX_FRAME]), Frame::TooLong);
        let mut long = vec![b'x'; MAX_FRAME];
        long.push(b'\n');
        assert_eq!(take_line(&long), Frame::TooLong);
        let mut fits = vec![b'x'; MAX_FRAME - 1];
        fits.push(b'\n');
        assert!(matches!(take_line(&fits), Frame::Line(l) if l.len() == MAX_FRAME - 1));
    }

    #[test]
    fn round_trip() {
        let r = Request { title: Some("Build".into()), progress: Some(40.0), replace: Some("b".into()), ..Default::default() };
        let line = encode(&r).unwrap();
        assert_eq!(*line.last().unwrap(), b'\n');
        assert_eq!(parse(&line[..line.len() - 1]).unwrap(), r);
        let huge = Request { body: Some("x".repeat(MAX_FRAME)), ..Default::default() };
        assert!(encode(&huge).is_none());
    }

    #[test]
    fn validation() {
        assert_eq!(parse(b"nope"), Err("invalid-json"));
        assert_eq!(parse(b"{}"), Err("empty"));
        assert_eq!(parse(br#"{"title":"   "}"#), Err("empty"));
        assert_eq!(parse(br#"{"title":"a","progress":101}"#), Err("progress"));
        assert_eq!(parse(br#"{"title":"a","progress":-1}"#), Err("progress"));
        assert!(parse(br#"{"command":"cargo test","exitCode":0,"durationMs":5}"#).is_ok());
        // Unknown fields are ignored, so a newer notnotch-notify still talks to an older NotNotch.
        assert!(parse(br#"{"title":"a","later":true}"#).is_ok());
        let r = parse(format!(r#"{{"title":" {} ","body":"a\u0007b\nc\u202e"}}"#, "t".repeat(300)).as_bytes()).unwrap();
        assert_eq!(r.title.unwrap().chars().count(), MAX_TITLE);
        assert_eq!(r.body.unwrap(), "ab\nc");
        assert_eq!(parse(br#"{"title":"a\nb"}"#).unwrap().title.unwrap(), "a b");
    }

    #[test]
    fn parts() {
        let r = parse(br#"{"part":{"id":"build","text":" Compiling ","icon":"build","progress":40,"open":"plugin:hello-notnotch","ttl":60}}"#).unwrap();
        let p = r.part.unwrap();
        assert_eq!((p.text.as_deref(), p.icon.as_deref(), p.progress, p.open.as_deref(), p.ttl), (Some("Compiling"), Some("build"), Some(40.0), Some("plugin:hello-notnotch"), Some(60)));
        // A part needs no title.
        assert!(parse(br#"{"part":{"id":"a","progress":0}}"#).is_ok());
        assert_eq!(parse(br#"{"part":{"id":"a"}}"#), Err("part-empty"));
        assert_eq!(parse(br#"{"part":{"id":"a","text":"   "}}"#), Err("part-empty"));
        assert_eq!(parse(br#"{"part":{"id":"","text":"x"}}"#), Err("part-id"));
        assert_eq!(parse(br#"{"part":{"id":"A b","text":"x"}}"#), Err("part-id"));
        assert_eq!(parse(format!(r#"{{"part":{{"id":"{}","text":"x"}}}}"#, "a".repeat(MAX_PART_ID + 1)).as_bytes()), Err("part-id"));
        assert_eq!(parse(br#"{"part":{"id":"a","text":"x","icon":"https://evil.example/x.png"}}"#), Err("part-icon"));
        assert_eq!(parse(br#"{"part":{"id":"a","text":"x","progress":101}}"#), Err("progress"));
        assert_eq!(parse(br#"{"part":{"id":"a","text":"x","open":"../settings"}}"#), Err("part-open"));
        assert_eq!(parse(br#"{"part":{"id":"a","text":"x","ttl":0}}"#), Err("part-ttl"));
        assert_eq!(parse(br#"{"part":{"id":"a","text":"x","ttl":86401}}"#), Err("part-ttl"));
        let text = format!("{}{}", '\u{202e}', "x".repeat(100));
        let long = parse(&serde_json::to_vec(&serde_json::json!({ "part": { "id": "a", "text": text } })).unwrap()).unwrap();
        assert_eq!(long.part.unwrap().text.unwrap().chars().count(), MAX_PART_TEXT);
        // Clearing ignores (and drops) everything else, even values that would be refused.
        let c = parse(br#"{"part":{"id":"a","clear":true,"icon":"nope","ttl":0}}"#).unwrap().part.unwrap();
        assert_eq!(c, Part { id: "a".into(), clear: true, ..Default::default() });
        let req = Request { part: Some(Part { id: "x".into(), text: Some("y".into()), ..Default::default() }), ..Default::default() };
        let line = encode(&req).unwrap();
        assert_eq!(parse(&line[..line.len() - 1]).unwrap(), req);
    }

    #[test]
    fn asks() {
        let r = parse(br#"{"title":"Bash","body":"cargo test","ask":{"options":["allow","always","deny"],"timeout":120}}"#).unwrap();
        assert_eq!(r.ask.unwrap(), Ask { options: vec!["allow".into(), "always".into(), "deny".into()], timeout: 120 });
        let ask = |options: &str, timeout: u64| parse(format!(r#"{{"title":"t","ask":{{"options":{options},"timeout":{timeout}}}}}"#).as_bytes());
        assert!(ask(r#"["yes-2"]"#, 600).is_ok());
        assert_eq!(ask("[]", 10), Err("ask-options"));
        assert_eq!(ask(r#"["a","b","c","d","e"]"#, 10), Err("ask-options"));
        assert_eq!(ask(r#"["a","a"]"#, 10), Err("ask-options"));
        assert_eq!(ask(r#"["Allow"]"#, 10), Err("ask-options"));
        assert_eq!(ask(r#"["a b"]"#, 10), Err("ask-options"));
        assert_eq!(ask(&format!(r#"["{}"]"#, "a".repeat(MAX_FIELD + 1)), 10), Err("ask-options"));
        assert_eq!(ask(r#"["a"]"#, 0), Err("ask-timeout"));
        assert_eq!(ask(r#"["a"]"#, 601), Err("ask-timeout"));
        // A question needs words.
        assert_eq!(parse(br#"{"ask":{"options":["a"],"timeout":5}}"#), Err("empty"));
        assert!(option_ok("always-allow") && !option_ok("") && !option_ok("é"));
        let reply: Reply = serde_json::from_str(r#"{"result":"answered","choice":"deny"}"#).unwrap();
        assert_eq!(reply.choice.as_deref(), Some("deny"));
    }

    #[test]
    fn rate_limit() {
        let mut r = RateLimiter::new();
        for i in 0..RATE_MAX as u64 {
            assert!(r.allow(i));
        }
        assert!(!r.allow(500));
        assert!(!r.allow(RATE_WINDOW_MS - 1));
        // The first one leaves the window: one more fits.
        assert!(r.allow(RATE_WINDOW_MS));
        assert!(!r.allow(RATE_WINDOW_MS));
        assert!(r.allow(RATE_WINDOW_MS * 3));
    }

    #[test]
    fn pipe() {
        assert_eq!(pipe_name(1, "S-1-5-21-1"), r"\\.\pipe\notnotch-notify-1-S-1-5-21-1");
    }
}
