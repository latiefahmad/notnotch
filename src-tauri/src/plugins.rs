//! Widget plugins: a folder with `notnotch-plugin.json` and its HTML, CSS and JS, shown as a tool in the open notch.
//!
//! Installing reads the folder or .zip into memory with every path checked (bundle.rs), writes it to a staging
//! folder and shows the user the manifest and its permissions; only a confirmation moves it to
//! `<app data>/plugins/<id>/`. Its storage lives apart, in `<app data>/plugin-data/<id>/`, so its pages can never
//! load it as a file.
//!
//! The page runs in an `<iframe sandbox="allow-scripts">` (an opaque origin, no same-origin access to NotNotch) served
//! by the `notnotchplugin` protocol below, only from the plugin's own folder and only to the notch webview, with a CSP
//! that allows no network at all. Everything else goes through postMessage to NotNotch's frontend
//! (src/features/plugins), which checks each message and calls the commands here: storage scoped to the plugin and
//! capped, and fetch over https to the domains the manifest declares, checked again here, resolved to public
//! addresses only and limited in size and time. Tauri's own bridge is injected into the main frame only, so a plugin
//! page cannot call a command directly.

mod bundle;
mod manifest;
mod storage;

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::http::{header, Response, StatusCode};
#[cfg(windows)]
use tauri::WebviewWindow;
use tauri::{AppHandle, State};

pub use manifest::Manifest;

pub const SCHEME: &str = "notnotchplugin";
/// How the notch webview reaches the scheme on Windows (wry maps custom schemes to http://<scheme>.localhost).
const ORIGIN: &str = "http://notnotchplugin.localhost";
const SDK_PATH: &str = ".notnotch/sdk.js";
const SDK: &str = include_str!("plugins/sdk.js");
const MAX_REQUEST_BODY: usize = 64 * 1024;
const MAX_RESPONSE: usize = 1024 * 1024;
const MAX_HEADERS: usize = 16;

#[derive(Default)]
pub struct PluginsState {
    /// Staged installs waiting for the user's answer: token → (folder, manifest).
    staged: Mutex<HashMap<String, (PathBuf, Manifest)>>,
    /// Storage files are read, changed and written one at a time.
    storage: Mutex<()>,
}

static NEXT: AtomicU64 = AtomicU64::new(1);

fn plugins_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::portable::app_data_dir(app).map(|d| d.join("plugins")).map_err(|_| "app-data".to_string())
}

fn data_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    crate::portable::app_data_dir(app).map(|d| d.join("plugin-data").join(id)).map_err(|_| "app-data".to_string())
}

/// The manifest of an installed plugin, read and checked again from disk (never taken from the frontend).
fn installed(app: &AppHandle, id: &str) -> Result<Manifest, String> {
    if !manifest::valid_id(id) {
        return Err("not-installed".into());
    }
    let bytes = fs::read(plugins_dir(app)?.join(id).join(manifest::MANIFEST)).map_err(|_| "not-installed")?;
    let m = manifest::parse(&bytes)?;
    if m.id != id {
        return Err("not-installed".into());
    }
    Ok(m)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    token: String,
    manifest: Manifest,
    /// The version already installed under the same id, which this one would replace.
    replaces: Option<String>,
}

/// Staging and replaced folders carry the process id, so leftovers of an earlier run can be told apart.
fn token() -> String {
    format!("{:x}-{:x}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed))
}

/// The installed plugins, by name. What an earlier run left half installed is removed.
#[tauri::command]
pub fn plugins_list(app: AppHandle) -> Vec<Manifest> {
    let Ok(dir) = plugins_dir(&app) else { return vec![] };
    let Ok(entries) = fs::read_dir(&dir) else { return vec![] };
    let this_run = format!("-{:x}-", std::process::id());
    let mut list = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            if !name.contains(&this_run) {
                let _ = fs::remove_dir_all(e.path());
            }
            continue;
        }
        if let Ok(m) = installed(&app, &name) {
            list.push(m);
        }
    }
    list.sort_by_key(|m| m.name.to_lowercase());
    list
}

/// Shows the system's folder or file picker over the notch; the chosen path, None when cancelled.
#[cfg(windows)]
#[tauri::command]
pub async fn plugins_pick(zip: bool, window: WebviewWindow) -> Option<String> {
    let owner = window.hwnd().ok()?.0 as isize;
    let (tx, rx) = tokio::sync::oneshot::channel();
    // The dialog needs a thread of its own in a single-threaded COM apartment.
    std::thread::spawn(move || {
        let _ = tx.send(pick(zip, owner));
    });
    rx.await.ok().flatten()
}

