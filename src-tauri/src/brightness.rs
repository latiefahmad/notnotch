//! Display brightness for the closed notch's HUD.
//!
//! - Built-in panel: WMI's `WmiMonitorBrightnessEvent` (root\WMI), read semi-synchronously on this thread, so nothing calls
//!   back into the process. The panel's level at the start is the baseline: only a different one is reported.
//! - External monitors: DDC/CI has no change event, so while the Brightness alert is on they are read every `POLL`, each
//!   monitor's first reading being its baseline. A monitor that does not answer three times in a row is left alone.
//!
//! - The Overview's slider sets the notch's monitor: DDC/CI for an external one, WMI's WmiSetBrightness for a laptop panel. For a
//!   moment after that, changes are taken as the new baseline, so the closed notch doesn't announce what the slider just did.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use windows::core::{w, BOOL, BSTR, PCWSTR};
use windows::Win32::Devices::Display::{
    DestroyPhysicalMonitors, GetMonitorBrightness, GetNumberOfPhysicalMonitorsFromHMONITOR, GetPhysicalMonitorsFromHMONITOR, SetMonitorBrightness,
    PHYSICAL_MONITOR,
};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayDevicesW, EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, DISPLAY_DEVICEW, HDC, HMONITOR, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoSetProxyBlanket, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, EOAC_NONE, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
};
use windows::Win32::System::Variant::{VariantClear, VariantToUInt32, VARIANT};
use windows::Win32::System::Wmi::{IEnumWbemClassObject, IWbemClassObject, IWbemLocator, IWbemServices, WbemLocator, WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY};

/// How often external monitors are read while the Brightness alert is on. A DDC/CI read takes tens of milliseconds per monitor.
const POLL: Duration = Duration::from_secs(2);
/// Failed reads in a row after which a monitor counts as without DDC/CI.
const GIVE_UP: u8 = 3;
// RPC_C_AUTHN_WINNT and RPC_C_AUTHZ_NONE (Win32_System_Rpc is not enabled).
const AUTHN_WINNT: u32 = 10;
const AUTHZ_NONE: u32 = 0;

static DDC: AtomicBool = AtomicBool::new(false);
/// Until when a change counts as the slider's own (brightness_set), not as news for the closed notch.
static QUIET_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);
/// How long after the slider a change stays its own: the panel's WMI event and the next DDC poll come within it.
const QUIET: Duration = Duration::from_millis(2500);

fn quiet() -> bool {
    QUIET_UNTIL.lock().unwrap().is_some_and(|until| Instant::now() < until)
}

pub fn set_ddc(on: bool) {
    DDC.store(on, Ordering::Relaxed);
}

pub fn spawn(app: AppHandle) {
    thread::spawn(move || run(app));
}

fn run(app: AppHandle) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let services = unsafe { wmi(r"ROOT\WMI") }.inspect_err(|e| eprintln!("brightness: WMI failed: {e}")).ok();
    let mut panel = services.as_ref().and_then(|s| unsafe { first_u8(&query(s, "SELECT CurrentBrightness FROM WmiMonitorBrightness", false).ok()?, w!("CurrentBrightness")) });
    let mut events = services.as_ref().and_then(|s| unsafe { query(s, "SELECT * FROM WmiMonitorBrightnessEvent", true) }.inspect_err(|e| eprintln!("brightness: panel events failed: {e}")).ok());
    let mut external: HashMap<(isize, usize), u8> = HashMap::new();
    let mut fails: HashMap<(isize, usize), u8> = HashMap::new();
    let mut next_poll = Instant::now() + POLL;
    loop {
        let wait = next_poll.saturating_duration_since(Instant::now());
        match &events {
            Some(e) => match unsafe { next_level(e, wait) } {
                Ok(Some(level)) if panel != Some(level) => {
                    panel = Some(level);
                    if !quiet() {
                        crate::sysevents::emit_level(&app, "brightness", level, false);
                    }
                }
                Ok(_) => {}
                // WMI went away (service restart): the panel stays silent rather than spinning on the error.
                Err(e) => {
                    eprintln!("brightness: panel events stopped: {e}");
                    events = None;
                }
            },
            None => thread::sleep(wait),
        }
        if Instant::now() < next_poll {
            continue;
        }
        next_poll = Instant::now() + POLL;
        if !DDC.load(Ordering::Relaxed) {
            external.clear();
            continue;
        }
        // Taken before the poll, which can outlast the quiet window on slow monitors and still read the slider's own change.
        let quiet = quiet();
        let now = unsafe { external_levels(&mut fails) };
        for (key, level) in &now {
            if !quiet && external.get(key).is_some_and(|before| before != level) {
                crate::sysevents::emit_level(&app, "brightness", *level, false);
            }
        }
        external = now;
    }
}

