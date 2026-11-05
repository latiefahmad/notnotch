//! GitHub contribution calendar, read-only.
//!
//! Without a token: the public page `github.com/users/<name>/contributions` (what the profile
//! shows), parsed here. With a token in Credential Manager (`github.token`): the GraphQL
//! `contributionCalendar` first, the page if that fails. Cached for an hour per user.
//! Errors: no-user, not-found, token-rejected, rate-limited, offline, parse, failed.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{net_error, now_ms};

const CACHE: Duration = Duration::from_secs(3600);
/// A forced refresh still waits this long after the last fetch.
const MIN_FORCED: Duration = Duration::from_secs(60);

#[derive(Clone, Serialize, PartialEq, Debug)]
pub struct Day {
    date: String,
    count: u32,
    level: u8,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributions {
    user: String,
    /// Contributions in the last year, as GitHub states it.
    total: u32,
    days: Vec<Day>,
    /// "page" or "api".
    source: &'static str,
    fetched_at: u64,
}

#[derive(Default)]
pub struct GithubState(Mutex<Option<(String, Instant, Contributions)>>);

/// GitHub logins: letters, digits and single hyphens, at most 39 characters.
fn valid_user(user: &str) -> bool {
    !user.is_empty() && user.len() <= 39 && user.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Opens the user's GitHub profile in the browser; only a valid login, so the page cannot open any other address.
#[tauri::command]
pub fn github_open_profile(user: String) -> Result<(), String> {
    let user = user.trim();
    if !valid_user(user) {
        return Err("not-found".into());
    }
    crate::open_url(&format!("https://github.com/{user}"))
}

#[tauri::command]
pub async fn github_contributions(user: String, force: bool, state: State<'_, GithubState>) -> Result<Contributions, String> {
    let user = user.trim().to_string();
    if user.is_empty() {
        return Err("no-user".into());
    }
    if !valid_user(&user) {
        return Err("not-found".into());
    }
    if let Some((cached_user, at, data)) = state.0.lock().unwrap().as_ref() {
        let max_age = if force { MIN_FORCED } else { CACHE };
        if cached_user.eq_ignore_ascii_case(&user) && at.elapsed() < max_age {
            return Ok(data.clone());
        }
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("NotNotch")
        .build()
        .map_err(|_| "failed".to_string())?;
    let mut data = None;
    if let Some(token) = crate::secrets::read("github.token") {
        match from_api(&client, &user, &token).await {
            Ok(d) => data = Some(d),
            // A rejected token is shown rather than hidden behind the page.
            Err(e) if e == "token-rejected" => return Err(e),
            Err(_) => {}
        }
    }
    let data = match data {
        Some(d) => d,
        None => from_page(&client, &user).await?,
    };
    *state.0.lock().unwrap() = Some((user, Instant::now(), data.clone()));
    Ok(data)
}

fn status_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        404 => "not-found",
        403 | 429 => "rate-limited",
        _ => "failed",
    }
    .into()
}

async fn from_page(client: &reqwest::Client, user: &str) -> Result<Contributions, String> {
    let r = client.get(format!("https://github.com/users/{user}/contributions")).send().await.map_err(net_error)?;
    if !r.status().is_success() {
        return Err(status_error(r.status()));
    }
    let html = r.text().await.map_err(net_error)?;
    let (total, days) = parse_page(&html).ok_or("parse")?;
    Ok(Contributions { user: user.to_string(), total, days, source: "page", fetched_at: now_ms() })
}

/// The value of `name="…"` inside one tag, the name preceded by any ASCII whitespace.
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let key = format!("{name}=\"");
    let mut from = 0;
    while let Some(i) = tag[from..].find(&key) {
        let at = from + i;
        if tag[..at].ends_with(|c: char| c.is_ascii_whitespace()) {
            let start = at + key.len();
            let len = tag[start..].find('"')?;
            return Some(&tag[start..start + len]);
        }
        from = at + key.len();
    }
    None
}

/// `<name` followed by whitespace (a space, tab or line break before the first attribute).
fn is_tag(tag: &str, name: &str) -> bool {
    tag.strip_prefix('<').and_then(|t| t.strip_prefix(name)).is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_whitespace()))
}

/// Leading number of a text, thousands separators allowed ("1,031 contributions on …").
fn leading_number(text: &str) -> Option<u32> {
    let digits: String = text.trim_start().chars().take_while(|c| c.is_ascii_digit() || *c == ',').filter(|c| *c != ',').collect();
    digits.parse().ok()
}