/// The same with AppKit's picker, through AppleScript; cancelling ends osascript with an error.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn plugins_pick(zip: bool) -> Option<String> {
    let script = if zip { "POSIX path of (choose file of type {\"zip\"})" } else { "POSIX path of (choose folder)" };
    let out = tauri::async_runtime::spawn_blocking(move || std::process::Command::new("osascript").arg("-e").arg(script).output()).await.ok()?.ok()?;
    let path = String::from_utf8(out.stdout).ok()?.trim_end().to_string();
    (out.status.success() && !path.is_empty()).then_some(path)
}

#[cfg(windows)]
fn pick(zip: bool, owner: isize) -> Option<String> {
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::{FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, SIGDN_FILESYSPATH};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let result = (|| {
            let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
            let mut options = dialog.GetOptions().ok()? | FOS_FORCEFILESYSTEM;
            if zip {
                dialog.SetFileTypes(&[COMDLG_FILTERSPEC { pszName: w!("NotNotch plugin (*.zip)"), pszSpec: w!("*.zip") }]).ok()?;
            } else {
                options |= FOS_PICKFOLDERS;
            }
            dialog.SetOptions(options).ok()?;
            // Cancelling returns an error.
            dialog.Show(Some(HWND(owner as *mut _))).ok()?;
            let path = dialog.GetResult().ok()?.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
            let text = path.to_string().ok();
            CoTaskMemFree(Some(path.0 as _));
            text
        })();
        CoUninitialize();
        result
    }
}

/// Reads a folder or .zip, checks it and writes it to a staging folder; nothing is installed yet. The settings page
/// shows the manifest and asks; plugins_commit or plugins_discard follows.
#[tauri::command]
pub async fn plugins_stage(path: String, app: AppHandle, state: State<'_, PluginsState>) -> Result<Staged, String> {
    let source = PathBuf::from(&path);
    let root = plugins_dir(&app)?;
    let token = token();
    let target = root.join(format!(".staging-{token}"));
    let staged_at = target.clone();
    let manifest = tauri::async_runtime::spawn_blocking(move || -> Result<Manifest, String> {
        let is_zip = source.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip"));
        let bundle = if is_zip { bundle::from_zip(&source)? } else { bundle::from_dir(&source)? };
        fs::create_dir_all(&root).map_err(|_| "write")?;
        bundle::write(&bundle, &target).map_err(|_| {
            let _ = fs::remove_dir_all(&target);
            "write".to_string()
        })?;
        Ok(bundle.manifest)
    })
    .await
    .map_err(|_| "failed")??;
    let replaces = installed(&app, &manifest.id).ok().map(|m| m.version);
    state.staged.lock().unwrap().insert(token.clone(), (staged_at, manifest.clone()));
    Ok(Staged { token, manifest, replaces })
}

/// Installs what was staged under `token`, replacing an installed version of the same id (its storage stays).
#[tauri::command]
pub fn plugins_commit(token: String, app: AppHandle, state: State<'_, PluginsState>) -> Result<Manifest, String> {
    let (staged, manifest) = state.staged.lock().unwrap().remove(&token).ok_or("expired")?;
    let root = plugins_dir(&app)?;
    let target = root.join(&manifest.id);
    let old = root.join(format!(".old-{}", self::token()));
    let had_old = target.exists();
    if had_old {
        fs::rename(&target, &old).map_err(|_| "in-use")?;
    }
    if fs::rename(&staged, &target).is_err() {
        if had_old {
            let _ = fs::rename(&old, &target);
        }
        let _ = fs::remove_dir_all(&staged);
        return Err("write".into());
    }
    if had_old {
        let _ = fs::remove_dir_all(&old);
    }
    Ok(manifest)
}

#[tauri::command]
pub fn plugins_discard(token: String, state: State<'_, PluginsState>) {
    if let Some((dir, _)) = state.staged.lock().unwrap().remove(&token) {
        let _ = fs::remove_dir_all(dir);
    }
}

