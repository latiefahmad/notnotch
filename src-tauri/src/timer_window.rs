//! Detached timer: a small always-on-top window (`timer` in tauri.conf.json, page timer.html)
//! that shows the running timer. The frontend saves its position; here it is only checked
//! against the connected monitors. The notch learns about open/closed via
//! "timer-window://open".
//!
//! Async commands on purpose: creating a window from a sync command deadlocks on Windows.

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const LABEL: &str = "timer";
const EVENT: &str = "timer-window://open";

#[tauri::command]
pub async fn timer_window_open(x: Option<i32>, y: Option<i32>, app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return window.show().map_err(|e| e.to_string());
    }
    let config = app.config().app.windows.iter().find(|w| w.label == LABEL).cloned().ok_or("Timer window missing in config")?;
    // A portable copy gives this window the notch's WebView2 folder too (portable.rs).
    let window = WebviewWindowBuilder::from_config(&app, &config)
        .map(|b| b.on_navigation(crate::own_page))
        .map(|b| match crate::portable::data_dir() {
            Some(dir) => b.data_directory(dir),
            None => b,
        })
        .and_then(|b| b.build())
        .map_err(|e| e.to_string())?;
    // Opened during a recording or screenshot: left out of it like the notch.
    #[cfg(windows)]
    crate::capture::exclude_if_capturing(&app);

    let saved = x.zip(y).filter(|&(x, y)| on_screen(&window, x, y));
    if let Some((x, y)) = saved.or_else(|| default_spot(&window)) {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    window.show().map_err(|e| e.to_string())?;

    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            let _ = handle.emit(EVENT, false);
        }
    });
    let _ = app.emit(EVENT, true);
    Ok(())
}

#[tauri::command]
pub async fn timer_window_close(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window(LABEL) {
        Some(window) => window.destroy().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Is at least the top-left 48 px of the window on a connected monitor? (A monitor that was
/// unplugged would otherwise leave the window out of reach.)
fn on_screen(window: &WebviewWindow, x: i32, y: i32) -> bool {
    let grip = 48;
    window.available_monitors().unwrap_or_default().iter().any(|m| {
        let (p, s) = (m.position(), m.size());
        x >= p.x && y >= p.y && x + grip <= p.x + s.width as i32 && y + grip <= p.y + s.height as i32
    })
}

/// Top right of the primary monitor, below the notch.
fn default_spot(window: &WebviewWindow) -> Option<(i32, i32)> {
    let monitor = window.primary_monitor().ok().flatten()?;
    let size = window.outer_size().ok()?;
    let (p, s, scale) = (monitor.position(), monitor.size(), monitor.scale_factor());
    let margin = (24.0 * scale) as i32;
    Some((p.x + s.width as i32 - size.width as i32 - margin, p.y + (72.0 * scale) as i32))
}
