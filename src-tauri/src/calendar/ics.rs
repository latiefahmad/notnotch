//! iCalendar (RFC 5545) reading: content lines, components, dates in their time zones, and the events of a window with
//! recurrences expanded (RRULE, RDATE, EXDATE, and instances moved or cancelled by RECURRENCE-ID).
//! A TZID is an IANA name, a Windows name (Outlook), a name ending in an IANA name ("/mozilla.org/…/Europe/Berlin"),
//! or one defined by a VTIMEZONE in the same file; anything else, and floating times, are read in the PC's zone.

use std::collections::{HashMap, HashSet};

use jiff::civil::{Date, DateTime, Time};
use jiff::tz::{Offset, TimeZone};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};

use super::recur;
use super::windows_zones::WINDOWS_TO_IANA;

/// Events kept per calendar and occurrences per series, so a huge or broken file stays small.
const MAX_EVENTS: usize = 3000;
const MAX_OCCURRENCES: usize = 500;
/// Characters kept of the text fields, which every instance of a series repeats in the result and the cache file.
/// Teams, Zoom and Meet invitations put their link within the first few thousand characters of the description.
const MAX_LOCATION: usize = 500;
const MAX_URL: usize = 2000;
const MAX_DESCRIPTION: usize = 4000;

#[derive(Debug)]
pub struct Prop {
    pub name: String,
    pub params: Vec<(String, String)>,
    pub value: String,
}

impl Prop {
    pub fn param(&self, key: &str) -> Option<&str> {
        self.params.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Default)]
pub struct Comp {
    pub name: String,
    pub props: Vec<Prop>,
    pub comps: Vec<Comp>,
}

impl Comp {
    pub fn prop(&self, name: &str) -> Option<&Prop> {
        self.props.iter().find(|p| p.name == name)
    }
    fn all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Prop> + 'a {
        self.props.iter().filter(move |p| p.name == name)
    }
    fn text(&self, name: &str) -> String {
        self.prop(name).map(|p| unescape(&p.value)).unwrap_or_default()
    }
}

/// Lines with folding undone (a line starting with a space or tab continues the one before).
fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = vec![];
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        match (line.strip_prefix([' ', '\t']), lines.last_mut()) {
            (Some(rest), Some(last)) => last.push_str(rest),
            _ if line.is_empty() => {}
            _ => lines.push(line.to_string()),
        }
    }
    lines
}

/// `NAME;PARAM=a;PARAM2="x:y":value`; parameter values may be quoted and hold ':' or ';'.
fn content_line(line: &str) -> Option<Prop> {
    let end = line.find([';', ':'])?;
    let name = line[..end].trim().to_ascii_uppercase();
    let mut rest = &line[end..];
    let mut params = vec![];
    while let Some(r) = rest.strip_prefix(';') {
        let eq = r.find('=')?;
        let key = r[..eq].trim().to_ascii_uppercase();
        let after = &r[eq + 1..];
        let (value, tail) = if let Some(q) = after.strip_prefix('"') {
            let close = q.find('"')?;
            (q[..close].to_string(), &q[close + 1..])
        } else {
            let stop = after.find([';', ':']).unwrap_or(after.len());
            (after[..stop].to_string(), &after[stop..])
        };
        params.push((key, value));
        rest = tail;
    }
    let value = rest.strip_prefix(':')?.to_string();
    Some(Prop { name, params, value })
}

/// Top-level components (normally one VCALENDAR) with their children; unknown or unbalanced lines are skipped.
pub fn parse(text: &str) -> Vec<Comp> {
    let mut top = vec![];
    let mut stack: Vec<Comp> = vec![];
    for line in unfold(text.trim_start_matches('\u{feff}')) {
        let Some(prop) = content_line(&line) else { continue };
        match prop.name.as_str() {
            "BEGIN" => stack.push(Comp { name: prop.value.trim().to_ascii_uppercase(), ..Default::default() }),
            "END" => {
                let name = prop.value.trim().to_ascii_uppercase();
                if stack.last().is_some_and(|c| c.name == name) {
                    let done = stack.pop().unwrap();
                    match stack.last_mut() {
                        Some(parent) => parent.comps.push(done),
                        None => top.push(done),
                    }
                }
            }
            _ => {
                if let Some(c) = stack.last_mut() {
                    c.props.push(prop);
                }
            }
        }
    }
    top
}

