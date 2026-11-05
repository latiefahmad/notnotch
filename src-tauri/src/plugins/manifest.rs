//! The plugin manifest (`notnotch-plugin.json`) and the checks every plugin path, domain and URL goes through.
//! Everything is strict: an unknown field, a value out of range or a doubtful path refuses the whole plugin.

use std::net::{IpAddr, Ipv4Addr};

use reqwest::Url;
use serde::{Deserialize, Serialize};

pub const MANIFEST: &str = "notnotch-plugin.json";
const MAX_MANIFEST: usize = 16 * 1024;
pub const MAX_DOMAINS: usize = 8;
/// The open panel's size for the plugin, header and dock included (the window allows 740 x 540, src/notch/size.ts).
pub const MIN_W: u32 = 320;
pub const MAX_W: u32 = 740;
pub const MIN_H: u32 = 160;
pub const MAX_H: u32 = 540;
/// Path components and depth inside a plugin folder.
const MAX_COMPONENT: usize = 64;
const MAX_DEPTH: usize = 8;
const MAX_PATH: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub description: String,
    /// One of notify_wire::ICONS.
    #[serde(default = "default_icon")]
    pub icon: String,
    /// The page the tool opens, relative to the plugin folder.
    pub entry: String,
    pub size: Size,
    #[serde(default)]
    pub permissions: Permissions,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Size {
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Permissions {
    /// Host names the plugin may fetch from (https only, exact match).
    #[serde(default)]
    pub network: Vec<String>,
    #[serde(default)]
    pub storage: bool,
    #[serde(default)]
    pub notices: bool,
}

fn default_icon() -> String {
    "puzzle".into()
}

/// Reads and checks a manifest. Errors are short codes the settings page words.
pub fn parse(bytes: &[u8]) -> Result<Manifest, String> {
    if bytes.len() > MAX_MANIFEST {
        return Err("manifest-size".into());
    }
    let m: Manifest = serde_json::from_slice(bytes).map_err(|_| "manifest-json".to_string())?;
    check(&m)?;
    Ok(m)
}

fn check(m: &Manifest) -> Result<(), &'static str> {
    if !valid_id(&m.id) {
        return Err("id");
    }
    if !plain(&m.name, 1, 40) {
        return Err("name");
    }
    let parts: Vec<&str> = m.version.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit())) {
        return Err("version");
    }
    if !plain(&m.author, 0, 60) {
        return Err("author");
    }
    if !plain(&m.description, 0, 200) {
        return Err("description");
    }
    if !crate::notify_wire::ICONS.contains(&m.icon.as_str()) {
        return Err("icon");
    }
    if rel_path(&m.entry).is_none() || !m.entry.ends_with(".html") {
        return Err("entry");
    }
    if !(MIN_W..=MAX_W).contains(&m.size.w) || !(MIN_H..=MAX_H).contains(&m.size.h) {
        return Err("size");
    }
    let net = &m.permissions.network;
    if net.len() > MAX_DOMAINS {
        return Err("too-many-domains");
    }
    if net.iter().any(|d| !valid_domain(d)) || net.iter().enumerate().any(|(i, d)| net[..i].contains(d)) {
        return Err("domain");
    }
    Ok(())
}

/// 3 to 32 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit.
pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    (3..=32).contains(&b.len())
        && b.iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
}

/// Text shown in NotNotch: within the length, no control characters, no bidirectional overrides, no surrounding space.
fn plain(s: &str, min: usize, max: usize) -> bool {
    let n = s.chars().count();
    (min..=max).contains(&n)
        && s.trim() == s
        && !s.chars().any(|c| c.is_control() || matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'))
}

/// One name in a plugin folder: letters, digits, `.`, `_` and `-`, not starting or ending with a dot, and not a
/// name Windows reserves for a device (CON, NUL, COM1, also with an extension).
pub fn valid_component(c: &str) -> bool {
    if c.is_empty() || c.len() > MAX_COMPONENT || c.starts_with('.') || c.ends_with('.') {
        return false;
    }
    if !c.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) {
        return false;
    }
    let stem = c.split('.').next().unwrap_or("").to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    !device
}

/// A relative path inside a plugin folder with `/` between names, as its components. None for anything that could
/// leave the folder or alias another name: `..`, `.`, a root, a drive, a backslash, `%`, an empty component.
pub fn rel_path(p: &str) -> Option<Vec<&str>> {
    if p.is_empty() || p.len() > MAX_PATH {
        return None;
    }
    let parts: Vec<&str> = p.split('/').collect();
    (parts.len() <= MAX_DEPTH && parts.iter().all(|c| valid_component(c))).then_some(parts)
}

