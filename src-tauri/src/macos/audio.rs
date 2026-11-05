//! Levels for the equalizer: Windows reads the shown player's audio (audio.rs, loopback.rs). On a Mac that needs
//! ScreenCaptureKit and the screen recording permission, so no levels are sent and the bars keep their idle animation.

use tauri::AppHandle;

#[derive(Default)]
pub struct AudioState {}

#[tauri::command]
pub fn audio_levels(enabled: bool) {
    let _ = enabled;
}

pub fn spawn(_: AppHandle, _: &AudioState) {}
