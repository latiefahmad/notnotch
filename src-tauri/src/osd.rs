// Adapted from Bloom (GPL-3.0, github.com/SehajveerSingh2005/bloom), src-tauri/src/services.rs (native_osd_windows, set_native_osd_suppressed).
//! "Hide the Windows indicator": while NotNotch's HUD replaces it, the system volume and brightness flyout is kept fully
//! transparent and click-through. Explorer still shows it; nothing of it is visible.
//!
//! It must never stay hidden after NotNotch. Each window NotNotch changes carries a property (`PROP`) holding its original extended
//! style, and every window with that property is put back: when the option goes off, when NotNotch exits, when it starts (a run
//! that ended without cleaning up), and from a guard process, the same exe started with `--osd-guard <pid>`, which waits for
//! NotNotch to end in any way (crash, Task Manager) and restores. Without a running guard nothing is hidden.
//!
//! Only flyout hosts that are visible right after a volume or brightness change are touched, in a short burst of scans, so
//! other small Explorer windows of the same class (snap layouts) are left alone unless they happen to show at that moment.

use std::os::windows::process::CommandExt;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use windows::core::{w, BOOL, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, COLORREF, HANDLE, HWND, LPARAM, RECT, TRUE};
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, FindWindowW, GetPropW, GetSystemMetrics, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible, RemovePropW,
    SetLayeredWindowAttributes, SetPropW, SetWindowLongW, GWL_EXSTYLE, LWA_ALPHA, SM_CXSCREEN, SM_CYSCREEN, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
};

const PROP: PCWSTR = w!("NotNotchHiddenOsd");
/// Set above the 32-bit style, so a stored style of 0 is still a property.
const MARK: usize = 1 << 32;
/// The flyout appears with the change or shortly after; scans run every `SCAN_MS` until `BURST_MS` after the last change.
const SCAN_MS: u64 = 100;
const BURST_MS: u64 = 800;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static HIDE: AtomicBool = AtomicBool::new(false);
static GUARD: Mutex<Option<Child>> = Mutex::new(None);
/// Hiding and restoring never overlap, so a scan cannot hide a window right after the option went off.
static SCAN: Mutex<()> = Mutex::new(());
static LAST_CHANGE: AtomicU64 = AtomicU64::new(0);
static BURST: AtomicBool = AtomicBool::new(false);

/// Turns hiding on (starting the guard first) or off (restoring everything, then stopping the guard).
pub fn set(hide: bool) {
    let mut guard = GUARD.lock().unwrap_or_else(|e| e.into_inner());
    if hide {
        if guard.as_mut().is_none_or(|c| !matches!(c.try_wait(), Ok(None))) {
            *guard = spawn_guard().inspect_err(|e| eprintln!("osd: guard failed, the indicator stays: {e}")).ok();
        }
        HIDE.store(guard.is_some(), Ordering::SeqCst);
    } else {
        HIDE.store(false, Ordering::SeqCst);
        restore();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn spawn_guard() -> std::io::Result<Child> {
    Command::new(std::env::current_exe()?).arg("--osd-guard").arg(std::process::id().to_string()).creation_flags(CREATE_NO_WINDOW).spawn()
}

/// The guard process (main.rs): waits for NotNotch to end, however it ends, then restores. A pid it cannot open restores at once.
pub fn guard(pid: &str) -> i32 {
    if let Ok(pid) = pid.parse::<u32>() {
        unsafe {
            if let Ok(process) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
                WaitForSingleObject(process, INFINITE);
                let _ = CloseHandle(process);
            }
        }
    }
    restore();
    0
}

/// A volume or brightness change: the flyout is showing or about to, so scan for it for a moment.
pub fn after_change() {
    if !HIDE.load(Ordering::SeqCst) {
        return;
    }
    LAST_CHANGE.store(unsafe { GetTickCount64() }, Ordering::SeqCst);
    if BURST.swap(true, Ordering::SeqCst) {
        return;
    }
    // A guard that died (ended from Task Manager) can no longer clean up: stop hiding.
    let alive = GUARD.lock().unwrap_or_else(|e| e.into_inner()).as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None)));
    if !alive {
        BURST.store(false, Ordering::SeqCst);
        set(false);
        return;
    }
    thread::spawn(|| loop {
        suppress();
        thread::sleep(Duration::from_millis(SCAN_MS));
        if burst_over() {
            BURST.store(false, Ordering::SeqCst);
            // A change in between saw the burst still running and left the scanning to this thread.
            if burst_over() || BURST.swap(true, Ordering::SeqCst) {
                break;
            }
        }
    });
}