pub(crate) unsafe fn wmi(namespace: &str) -> windows::core::Result<IWbemServices> {
    unsafe {
        let locator: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER)?;
        let empty = BSTR::new();
        let services = locator.ConnectServer(&BSTR::from(namespace), &empty, &empty, &empty, 0, &empty, None)?;
        // Without impersonation WMI can refuse the query when the process never set its COM security.
        blanket(&services)?;
        Ok(services)
    }
}

unsafe fn blanket(proxy: impl windows::core::Param<windows::core::IUnknown>) -> windows::core::Result<()> {
    unsafe { CoSetProxyBlanket(proxy, AUTHN_WINNT, AUTHZ_NONE, PCWSTR::null(), RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, None, EOAC_NONE) }
}

pub(crate) unsafe fn query(services: &IWbemServices, wql: &str, notification: bool) -> windows::core::Result<IEnumWbemClassObject> {
    unsafe {
        let flags = WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY;
        let (lang, wql) = (BSTR::from("WQL"), BSTR::from(wql));
        let list = if notification { services.ExecNotificationQuery(&lang, &wql, flags, None)? } else { services.ExecQuery(&lang, &wql, flags, None)? };
        let _ = blanket(&list);
        Ok(list)
    }
}

/// The next panel event's level within `wait`; `Ok(None)` when none came.
unsafe fn next_level(events: &IEnumWbemClassObject, wait: Duration) -> windows::core::Result<Option<u8>> {
    unsafe {
        let mut objects: [Option<IWbemClassObject>; 1] = [None];
        let mut returned = 0;
        events.Next(wait.as_millis().min(i32::MAX as u128) as i32, &mut objects, &mut returned).ok()?;
        Ok(objects[0].as_ref().filter(|_| returned == 1).and_then(|o| prop_u8(o, w!("Brightness"))))
    }
}

/// The property of the first object a plain query returns.
unsafe fn first_u8(list: &IEnumWbemClassObject, name: PCWSTR) -> Option<u8> {
    unsafe {
        let mut objects: [Option<IWbemClassObject>; 1] = [None];
        let mut returned = 0;
        // WBEM_INFINITE: a plain query ends on its own.
        let _ = list.Next(-1, &mut objects, &mut returned);
        objects[0].as_ref().filter(|_| returned == 1).and_then(|o| prop_u8(o, name))
    }
}

unsafe fn prop_u8(object: &IWbemClassObject, name: PCWSTR) -> Option<u8> {
    unsafe {
        let mut value = VARIANT::default();
        object.Get(name, 0, &mut value, None, None).ok()?;
        let level = VariantToUInt32(&value).ok();
        let _ = VariantClear(&mut value);
        level.map(|l| l.min(100) as u8)
    }
}