/// A host name a plugin may declare: lowercase ASCII labels (punycode for other scripts), at least two of them, a
/// top-level label that starts with a letter (so no IPv4 literal), no port, wildcard, trailing dot or local name.
pub fn valid_domain(d: &str) -> bool {
    if d.is_empty() || d.len() > 253 {
        return false;
    }
    let labels: Vec<&str> = d.split('.').collect();
    let label_ok = |l: &&str| {
        (1..=63).contains(&l.len())
            && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !l.starts_with('-')
            && !l.ends_with('-')
    };
    let Some(tld) = labels.last() else { return false };
    labels.len() >= 2
        && labels.iter().all(label_ok)
        && tld.as_bytes()[0].is_ascii_lowercase()
        && !matches!(*tld, "localhost" | "local" | "internal" | "arpa" | "lan" | "home" | "test" | "invalid")
}

/// The URL a plugin asked for, when it is https on the default port to one of its declared hosts exactly (a
/// subdomain, a look-alike or an IP address is refused), without a user name or password.
pub fn allowed_url(raw: &str, domains: &[String]) -> Result<Url, &'static str> {
    if raw.len() > 2048 {
        return Err("bad-url");
    }
    let url = Url::parse(raw).map_err(|_| "bad-url")?;
    if url.scheme() != "https" {
        return Err("https-only");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("bad-url");
    }
    // The parser drops an explicit :443, so any port left is another one.
    if url.port().is_some() {
        return Err("port");
    }
    // domain() is None for an IP address.
    match url.domain() {
        Some(host) if domains.iter().any(|d| d == host) => Ok(url),
        Some(_) => Err("domain"),
        None => Err("ip-literal"),
    }
}