/// TEXT values: `\n`, `\,`, `\;`, `\\`.
pub fn unescape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') | Some('N') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out.trim().to_string()
}

fn cmp_ignore_case(a: &str, b: &str) -> std::cmp::Ordering {
    a.bytes().map(|c| c.to_ascii_lowercase()).cmp(b.bytes().map(|c| c.to_ascii_lowercase()))
}

/// The zone a TZID names (see the module comment); `custom` holds the file's VTIMEZONEs.
pub fn zone(tzid: &str, custom: &HashMap<String, TimeZone>, local: &TimeZone) -> TimeZone {
    let id = tzid.trim().trim_matches('"');
    if let Ok(tz) = TimeZone::get(id) {
        return tz;
    }
    if let Ok(i) = WINDOWS_TO_IANA.binary_search_by(|(w, _)| cmp_ignore_case(w, id)) {
        if let Ok(tz) = TimeZone::get(WINDOWS_TO_IANA[i].1) {
            return tz;
        }
    }
    for (i, _) in id.match_indices('/') {
        if let Ok(tz) = TimeZone::get(&id[i + 1..]) {
            return tz;
        }
    }
    custom.get(id).cloned().unwrap_or_else(|| local.clone())
}

/// `+0100`, `-0500`, `+053000` as seconds east of UTC.
fn utc_offset(v: &str) -> Option<i32> {
    let v = v.trim();
    let (sign, digits) = match v.as_bytes().first()? {
        b'+' => (1, &v[1..]),
        b'-' => (-1, &v[1..]),
        _ => (1, v),
    };
    if digits.len() < 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n = |r: std::ops::Range<usize>| digits.get(r).and_then(|s| s.parse::<i32>().ok()).unwrap_or(0);
    Some(sign * (n(0..2) * 3600 + n(2..4) * 60 + n(4..6)))
}

/// POSIX TZ offset (hours west of UTC) for seconds east.
fn posix_offset(east: i32) -> String {
    let west = -east;
    let a = west.abs();
    format!("{}{:02}:{:02}:{:02}", if west < 0 { "-" } else { "+" }, a / 3600, a % 3600 / 60, a % 60)
}

/// `Mm.w.d/time` for a yearly onset rule ("the last Sunday of March at 2:00").
fn posix_rule(c: &Comp) -> Option<String> {
    let rule = recur::parse(&c.prop("RRULE")?.value, |_| None)?;
    if rule.freq != recur::Freq::Yearly || rule.by_month.len() != 1 || rule.by_day.len() != 1 || rule.interval != 1 {
        return None;
    }
    let (n, wd) = rule.by_day[0];
    let week = match (n, rule.by_month_day.as_slice()) {
        (-1, []) | (5, []) => 5,
        (1..=4, []) => n,
        // The older style: BYMONTHDAY=8,9,…,14;BYDAY=SU for the second Sunday.
        (0, days) if days.len() == 7 && days[0] > 0 && (days[0] - 1) % 7 == 0 => (days[0] - 1) / 7 + 1,
        _ => return None,
    };
    let start = datetime_value(&c.prop("DTSTART")?.value)?.0;
    let t = start.time();
    Some(format!("M{}.{}.{}/{}:{:02}:{:02}", rule.by_month[0], week, wd.to_sunday_zero_offset(), t.hour(), t.minute(), t.second()))
}

