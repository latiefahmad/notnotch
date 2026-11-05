//! System status for the closed notch's alerts: charger and battery, internet,
//! Bluetooth devices, and the volume of the default output device for the HUD (brightness is in brightness.rs).
//!
//! One thread with a message-only window. Power settings arrive as WM_POWERBROADCAST and are
//! handled in the GetMessageW loop, so the thread sleeps at idle. The network, Bluetooth and audio
//! endpoint callbacks only post to the same loop; the network and Bluetooth are settled with window timers. Each source registers on its own:
//! a failure is logged and leaves only that source off. What a source reads at registration goes
//! into the seed (`status://seed`, `status_seed`), never into a change event. The volume callback only fires on a change,
//! so registering it is silent too; changes NotNotch makes itself carry `controls::OWN_CHANGE` and are skipped.
//! Caps Lock and Num Lock have no change event short of a keyboard hook, so a small thread reads them every `LOCK_POLL` while their alert is on.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{implement, w, GUID, PCWSTR};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    CM_Get_DevNode_PropertyW, CM_Get_Device_ID_ListW, CM_Get_Device_ID_List_SizeW, CM_Locate_DevNodeW, CM_GETIDLIST_FILTER_ENUMERATOR,
    CM_GETIDLIST_FILTER_PRESENT, CM_LOCATE_DEVNODE_NORMAL, CR_SUCCESS,
};
use windows::Win32::Devices::Properties::{DEVPKEY_Device_ContainerId, DEVPROPTYPE, DEVPROP_TYPE_BYTE, DEVPROP_TYPE_GUID};
use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioEndpointVolumeCallback, IAudioEndpointVolumeCallback_Impl};
use windows::Win32::Media::Audio::{
    eConsole, eRender, EDataFlow, ERole, IMMDeviceEnumerator, AUDIO_VOLUME_NOTIFICATION_DATA, IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator, DEVICE_STATE,
};
use windows::core::{Array, Interface, Ref, HSTRING};
use windows::Devices::Enumeration::{DeviceInformation, DeviceInformationKind, DeviceInformationUpdate, DeviceWatcher};
use windows_collections::IIterable;
use windows::Foundation::{IPropertyValue, TypedEventHandler};
use windows::Networking::Connectivity::{NetworkConnectivityLevel, NetworkInformation, NetworkStatusChangedEventHandler};
use windows::Win32::Foundation::{DEVPROPKEY, HANDLE, HWND, LPARAM, LRESULT, PROPERTYKEY, WPARAM};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CAPITAL, VK_NUMLOCK};
use windows::Win32::System::Power::{GetSystemPowerStatus, RegisterPowerSettingNotification, SYSTEM_POWER_STATUS};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, KillTimer, PostMessageW, RegisterClassW, SetTimer, DEVICE_NOTIFY_WINDOW_HANDLE,
    HWND_MESSAGE, MSG, PBT_POWERSETTINGCHANGE, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WM_POWERBROADCAST, WM_TIMER, WNDCLASSW,
};

// Not in the enabled features; values from winnt.h.
const GUID_ACDC_POWER_SOURCE: GUID = GUID::from_u128(0x5d3e9a59_e9d5_4b00_a6bd_ff34ff516548);
const GUID_BATTERY_PERCENTAGE_REMAINING: GUID = GUID::from_u128(0xa7ad8041_b45a_4cae_87a3_eecbb468a9e1);
/// Battery level Windows takes from the hands-free indicators or the LE battery service; not in the crate.
const DEVPKEY_BLUETOOTH_BATTERY: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::from_u128(0x104ea319_6ee2_4701_bd47_8ddbf425bbe5), pid: 2 };
/// Paired Bluetooth and Bluetooth LE devices, as Settings lists them. Audio endpoints cannot tell them apart: with an
/// offload driver (AMD's) their enumerator is the driver's GUID, not BTHENUM, and mice or controllers have none.
const BT_PAIRED: &str = r#"System.Devices.Aep.IsPaired:=System.StructuredQueryType.Boolean#True AND (System.Devices.Aep.ProtocolId:="{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}" OR System.Devices.Aep.ProtocolId:="{bb7bb05e-5972-42b5-94fc-76eaa7084d49}")"#;
const BT_CONNECTED: &str = "System.Devices.Aep.IsConnected";
const BT_CATEGORY: &str = "System.Devices.Aep.Category";
const BT_ADDRESS: &str = "System.Devices.Aep.DeviceAddress";
const BT_CONTAINER: &str = "System.Devices.Aep.ContainerId";