/// Total and days (sorted by date) from the contributions page. The cells sit in rows by weekday;
/// each count is in a `<tool-tip for="<cell id>">`. A cell without one keeps count 0 and its shade.
pub(crate) fn parse_page(html: &str) -> Option<(u32, Vec<Day>)> {
    let mut days: Vec<(String, Day)> = Vec::new();
    let mut counts = std::collections::HashMap::new();
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        rest = &rest[i..];
        let Some(end) = rest.find('>') else { break };
        let tag = &rest[..end];
        if is_tag(tag, "td") {
            if let (Some(date), Some(id)) = (attr(tag, "data-date"), attr(tag, "id")) {
                let level = attr(tag, "data-level").and_then(|l| l.parse().ok()).unwrap_or(0u8).min(4);
                if date.len() == 10 {
                    days.push((id.to_string(), Day { date: date.to_string(), count: 0, level }));
                }
            }
        } else if is_tag(tag, "tool-tip") {
            if let Some(target) = attr(tag, "for") {
                let body = &rest[end + 1..];
                let text = &body[..body.find("</tool-tip>").unwrap_or(0)];
                counts.insert(target.to_string(), leading_number(text).unwrap_or(0));
            }
        }
        rest = &rest[end + 1..];
    }
    if days.is_empty() {
        return None;
    }
    let mut days: Vec<Day> = days.into_iter().map(|(id, d)| Day { count: counts.get(&id).copied().unwrap_or(0), ..d }).collect();
    days.sort_by(|a, b| a.date.cmp(&b.date));
    let heading = html
        .find("id=\"js-contribution-activity-description\"")
        .and_then(|i| html[i..].find('>').map(|j| &html[i + j + 1..]))
        .and_then(leading_number);
    let total = heading.unwrap_or_else(|| days.iter().map(|d| d.count).sum());
    Some((total, days))
}

#[derive(Deserialize)]
struct GqlResponse {
    data: Option<GqlData>,
}
#[derive(Deserialize)]
struct GqlData {
    user: Option<GqlUser>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlUser {
    contributions_collection: GqlCollection,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlCollection {
    contribution_calendar: GqlCalendar,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlCalendar {
    total_contributions: u32,
    weeks: Vec<GqlWeek>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlWeek {
    contribution_days: Vec<GqlDay>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlDay {
    date: String,
    contribution_count: u32,
    contribution_level: String,
}

const QUERY: &str = "query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount contributionLevel}}}}}}";

async fn from_api(client: &reqwest::Client, user: &str, token: &str) -> Result<Contributions, String> {
    let r = client
        .post("https://api.github.com/graphql")
        .bearer_auth(token)
        .json(&serde_json::json!({ "query": QUERY, "variables": { "login": user } }))
        .send()
        .await
        .map_err(net_error)?;
    if r.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("token-rejected".into());
    }
    if !r.status().is_success() {
        return Err(status_error(r.status()));
    }
    let body: GqlResponse = r.json().await.map_err(|_| "parse".to_string())?;
    let calendar = body.data.and_then(|d| d.user).ok_or("not-found")?.contributions_collection.contribution_calendar;
    let days = calendar
        .weeks
        .into_iter()
        .flat_map(|w| w.contribution_days)
        .map(|d| Day {
            level: match d.contribution_level.as_str() {
                "FIRST_QUARTILE" => 1,
                "SECOND_QUARTILE" => 2,
                "THIRD_QUARTILE" => 3,
                "FOURTH_QUARTILE" => 4,
                _ => 0,
            },
            date: d.date,
            count: d.contribution_count,
        })
        .collect();
    Ok(Contributions { user: user.to_string(), total: calendar.total_contributions, days, source: "api", fetched_at: now_ms() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(date: &str, count: u32, level: u8) -> Day {
        Day { date: date.into(), count, level }
    }

    #[test]
    fn parses_the_fixture() {
        let (total, days) = parse_page(include_str!("../fixtures/github-contributions.html")).unwrap();
        assert_eq!(total, 1204);
        assert_eq!(
            days,
            vec![
                day("2026-10-18", 0, 0),
                day("2026-10-19", 1, 1),
                // No tool-tip: count unknown, the shade stays.
                day("2026-10-20", 0, 2),
                day("2026-10-25", 12, 3),
                day("2026-10-26", 1031, 4),
                day("2026-10-27", 0, 0),
            ]
        );
    }

    #[test]
    fn total_falls_back_to_the_sum() {
        let html = r#"<td data-date="2026-01-02" id="a" data-level="1"></td><tool-tip for="a">3 contributions</tool-tip>"#;
        assert_eq!(parse_page(html), Some((3, vec![day("2026-01-02", 3, 1)])));
    }

    #[test]
    fn accepts_any_whitespace_between_attributes() {
        let html = "<td\n\tdata-date=\"2026-01-02\"\r\n id=\"a\"\tdata-level=\"2\"></td><tool-tip\nfor=\"a\">4 contributions</tool-tip>";
        assert_eq!(parse_page(html), Some((4, vec![day("2026-01-02", 4, 2)])));
        // `data-id` must not be read as `id`, nor `<tdx` as a cell.
        let html = r#"<td data-id="x" data-date="2026-01-02" id="b"></td><tdx data-date="2026-01-03" id="c"></tdx>"#;
        assert_eq!(parse_page(html), Some((0, vec![day("2026-01-02", 0, 0)])));
    }

    #[test]
    fn rejects_pages_without_days() {
        assert_eq!(parse_page("<html><body>Not Found</body></html>"), None);
        assert_eq!(parse_page(""), None);
        assert_eq!(parse_page("<td data-date="), None);
    }

    #[test]
    fn checks_user_names() {
        assert!(valid_user("latiefahmad"));
        assert!(valid_user("a-b"));
        assert!(!valid_user("a/b"));
        assert!(!valid_user("a b"));
        assert!(!valid_user("../x"));
        assert!(!valid_user(&"a".repeat(40)));
    }
}