/// The zone a VTIMEZONE describes, from its current rules (the STANDARD and DAYLIGHT parts that start last).
/// shortcut: older rules are ignored, which only matters for events years back; a rule POSIX cannot say becomes a fixed offset.
fn vtimezone(c: &Comp) -> Option<TimeZone> {
    let latest = |name: &str| c.comps.iter().filter(|s| s.name == name).max_by_key(|s| s.prop("DTSTART").and_then(|p| datetime_value(&p.value)).map(|v| v.0));
    let std = latest("STANDARD");
    let dst = latest("DAYLIGHT");
    let to = |s: &Comp| s.prop("TZOFFSETTO").and_then(|p| utc_offset(&p.value));
    let base = std.or(dst)?;
    let fixed = TimeZone::fixed(Offset::from_seconds(to(base)?).ok()?);
    let (Some(std), Some(dst)) = (std, dst) else { return Some(fixed) };
    let (Some(std_rule), Some(dst_rule), Some(std_off), Some(dst_off)) = (posix_rule(std), posix_rule(dst), to(std), to(dst)) else { return Some(fixed) };
    let posix = format!("<STD>{}<DST>{},{},{}", posix_offset(std_off), posix_offset(dst_off), dst_rule, std_rule);
    Some(TimeZone::posix(&posix).unwrap_or(fixed))
}

/// `20261101`, `20261101T090000`, `20261101T090000Z`: the wall-clock time, whether it is a date, and whether it is UTC.
fn datetime_value(v: &str) -> Option<(DateTime, bool, bool)> {
    let v = v.trim();
    let num = |r: std::ops::Range<usize>| v.get(r).and_then(|s| s.parse::<i32>().ok());
    let date = Date::new(num(0..4)? as i16, num(4..6)? as i8, num(6..8)? as i8).ok()?;
    if v.len() == 8 {
        return Some((date.to_datetime(Time::midnight()), true, false));
    }
    if v.as_bytes().get(8) != Some(&b'T') {
        return None;
    }
    let time = Time::new(num(9..11)? as i8, num(11..13)? as i8, num(13..15)?.min(59) as i8, 0).ok()?;
    Some((date.to_datetime(time), false, v.ends_with('Z') || v.ends_with('z')))
}

/// A DTSTART-like value: its wall-clock time in its zone, or a date (read at local midnight).
#[derive(Clone)]
struct When {
    local: DateTime,
    all_day: bool,
    tz: TimeZone,
}

impl When {
    fn timestamp(&self) -> Option<Timestamp> {
        self.tz.to_ambiguous_timestamp(self.local).compatible().ok()
    }
}

struct Ctx<'a> {
    custom: &'a HashMap<String, TimeZone>,
    local: &'a TimeZone,
}

impl Ctx<'_> {
    fn when_of(&self, value: &str, tzid: Option<&str>, date_param: bool) -> Option<When> {
        let (local, is_date, utc) = datetime_value(value)?;
        let all_day = is_date || date_param;
        let tz = if all_day {
            self.local.clone()
        } else if utc {
            TimeZone::UTC
        } else {
            tzid.map(|id| zone(id, self.custom, self.local)).unwrap_or_else(|| self.local.clone())
        };
        Some(When { local: if all_day { local.date().to_datetime(Time::midnight()) } else { local }, all_day, tz })
    }

    fn when(&self, p: &Prop) -> Option<When> {
        self.when_of(&p.value, p.param("TZID"), p.param("VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE")))
    }

    /// Every value of a list property (EXDATE, RDATE) as instants; a period keeps its start.
    fn instants(&self, comp: &Comp, name: &str) -> Vec<When> {
        comp.all(name)
            .flat_map(|p| {
                p.value
                    .split(',')
                    .filter_map(|v| self.when_of(v.split('/').next().unwrap_or(v), p.param("TZID"), p.param("VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE"))))
                    .collect::<Vec<_>>()
            })
            .collect()
    }
}