/// The brightness of every external monitor that answers over DDC/CI, keyed by its display handle and index on it.
unsafe fn external_levels(fails: &mut HashMap<(isize, usize), u8>) -> HashMap<(isize, usize), u8> {
    let mut monitors: Vec<HMONITOR> = Vec::new();
    let mut out = HashMap::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut monitors as *mut _ as isize));
        for monitor in monitors {
            let mut count = 0;
            if GetNumberOfPhysicalMonitorsFromHMONITOR(monitor, &mut count).is_err() || count == 0 {
                continue;
            }
            let mut list = vec![PHYSICAL_MONITOR::default(); count as usize];
            if GetPhysicalMonitorsFromHMONITOR(monitor, &mut list).is_err() {
                continue;
            }
            for (i, physical) in list.iter().enumerate() {
                let key = (monitor.0 as isize, i);
                let failed = fails.entry(key).or_insert(0);
                if *failed >= GIVE_UP {
                    continue;
                }
                let (mut min, mut cur, mut max) = (0, 0, 0);
                match (GetMonitorBrightness(physical.hPhysicalMonitor, &mut min, &mut cur, &mut max) != 0).then(|| ddc_percent(min, cur, max)).flatten() {
                    Some(level) => {
                        *failed = 0;
                        out.insert(key, level);
                    }
                    None => *failed += 1,
                }
            }
            let _ = DestroyPhysicalMonitors(&list);
        }
    }
    out
}

unsafe extern "system" fn each(monitor: HMONITOR, _: HDC, _: *mut RECT, list: LPARAM) -> BOOL {
    unsafe { (*(list.0 as *mut Vec<HMONITOR>)).push(monitor) };
    TRUE
}

/// The monitor the notch window is on.
fn notch_monitor(window: &tauri::WebviewWindow) -> Option<isize> {
    let hwnd = window.hwnd().ok()?;
    Some(unsafe { MonitorFromWindow(HWND(hwnd.0), MONITOR_DEFAULTTONEAREST) }.0 as isize)
}

/// Runs `job` on a thread of its own with COM, off the command thread (a DDC/CI call can take a tenth of a second).
async fn on_com_thread<T: Send + 'static>(job: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        job()
    })
    .await
    .map_err(|e| e.to_string())
}

/// The slider's level for the notch's monitor: over DDC/CI, else its laptop panel through WMI; None when it can't be set from here.
#[tauri::command]
pub async fn brightness_get(window: tauri::WebviewWindow) -> Option<u8> {
    let monitor = notch_monitor(&window)?;
    on_com_thread(move || unsafe {
        let monitor = HMONITOR(monitor as _);
        ddc_level(monitor).or_else(|| panel(monitor).and_then(|(services, name)| panel_level(&services, &name)))
    })
    .await
    .ok()
    .flatten()
}

/// Sets the notch's monitor to `percent`.
#[tauri::command]
pub async fn brightness_set(window: tauri::WebviewWindow, percent: u8) -> Result<(), String> {
    let monitor = notch_monitor(&window).ok_or("no-monitor")?;
    let percent = percent.min(100);
    *QUIET_UNTIL.lock().unwrap() = Some(Instant::now() + QUIET);
    let done = on_com_thread(move || unsafe {
        let monitor = HMONITOR(monitor as _);
        match ddc_set(monitor, percent) {
            Some(done) => done,
            None => panel(monitor).is_some_and(|(services, name)| panel_set(&services, &name, percent).is_ok()),
        }
    })
    .await?;
    // Counted again from the end: a slow DDC/CI write must not let its own change through.
    *QUIET_UNTIL.lock().unwrap() = Some(Instant::now() + QUIET);
    if done {
        Ok(())
    } else {
        Err("unsupported".into())
    }
}

/// One DDC/CI reading, asked again after the 50 ms a monitor may need between two commands (the slider writes back to back).
unsafe fn ddc_answer(handle: HANDLE) -> Option<(u32, u32, u32)> {
    unsafe {
        ddc_reading(handle).or_else(|| {
            thread::sleep(Duration::from_millis(50));
            ddc_reading(handle)
        })
    }
}

/// The level of the first physical monitor that answers over DDC/CI.
unsafe fn ddc_level(monitor: HMONITOR) -> Option<u8> {
    unsafe { physical(monitor, |list| list.iter().find_map(|m| ddc_answer(m.hPhysicalMonitor))).flatten().and_then(|(min, cur, max)| ddc_percent(min, cur, max)) }
}