fn burst_over() -> bool {
    unsafe { GetTickCount64() }.saturating_sub(LAST_CHANGE.load(Ordering::SeqCst)) >= BURST_MS
}

fn suppress() {
    let _scan = SCAN.lock().unwrap_or_else(|e| e.into_inner());
    if !HIDE.load(Ordering::SeqCst) {
        return;
    }
    for hwnd in unsafe { flyouts() } {
        unsafe {
            let style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            let saved = GetPropW(hwnd, PROP);
            let original = if saved.is_invalid() {
                // Layered by Explorer itself: its own transparency is not NotNotch's to change.
                if style & WS_EX_LAYERED.0 != 0 {
                    continue;
                }
                // Not marked, not touched: a window NotNotch could not find again is never hidden.
                if SetPropW(hwnd, PROP, Some(HANDLE((MARK | style as usize) as _))).is_err() {
                    continue;
                }
                style
            } else {
                saved.0 as usize as u32
            };
            // Explorer may reset the style when it shows the flyout again; applying it twice is harmless.
            SetWindowLongW(hwnd, GWL_EXSTYLE, (original | WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0) as i32);
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 0, LWA_ALPHA);
        }
    }
}

/// Puts back every window NotNotch hid, found by its property; safe to call any time, also from another process.
pub fn restore() {
    let _scan = SCAN.lock().unwrap_or_else(|e| e.into_inner());
    unsafe {
        // The flyouts live in a shell z-order band that EnumWindows does not list (seen on Windows 11 26300: a hidden
        // flyout stayed invisible after restore); FindWindowExW, which `flyouts` uses to hide them, does find them.
        for class in FLYOUT_CLASSES {
            let mut after = None;
            while let Ok(hwnd) = FindWindowExW(None, after, class, PCWSTR::null()) {
                after = Some(hwnd);
                let _ = restore_one(hwnd, LPARAM(0));
            }
        }
        let _ = EnumWindows(Some(restore_one), LPARAM(0));
    }
}

/// The window classes `flyouts` hides and `restore` looks through.
const FLYOUT_CLASSES: [PCWSTR; 2] = [w!("XamlExplorerHostIslandWindow"), w!("NativeHWNDHost")];

unsafe extern "system" fn restore_one(hwnd: HWND, _: LPARAM) -> BOOL {
    unsafe {
        let saved = GetPropW(hwnd, PROP);
        if !saved.is_invalid() {
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
            SetWindowLongW(hwnd, GWL_EXSTYLE, saved.0 as usize as u32 as i32);
            let _ = RemovePropW(hwnd, PROP);
        }
    }
    TRUE
}

/// Visible flyout hosts of Explorer: on Windows 11 a small non-activating `XamlExplorerHostIslandWindow` (the same class also hosts
/// full-screen surfaces such as Task View, which the size leaves out); on Windows 10 the `NativeHWNDHost` with a `DirectUIHWND` inside.
unsafe fn flyouts() -> Vec<HWND> {
    let mut found = Vec::new();
    unsafe {
        let Ok(tray) = FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) else { return found };
        let mut explorer = 0;
        GetWindowThreadProcessId(tray, Some(&mut explorer));
        let (screen_w, screen_h) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
        for (class, win10) in [(FLYOUT_CLASSES[0], false), (FLYOUT_CLASSES[1], true)] {
            let mut after = None;
            while let Ok(hwnd) = FindWindowExW(None, after, class, PCWSTR::null()) {
                after = Some(hwnd);
                let mut pid = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                let mut rect = RECT::default();
                let small = GetWindowRect(hwnd, &mut rect).is_ok() && rect.right - rect.left < screen_w / 2 && rect.bottom - rect.top < screen_h / 2;
                let host = if win10 {
                    FindWindowExW(Some(hwnd), None, w!("DirectUIHWND"), PCWSTR::null()).is_ok()
                } else {
                    GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_NOACTIVATE.0 != 0
                };
                if pid == explorer && small && host && IsWindowVisible(hwnd).as_bool() {
                    found.push(hwnd);
                }
            }
        }
    }
    found
}
