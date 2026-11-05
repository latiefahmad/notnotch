//! Start with Windows, for the settings switch and the tray check alike. The GitHub build writes the Run key through
//! the autostart plugin; the Store build (feature `store`) uses its package's startup task (packaging/store/
//! AppxManifest.xml), which Windows lists under Task Manager, Startup apps, where the user has the last word.

use tauri::AppHandle;

#[cfg(not(feature = "store"))]
pub fn is_enabled(app: &AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[cfg(not(feature = "store"))]
pub fn set(app: &AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled { manager.enable() } else { manager.disable() }.map_err(|e| e.to_string())
}

#[cfg(feature = "store")]
use windows::ApplicationModel::{StartupTask, StartupTaskState};

/// The TaskId in the manifest.
#[cfg(feature = "store")]
const TASK: &str = "NotNotchStartup";

/// Shown (translated) when Windows keeps the task off: the user or a policy switched it off, and no app can override that.
#[cfg(feature = "store")]
const REFUSED: &str = "Von Windows ausgeschaltet. NotNotch im Task-Manager unter Autostart-Apps einschalten";

/// StartupTask is agile and never prompts a packaged desktop app, so blocking on it is safe on any thread.
#[cfg(feature = "store")]
fn task() -> windows::core::Result<StartupTask> {
    StartupTask::GetAsync(&windows::core::HSTRING::from(TASK))?.join()
}

#[cfg(feature = "store")]
fn on(state: StartupTaskState) -> bool {
    state == StartupTaskState::Enabled || state == StartupTaskState::EnabledByPolicy
}

#[cfg(feature = "store")]
pub fn is_enabled(_: &AppHandle) -> bool {
    task().and_then(|t| t.State()).is_ok_and(on)
}

#[cfg(feature = "store")]
pub fn set(_: &AppHandle, enabled: bool) -> Result<(), String> {
    let task = task().map_err(|e| e.to_string())?;
    if !enabled {
        return task.Disable().map_err(|e| e.to_string());
    }
    // DisabledByUser and DisabledByPolicy come back unchanged: Windows does not let the app turn them on.
    let state = task.RequestEnableAsync().and_then(|op| op.join()).map_err(|e| e.to_string())?;
    if on(state) { Ok(()) } else { Err(REFUSED.into()) }
}