/// WM_POWERBROADCAST is sent straight to the window procedure; it reposts this to reach the loop.
const WM_POWER: u32 = WM_APP + 1;
/// Posted from the WinRT threadpool on every network change.
const WM_NET: u32 = WM_APP + 2;
/// Network changes come in bursts (VPN, vSwitch, DHCP); only a state stable this long is sent.
const NET_TIMER: usize = 1;
const NET_SETTLE_MS: u32 = 2000;
/// Posted from the WinRT threadpool on every change of a paired Bluetooth device.
const WM_BT: u32 = WM_APP + 3;
/// A connection comes as a burst of updates, and the battery level lands a moment after it; one scan after the last.
const BT_TIMER: usize = 2;
const BT_SETTLE_MS: u32 = 1000;
/// Posted from the audio service thread on a volume or mute change: wParam the level in percent, lParam bit 0 muted, bit 1 NotNotch's own.
const WM_VOL: u32 = WM_APP + 4;
/// The default output device changed: the volume callback moves to the new one.
const WM_VOLDEV: u32 = WM_APP + 5;

#[derive(Serialize, Clone, Copy, PartialEq)]
pub struct Power {
    ac: bool,
    percent: Option<u8>,
    /// False on PCs without a battery.
    battery: bool,
}

/// Current state of each source, `null` while a source is off. Kept up to date after the
/// start so a page that loads late compares against what was last sent.
#[derive(Serialize, Clone)]
pub struct Seed {
    power: Option<Power>,
    online: Option<bool>,
    /// Names of the Bluetooth devices connected now.
    devices: Vec<String>,
}

static SEED: Mutex<Seed> = Mutex::new(Seed { power: None, online: None, devices: Vec::new() });

/// A panic elsewhere must not take the alerts down with it: the seed stays readable.
fn seed() -> MutexGuard<'static, Seed> {
    SEED.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command]
pub fn status_seed() -> Seed {
    seed().clone()
}

pub fn spawn(app: AppHandle) {
    thread::spawn(move || run(app));
}

