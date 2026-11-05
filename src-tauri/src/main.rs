// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Elevated helper call from "Unlock FPS": grant rights and exit. Must run
    // before run(), otherwise single-instance would hand it to the running app.
    let args: Vec<String> = std::env::args().collect();
    #[cfg(windows)]
    if let [_, flag, value] = args.as_slice() {
        if flag == "--fps-unlock" {
            std::process::exit(notnotch_lib::fps_elevated_unlock(value));
        }
        // Started by NotNotch while it hides the Windows volume indicator: restores it once NotNotch ends (value: its pid).
        if flag == "--osd-guard" {
            std::process::exit(notnotch_lib::osd_guard(value));
        }
    }
    // A portable copy that just updated itself waits for the old process to exit first.
    notnotch_lib::portable::after_update(&args);
    notnotch_lib::run()
}
