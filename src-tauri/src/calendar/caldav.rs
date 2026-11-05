//! CalDAV (RFC 4791), read-only: find the account's calendars with PROPFIND (principal, calendar home, the calendars in it)
//! and fetch the events of a time range with a REPORT calendar-query. Basic authentication with an app password.

use std::collections::HashMap;

use quick_xml::events::Event;
use reqwest::{Method, Url};

pub struct Auth<'a> {
    pub user: &'a str,
    pub pass: &'a str,
}

pub struct Calendar {
    pub href: Url,
    pub name: String,
    pub color: String,
}

const MAX_BYTES: usize = 20 * 1024 * 1024;

const PRINCIPAL: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:current-user-principal/><c:calendar-home-set/><d:resourcetype/><d:displayname/></d:prop></d:propfind>"#;
const CALENDARS: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/></d:prop></d:propfind>"#;

/// One property of a response: its text, the hrefs inside it, the elements inside it and the `name` of any `comp` in it.
#[derive(Default, Debug)]
pub struct PropVal {
    pub text: String,
    pub hrefs: Vec<String>,
    pub children: Vec<String>,
    pub comps: Vec<String>,
}

#[derive(Default, Debug)]
pub struct Response {
    pub href: String,
    /// By local name; only properties from a propstat with status 200.
    pub props: HashMap<String, PropVal>,
}

impl Response {
    fn is_calendar(&self) -> bool {
        self.props.get("resourcetype").is_some_and(|p| p.children.iter().any(|c| c == "calendar"))
    }
    fn href_of(&self, prop: &str) -> Option<&str> {
        self.props.get(prop).and_then(|p| p.hrefs.first()).map(|s| s.as_str())
    }
}

fn entity(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        _ => return None,
    })
}

/// A WebDAV multistatus body, namespaces ignored (every server prefixes them differently).
pub fn multistatus(xml: &str) -> Vec<Response> {
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut stack: Vec<String> = vec![];
    let mut out = vec![];
    let mut cur: Option<Response> = None;
    let mut props: Vec<(String, PropVal)> = vec![];
    let mut status = String::new();
    let mut prop_depth: Option<usize> = None;
    let mut text = String::new();
    let open = |name: String, comp_name: Option<String>, stack: &mut Vec<String>, props: &mut Vec<(String, PropVal)>, prop_depth: &mut Option<usize>, cur: &mut Option<Response>, status: &mut String| {
        match name.as_str() {
            "response" => *cur = Some(Response::default()),
            "propstat" => {
                props.clear();
                status.clear();
            }
            "prop" if stack.last().is_some_and(|p| p == "propstat") => *prop_depth = Some(stack.len()),
            _ => {}
        }
        if let Some(pd) = *prop_depth {
            if stack.len() == pd + 1 {
                props.push((name.clone(), PropVal::default()));
            } else if stack.len() > pd + 1 {
                if let Some((_, p)) = props.last_mut() {
                    p.children.push(name.clone());
                    if let Some(c) = comp_name {
                        p.comps.push(c);
                    }
                }
            }
        }
        stack.push(name);
    };
    loop {
        let ev = match reader.read_event() {
            Ok(Event::Eof) | Err(_) => break,
            Ok(ev) => ev,
        };
        let end = match &ev {
            Event::Start(e) | Event::Empty(e) => {
                let name = AsRef::<str>::as_ref(&e.local_name()).to_string();
                let comp = (name == "comp")
                    .then(|| e.attributes().flatten().find(|a| AsRef::<str>::as_ref(&a.key.local_name()) == "name").and_then(|a| a.normalized_value(quick_xml::XmlVersion::Implicit1_0).ok().map(|v| v.trim().to_ascii_uppercase())))
                    .flatten();
                text.clear();
                open(name, comp, &mut stack, &mut props, &mut prop_depth, &mut cur, &mut status);
                matches!(ev, Event::Empty(_))
            }
            Event::End(_) => true,
            Event::Text(t) => {
                text.push_str(&t.xml10_content());
                false
            }
            Event::CData(c) => {
                text.push_str(&c.xml10_content());
                false
            }
            Event::GeneralRef(r) => {
                if let Ok(Some(c)) = r.resolve_char_ref() {
                    text.push(c);
                } else if let Some(c) = entity(AsRef::<str>::as_ref(r)) {
                    text.push(c);
                }
                false
            }
            _ => false,
        };
        if !end {
            continue;
        }
        let Some(name) = stack.pop() else { continue };
        let parent = stack.last().map(|s| s.as_str()).unwrap_or("");
        match prop_depth {
            Some(pd) if stack.len() == pd + 1 => {
                if let Some((_, p)) = props.last_mut() {
                    p.text = std::mem::take(&mut text);
                }
            }
            Some(pd) if stack.len() > pd + 1 && name == "href" => {
                if let Some((_, p)) = props.last_mut() {
                    p.hrefs.push(text.trim().to_string());
                }
            }
            _ => {}
        }
        match name.as_str() {
            "href" if parent == "response" => {
                if let Some(r) = cur.as_mut() {
                    r.href = text.trim().to_string();
                }
            }
            "status" if parent == "propstat" => status = text.trim().to_string(),
            "prop" if prop_depth == Some(stack.len()) => prop_depth = None,
            "propstat" => {
                if let Some(r) = cur.as_mut() {
                    if status.is_empty() || status.contains(" 200") {
                        r.props.extend(props.drain(..));
                    }
                }
                props.clear();
            }
            "response" => out.extend(cur.take()),
            _ => {}
        }
    }
    out
}

