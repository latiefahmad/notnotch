//! App launcher: the Start menu's app list, icons, launching, and Alt+1..6.
//!
//! - List: `shell:AppsFolder` (the Start menu's "All apps": desktop shortcuts and Store
//!   packages alike). An entry's id is `shell:AppsFolder\<parsing name>`, which the shell
//!   opens directly. App Paths in the registry add exe paths (the frontend uses them only to
//!   find AI apps missing from the Start menu).
//! - Icons: `IShellItemImageFactory` for both kinds, as PNG data URLs, cached per id.
//! - Launch: only ids from the list, so the WebView cannot start an arbitrary command.
//! - Shortcuts: Alt+1..6, registered and dispatched by shell.rs with NotNotch's other shortcuts.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS, SIZE};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
};
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
};
use windows::Win32::UI::Shell::{
    BHID_EnumItems, FOLDERID_AppsFolder, IEnumShellItems, IShellItem, IShellItemImageFactory, SHCreateItemFromParsingName, SHGetKnownFolderItem,
    ShellExecuteW, KF_FLAG_DEFAULT, SIGDN, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING, SIIGBF_ICONONLY,
};
use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY, SW_SHOWNORMAL};

const APPS_PREFIX: &str = r"shell:AppsFolder\";
/// Icon edge in device pixels: 32 CSS px tiles on a 200 % screen.
const ICON_PX: i32 = 64;
const DIGITS: [Code; 6] = [Code::Digit1, Code::Digit2, Code::Digit3, Code::Digit4, Code::Digit5, Code::Digit6];

#[derive(Clone, Serialize)]
pub struct App {
    id: String,
    name: String,
    /// "start" or "apppaths".
    source: &'static str,
}

/// An unknown id reads the list again at most this often.
const RESCAN_GAP: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct LauncherState {
    apps: Mutex<Option<Vec<App>>>,
    /// When the list was last read.
    scanned: Mutex<Option<Instant>>,
    icons: Mutex<HashMap<String, Option<String>>>,
}

/// Runs COM work on its own STA thread: shell extensions expect one, and the async runtime's
/// threads are initialised as MTA elsewhere in the app.
fn on_sta<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    std::thread::spawn(move || unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).is_ok();
        let out = f();
        if init {
            CoUninitialize();
        }
        out
    })
    .join()
    .ok()
}

/// The Start list failing (or coming back empty) is an error: an empty list must not look like
/// "nothing installed", or the first-run seeding would pin nothing for good.
fn list_apps() -> Result<Vec<App>, String> {
    let mut apps = start_apps().map_err(|e| e.message())?;
    if apps.is_empty() {
        return Err("empty".into());
    }
    apps.extend(app_paths());
    Ok(apps)
}

unsafe fn display_name(item: &IShellItem, kind: SIGDN) -> Option<String> {
    let p: PWSTR = item.GetDisplayName(kind).ok()?;
    let s = p.to_string().ok();
    CoTaskMemFree(Some(p.0 as *const _));
    s
}

fn start_apps() -> windows::core::Result<Vec<App>> {
    unsafe {
        let folder: IShellItem = SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None)?;
        let items: IEnumShellItems = folder.BindToHandler(None, &BHID_EnumItems)?;
        let mut out = Vec::new();
        loop {
            let mut batch: [Option<IShellItem>; 32] = Default::default();
            let mut fetched = 0u32;
            let _ = items.Next(&mut batch, Some(&mut fetched));
            if fetched == 0 {
                break;
            }
            for item in batch.iter().take(fetched as usize).flatten() {
                let (Some(name), Some(id)) = (display_name(item, SIGDN_NORMALDISPLAY), display_name(item, SIGDN_PARENTRELATIVEPARSING)) else { continue };
                if !name.trim().is_empty() && !id.is_empty() {
                    out.push(App { id: format!("{APPS_PREFIX}{id}"), name, source: "start" });
                }
            }
        }
        Ok(out)
    }
}

