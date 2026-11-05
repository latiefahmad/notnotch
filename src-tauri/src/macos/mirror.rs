//! "Follow the cursor" and "All monitors" (mirror.rs) are not on a Mac yet: the notch stays on its chosen monitor.

use tauri::AppHandle;

/// display.rs wakes the mirrors after every move; there are none.
pub fn wake(_: &AppHandle) {}