/// Removes a plugin and its storage.
#[tauri::command]
pub fn plugins_remove(id: String, app: AppHandle) -> Result<(), String> {
    if !manifest::valid_id(&id) {
        return Err("not-installed".into());
    }
    let dir = plugins_dir(&app)?.join(&id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|_| "in-use")?;
    }
    let data = data_dir(&app, &id)?;
    if data.exists() {
        fs::remove_dir_all(&data).map_err(|_| "in-use")?;
    }
    Ok(())
}

/// One storage operation for a plugin that declared `storage`.
#[tauri::command]
pub fn plugins_storage(id: String, op: storage::Op, app: AppHandle, state: State<'_, PluginsState>) -> Result<Value, String> {
    if !installed(&app, &id)?.permissions.storage {
        return Err("permission".into());
    }
    let _one_at_a_time = state.storage.lock().unwrap();
    let dir = data_dir(&app, &id)?;
    let file = dir.join("storage.json");
    // Only a missing file is empty storage: one that can't be read or parsed must not be replaced by the next set.
    let mut map: Map<String, Value> = match fs::read(&file) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "storage-unreadable")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(_) => return Err("storage-unreadable".into()),
    };
    let (result, changed) = storage::apply(&mut map, op)?;
    if changed {
        fs::create_dir_all(&dir).map_err(|_| "write")?;
        crate::write_atomic(&file, &serde_json::to_vec(&map).map_err(|_| "write")?).map_err(|_| "write")?;
    }
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FetchRequest {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResponse {
    status: u16,
    content_type: String,
    body: String,
}

/// Headers a plugin may not set: they belong to the connection, would claim another origin, or carry cookies.
fn header_allowed(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    !n.is_empty()
        && n.len() <= 64
        && n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !matches!(
            n.as_str(),
            "host" | "cookie" | "cookie2" | "origin" | "referer" | "connection" | "content-length" | "transfer-encoding" | "te" | "trailer" | "upgrade"
                | "keep-alive" | "expect" | "via" | "forwarded"
        )
        && !n.starts_with("proxy-")
        && !n.starts_with("sec-")
        && !n.starts_with("x-forwarded-")
}

fn check_fetch(req: &FetchRequest, domains: &[String]) -> Result<(reqwest::Url, reqwest::Method), &'static str> {
    let url = manifest::allowed_url(&req.url, domains)?;
    let method = match req.method.as_deref().unwrap_or("GET") {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("method"),
    };
    if req.headers.len() > MAX_HEADERS || req.headers.iter().any(|(k, v)| !header_allowed(k) || v.len() > 2048 || v.chars().any(char::is_control)) {
        return Err("header");
    }
    if req.body.as_ref().is_some_and(|b| b.len() > MAX_REQUEST_BODY) {
        return Err("body-too-large");
    }
    Ok((url, method))
}

/// A request for a plugin that declared the URL's host. The name is resolved here and every address checked
/// (no loopback, private, link-local or reserved ones), and the connection is pinned to those addresses, so a name
/// that changes its answer in between cannot lead to the local network. No proxy, no cookies, no redirects.
#[tauri::command]
pub async fn plugins_fetch(id: String, request: FetchRequest, app: AppHandle) -> Result<FetchResponse, String> {
    let m = installed(&app, &id)?;
    let (url, method) = check_fetch(&request, &m.permissions.network)?;
    let host = url.host_str().ok_or("bad-url")?.to_string();
    let addrs: Vec<std::net::SocketAddr> = tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((host.as_str(), 443)))
        .await
        .map_err(|_| "timeout")?
        .map_err(|_| "offline")?
        .collect();
    if addrs.is_empty() {
        return Err("offline".into());
    }
    if addrs.iter().any(|a| !manifest::public_ip(a.ip())) {
        return Err("private-address".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .resolve_to_addrs(&host, &addrs)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .user_agent("NotNotch-Plugin")
        .build()
        .map_err(|_| "failed")?;
    let mut builder = client.request(method, url);
    for (k, v) in &request.headers {
        builder = builder.header(k.as_str(), v.as_str());
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }
    let mut response = builder.send().await.map_err(|e| if e.is_timeout() { "timeout" } else { "offline" })?;
    if response.content_length().is_some_and(|n| n as usize > MAX_RESPONSE) {
        return Err("too-large".into());
    }
    let status = response.status().as_u16();
    let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").chars().take(128).collect();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| if e.is_timeout() { "timeout" } else { "offline" })? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_RESPONSE {
            return Err("too-large".into());
        }
    }
    Ok(FetchResponse { status, content_type, body: String::from_utf8_lossy(&body).into_owned() })
}

