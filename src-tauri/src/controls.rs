//! Overview: system volume and Windows focus.
//!
//! - Volume: default output device via `IAudioEndpointVolume` (same as the taskbar slider).
//! - Output device: the active playback devices, and switching the default one (`IPolicyConfig`).
//! - Focus: Windows 11 focus session (`FocusSessionManager`, also turns on Do Not Disturb).
//!   Without that API (older builds), Do Not Disturb is set directly through the WNF state
//!   `WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED`, which is what the toggle in the
//!   notification center does.

use std::ffi::c_void;

use serde::Serialize;
use windows::core::{GUID, HSTRING, PWSTR};
use windows::UI::Shell::FocusSessionManager;
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};

/// Passed with NotNotch's own volume changes, so the HUD (sysevents.rs) can tell them from keys and other apps.
pub const OWN_CHANGE: windows::core::GUID = windows::core::GUID::from_u128(0x5f2c6a1e_93b4_4d7e_a0c1_c4e57a3b9d20);

#[derive(Serialize)]
pub struct Volume {
    /// 0..1
    level: f32,
    muted: bool,
}

#[derive(Serialize)]
pub struct Focus {
    active: bool,
    /// "focus" = focus session, "dnd" = only Do Not Disturb available
    kind: &'static str,
}

fn endpoint() -> windows::core::Result<IAudioEndpointVolume> {
    unsafe {
        // Own thread per call (spawn_blocking) → MTA; "already initialized" is fine.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        devices.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)
    }
}

fn read_volume() -> windows::core::Result<Volume> {
    let ep = endpoint()?;
    unsafe { Ok(Volume { level: ep.GetMasterVolumeLevelScalar()?, muted: ep.GetMute()?.as_bool() }) }
}

#[tauri::command]
pub async fn volume_get() -> Result<Volume, String> {
    tauri::async_runtime::spawn_blocking(|| read_volume().map_err(|e| e.message()))
        .await
        .map_err(|e| e.to_string())?
}

/// Sets `level` 0..1 and/or `muted`. Raising the volume unmutes, like Windows does.
#[tauri::command]
pub async fn volume_set(level: Option<f32>, muted: Option<bool>) -> Result<Volume, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ep = endpoint().map_err(|e| e.message())?;
        unsafe {
            if let Some(l) = level {
                ep.SetMasterVolumeLevelScalar(l.clamp(0.0, 1.0), &OWN_CHANGE).map_err(|e| e.message())?;
                if l > 0.0 && muted.is_none() {
                    let _ = ep.SetMute(false, &OWN_CHANGE);
                }
            }
            if let Some(m) = muted {
                ep.SetMute(m, &OWN_CHANGE).map_err(|e| e.message())?;
            }
        }
        read_volume().map_err(|e| e.message())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Output device ─────────────────────────────────────────────────────────────

/// One active playback device.
#[derive(Serialize)]
pub struct Output {
    id: String,
    name: String,
    /// The default console endpoint, the one the volume slider controls.
    default: bool,
}

/// IPolicyConfig: undocumented, but unchanged since Windows 7; the Sound settings pick the default device through it.
/// Method order as in EarTrumpet (Interop/MMDeviceAPI/IPolicyConfig.cs) and the widely copied PolicyConfig.h:
/// ten methods NotNotch never calls, then SetDefaultEndpoint. Only the slot count of the first ten matters.
/// The interface macro takes no attributes, so the lint exceptions sit on this module.
#[allow(non_snake_case, dead_code)]
mod policy {
    use windows::core::{interface, IUnknown, IUnknown_Vtbl, GUID, HRESULT, HSTRING, PCWSTR};
    use windows::Win32::Media::Audio::{eCommunications, eConsole, eMultimedia, ERole};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    /// CPolicyConfigClient.
    const POLICY_CONFIG: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

    /// Makes the endpoint `id` the default for all three roles. COM must be initialised on this thread.
    pub fn set_default(id: &HSTRING) -> windows::core::Result<()> {
        unsafe {
            let policy: IPolicyConfig = CoCreateInstance(&POLICY_CONFIG, None, CLSCTX_ALL)?;
            for role in [eConsole, eMultimedia, eCommunications] {
                policy.SetDefaultEndpoint(PCWSTR(id.as_ptr()), role).ok()?;
            }
        }
        Ok(())
    }

    #[interface("f8679f50-850a-41cf-9c72-430f290290c8")]
    unsafe trait IPolicyConfig: IUnknown {
        fn GetMixFormat(&self) -> HRESULT;
        fn GetDeviceFormat(&self) -> HRESULT;
        fn ResetDeviceFormat(&self) -> HRESULT;
        fn SetDeviceFormat(&self) -> HRESULT;
        fn GetProcessingPeriod(&self) -> HRESULT;
        fn SetProcessingPeriod(&self) -> HRESULT;
        fn GetShareMode(&self) -> HRESULT;
        fn SetShareMode(&self) -> HRESULT;
        fn GetPropertyValue(&self) -> HRESULT;
        fn SetPropertyValue(&self) -> HRESULT;
        fn SetDefaultEndpoint(&self, id: PCWSTR, role: ERole) -> HRESULT;
    }
}

/// PKEY_Device_FriendlyName, defined here so one key does not need the FunctionDiscovery feature.
const FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0), pid: 14 };