/// `App Paths\<name>.exe` default values: the exe paths Windows finds by name (Win+R). Existing files only.
fn app_paths() -> Vec<App> {
    const KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths";
    let mut out: Vec<App> = Vec::new();
    for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let mut key = HKEY::default();
        if unsafe { RegOpenKeyExW(root, &HSTRING::from(KEY), Some(0), KEY_READ, &mut key) } != ERROR_SUCCESS {
            continue;
        }
        for i in 0.. {
            let mut buf = [0u16; 260];
            let mut len = buf.len() as u32;
            match unsafe { RegEnumKeyExW(key, i, Some(PWSTR(buf.as_mut_ptr())), &mut len, None, None, None, None) } {
                ERROR_SUCCESS => {}
                // A name longer than the buffer only skips that key.
                ERROR_MORE_DATA => continue,
                _ => break,
            }
            let sub = HSTRING::from_wide(&buf[..len as usize]);
            let mut value = [0u16; 1024];
            let mut size = (value.len() * 2) as u32;
            let ok = unsafe {
                RegGetValueW(key, &sub, PCWSTR::null(), RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ, None, Some(value.as_mut_ptr().cast()), Some(&mut size))
            } == ERROR_SUCCESS;
            if !ok {
                continue;
            }
            let chars = (size as usize / 2).min(value.len());
            let path = String::from_utf16_lossy(&value[..chars]).trim_end_matches('\0').trim().trim_matches('"').to_string();
            if path.is_empty() || !std::path::Path::new(&path).is_file() || out.iter().any(|a| a.id.eq_ignore_ascii_case(&path)) {
                continue;
            }
            out.push(App { name: crate::mixer::display_name(&path), id: path, source: "apppaths" });
        }
        let _ = unsafe { RegCloseKey(key) };
    }
    out
}

/// The cached list, read once if empty. A failed read is not cached.
fn apps(state: &LauncherState, refresh: bool) -> Result<Vec<App>, String> {
    if !refresh {
        if let Some(apps) = state.apps.lock().unwrap().clone() {
            return Ok(apps);
        }
    }
    // Stamped on the attempt, so a failing list is not read again on every Alt+N press.
    *state.scanned.lock().unwrap() = Some(Instant::now());
    let apps = on_sta(list_apps).ok_or("failed")??;
    *state.apps.lock().unwrap() = Some(apps.clone());
    Ok(apps)
}

fn is_known(state: &LauncherState, id: &str) -> bool {
    state.apps.lock().unwrap().as_ref().is_some_and(|apps| apps.iter().any(|a| a.id == id))
}

/// Blocking work (the list takes a moment, a few hundred entries) off the async runtime.
async fn blocking<T: Send + 'static>(app: AppHandle, f: impl FnOnce(&LauncherState) -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<LauncherState>())).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn launcher_apps(refresh: bool, app: AppHandle) -> Result<Vec<App>, String> {
    blocking(app, move |state| apps(state, refresh)).await?
}

/// Icons only for ids from the list, so no other path (a UNC share, say) reaches the shell.
#[tauri::command]
pub async fn launcher_icons(ids: Vec<String>, app: AppHandle) -> Result<HashMap<String, Option<String>>, String> {
    blocking(app, move |state| {
        apps(state, false)?;
        let ids: Vec<String> = ids.into_iter().filter(|id| is_known(state, id)).collect();
        let missing: Vec<String> = {
            let cache = state.icons.lock().unwrap();
            ids.iter().filter(|id| !cache.contains_key(*id)).cloned().collect()
        };
        if !missing.is_empty() {
            let fresh = on_sta(move || missing.into_iter().map(|id| (icon_png(&id), id)).map(|(icon, id)| (id, icon)).collect::<HashMap<_, _>>());
            state.icons.lock().unwrap().extend(fresh.unwrap_or_default());
        }
        let cache = state.icons.lock().unwrap();
        Ok(ids.into_iter().filter_map(|id| cache.get(&id).cloned().map(|icon| (id, icon))).collect())
    })
    .await?
}