/// The CSP of every plugin response: scripts, styles, images, fonts and media only from the plugin's own folder,
/// no connections, frames, workers, forms or plugins, and the document sandboxed even if it were loaded outside
/// its iframe.
fn csp(id: &str) -> String {
    let own = format!("{ORIGIN}/{id}/");
    format!(
        "default-src 'none'; script-src {own}; style-src {own} 'unsafe-inline'; img-src {own} data: blob:; font-src {own} data:; \
         media-src {own} data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; \
         manifest-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts"
    )
}

fn content_type(name: &str) -> &'static str {
    match bundle::extension(name).as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "text/plain; charset=utf-8",
    }
}

/// The SDK goes first in the page: right after a doctype, or with one added in front.
fn inject(html: &[u8], tag: &str) -> Vec<u8> {
    let start = html.iter().position(|b| !b.is_ascii_whitespace() && !matches!(b, 0xEF | 0xBB | 0xBF)).unwrap_or(html.len());
    let rest = &html[start..];
    let at = if rest.len() >= 9 && rest[..9].eq_ignore_ascii_case(b"<!doctype") { rest.iter().position(|&b| b == b'>').map(|i| start + i + 1) } else { None };
    let mut out = Vec::with_capacity(html.len() + tag.len() + 16);
    match at {
        Some(i) => {
            out.extend_from_slice(&html[..i]);
            out.extend_from_slice(tag.as_bytes());
            out.extend_from_slice(&html[i..]);
        }
        None => {
            out.extend_from_slice(b"<!doctype html>");
            out.extend_from_slice(tag.as_bytes());
            out.extend_from_slice(html);
        }
    }
    out
}