/// A server may point to another host of its own (iCloud: caldav.icloud.com → p52-caldav.icloud.com), never elsewhere:
/// the same host, or one under the same parent domain, and no step down from https.
/// shortcut: "parent domain" is the host minus its first label, which is too wide for a bare "example.co.uk"; a public suffix list would be exact.
fn same_site(base: &Url, next: &Url) -> bool {
    let (Some(a), Some(b)) = (base.host_str(), next.host_str()) else { return false };
    if base.scheme() == "https" && next.scheme() != "https" {
        return false;
    }
    if a.eq_ignore_ascii_case(b) {
        return true;
    }
    match a.split_once('.') {
        Some((_, parent)) if parent.contains('.') => b.to_ascii_lowercase().ends_with(&format!(".{}", parent.to_ascii_lowercase())),
        _ => false,
    }
}

fn join(base: &Url, href: &str) -> Result<Url, String> {
    let url = base.join(href.trim()).map_err(|_| "parse".to_string())?;
    if same_site(base, &url) {
        Ok(url)
    } else {
        Err("failed".into())
    }
}

/// The client must not follow redirects itself: it would turn PROPFIND into GET. Redirects are followed here, with the
/// same method and body, only within the server (`same_site`). Answers the final URL, which relative hrefs are read against.
async fn request(client: &reqwest::Client, method: &str, url: &Url, depth: &str, body: &str, auth: &Auth<'_>) -> Result<(Url, Vec<Response>), String> {
    let method = Method::from_bytes(method.as_bytes()).map_err(|_| "failed".to_string())?;
    let mut at = url.clone();
    let mut hops = 0;
    let r = loop {
        let r = client
            .request(method.clone(), at.clone())
            .basic_auth(auth.user, Some(auth.pass))
            .header("Depth", depth)
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(body.to_string())
            .send()
            .await
            .map_err(super::net_error)?;
        if !r.status().is_redirection() {
            break r;
        }
        hops += 1;
        let next = r.headers().get("location").and_then(|l| l.to_str().ok()).ok_or("failed")?;
        if hops > 5 {
            return Err("failed".into());
        }
        at = join(&at, next)?;
    };
    super::check_status(r.status())?;
    let text = super::read_capped(r, MAX_BYTES).await?;
    Ok((at, multistatus(&text)))
}

