//! Display brightness on a Mac for the Overview's slider (brightness.rs on Windows). macOS has no public API for it:
//! DisplayServices, a private framework that ships with macOS and that brightness apps use, drives Apple panels and Apple
//! displays. It is looked up at run time, so a macOS without it, or a display it can't drive, only hides the slider.

use std::ffi::{c_char, c_int, c_void};
use std::sync::OnceLock;

use tauri::WebviewWindow;

type GetBrightness = unsafe extern "C" fn(display: u32, level: *mut f32) -> c_int;
type SetBrightness = unsafe extern "C" fn(display: u32, level: f32) -> c_int;

const RTLD_LAZY: c_int = 1;

extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
}

#[repr(C)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGGetDisplaysWithPoint(point: CGPoint, max: u32, displays: *mut u32, count: *mut u32) -> i32;
    fn CGMainDisplayID() -> u32;
}

/// DisplayServicesGetBrightness and DisplayServicesSetBrightness, found once; None when the framework or either is missing.
fn api() -> Option<(GetBrightness, SetBrightness)> {
    static API: OnceLock<Option<(usize, usize)>> = OnceLock::new();
    let (get, set) = (*API.get_or_init(|| unsafe {
        let lib = dlopen(c"/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices".as_ptr(), RTLD_LAZY);
        if lib.is_null() {
            return None;
        }
        let get = dlsym(lib, c"DisplayServicesGetBrightness".as_ptr());
        let set = dlsym(lib, c"DisplayServicesSetBrightness".as_ptr());
        (!get.is_null() && !set.is_null()).then_some((get as usize, set as usize))
    }))?;
    Some(unsafe { (std::mem::transmute::<usize, GetBrightness>(get), std::mem::transmute::<usize, SetBrightness>(set)) })
}

/// The display under the notch window's top edge, in CoreGraphics' global points (origin at the main display's top left).
fn display(window: &WebviewWindow) -> u32 {
    let (Ok(pos), Ok(size), Ok(scale)) = (window.outer_position(), window.outer_size(), window.scale_factor()) else {
        return unsafe { CGMainDisplayID() };
    };
    let point = CGPoint { x: (pos.x as f64 + size.width as f64 / 2.0) / scale, y: pos.y as f64 / scale + 4.0 };
    let (mut id, mut count) = (0u32, 0u32);
    if unsafe { CGGetDisplaysWithPoint(point, 1, &mut id, &mut count) } == 0 && count == 1 {
        id
    } else {
        unsafe { CGMainDisplayID() }
    }
}

/// The slider's level for the notch's display, None when DisplayServices can't read it (most third-party monitors).
#[tauri::command]
pub fn brightness_get(window: WebviewWindow) -> Option<u8> {
    let (get, _) = api()?;
    let mut level = 0f32;
    (unsafe { get(display(&window), &mut level) } == 0).then(|| (level.clamp(0.0, 1.0) * 100.0).round() as u8)
}

/// Sets the notch's display to `percent`.
#[tauri::command]
pub fn brightness_set(window: WebviewWindow, percent: u8) -> Result<(), String> {
    let (_, set) = api().ok_or("unsupported")?;
    if unsafe { set(display(&window), f32::from(percent.min(100)) / 100.0) } == 0 {
        Ok(())
    } else {
        Err("unsupported".into())
    }
}