fn run(app: AppHandle) {
    unsafe {
        if let Err(e) = CoInitializeEx(None, COINIT_MULTITHREADED).ok() {
            eprintln!("sysevents: COM init failed: {e}");
        }
        let Some(hwnd) = window() else {
            let _ = app.emit("status://seed", status_seed());
            return;
        };

        // Registering sends the current value at once; it matches the seed, so it emits nothing.
        let power_on = [GUID_ACDC_POWER_SOURCE, GUID_BATTERY_PERCENTAGE_REMAINING].iter().fold(false, |on, guid| {
            match RegisterPowerSettingNotification(HANDLE(hwnd.0), guid, DEVICE_NOTIFY_WINDOW_HANDLE) {
                Ok(_) => true,
                Err(e) => {
                    eprintln!("sysevents: power notification failed: {e}");
                    on
                }
            }
        });
        if power_on {
            seed().power = power();
        }

        let h = hwnd.0 as isize;
        let handler = NetworkStatusChangedEventHandler::new(move |_| {
            let _ = PostMessageW(Some(HWND(h as _)), WM_NET, WPARAM(0), LPARAM(0));
            Ok(())
        });
        match NetworkInformation::NetworkStatusChanged(&handler) {
            Ok(_) => seed().online = Some(online()),
            Err(e) => eprintln!("sysevents: network notification failed: {e}"),
        }

        // Enumerator and client live as long as the loop; nothing is unregistered in a callback.
        let client: IMMNotificationClient = Endpoints(h).into();
        let devices = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .and_then(|d| d.RegisterEndpointNotificationCallback(&client).map(|()| d))
            .inspect_err(|e| eprintln!("sysevents: audio endpoint notification failed: {e}"))
            .ok();
        let paired = Paired::default();
        let _watcher = bt_watch(h, paired.clone());
        // `None` until the watcher has listed every paired device (which can take 30 s, in bursts) and that has settled:
        // that reading is the baseline, not a change.
        let mut connected: Option<HashMap<String, BtDevice>> = None;
        let mut enumerated = false;

        let volume_client: IAudioEndpointVolumeCallback = VolumeWatch(h).into();
        let mut volume = devices.as_ref().and_then(|d| watch_volume(d, &volume_client));
        let mut last_volume = volume.as_ref().map(|v| v.1);

        let _ = app.emit("status://seed", status_seed());

        // Runs for the app's lifetime; process exit releases the registrations.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            match msg.message {
                WM_POWER => {
                    // Only this thread writes the seed, and the lock is not held across emit.
                    let now = power();
                    if now.is_some() && seed().power != now {
                        seed().power = now;
                        let _ = app.emit("status://power", now);
                    }
                }
                // Same id re-arms the timer, so it fires 2 s after the last change.
                WM_NET => {
                    SetTimer(Some(hwnd), NET_TIMER, NET_SETTLE_MS, None);
                }
                WM_TIMER if msg.wParam.0 == NET_TIMER => {
                    let _ = KillTimer(Some(hwnd), NET_TIMER);
                    let now = Some(online());
                    if seed().online != now {
                        seed().online = now;
                        let _ = app.emit("status://net", serde_json::json!({ "online": now }));
                    }
                }
                WM_BT => {
                    enumerated |= msg.wParam.0 == 1;
                    SetTimer(Some(hwnd), BT_TIMER, BT_SETTLE_MS, None);
                }
                WM_TIMER if msg.wParam.0 == BT_TIMER => {
                    let _ = KillTimer(Some(hwnd), BT_TIMER);
                    let now = bluetooth(&paired);
                    if let Some(before) = &connected {
                        for (id, d) in &now {
                            if !before.contains_key(id) {
                                let battery = battery(&d.address, d.container);
                                let _ = app.emit("status://bt", serde_json::json!({ "name": d.name, "connected": true, "battery": battery, "categories": d.categories }));
                            }
                        }
                        for (id, d) in before {
                            if !now.contains_key(id) {
                                let _ = app.emit("status://bt", serde_json::json!({ "name": d.name, "connected": false, "battery": null, "categories": d.categories }));
                            }
                        }
                    }
                    seed().devices = now.values().map(|d| d.name.clone()).collect();
                    if enumerated {
                        connected = Some(now);
                    }
                }
                WM_VOL => {
                    let now = (msg.wParam.0.min(100) as u8, msg.lParam.0 & 1 != 0);
                    // NotNotch's own change still moves the baseline, so the next outside change compares against it.
                    if volume_changed(&mut last_volume, now) && msg.lParam.0 & 2 == 0 {
                        emit_level(&app, "volume", now.0, now.1);
                    }
                }
                WM_VOLDEV => {
                    if let Some((endpoint, _)) = &volume {
                        let _ = endpoint.UnregisterControlChangeNotify(&volume_client);
                    }
                    volume = devices.as_ref().and_then(|d| watch_volume(d, &volume_client));
                    last_volume = volume.as_ref().map(|v| v.1);
                }
                _ => {
                    DispatchMessageW(&msg);
                }
            }
        }
    }
}

/// Message-only window with its own class: no broadcasts, only what is registered on it.
unsafe fn window() -> Option<HWND> {
    unsafe {
        let instance = GetModuleHandleW(None).ok()?;
        let class = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: instance.into(), lpszClassName: w!("NotNotchSysEvents"), ..Default::default() };
        if RegisterClassW(&class) == 0 {
            eprintln!("sysevents: window class failed: {}", windows::core::Error::from_thread());
            return None;
        }
        CreateWindowExW(WINDOW_EX_STYLE::default(), w!("NotNotchSysEvents"), w!(""), WINDOW_STYLE::default(), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(instance.into()), None)
            .inspect_err(|e| eprintln!("sysevents: window failed: {e}"))
            .ok()
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        if msg == WM_POWERBROADCAST && wparam.0 as u32 == PBT_POWERSETTINGCHANGE {
            let _ = PostMessageW(Some(hwnd), WM_POWER, WPARAM(0), LPARAM(0));
            return LRESULT(1);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

fn power() -> Option<Power> {
    let mut s = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut s) }.ok()?;
    // 128 = no system battery; 255 = unknown percent.
    let battery = s.BatteryFlag & 128 == 0;
    Some(Power { ac: s.ACLineStatus == 1, percent: (battery && s.BatteryLifePercent <= 100).then_some(s.BatteryLifePercent), battery })
}

/// No internet profile (cable out, Wi-Fi off) counts as offline.
fn online() -> bool {
    NetworkInformation::GetInternetConnectionProfile()
        .and_then(|p| p.GetNetworkConnectivityLevel())
        .is_ok_and(|level| level == NetworkConnectivityLevel::InternetAccess)
}