/// `PT1H30M`, `P1D`, `P2W`, `-PT15M` in seconds.
fn duration(v: &str) -> Option<i64> {
    let v = v.trim();
    let (sign, v) = match v.strip_prefix('-') {
        Some(r) => (-1, r),
        None => (1, v.strip_prefix('+').unwrap_or(v)),
    };
    let v = v.strip_prefix('P')?;
    let (mut total, mut num, mut in_time) = (0i64, String::new(), false);
    for c in v.chars() {
        match c {
            'T' => in_time = true,
            '0'..='9' => num.push(c),
            _ => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                total += n * match (c, in_time) {
                    ('W', false) => 604_800,
                    ('D', false) => 86_400,
                    ('H', true) => 3600,
                    ('M', true) => 60,
                    ('S', true) => 1,
                    _ => return None,
                };
            }
        }
    }
    Some(sign * total)
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// Unique within the result: the calendar, the UID and the start.
    pub id: String,
    pub calendar: String,
    pub title: String,
    pub location: String,
    /// URL and DESCRIPTION, where the Join button looks for a meeting link. Missing in older cache files.
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub description: String,
    /// Epoch milliseconds; an all-day event runs from local midnight to local midnight (end exclusive).
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
}

/// What the file says about itself (X-WR-CALNAME, X-APPLE-CALENDAR-COLOR or COLOR).
#[derive(Default, Debug)]
pub struct Meta {
    pub name: String,
    pub color: String,
}

/// A `#rrggbb` colour from `#rrggbb`, `#rrggbbaa` or `#rgb`; anything else is dropped (it ends up in a style).
pub fn hex_color(v: &str) -> Option<String> {
    let v = v.trim();
    let hex = v.strip_prefix('#')?;
    if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        6 | 8 => Some(format!("#{}", hex[..6].to_ascii_lowercase())),
        3 => Some(format!("#{}", hex.chars().flat_map(|c| [c, c]).collect::<String>().to_ascii_lowercase())),
        _ => None,
    }
}

/// The events of one calendar's data (one or more VCALENDARs, as a CalDAV report returns them) that overlap [from, to).
/// None when the text holds no VCALENDAR at all. `local` is the PC's zone (floating times, all-day events).
pub fn events(texts: &[&str], calendar: &str, from: Timestamp, to: Timestamp, local: &TimeZone) -> Option<(Meta, Vec<Event>)> {
    let cals: Vec<Comp> = texts.iter().flat_map(|t| parse(t)).filter(|c| c.name == "VCALENDAR").collect();
    if cals.is_empty() {
        return None;
    }
    let mut meta = Meta::default();
    let mut out = vec![];
    for cal in &cals {
        if meta.name.is_empty() {
            meta.name = cal.text("X-WR-CALNAME");
        }
        if meta.color.is_empty() {
            meta.color = cal.prop("X-APPLE-CALENDAR-COLOR").or(cal.prop("COLOR")).and_then(|p| hex_color(&p.value)).unwrap_or_default();
        }
        let custom: HashMap<String, TimeZone> = cal
            .comps
            .iter()
            .filter(|c| c.name == "VTIMEZONE")
            .filter_map(|c| Some((c.prop("TZID")?.value.trim().to_string(), vtimezone(c)?)))
            .collect();
        let ctx = Ctx { custom: &custom, local };
        let vevents: Vec<&Comp> = cal.comps.iter().filter(|c| c.name == "VEVENT").collect();
        // Instances replaced or cancelled by an override, per UID.
        let mut moved: HashMap<String, HashSet<i64>> = HashMap::new();
        for e in &vevents {
            if let Some(rid) = e.prop("RECURRENCE-ID").and_then(|p| ctx.when(p)).and_then(|w| w.timestamp()) {
                moved.entry(e.text("UID")).or_default().insert(rid.as_second());
            }
        }
        for e in vevents {
            if out.len() >= MAX_EVENTS {
                break;
            }
            series(e, &ctx, calendar, from, to, moved.get(&e.text("UID")), &mut out);
        }
    }
    out.sort_by_key(|e| (e.start, e.end));
    out.truncate(MAX_EVENTS);
    Some((meta, out))
}