/// An address a plugin's request may reach: not this PC, the local network, link-local, carrier NAT, multicast or a
/// reserved range. Checked on what the name resolves to, so a declared domain pointing at 192.168.0.1 is refused.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return public_v4(v4);
            }
            let s = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // link-local
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || (s[0] == 0x0064 && s[1] == 0xff9b) // NAT64, reaches IPv4 hosts
                || s[..6] == [0; 6]) // IPv4-compatible and other ::/96
        }
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        || a >= 240
        || (a == 100 && (64..128).contains(&b)) // carrier NAT
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (b == 18 || b == 19)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> serde_json::Value {
        serde_json::json!({
            "id": "hello-notnotch", "name": "Hello NotNotch", "version": "1.0.0", "author": "latiefahmad", "description": "A sample",
            "icon": "rocket", "entry": "index.html", "size": { "w": 520, "h": 260 },
            "permissions": { "network": ["api.github.com"], "storage": true, "notices": true }
        })
    }

    fn with(change: impl FnOnce(&mut serde_json::Value)) -> Result<Manifest, String> {
        let mut v = sample();
        change(&mut v);
        parse(&serde_json::to_vec(&v).unwrap())
    }

    #[test]
    fn manifest_ok() {
        let m = with(|_| {}).unwrap();
        assert_eq!((m.id.as_str(), m.size, m.permissions.network.len()), ("hello-notnotch", Size { w: 520, h: 260 }, 1));
        // Optional fields have defaults.
        let m = with(|v| {
            let o = v.as_object_mut().unwrap();
            for k in ["author", "description", "icon", "permissions"] {
                o.remove(k);
            }
        })
        .unwrap();
        assert_eq!((m.icon.as_str(), m.permissions.clone()), ("puzzle", Permissions::default()));
    }

    #[test]
    fn manifest_refused() {
        let code = |r: Result<Manifest, String>| r.unwrap_err();
        assert_eq!(code(parse(b"{nope")), "manifest-json");
        assert_eq!(code(parse(&vec![b' '; MAX_MANIFEST + 1])), "manifest-size");
        assert_eq!(code(with(|v| v["extra"] = 1.into())), "manifest-json");
        assert_eq!(code(with(|v| v["permissions"]["clipboard"] = true.into())), "manifest-json");
        assert_eq!(code(with(|v| v["size"]["w"] = 520.5.into())), "manifest-json");
        assert_eq!(code(with(|v| v["size"]["w"] = (-1).into())), "manifest-json");
        for id in ["ab", "Hello", "hello_notnotch", "-hello", "hello-", "a".repeat(33).as_str(), "../x", "hello notnotch"] {
            assert_eq!(code(with(|v| v["id"] = id.into())), "id", "{id}");
        }
        assert_eq!(code(with(|v| v["name"] = "".into())), "name");
        assert_eq!(code(with(|v| v["name"] = " Padded".into())), "name");
        assert_eq!(code(with(|v| v["name"] = "Evil\u{202e}gnp".into())), "name");
        assert_eq!(code(with(|v| v["name"] = "a".repeat(41).into())), "name");
        for version in ["1.0", "1.0.0-beta", "v1.0.0", "1..0", "123456.0.0"] {
            assert_eq!(code(with(|v| v["version"] = version.into())), "version", "{version}");
        }
        assert_eq!(code(with(|v| v["icon"] = "https://x.example/i.png".into())), "icon");
        for entry in ["../index.html", "/index.html", "C:/index.html", "a\\index.html", "index.js", "./index.html", "%2e%2e/index.html", ""] {
            assert_eq!(code(with(|v| v["entry"] = entry.into())), "entry", "{entry}");
        }
        assert_eq!(code(with(|v| v["size"]["w"] = 1000.into())), "size");
        assert_eq!(code(with(|v| v["size"]["h"] = 10.into())), "size");
        assert_eq!(code(with(|v| v["permissions"]["network"] = serde_json::json!(["a.com", "a.com"]))), "domain");
        assert_eq!(code(with(|v| v["permissions"]["network"] = serde_json::json!(["https://a.com"]))), "domain");
        let many: Vec<String> = (0..9).map(|i| format!("d{i}.example.com")).collect();
        assert_eq!(code(with(|v| v["permissions"]["network"] = serde_json::json!(many))), "too-many-domains");
    }

    #[test]
    fn components_and_paths() {
        for ok in ["index.html", "app.js", "LICENSE", "img-1_x.png", "a.b.c"] {
            assert!(valid_component(ok), "{ok}");
        }
        for bad in ["", ".", "..", ".git", "a.", "a b", "a%2f", "a:b", "a\\b", "CON", "con.txt", "Nul", "COM1", "lpt9.js", "é.js", &"a".repeat(65)] {
            assert!(!valid_component(bad), "{bad}");
        }
        assert!(valid_component("console.js"), "only the exact device names are reserved");
        assert_eq!(rel_path("a/b/c.js"), Some(vec!["a", "b", "c.js"]));
        for bad in ["", "/a", "a/", "a//b", "../a", "a/../b", "a/./b", "C:/a", "\\\\server\\a", "a/b/c/d/e/f/g/h/i.js"] {
            assert!(rel_path(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn domains() {
        for ok in ["example.com", "api.github.com", "xn--bcher-kva.example", "a-b.co", "1password.com"] {
            assert!(valid_domain(ok), "{ok}");
        }
        for bad in ["", "com", "Example.com", "example.com.", ".example.com", "*.example.com", "example.com:443", "127.0.0.1", "1.2.3.4",
            "[::1]", "-a.com", "a-.com", "localhost", "ipc.localhost", "printer.local", "x.internal", "a..com", "exa mple.com", "example.123"]
        {
            assert!(!valid_domain(bad), "{bad}");
        }
    }

    #[test]
    fn url_allowlist() {
        let d = vec!["example.com".to_string()];
        assert!(allowed_url("https://example.com/a?b=c", &d).is_ok());
        assert!(allowed_url("https://EXAMPLE.com/", &d).is_ok(), "hosts are compared lowercased");
        assert!(allowed_url("https://example.com:443/", &d).is_ok(), "the default port is the same host");
        assert_eq!(allowed_url("https://evil-example.com/", &d).unwrap_err(), "domain");
        assert_eq!(allowed_url("https://example.com.evil.com/", &d).unwrap_err(), "domain");
        assert_eq!(allowed_url("https://evilexample.com/", &d).unwrap_err(), "domain");
        assert_eq!(allowed_url("https://sub.example.com/", &d).unwrap_err(), "domain");
        assert_eq!(allowed_url("https://example.com./", &d).unwrap_err(), "domain");
        assert!(allowed_url("https://example.com%2eevil.com/", &d).is_err());
        assert_eq!(allowed_url("http://example.com/", &d).unwrap_err(), "https-only");
        assert_eq!(allowed_url("wss://example.com/", &d).unwrap_err(), "https-only");
        assert_eq!(allowed_url("https://example.com:8443/", &d).unwrap_err(), "port");
        assert_eq!(allowed_url("https://user:pw@example.com/", &d).unwrap_err(), "bad-url");
        assert_eq!(allowed_url("https://example.com@evil.com/", &d).unwrap_err(), "bad-url");
        assert_eq!(allowed_url("https://127.0.0.1/", &d).unwrap_err(), "ip-literal");
        assert_eq!(allowed_url("https://2130706433/", &d).unwrap_err(), "ip-literal");
        assert_eq!(allowed_url("https://0x7f.1/", &d).unwrap_err(), "ip-literal");
        assert_eq!(allowed_url("https://[::1]/", &d).unwrap_err(), "ip-literal");
        assert_eq!(allowed_url("not a url", &d).unwrap_err(), "bad-url");
        assert_eq!(allowed_url("https://example.com/", &[]).unwrap_err(), "domain");
    }

    #[test]
    fn addresses() {
        for public in ["140.82.112.6", "1.1.1.1", "2606:4700::1111", "::ffff:140.82.112.6"] {
            assert!(public_ip(public.parse().unwrap()), "{public}");
        }
        for private in ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255",
            "224.0.0.1", "240.0.0.1", "198.18.0.1", "::1", "::", "fe80::1", "fd00::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:192.168.0.1",
            "64:ff9b::7f00:1", "::127.0.0.1", "2001:db8::1", "ff02::1"]
        {
            assert!(!public_ip(private.parse().unwrap()), "{private}");
        }
    }
}