/// Sets every physical monitor that answers over DDC/CI, one reading each for its scale. None when none answers.
unsafe fn ddc_set(monitor: HMONITOR, percent: u8) -> Option<bool> {
    unsafe {
        physical(monitor, |list| {
            let (mut answered, mut done) = (false, false);
            for m in list {
                if let Some((min, _, max)) = ddc_answer(m.hPhysicalMonitor) {
                    answered = true;
                    done |= SetMonitorBrightness(m.hPhysicalMonitor, ddc_value(min, max, percent)) != 0;
                }
            }
            answered.then_some(done)
        })
        .flatten()
    }
}

/// The laptop panel WMI knows for this monitor, matched by hardware code.
unsafe fn panel(monitor: HMONITOR) -> Option<(IWbemServices, String)> {
    unsafe {
        let code = hardware_code(monitor)?;
        let services = wmi(r"ROOT\WMI").ok()?;
        let list = query(&services, "SELECT InstanceName FROM WmiMonitorBrightness", false).ok()?;
        loop {
            let mut objects: [Option<IWbemClassObject>; 1] = [None];
            let mut returned = 0;
            if list.Next(-1, &mut objects, &mut returned).is_err() || returned == 0 {
                return None;
            }
            let Some(name) = objects[0].as_ref().and_then(|o| prop_string(o, w!("InstanceName"))) else { continue };
            if same_hardware(&name, &code) {
                return Some((services, name));
            }
        }
    }
}

unsafe fn panel_level(services: &IWbemServices, name: &str) -> Option<u8> {
    unsafe {
        let wql = format!("SELECT CurrentBrightness FROM WmiMonitorBrightness WHERE InstanceName='{}'", wql_escape(name));
        first_u8(&query(services, &wql, false).ok()?, w!("CurrentBrightness"))
    }
}

