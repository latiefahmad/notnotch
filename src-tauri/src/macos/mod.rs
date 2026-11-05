//! macOS: what the Windows modules do with Win32, done with AppKit and CoreGraphics, plus stand-ins for the Windows-only
//! services the shared code calls into (audio levels, mirrors). Tools that need more are hidden on a Mac
//! (src/notch/tabs.ts).

pub mod audio;
pub mod brightness;
pub mod media;
pub mod mirror;

use objc2_app_kit::{
    NSApplicationActivationOptions, NSPasteboard, NSRunningApplication, NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWorkspace,
};
use objc2_foundation::NSString;
use tauri::WebviewWindow;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
}

/// The left mouse button is held (hit_test.rs). Combined session state (0), left button (0).
pub fn left_button_down() -> bool {
    unsafe { CGEventSourceButtonState(0, 0) }
}

/// Above the menu bar, on every Space and over full-screen apps. Tauri's "always on top" is the floating level, under the
/// menu bar, so this runs again after each `set_always_on_top`.
pub fn raise(window: &WebviewWindow) {
    let Ok(ptr) = window.ns_window() else { return };
    let ptr = ptr as usize;
    let _ = window.run_on_main_thread(move || {
        // SAFETY: Tauri's NSWindow for this window, used on the main thread, where the window lives.
        let ns = unsafe { &*(ptr as *const NSWindow) };
        ns.setLevel(NSStatusWindowLevel);
        ns.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
    });
}

/// The process id of the frontmost app (lib.rs keyboard_focus), 0 when there is none.
pub fn frontmost_pid() -> i32 {
    NSWorkspace::sharedWorkspace().frontmostApplication().map_or(0, |app| app.processIdentifier())
}

/// Gives the keyboard back to the app that had it before the notch opened.
pub fn activate_pid(pid: i32) {
    if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
        // `activate()` is macOS 14 only; this one works from 10.6 on.
        #[allow(deprecated)]
        app.activateWithOptions(NSApplicationActivationOptions::empty());
    }
}

/// Commands the shared interface sends without waiting for an answer or polls (memory.rs, sysevents.rs, privacy.rs on
/// Windows): answered here so a Mac doesn't log a missing command each time.
#[tauri::command]
pub fn memory_low() {}

#[tauri::command]
pub fn status_configure() {}

/// macOS shows its own dots for the microphone, camera and screen, and doesn't tell other apps.
#[tauri::command]
pub fn privacy_state() -> serde_json::Value {
    serde_json::json!({ "mic": false, "camera": false, "screen": false })
}

/// Counts every change of the general pasteboard, like GetClipboardSequenceNumber (clipboard.rs).
pub fn pasteboard_change_count() -> u32 {
    NSPasteboard::generalPasteboard().changeCount() as u32
}

/// Password managers mark what they copy with these types (nspasteboard.org): keep it out of the history.
pub fn pasteboard_is_private() -> bool {
    let Some(types) = NSPasteboard::generalPasteboard().types() else { return false };
    let private = [NSString::from_str("org.nspasteboard.ConcealedType"), NSString::from_str("org.nspasteboard.TransientType")];
    types.iter().any(|t| private.iter().any(|p| t.isEqualToString(p)))
}