/// One VEVENT's occurrences in [from, to): itself, or its recurrences without the excluded and moved ones.
fn series(e: &Comp, ctx: &Ctx, calendar: &str, from: Timestamp, to: Timestamp, moved: Option<&HashSet<i64>>, out: &mut Vec<Event>) {
    if e.prop("STATUS").is_some_and(|p| p.value.trim().eq_ignore_ascii_case("CANCELLED")) {
        return;
    }
    let Some(start) = e.prop("DTSTART").and_then(|p| ctx.when(p)) else { return };
    let Some(start_ts) = start.timestamp() else { return };
    let override_ = e.prop("RECURRENCE-ID").is_some();
    // Length: DTEND, else DURATION, else a day for a date and nothing for a time.
    let end = e.prop("DTEND").and_then(|p| ctx.when(p));
    let (len_days, len_secs) = if start.all_day {
        let days = end.as_ref().map(|w| recur::days_between(start.local.date(), w.local.date())).or_else(|| e.prop("DURATION").and_then(|p| duration(&p.value)).map(|s| s / 86_400)).unwrap_or(1);
        (days.max(1), 0)
    } else {
        let secs = end.and_then(|w| w.timestamp()).map(|t| t.as_second() - start_ts.as_second()).or_else(|| e.prop("DURATION").and_then(|p| duration(&p.value))).unwrap_or(0);
        (0, secs.max(0))
    };
    let mut starts: Vec<DateTime> = vec![start.local];
    if !override_ {
        if let Some(rule) = e.prop("RRULE").and_then(|p| {
            recur::parse(&p.value, |u| {
                let (local, is_date, utc) = datetime_value(u)?;
                Some(if is_date {
                    local.date().to_datetime(Time::constant(23, 59, 59, 0))
                } else if utc {
                    start.tz.to_datetime(TimeZone::UTC.to_ambiguous_timestamp(local).compatible().ok()?)
                } else {
                    local
                })
            })
        }) {
            // A day of margin on each side in the series' own wall time; the exact cut is on instants below.
            let margin = jiff::SignedDuration::from_secs(len_secs + (len_days + 1) * 86_400);
            let lo = start.tz.to_datetime(from.checked_sub(margin).unwrap_or(from));
            let hi = start.tz.to_datetime(to.checked_add(jiff::SignedDuration::from_hours(24)).unwrap_or(to));
            starts = recur::expand(&rule, start.local, lo, hi, MAX_OCCURRENCES);
        }
        for r in ctx.instants(e, "RDATE") {
            // An RDATE in another zone, as the series' wall-clock time.
            starts.push(if start.all_day { r.local.date().to_datetime(Time::midnight()) } else { r.timestamp().map(|t| start.tz.to_datetime(t)).unwrap_or(r.local) });
        }
    }
    let excluded: HashSet<i64> = ctx.instants(e, "EXDATE").iter().filter_map(|w| w.timestamp()).map(|t| t.as_second()).collect();
    let uid = e.text("UID");
    let (title, location) = (e.text("SUMMARY"), capped(e.text("LOCATION"), MAX_LOCATION));
    // URL is a URI value, not text: no escapes to undo.
    let url = capped(e.prop("URL").map(|p| p.value.trim().to_string()).unwrap_or_default(), MAX_URL);
    let description = capped(e.text("DESCRIPTION"), MAX_DESCRIPTION);
    starts.sort();
    starts.dedup();
    for local in starts {
        let w = When { local, ..start.clone() };
        let Some(s) = w.timestamp() else { continue };
        if excluded.contains(&s.as_second()) || (!override_ && moved.is_some_and(|m| m.contains(&s.as_second()))) {
            continue;
        }
        let end_ts = if start.all_day {
            let end_local = recur::add_days(local.date(), len_days).map(|d| d.to_datetime(Time::midnight()));
            end_local.and_then(|l| When { local: l, ..start.clone() }.timestamp())
        } else {
            s.checked_add(jiff::SignedDuration::from_secs(len_secs)).ok()
        };
        let Some(end_ts) = end_ts else { continue };
        // A zero-length event still shows at its start.
        if s >= to || (end_ts <= from && !(end_ts == s && s >= from)) {
            continue;
        }
        out.push(Event {
            id: format!("{calendar}/{uid}@{}", s.as_second()),
            calendar: calendar.to_string(),
            title: title.clone(),
            location: location.clone(),
            url: url.clone(),
            description: description.clone(),
            start: s.as_millisecond(),
            end: end_ts.as_millisecond(),
            all_day: start.all_day,
        });
    }
}