/// Runs on an audio service thread: it only tells the loop that the default output changed.
#[implement(IMMNotificationClient)]
struct Endpoints(isize);

impl IMMNotificationClient_Impl for Endpoints_Impl {
    fn OnDeviceStateChanged(&self, _: &PCWSTR, _: DEVICE_STATE) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnDeviceAdded(&self, _: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnDeviceRemoved(&self, _: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    // The volume keys and the taskbar act on the console role of the default output.
    fn OnDefaultDeviceChanged(&self, flow: EDataFlow, role: ERole, _: &PCWSTR) -> windows::core::Result<()> {
        if flow == eRender && role == eConsole {
            let _ = unsafe { PostMessageW(Some(HWND(self.0 as _)), WM_VOLDEV, WPARAM(0), LPARAM(0)) };
        }
        Ok(())
    }
    fn OnPropertyValueChanged(&self, _: &PCWSTR, _: &PROPERTYKEY) -> windows::core::Result<()> {
        Ok(())
    }
}

/// A connected Bluetooth device, as the association endpoint describes it.
struct BtDevice {
    name: String,
    /// Windows' device categories ("Audio.Headphone", "Input.Mouse"), for the icon.
    categories: Vec<String>,
    /// "c0:e5:79:36:e7:c6".
    address: String,
    /// Missing on some LE devices.
    container: Option<GUID>,
}

fn bt_props() -> IIterable<HSTRING> {
    IIterable::from([BT_CONNECTED, BT_CATEGORY, BT_ADDRESS, BT_CONTAINER].map(HSTRING::from).to_vec())
}

/// The paired devices as the watcher reported them, by association endpoint id. Kept from its events because a fresh
/// query (FindAllAsync) runs the whole enumeration and takes 30 s, while the watcher reports each change at once.
type Paired = Arc<Mutex<HashMap<String, DeviceInformation>>>;

fn lock(paired: &Paired) -> MutexGuard<'_, HashMap<String, DeviceInformation>> {
    paired.lock().unwrap_or_else(|e| e.into_inner())
}

/// Keeps `paired` current and wakes the loop on every change; the loop reads it once the burst is over. Kept for the app's lifetime.
fn bt_watch(h: isize, paired: Paired) -> Option<DeviceWatcher> {
    // wParam 1: the first enumeration of the paired devices is complete.
    let wake = move |done: usize| unsafe {
        let _ = PostMessageW(Some(HWND(h as _)), WM_BT, WPARAM(done), LPARAM(0));
    };
    let (added, updated) = (paired.clone(), paired.clone());
    DeviceInformation::CreateWatcherWithKindAqsFilterAndAdditionalProperties(&BT_PAIRED.into(), &bt_props(), DeviceInformationKind::AssociationEndpoint)
        .and_then(|w| {
            w.Added(&TypedEventHandler::new(move |_, info: Ref<DeviceInformation>| {
                if let Some(info) = info.as_ref() {
                    lock(&added).insert(info.Id()?.to_string(), info.clone());
                }
                Ok(wake(0))
            }))?;
            w.Updated(&TypedEventHandler::new(move |_, update: Ref<DeviceInformationUpdate>| {
                if let Some(update) = update.as_ref() {
                    if let Some(info) = lock(&updated).get(&update.Id()?.to_string()) {
                        info.Update(update)?;
                    }
                }
                Ok(wake(0))
            }))?;
            w.Removed(&TypedEventHandler::new(move |_, update: Ref<DeviceInformationUpdate>| {
                if let Some(update) = update.as_ref() {
                    lock(&paired).remove(&update.Id()?.to_string());
                }
                Ok(wake(0))
            }))?;
            w.EnumerationCompleted(&TypedEventHandler::new(move |_, _| Ok(wake(1))))?;
            w.Start()?;
            Ok(w)
        })
        .inspect_err(|e| eprintln!("sysevents: bluetooth watcher failed: {e}"))
        .ok()
}

/// The paired devices connected now, by association endpoint id.
fn bluetooth(paired: &Paired) -> HashMap<String, BtDevice> {
    lock(paired).iter().filter_map(|(id, d)| {
        let props = d.Properties().ok()?;
        let value = |key: &str| props.Lookup(&key.into()).ok().and_then(|v| v.cast::<IPropertyValue>().ok());
        if !value(BT_CONNECTED)?.GetBoolean().ok()? {
            return None;
        }
        let name = d.Name().ok()?.to_string();
        let mut categories = Array::<HSTRING>::new();
        let categories = match value(BT_CATEGORY) {
            Some(v) if v.GetStringArray(&mut categories).is_ok() => categories.iter().map(|c| c.to_string()).collect(),
            _ => Vec::new(),
        };
        let address = value(BT_ADDRESS).and_then(|v| v.GetString().ok()).map(|a| a.to_string()).unwrap_or_default();
        let container = value(BT_CONTAINER).and_then(|v| v.GetGuid().ok());
        Some((id.clone(), BtDevice { name, categories, address, container }))
    })
    .collect()
}

/// Battery from the device's Bluetooth nodes, found by its address in the instance id or by its container; read once at
/// connection, `None` when the device does not report it.
fn battery(address: &str, container: Option<GUID>) -> Option<u8> {
    let address = address.replace(':', "").to_ascii_uppercase();
    let flags = CM_GETIDLIST_FILTER_ENUMERATOR | CM_GETIDLIST_FILTER_PRESENT;
    for enumerator in [w!("BTHENUM"), w!("BTHHFENUM"), w!("BTHLE")] {
        unsafe {
            let mut len = 0;
            if CM_Get_Device_ID_List_SizeW(&mut len, enumerator, flags) != CR_SUCCESS {
                continue;
            }
            let mut ids = vec![0u16; len as usize];
            if CM_Get_Device_ID_ListW(enumerator, &mut ids, flags) != CR_SUCCESS {
                continue;
            }
            for id in ids.split(|&c| c == 0).filter(|id| !id.is_empty()) {
                let by_address = address.len() == 12 && String::from_utf16_lossy(id).to_ascii_uppercase().contains(&address);
                let id: Vec<u16> = id.iter().copied().chain([0]).collect();
                let mut node = 0;
                if CM_Locate_DevNodeW(&mut node, PCWSTR(id.as_ptr()), CM_LOCATE_DEVNODE_NORMAL) != CR_SUCCESS {
                    continue;
                }
                if !by_address && (container.is_none() || node_prop::<GUID>(node, &DEVPKEY_Device_ContainerId, DEVPROP_TYPE_GUID) != container) {
                    continue;
                }
                if let Some(level) = node_prop::<u8>(node, &DEVPKEY_BLUETOOTH_BATTERY, DEVPROP_TYPE_BYTE) {
                    return Some(level.min(100));
                }
            }
        }
    }
    None
}

/// A fixed-size device node property of the expected type.
unsafe fn node_prop<T: Default>(node: u32, key: &DEVPROPKEY, kind: DEVPROPTYPE) -> Option<T> {
    let mut value = T::default();
    let mut found = DEVPROPTYPE(0);
    let mut size = size_of::<T>() as u32;
    let ok = unsafe { CM_Get_DevNode_PropertyW(node, key, &mut found, Some(&mut value as *mut T as *mut u8), &mut size, 0) } == CR_SUCCESS;
    (ok && found == kind && size as usize == size_of::<T>()).then_some(value)
}

/// Volume and mute in percent, as the taskbar shows them.
type Level = (u8, bool);

/// The default output's volume callback; returns its endpoint (kept to unregister) and the level now, the baseline.
unsafe fn watch_volume(devices: &IMMDeviceEnumerator, client: &IAudioEndpointVolumeCallback) -> Option<(IAudioEndpointVolume, Level)> {
    unsafe {
        // No output device at all is not an error: the next default change registers.
        let endpoint: IAudioEndpointVolume = devices.GetDefaultAudioEndpoint(eRender, eConsole).and_then(|d| d.Activate(CLSCTX_ALL, None)).ok()?;
        endpoint.RegisterControlChangeNotify(client).inspect_err(|e| eprintln!("sysevents: volume notification failed: {e}")).ok()?;
        let now = (percent(endpoint.GetMasterVolumeLevelScalar().unwrap_or(0.0)), endpoint.GetMute().is_ok_and(|m| m.as_bool()));
        Some((endpoint, now))
    }
}

/// Runs on an audio service thread: it only posts the new level to the loop.
#[implement(IAudioEndpointVolumeCallback)]
struct VolumeWatch(isize);

impl IAudioEndpointVolumeCallback_Impl for VolumeWatch_Impl {
    fn OnNotify(&self, data: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> windows::core::Result<()> {
        let Some(d) = (unsafe { data.as_ref() }) else { return Ok(()) };
        let flags = d.bMuted.as_bool() as isize | ((d.guidEventContext == crate::controls::OWN_CHANGE) as isize) << 1;
        let _ = unsafe { PostMessageW(Some(HWND(self.0 as _)), WM_VOL, WPARAM(percent(d.fMasterVolume) as usize), LPARAM(flags)) };
        Ok(())
    }
}

/// A scalar 0..1 as the whole percent Windows shows.
fn percent(scalar: f32) -> u8 {
    (scalar.clamp(0.0, 1.0) * 100.0).round() as u8
}

/// The callback also fires for balance and channel changes and repeats while a key is held: only a new level or mute counts.
fn volume_changed(last: &mut Option<Level>, now: Level) -> bool {
    let changed = *last != Some(now);
    *last = Some(now);
    changed
}

/// One HUD reading for the frontend (status://level): `kind` "volume" or "brightness", `level` 0..100.
pub fn emit_level(app: &AppHandle, kind: &str, level: u8, muted: bool) {
    let _ = app.emit("status://level", serde_json::json!({ "kind": kind, "level": level, "muted": muted }));
    crate::osd::after_change();
}

/// From the settings: external monitors are read over DDC/CI only while the Brightness alert is on, Caps Lock and Num Lock only
/// while theirs is, and the Windows indicator is hidden only while the frontend says NotNotch's HUD replaces it.
#[tauri::command]
pub fn status_configure(app: AppHandle, ddc: bool, locks: bool, hide_osd: bool) {
    crate::brightness::set_ddc(ddc);
    watch_locks(&app, locks);
    crate::osd::set(hide_osd);
}

const LOCK_POLL: Duration = Duration::from_millis(150);
static LOCKS_ON: AtomicBool = AtomicBool::new(false);
/// Bumped on every switch; a polling thread runs while the number is still its own, so turning off ends it.
static LOCKS_RUN: AtomicUsize = AtomicUsize::new(0);

/// Caps Lock and Num Lock, toggled on or not.
type Locks = (bool, bool);

fn locks() -> Locks {
    // The low bit is the toggle state.
    unsafe { (GetKeyState(VK_CAPITAL.0 as i32) & 1 != 0, GetKeyState(VK_NUMLOCK.0 as i32) & 1 != 0) }
}

fn watch_locks(app: &AppHandle, on: bool) {
    if LOCKS_ON.swap(on, Ordering::SeqCst) == on {
        return;
    }
    let run = LOCKS_RUN.fetch_add(1, Ordering::SeqCst) + 1;
    if !on {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        let mut last = None;
        while LOCKS_RUN.load(Ordering::SeqCst) == run {
            for (key, on) in lock_changes(&mut last, locks()) {
                let _ = app.emit("status://lock", serde_json::json!({ "key": key, "on": on }));
            }
            thread::sleep(LOCK_POLL);
        }
    });
}

/// The keys whose state differs from the last reading; the first reading is the baseline, so starting never alerts.
fn lock_changes(last: &mut Option<Locks>, now: Locks) -> Vec<(&'static str, bool)> {
    let Some(before) = last.replace(now) else { return Vec::new() };
    [("caps", before.0, now.0), ("num", before.1, now.1)].into_iter().filter(|(_, was, is)| was != is).map(|(key, _, is)| (key, is)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_rounds_and_clamps() {
        assert_eq!(percent(0.0), 0);
        assert_eq!(percent(0.319_99), 32);
        assert_eq!(percent(0.5), 50);
        assert_eq!(percent(1.2), 100);
        assert_eq!(percent(-0.1), 0);
    }

    #[test]
    fn volume_changed_only_on_a_new_level() {
        let mut last = None;
        assert!(volume_changed(&mut last, (40, false)));
        // The same level again (a balance change, a held key at the top) is no change.
        assert!(!volume_changed(&mut last, (40, false)));
        assert!(volume_changed(&mut last, (40, true)));
        assert!(volume_changed(&mut last, (42, true)));
        assert_eq!(last, Some((42, true)));
    }

    #[test]
    fn lock_changes_skip_the_first_reading_and_repeats() {
        let mut last = None;
        assert!(lock_changes(&mut last, (false, true)).is_empty());
        assert!(lock_changes(&mut last, (false, true)).is_empty());
        assert_eq!(lock_changes(&mut last, (true, true)), vec![("caps", true)]);
        assert_eq!(lock_changes(&mut last, (false, false)), vec![("caps", false), ("num", false)]);
        assert_eq!(last, Some((false, false)));
    }
}