#[tauri::command]
pub async fn launcher_open(id: String, app: AppHandle) -> Result<(), String> {
    blocking(app, move |state| open(state, id)).await?
}

fn open(state: &LauncherState, id: String) -> Result<(), String> {
    apps(state, false)?;
    // Not in the cached list: it may be new since. Read the list again, at most once a minute.
    if !is_known(state, &id) {
        let recent = state.scanned.lock().unwrap().is_some_and(|t| t.elapsed() < RESCAN_GAP);
        if recent || apps(state, true).is_err() || !is_known(state, &id) {
            return Err("not-found".into());
        }
    }
    let ok = on_sta(move || unsafe {
        // Lets an already running single-instance app (which only gets a message) take the foreground.
        let _ = AllowSetForegroundWindow(ASFW_ANY);
        ShellExecuteW(None, PCWSTR::null(), &HSTRING::from(id), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL).0 as isize > 32
    })
    .unwrap_or(false);
    if ok { Ok(()) } else { Err("failed".into()) }
}

/// Registers Alt+1.. for these ids (slot = index, at most six) through the shell's shortcut registry,
/// which frees the keys held before. Returns per slot whether Windows gave the key (false = another app holds it).
/// Not async: it runs on the main thread, where the plugin's hotkey window lives.
#[tauri::command]
pub fn launcher_shortcuts(ids: Vec<String>, app: AppHandle) -> Vec<bool> {
    crate::shell::bind_launch(&app, ids.into_iter().zip(DIGITS).map(|(id, code)| (Shortcut::new(Some(Modifiers::ALT), code), id)).collect())
}

/// An Alt+N key was pressed (dispatched by `shell::on_shortcut`).
pub fn launch_from_key(app: &AppHandle, id: String) {
    let app = app.clone();
    // Off the main thread: the first launch may have to read the app list.
    std::thread::spawn(move || {
        if open(&app.state::<LauncherState>(), id.clone()) == Err("not-found".into()) {
            // The frontend names the app; open the notch so the message is seen.
            let _ = app.emit("launcher://missing", id);
            crate::shell::open(&app, Some("launcher"));
        }
    });
}

/// The entry's icon as a PNG data URL (works for `shell:AppsFolder\…` ids and exe paths).
fn icon_png(id: &str) -> Option<String> {
    unsafe {
        let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(id), None).ok()?;
        let bitmap = factory.GetImage(SIZE { cx: ICON_PX, cy: ICON_PX }, SIIGBF_ICONONLY).ok()?;
        let png = bitmap_to_png(bitmap);
        let _ = DeleteObject(bitmap.into());
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png?)))
    }
}

/// 32-bit bitmap with premultiplied alpha (what the shell hands out) to a straight-alpha PNG.
unsafe fn bitmap_to_png(bitmap: HBITMAP) -> Option<Vec<u8>> {
    let mut bm = BITMAP::default();
    if GetObjectW(bitmap.into(), std::mem::size_of::<BITMAP>() as i32, Some((&mut bm as *mut BITMAP).cast())) == 0 {
        return None;
    }
    let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h, // top-down
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let mut px = vec![0u8; (w * h * 4) as usize];
    let dc = CreateCompatibleDC(None);
    let lines = GetDIBits(dc, bitmap, 0, h as u32, Some(px.as_mut_ptr().cast()), &mut bmi, DIB_RGB_COLORS);
    let _ = DeleteDC(dc);
    if lines == 0 {
        return None;
    }
    let no_alpha = px.chunks(4).all(|p| p[3] == 0);
    for p in px.chunks_mut(4) {
        p.swap(0, 2); // BGRA → RGBA
        if no_alpha {
            p[3] = 255;
        } else if p[3] > 0 && p[3] < 255 {
            let a = p[3] as u32;
            for c in &mut p[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    let img = image::RgbaImage::from_raw(w as u32, h as u32, px)?;
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    Some(png)
}