/// The calendars (with events) the URL leads to: a calendar itself, a calendar home, a principal or the server
/// (then through `current-user-principal`, and `/.well-known/caldav` when the server root says nothing).
pub async fn discover(client: &reqwest::Client, url: &Url, auth: &Auth<'_>) -> Result<Vec<Calendar>, String> {
    let mut first = request(client, "PROPFIND", url, "0", PRINCIPAL, auth).await;
    let says_nothing = |r: &Result<(Url, Vec<Response>), String>| match r {
        Ok((_, list)) => list.iter().all(|x| !x.is_calendar() && x.href_of("calendar-home-set").is_none() && x.href_of("current-user-principal").is_none()),
        Err(e) => e == "not-found" || e == "failed",
    };
    if says_nothing(&first) && matches!(url.path(), "" | "/") {
        let known = url.join("/.well-known/caldav").map_err(|_| "bad-url".to_string())?;
        first = request(client, "PROPFIND", &known, "0", PRINCIPAL, auth).await;
    }
    let (at, first) = first?;
    if let Some(cal) = first.iter().find(|r| r.is_calendar()) {
        let href = if cal.href.is_empty() { at.clone() } else { join(&at, &cal.href)? };
        let name = cal.props.get("displayname").map(|p| p.text.trim().to_string()).unwrap_or_default();
        return Ok(vec![Calendar { href, name, color: String::new() }]);
    }
    let mut home = first.iter().find_map(|r| r.href_of("calendar-home-set")).map(|h| join(&at, h)).transpose()?;
    if home.is_none() {
        if let Some(principal) = first.iter().find_map(|r| r.href_of("current-user-principal")) {
            let (principal, r) = request(client, "PROPFIND", &join(&at, principal)?, "0", PRINCIPAL, auth).await?;
            home = r.iter().find_map(|x| x.href_of("calendar-home-set")).map(|h| join(&principal, h)).transpose()?;
        }
    }
    // Nothing points further: take the URL as the calendar home.
    let (home, list) = request(client, "PROPFIND", &home.unwrap_or(at), "1", CALENDARS, auth).await?;
    let calendars: Vec<Calendar> = list
        .iter()
        .filter(|r| r.is_calendar())
        .filter(|r| r.props.get("supported-calendar-component-set").is_none_or(|p| p.comps.is_empty() || p.comps.iter().any(|c| c == "VEVENT")))
        .filter_map(|r| {
            let href = join(&home, &r.href).ok()?;
            let fallback = href.path_segments().and_then(|s| s.filter(|x| !x.is_empty()).last()).unwrap_or("").to_string();
            let name = r.props.get("displayname").map(|p| p.text.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or(fallback);
            let color = r.props.get("calendar-color").and_then(|p| super::ics::hex_color(&p.text)).unwrap_or_default();
            Some(Calendar { href, name, color })
        })
        .collect();
    if calendars.is_empty() {
        return Err("no-calendars".into());
    }
    Ok(calendars)
}

/// The iCalendar texts of the events in [from, to) (UTC, `20261101T000000Z`), recurring ones as whole series.
pub async fn events(client: &reqwest::Client, calendar: &Url, auth: &Auth<'_>, from: &str, to: &str) -> Result<Vec<String>, String> {
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="{from}" end="{to}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"#
    );
    let (_, list) = request(client, "REPORT", calendar, "1", &body, auth).await?;
    Ok(list.into_iter().filter_map(|mut r| r.props.remove("calendar-data")).map(|p| p.text).filter(|t| !t.trim().is_empty()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_calendar_home_listing() {
        let xml = r#"<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
  <D:response><D:href>/cal/user/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype><D:displayname>Home</D:displayname></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response><D:href>/cal/user/work/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Work &amp; more</D:displayname><A:calendar-color>#FF9500FF</A:calendar-color>
      <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    <D:propstat><D:prop><D:getctag/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>
  </D:response>
  <D:response><D:href>/cal/user/tasks/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>"#;
        let r = multistatus(xml);
        assert_eq!(r.len(), 3);
        assert!(!r[0].is_calendar());
        assert!(r[1].is_calendar());
        assert_eq!(r[1].href, "/cal/user/work/");
        assert_eq!(r[1].props["displayname"].text, "Work & more");
        assert_eq!(r[1].props["calendar-color"].text, "#FF9500FF");
        assert_eq!(r[1].props["supported-calendar-component-set"].comps, ["VEVENT"]);
        assert!(!r[1].props.contains_key("getctag"));
        assert_eq!(r[2].props["supported-calendar-component-set"].comps, ["VTODO"]);
    }

    #[test]
    fn reads_principal_and_home_hrefs_and_calendar_data() {
        let xml = r#"<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><current-user-principal><href>/principals/me/</href></current-user-principal><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">https://p52-caldav.icloud.com/123/calendars/</href></calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>"#;
        let r = multistatus(xml);
        assert_eq!(r[0].href_of("current-user-principal"), Some("/principals/me/"));
        assert_eq!(r[0].href_of("calendar-home-set"), Some("https://p52-caldav.icloud.com/123/calendars/"));
        let xml = "<d:multistatus xmlns:d=\"DAV:\" xmlns:cal=\"urn:ietf:params:xml:ns:caldav\"><d:response><d:href>/c/1.ics</d:href><d:propstat><d:prop><cal:calendar-data><![CDATA[BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n]]></cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/c/2.ics</d:href><d:propstat><d:prop><cal:calendar-data>BEGIN:VCALENDAR&#13;\nSUMMARY:a &lt; b&#13;\nEND:VCALENDAR</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>";
        let r = multistatus(xml);
        // XML turns CR LF into LF; the iCalendar reader takes either.
        assert_eq!(r[0].props["calendar-data"].text, "BEGIN:VCALENDAR\nEND:VCALENDAR\n");
        assert_eq!(r[1].props["calendar-data"].text, "BEGIN:VCALENDAR\r\nSUMMARY:a < b\r\nEND:VCALENDAR");
    }

    #[test]
    fn hrefs_stay_on_the_server() {
        let base = Url::parse("https://caldav.icloud.com/").unwrap();
        assert!(join(&base, "https://p52-caldav.icloud.com/1/calendars/").is_ok());
        assert!(join(&base, "/1/principal/").is_ok());
        assert!(join(&base, "https://evil.example/").is_err());
        assert!(join(&base, "http://p52-caldav.icloud.com/").is_err());
        let bare = Url::parse("https://localhost:5232/").unwrap();
        assert!(join(&bare, "https://other:5232/").is_err());
    }
}