/// At most `max` characters.
fn capped(mut s: String, max: usize) -> String {
    if let Some((i, _)) = s.char_indices().nth(max) {
        s.truncate(i);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn berlin() -> TimeZone {
        TimeZone::get("Europe/Berlin").unwrap()
    }

    fn ts(s: &str) -> Timestamp {
        s.parse().unwrap()
    }

    /// Events in November 2026 as "start/end" in UTC, read with the PC in `local`.
    fn read(ics: &str, local: &TimeZone) -> Vec<(String, String, String)> {
        let (_, events) = events(&[ics], "c", ts("2026-11-01T00:00:00Z"), ts("2026-12-01T00:00:00Z"), local).unwrap();
        events
            .into_iter()
            .map(|e| (e.title, Timestamp::from_millisecond(e.start).unwrap().to_string(), Timestamp::from_millisecond(e.end).unwrap().to_string()))
            .collect()
    }

    fn cal(body: &str) -> String {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Work\r\nX-APPLE-CALENDAR-COLOR:#FF2968FF\r\n{body}END:VCALENDAR\r\n")
    }

    #[test]
    fn content_lines_with_quotes_folding_and_escapes() {
        let text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY;LANGUAGE=en:Lunch\\, then \r\n a walk\\; ok\\nbye\r\nLOCATION;ALTREP=\"http://x/y;z:1\":Room 1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let top = parse(text);
        assert_eq!(top.len(), 1);
        let ev = &top[0].comps[0];
        assert_eq!(ev.text("SUMMARY"), "Lunch, then a walk; ok\nbye");
        let loc = ev.prop("LOCATION").unwrap();
        assert_eq!(loc.param("altrep"), Some("http://x/y;z:1"));
        assert_eq!(loc.value, "Room 1");
    }

    #[test]
    fn meta_and_colour() {
        let (meta, _) = events(&[&cal("")], "c", ts("2026-11-01T00:00:00Z"), ts("2026-12-01T00:00:00Z"), &berlin()).unwrap();
        assert_eq!(meta.name, "Work");
        assert_eq!(meta.color, "#ff2968");
        assert_eq!(hex_color("#abc").as_deref(), Some("#aabbcc"));
        assert_eq!(hex_color("red; x"), None);
        assert!(events(&["<html>not a calendar</html>"], "c", ts("2026-11-01T00:00:00Z"), ts("2026-12-01T00:00:00Z"), &berlin()).is_none());
    }

    #[test]
    fn utc_iana_windows_floating_and_vtimezone() {
        let body = concat!(
            "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:utc\r\nDTSTART:20261102T090000Z\r\nDTEND:20261102T100000Z\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:iana\r\nDTSTART;TZID=America/New_York:20261102T090000\r\nDURATION:PT30M\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:c\r\nSUMMARY:windows\r\nDTSTART;TZID=\"W. Europe Standard Time\":20261103T090000\r\nDTEND;TZID=\"W. Europe Standard Time\":20261103T093000\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:d\r\nSUMMARY:floating\r\nDTSTART:20261104T090000\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:e\r\nSUMMARY:mozilla\r\nDTSTART;TZID=/mozilla.org/20050126_1/Asia/Tokyo:20261105T090000\r\nEND:VEVENT\r\n",
            "BEGIN:VTIMEZONE\r\nTZID:Custom Zone\r\n",
            "BEGIN:STANDARD\r\nDTSTART:16011104T020000\r\nRRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nEND:STANDARD\r\n",
            "BEGIN:DAYLIGHT\r\nDTSTART:16010311T020000\r\nRRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nEND:DAYLIGHT\r\n",
            "END:VTIMEZONE\r\n",
            // 1 Nov 2026 is the first Sunday of November: 9:00 is already standard time (UTC-5); 31 Oct is still daylight time (UTC-4).
            "BEGIN:VEVENT\r\nUID:f\r\nSUMMARY:custom\r\nDTSTART;TZID=Custom Zone:20261101T090000\r\nEND:VEVENT\r\n",
        );
        let got = read(&cal(body), &berlin());
        let find = |t: &str| got.iter().find(|e| e.0 == t).map(|e| (e.1.as_str(), e.2.as_str())).unwrap();
        assert_eq!(find("utc"), ("2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"));
        assert_eq!(find("iana"), ("2026-11-02T14:00:00Z", "2026-11-02T14:30:00Z"));
        assert_eq!(find("windows"), ("2026-11-03T08:00:00Z", "2026-11-03T08:30:00Z"));
        assert_eq!(find("floating"), ("2026-11-04T08:00:00Z", "2026-11-04T08:00:00Z"));
        assert_eq!(find("mozilla"), ("2026-11-05T00:00:00Z", "2026-11-05T00:00:00Z"));
        assert_eq!(find("custom"), ("2026-11-01T14:00:00Z", "2026-11-01T14:00:00Z"));
    }

    #[test]
    fn vtimezone_without_dst_is_a_fixed_offset() {
        let c = parse("BEGIN:VTIMEZONE\r\nTZID:X\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0530\r\nTZOFFSETTO:+0530\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n");
        let tz = vtimezone(&c[0]).unwrap();
        assert_eq!(tz.to_offset(ts("2026-11-01T00:00:00Z")).seconds(), 19_800);
    }

    #[test]
    fn all_day_events_follow_local_midnight() {
        let body = concat!(
            "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:holiday\r\nDTSTART;VALUE=DATE:20261102\r\nDTEND;VALUE=DATE:20261104\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:no end\r\nDTSTART;VALUE=DATE:20261110\r\nEND:VEVENT\r\n",
        );
        let got = read(&cal(body), &berlin());
        assert_eq!(got[0], ("holiday".into(), "2026-11-01T23:00:00Z".into(), "2026-11-03T23:00:00Z".into()));
        assert_eq!(got[1], ("no end".into(), "2026-11-09T23:00:00Z".into(), "2026-11-10T23:00:00Z".into()));
        let ny = TimeZone::get("America/New_York").unwrap();
        assert_eq!(read(&cal(body), &ny)[0].1, "2026-11-02T05:00:00Z");
    }

    #[test]
    fn weekly_series_keeps_wall_time_across_dst() {
        // 09:00 in Berlin each Friday from 23 Oct (summer time) into November (winter time).
        let body = "BEGIN:VEVENT\r\nUID:s\r\nSUMMARY:standup\r\nDTSTART;TZID=Europe/Berlin:20261023T090000\r\nDTEND;TZID=Europe/Berlin:20261023T091500\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\n";
        let got = read(&cal(body), &berlin());
        assert_eq!(got.iter().map(|e| e.1.as_str()).collect::<Vec<_>>(), ["2026-11-06T08:00:00Z"]);
        let (_, all) = events(&[&cal(body)], "c", ts("2026-10-01T00:00:00Z"), ts("2026-12-01T00:00:00Z"), &berlin()).unwrap();
        let starts: Vec<String> = all.iter().map(|e| Timestamp::from_millisecond(e.start).unwrap().to_string()).collect();
        assert_eq!(starts, ["2026-10-23T07:00:00Z", "2026-10-30T08:00:00Z", "2026-11-06T08:00:00Z"]);
    }

    #[test]
    fn exdate_override_and_cancelled_instances() {
        let body = concat!(
            "BEGIN:VEVENT\r\nUID:r\r\nSUMMARY:daily\r\nDTSTART;TZID=Europe/Berlin:20261102T100000\r\nDTEND;TZID=Europe/Berlin:20261102T110000\r\n",
            "RRULE:FREQ=DAILY;UNTIL=20261106T090000Z\r\nEXDATE;TZID=Europe/Berlin:20261103T100000\r\nEND:VEVENT\r\n",
            // The 4th moved to 15:00, the 5th cancelled.
            "BEGIN:VEVENT\r\nUID:r\r\nSUMMARY:daily (moved)\r\nRECURRENCE-ID;TZID=Europe/Berlin:20261104T100000\r\nDTSTART;TZID=Europe/Berlin:20261104T150000\r\nDTEND;TZID=Europe/Berlin:20261104T160000\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:r\r\nSUMMARY:daily\r\nRECURRENCE-ID:20261105T090000Z\r\nSTATUS:CANCELLED\r\nDTSTART:20261105T090000Z\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:x\r\nSUMMARY:gone\r\nSTATUS:CANCELLED\r\nDTSTART:20261102T090000Z\r\nEND:VEVENT\r\n",
        );
        let got = read(&cal(body), &berlin());
        let titles: Vec<(&str, &str)> = got.iter().map(|e| (e.0.as_str(), e.1.as_str())).collect();
        assert_eq!(titles, [("daily", "2026-11-02T09:00:00Z"), ("daily (moved)", "2026-11-04T14:00:00Z"), ("daily", "2026-11-06T09:00:00Z")]);
    }

    #[test]
    fn recurring_all_day_and_ongoing_events() {
        let body = concat!(
            "BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:birthday\r\nDTSTART;VALUE=DATE:19900315\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=20\r\nEND:VEVENT\r\n",
            // Started in October, still running on 1 November.
            "BEGIN:VEVENT\r\nUID:t\r\nSUMMARY:trip\r\nDTSTART;VALUE=DATE:20261030\r\nDTEND;VALUE=DATE:20261103\r\nEND:VEVENT\r\n",
        );
        let got = read(&cal(body), &berlin());
        assert_eq!(got.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(), ["trip", "birthday"]);
        assert_eq!(got[1].1, "2026-11-19T23:00:00Z");
    }

    #[test]
    fn url_and_description_capped() {
        let long = "ä".repeat(MAX_DESCRIPTION + 10);
        let body = format!("BEGIN:VEVENT\r\nUID:m\r\nSUMMARY:call\r\nURL:https://meet.google.com/abc-defg-hij\r\nDESCRIPTION:Join\\, then {long}\r\nDTSTART:20261102T090000Z\r\nEND:VEVENT\r\n");
        let (_, list) = events(&[&cal(&body)], "c", ts("2026-11-01T00:00:00Z"), ts("2026-12-01T00:00:00Z"), &berlin()).unwrap();
        assert_eq!(list[0].url, "https://meet.google.com/abc-defg-hij");
        assert!(list[0].description.starts_with("Join, then ä"));
        assert_eq!(list[0].description.chars().count(), MAX_DESCRIPTION);
        assert_eq!(capped("abc".into(), 5), "abc");
    }

    #[test]
    fn durations() {
        assert_eq!(duration("PT1H30M"), Some(5400));
        assert_eq!(duration("P1D"), Some(86_400));
        assert_eq!(duration("P1W"), Some(604_800));
        assert_eq!(duration("-PT15M"), Some(-900));
        assert_eq!(duration("1H"), None);
    }
}