/// Copies a string COM allocated and frees it.
unsafe fn take(p: PWSTR) -> Option<String> {
    unsafe {
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as _));
        s
    }
}

fn device_id(device: &IMMDevice) -> Option<String> {
    unsafe { device.GetId().ok().and_then(|p| take(p)) }
}

fn read_outputs() -> windows::core::Result<Vec<Output>> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let current = devices.GetDefaultAudioEndpoint(eRender, eConsole).ok().and_then(|d| device_id(&d));
        let list = devices.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        let mut outputs = Vec::new();
        for i in 0..list.GetCount()? {
            let Ok(device) = list.Item(i) else { continue };
            let Some(id) = device_id(&device) else { continue };
            let name = device
                .OpenPropertyStore(STGM_READ)
                .and_then(|store| store.GetValue(&FRIENDLY_NAME))
                .and_then(|value| PropVariantToStringAlloc(&value))
                .ok()
                .and_then(|p| take(p))
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| id.clone());
            outputs.push(Output { default: current.as_deref() == Some(id.as_str()), id, name });
        }
        Ok(outputs)
    }
}

/// The id comes from the web view, so only an endpoint Windows lists as active right now is passed on.
fn check_output(id: &str, outputs: &[Output]) -> Result<(), String> {
    if outputs.iter().any(|o| o.id == id) { Ok(()) } else { Err("Unknown output device".into()) }
}

#[tauri::command]
pub async fn audio_outputs() -> Result<Vec<Output>, String> {
    tauri::async_runtime::spawn_blocking(|| read_outputs().map_err(|e| e.message()))
        .await
        .map_err(|e| e.to_string())?
}

/// Makes `id` the default for all three roles, like picking it in the taskbar's sound menu.
#[tauri::command]
pub async fn audio_set_output(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_output(&id, &read_outputs().map_err(|e| e.message())?)?;
        policy::set_default(&HSTRING::from(id.as_str())).map_err(|e| e.message())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Focus / Do Not Disturb ────────────────────────────────────────────────────

const WNF_QUIET_HOURS: u64 = 0x0D83_063E_A3BF_1C75;

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryWnfStateData(state: *const u64, type_id: *const c_void, scope: *const c_void, stamp: *mut u32, buffer: *mut c_void, size: *mut u32) -> i32;
    fn NtUpdateWnfStateData(state: *const u64, buffer: *const c_void, length: u32, type_id: *const c_void, scope: *const c_void, matching_stamp: u32, check_stamp: u32) -> i32;
}

/// 0 = off, 1 = priority only, 2 = alarms only.
fn dnd_profile() -> Option<u32> {
    let (mut stamp, mut value, mut size) = (0u32, 0u32, 4u32);
    let status = unsafe { NtQueryWnfStateData(&WNF_QUIET_HOURS, std::ptr::null(), std::ptr::null(), &mut stamp, (&mut value as *mut u32).cast(), &mut size) };
    (status >= 0).then_some(if size == 0 { 0 } else { value })
}

fn set_dnd(on: bool) -> Result<(), String> {
    let value: u32 = if on { 1 } else { 0 };
    let status = unsafe { NtUpdateWnfStateData(&WNF_QUIET_HOURS, (&value as *const u32).cast(), 4, std::ptr::null(), std::ptr::null(), 0, 0) };
    if status >= 0 { Ok(()) } else { Err(format!("Could not switch Do Not Disturb ({status:#x})")) }
}

fn sessions() -> Option<FocusSessionManager> {
    FocusSessionManager::IsSupported().ok().filter(|&s| s).and_then(|_| FocusSessionManager::GetDefault().ok())
}

fn read_focus() -> Focus {
    let dnd = dnd_profile().is_some_and(|p| p != 0);
    match sessions() {
        Some(m) => Focus { active: m.IsFocusActive().unwrap_or(false) || dnd, kind: "focus" },
        None => Focus { active: dnd, kind: "dnd" },
    }
}

#[tauri::command]
pub async fn focus_get() -> Focus {
    tauri::async_runtime::spawn_blocking(read_focus).await.unwrap_or(Focus { active: false, kind: "dnd" })
}

#[tauri::command]
pub async fn focus_set(active: bool) -> Result<Focus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = sessions();
        if active {
            // Prefer a focus session; if that fails, at least Do Not Disturb.
            if manager.as_ref().and_then(|m| m.TryStartFocusSession().ok()).is_none() {
                set_dnd(true)?;
            }
        } else {
            if let Some(m) = &manager {
                let _ = m.DeactivateFocus();
            }
            if dnd_profile().is_some_and(|p| p != 0) {
                set_dnd(false)?;
            }
        }
        Ok(read_focus())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_listed_output_is_accepted() {
        let outputs = [
            Output { id: "{0.0.0.00000000}.{a}".into(), name: "Speakers".into(), default: true },
            Output { id: "{0.0.0.00000000}.{b}".into(), name: "Headphones".into(), default: false },
        ];
        assert!(check_output("{0.0.0.00000000}.{b}", &outputs).is_ok());
        assert!(check_output("{0.0.0.00000000}.{c}", &outputs).is_err());
        assert!(check_output("", &outputs).is_err());
        assert!(check_output("{0.0.0.00000000}.{a}", &[]).is_err());
    }
}