/// WmiMonitorBrightnessMethods.WmiSetBrightness(Timeout 0, Brightness) on the panel's instance.
unsafe fn panel_set(services: &IWbemServices, name: &str, percent: u8) -> windows::core::Result<()> {
    unsafe {
        let mut class = None;
        services.GetObject(&BSTR::from("WmiMonitorBrightnessMethods"), Default::default(), None, Some(&mut class), None)?;
        let class = class.ok_or_else(windows::core::Error::empty)?;
        let mut input = None;
        class.GetMethod(w!("WmiSetBrightness"), 0, &mut input, std::ptr::null_mut())?;
        let params = input.ok_or_else(windows::core::Error::empty)?.SpawnInstance(0)?;
        // WMI takes a uint32 as VT_I4 (a VT_UI4 is a type mismatch, 0x80041005); a uint8 as VT_UI1.
        params.Put(w!("Timeout"), 0, &VARIANT::from(0i32), 0)?;
        params.Put(w!("Brightness"), 0, &VARIANT::from(percent), 0)?;
        // An object path takes the key in double quotes (WQL above takes single ones).
        let path = BSTR::from(format!(r#"WmiMonitorBrightnessMethods.InstanceName="{}""#, name.replace('\\', r"\\").replace('"', r#"\""#)));
        services.ExecMethod(&path, &BSTR::from("WmiSetBrightness"), Default::default(), None, &params, None, None)
    }
}

/// Runs `f` on the monitor's physical monitors and releases them; None when it has none.
unsafe fn physical<T>(monitor: HMONITOR, f: impl FnOnce(&[PHYSICAL_MONITOR]) -> T) -> Option<T> {
    unsafe {
        let mut count = 0;
        if GetNumberOfPhysicalMonitorsFromHMONITOR(monitor, &mut count).is_err() || count == 0 {
            return None;
        }
        let mut list = vec![PHYSICAL_MONITOR::default(); count as usize];
        GetPhysicalMonitorsFromHMONITOR(monitor, &mut list).ok()?;
        let out = f(&list);
        let _ = DestroyPhysicalMonitors(&list);
        Some(out)
    }
}

unsafe fn ddc_reading(handle: HANDLE) -> Option<(u32, u32, u32)> {
    let (mut min, mut cur, mut max) = (0, 0, 0);
    (unsafe { GetMonitorBrightness(handle, &mut min, &mut cur, &mut max) } != 0 && max > min).then_some((min, cur, max))
}

/// The monitor's hardware code ("BOE0812"): the second part of its device id, `MONITOR\BOE0812\{...}\0001`.
unsafe fn hardware_code(monitor: HMONITOR) -> Option<String> {
    unsafe {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !GetMonitorInfoW(monitor, &mut info.monitorInfo).as_bool() {
            return None;
        }
        let mut device = DISPLAY_DEVICEW { cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
        if !EnumDisplayDevicesW(PCWSTR(info.szDevice.as_ptr()), 0, &mut device, 0).as_bool() {
            return None;
        }
        let end = device.DeviceID.iter().position(|&c| c == 0).unwrap_or(device.DeviceID.len());
        String::from_utf16_lossy(&device.DeviceID[..end]).split('\\').nth(1).filter(|c| !c.is_empty()).map(str::to_owned)
    }
}

/// A WMI monitor instance (`DISPLAY\BOE0812\4&2b...&UID8388688_0`) belongs to the monitor with that hardware code.
fn same_hardware(instance: &str, code: &str) -> bool {
    instance.split('\\').nth(1).is_some_and(|c| c.eq_ignore_ascii_case(code))
}

/// A value inside single quotes in WQL or an object path: backslash and quote escaped.
fn wql_escape(s: &str) -> String {
    s.replace('\\', r"\\").replace('\'', r"\'")
}

unsafe fn prop_string(object: &IWbemClassObject, name: PCWSTR) -> Option<String> {
    unsafe {
        let mut value = VARIANT::default();
        object.Get(name, 0, &mut value, None, None).ok()?;
        let text = BSTR::try_from(&value).ok().map(|b| b.to_string());
        let _ = VariantClear(&mut value);
        text.filter(|t| !t.is_empty())
    }
}

/// A slider percent on the monitor's own DDC/CI scale.
fn ddc_value(min: u32, max: u32, percent: u8) -> u32 {
    min + ((max - min) as f64 * percent.min(100) as f64 / 100.0).round() as u32
}

/// A DDC/CI reading on the monitor's own scale (often 0..100, not always) as a percent.
fn ddc_percent(min: u32, current: u32, max: u32) -> Option<u8> {
    if max <= min {
        return None;
    }
    let span = (max - min) as f64;
    Some(((current.clamp(min, max) - min) as f64 * 100.0 / span).round() as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ddc_percent_maps_the_monitor_scale() {
        assert_eq!(ddc_percent(0, 70, 100), Some(70));
        assert_eq!(ddc_percent(0, 128, 255), Some(50));
        assert_eq!(ddc_percent(20, 20, 120), Some(0));
        // Out of range readings are clamped, a broken range is no reading.
        assert_eq!(ddc_percent(0, 300, 100), Some(100));
        assert_eq!(ddc_percent(50, 50, 50), None);
        assert_eq!(ddc_percent(80, 10, 20), None);
    }

    #[test]
    fn slider_percent_goes_back_to_the_monitor_scale() {
        assert_eq!(ddc_value(0, 100, 70), 70);
        assert_eq!(ddc_value(0, 255, 50), 128);
        assert_eq!(ddc_value(20, 120, 0), 20);
        assert_eq!(ddc_value(0, 100, 250), 100);
        for p in [0, 33, 50, 99, 100] {
            assert_eq!(ddc_percent(0, ddc_value(0, 255, p), 255), Some(p));
        }
    }

    #[test]
    fn a_wmi_panel_matches_its_monitor_by_hardware_code() {
        assert!(same_hardware(r"DISPLAY\BOE0812\4&2b7f1d2&0&UID8388688_0", "BOE0812"));
        assert!(same_hardware(r"DISPLAY\boe0812\x_0", "BOE0812"));
        assert!(!same_hardware(r"DISPLAY\LGD06B9\x_0", "BOE0812"));
        assert!(!same_hardware("garbage", "BOE0812"));
        assert_eq!(wql_escape(r"DISPLAY\A'B"), r"DISPLAY\\A\'B");
    }
}
