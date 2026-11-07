//! Lower WebView2 memory while the notch sits closed.
//!
//! WebView2's own knob for this: `MemoryUsageTargetLevel = Low` lets the renderer trim
//! caches and page out what it doesn't need. The frontend switches it on after the notch
//! has been closed for a while and back to normal as soon as the cursor touches it
//! (peek), so the hover delay covers paging memory back in before it opens.
//!
//! The optional low-memory mode goes further: one process for every window instead of the
//! renderer, GPU and utility processes WebView2 starts on its own. About a third of the RAM,
//! at the price of the renderer sandbox (a plugin page runs in the app's process then).

use tauri::{AppHandle, Manager};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
};
use windows::core::Interface;

/// Every WebView2 window in one process, with the raster and image caches kept small.
const SINGLE_PROCESS: &str = "--single-process --enable-low-end-device-mode";

/// Marker in the app's data folder: the user picked the low-memory mode (Settings, General). A file rather than a
/// setting, because it is read before the window and its WebView2 environment exist.
fn marker(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::portable::app_data_dir(app).ok().map(|dir| dir.join("low-memory"))
}

/// Before the first window is created: WebView2 reads the environment once, when it starts. Microsoft documents that
/// the variable is appended to the arguments from tauri.conf.json; flags already in it (a debug session) stay.
pub fn apply_low_memory(app: &AppHandle) {
    if !low_memory_get(app.clone()) {
        return;
    }
    let current = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    if current.contains("--single-process") {
        return;
    }
    let merged = if current.trim().is_empty() { SINGLE_PROCESS.to_string() } else { format!("{current} {SINGLE_PROCESS}") };
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
}

#[tauri::command]
pub fn low_memory_get(app: AppHandle) -> bool {
    marker(&app).map(|path| path.exists()).unwrap_or(false)
}

/// On: every WebView2 window in one process (the next start). Off: WebView2's own processes again.
#[tauri::command]
pub fn low_memory_set(on: bool, app: AppHandle) -> Result<(), String> {
    let path = marker(&app).ok_or("no-dir")?;
    if on {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, "").map_err(|e| e.to_string())
    } else if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn memory_low(low: bool, app: AppHandle) {
    // Every webview, not just the caller's: the renderer hosts the notch, the mirrors and the timer
    // together, so trimming only one leaves the process's memory untouched.
    for (_, window) in app.webview_windows() {
        let _ = window.with_webview(move |webview| unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            // Older WebView2 runtimes (< 1.0.2210) don't have it; then nothing changes.
            let Ok(core) = core.cast::<ICoreWebView2_19>() else { return };
            let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
            let _ = core.SetMemoryUsageTargetLevel(level);
        });
    }
}