/// What the protocol answers for `/<id>/<path>`: (status, content type, body); None for the plugin to get a 404.
fn resolve(root: &Path, path: &str) -> Option<(String, &'static str, Vec<u8>)> {
    let (id, rest) = path.trim_start_matches('/').split_once('/')?;
    if !manifest::valid_id(id) {
        return None;
    }
    let dir = root.join(id);
    if !dir.join(manifest::MANIFEST).is_file() {
        return None;
    }
    if rest == SDK_PATH {
        return Some((id.to_string(), "text/javascript; charset=utf-8", SDK.as_bytes().to_vec()));
    }
    let parts = manifest::rel_path(rest)?;
    let file = parts.iter().fold(dir, |p, c| p.join(c));
    let meta = fs::symlink_metadata(&file).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > bundle::MAX_FILE {
        return None;
    }
    let name = parts.last()?;
    let ext = bundle::extension(name);
    if name.contains('.') && !bundle::EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    let bytes = fs::read(&file).ok()?;
    let ct = content_type(name);
    let body = if ext == "html" { inject(&bytes, &format!(r#"<script src="{ORIGIN}/{id}/{SDK_PATH}"></script>"#)) } else { bytes };
    Some((id.to_string(), ct, body))
}

/// The `notnotchplugin` protocol. Only the notch webview gets an answer.
pub fn protocol(app: &AppHandle, webview: &str, request: &tauri::http::Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path().to_string();
    let found = (webview == "notch").then(|| plugins_dir(app).ok()).flatten().and_then(|root| resolve(&root, &path));
    let id = path.trim_start_matches('/').split('/').next().filter(|id| manifest::valid_id(id)).unwrap_or("none").to_string();
    let (status, ct, body) = match found {
        Some((_, ct, body)) => (StatusCode::OK, ct, body),
        None => (StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"Not found".to_vec()),
    };
    let mut r = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, ct)
        .header(header::CONTENT_SECURITY_POLICY, csp(&id))
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-DNS-Prefetch-Control", "off")
        .header(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), fullscreen=()",
        );
    // Module scripts load in cors mode from the page's opaque origin.
    if ct.starts_with("text/javascript") {
        r = r.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "null");
    }
    r.body(body).unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sdk_goes_first() {
        let tag = "<script src=\"sdk\"></script>";
        assert_eq!(inject(b"<!DOCTYPE html><html><script>x</script>", tag), b"<!DOCTYPE html><script src=\"sdk\"></script><html><script>x</script>".to_vec());
        assert_eq!(inject(b"\xEF\xBB\xBF\n<!doctype html>\n<p>", tag), b"\xEF\xBB\xBF\n<!doctype html><script src=\"sdk\"></script>\n<p>".to_vec());
        // A page whose first script comes before any head still gets the SDK ahead of it.
        assert_eq!(inject(b"<script>evil()</script><head>", tag), b"<!doctype html><script src=\"sdk\"></script><script>evil()</script><head>".to_vec());
    }

    #[test]
    fn csp_is_closed() {
        let c = csp("hello-notnotch");
        assert!(c.contains("connect-src 'none'") && c.contains("default-src 'none'") && c.contains("frame-src 'none'") && c.contains("sandbox allow-scripts"));
        assert!(c.contains("script-src http://notnotchplugin.localhost/hello-notnotch/;"));
        assert!(!c.contains("unsafe-eval") && !c.contains("script-src 'self'"));
    }

    #[test]
    fn serves_only_its_folder() {
        let root = std::env::temp_dir().join(format!("notnotch-protocol-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = root.join("hello-notnotch");
        fs::create_dir_all(dir.join("js")).unwrap();
        fs::write(dir.join(manifest::MANIFEST), "{}").unwrap();
        fs::write(dir.join("index.html"), "<!doctype html><p>").unwrap();
        fs::write(dir.join("js").join("app.js"), "1").unwrap();
        fs::write(root.join("secret.txt"), "x").unwrap();
        let (_, ct, body) = resolve(&root, "/hello-notnotch/index.html").unwrap();
        assert_eq!(ct, "text/html; charset=utf-8");
        assert!(String::from_utf8(body).unwrap().contains(".notnotch/sdk.js"));
        assert_eq!(resolve(&root, "/hello-notnotch/js/app.js").unwrap().2, b"1");
        assert!(resolve(&root, "/hello-notnotch/.notnotch/sdk.js").unwrap().2.starts_with(b"// NotNotch plugin API"));
        for bad in ["/hello-notnotch/../secret.txt", "/hello-notnotch/..%2fsecret.txt", "/hello-notnotch/%2e%2e/secret.txt", "/../secret.txt", "/hello-notnotch/js",
            "/hello-notnotch/", "/hello-notnotch", "/other/index.html", "/HELLO-NOTNOTCH/index.html", "/hello-notnotch/js\\app.js", "/hello-notnotch/js//app.js", "/hello-notnotch/.notnotch/other.js"]
        {
            assert!(resolve(&root, bad).is_none(), "{bad}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn fetch_checks() {
        let d = vec!["api.github.com".to_string()];
        let req = |url: &str, method: Option<&str>, headers: &[(&str, &str)], body: Option<usize>| FetchRequest {
            url: url.into(),
            method: method.map(Into::into),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body: body.map(|n| "x".repeat(n)),
        };
        assert!(check_fetch(&req("https://api.github.com/zen", None, &[("Accept", "text/plain")], None), &d).is_ok());
        assert!(check_fetch(&req("https://api.github.com/x", Some("POST"), &[("authorization", "Bearer t")], Some(10)), &d).is_ok());
        assert_eq!(check_fetch(&req("https://evil.com/", None, &[], None), &d).err(), Some("domain"));
        assert_eq!(check_fetch(&req("https://api.github.com/", Some("CONNECT"), &[], None), &d).err(), Some("method"));
        assert_eq!(check_fetch(&req("https://api.github.com/", Some("get"), &[], None), &d).err(), Some("method"));
        for h in ["Cookie", "Host", "Origin", "Proxy-Authorization", "Sec-Fetch-Site", "X-Forwarded-For", "bad header", ""] {
            assert_eq!(check_fetch(&req("https://api.github.com/", None, &[(h, "x")], None), &d).err(), Some("header"), "{h}");
        }
        assert_eq!(check_fetch(&req("https://api.github.com/", None, &[("x-a", "a\r\nHost: evil")], None), &d).err(), Some("header"));
        let many: Vec<(String, String)> = (0..=MAX_HEADERS).map(|i| (format!("x-{i}"), "v".into())).collect();
        let many: Vec<(&str, &str)> = many.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(check_fetch(&req("https://api.github.com/", None, &many, None), &d).err(), Some("header"));
        assert_eq!(check_fetch(&req("https://api.github.com/", Some("POST"), &[], Some(MAX_REQUEST_BODY + 1)), &d).err(), Some("body-too-large"));
    }
}
