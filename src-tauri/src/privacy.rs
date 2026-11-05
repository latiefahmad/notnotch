//! Dots like on iPhone: is anything using the mic or camera, or recording the screen?
//!
//! Windows tracks this itself (Settings → Privacy → "Recent activity") under
//! `HKCU\…\CapabilityAccessManager\ConsentStore\<capability>`: one key per app with
//! `LastUsedTimeStart`/`LastUsedTimeStop`. Stop = 0 means "in use". Desktop apps
//! sit one level deeper under `NonPackaged`.
//!
//! Screen recording: `graphicsCaptureProgrammatic` (Windows.Graphics.Capture: Discord,
//! Teams, Snipping Tool, OBS depending on source). Older capture paths (DXGI
//! duplication) don't show up there.

use serde::Serialize;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ};

const BASE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";

#[derive(Serialize)]
pub struct Privacy {
    mic: bool,
    camera: bool,
    screen: bool,
}

/// NotNotch's own entries: its exe path as the consent store spells it (`\` as `#`) and, in the Store build, its
/// package family. Never counted, so the Camera tool does not light the camera dot while the user looks at themself.
struct Own {
    exe: Option<String>,
    family: Option<String>,
}

impl Own {
    fn get() -> &'static Own {
        static OWN: std::sync::OnceLock<Own> = std::sync::OnceLock::new();
        OWN.get_or_init(|| Own {
            exe: std::env::current_exe().ok().map(|p| p.to_string_lossy().replace('\\', "#").to_lowercase()),
            // Fails outside a package, which is every build but the Store one.
            family: windows::ApplicationModel::Package::Current().and_then(|p| p.Id()).and_then(|id| id.FamilyName()).ok().map(|f| f.to_string().to_lowercase()),
        })
    }

    /// `name`: a subkey of `NonPackaged` (an exe path) or of the capability itself (a package family).
    fn is(&self, name: &str, non_packaged: bool) -> bool {
        let mine = if non_packaged { &self.exe } else { &self.family };
        mine.as_deref() == Some(name.to_lowercase().as_str())
    }
}

#[tauri::command]
pub fn privacy_state() -> Privacy {
    let busy = |cap: &str| in_use(&format!(r"{BASE}\{cap}"), Own::get());
    Privacy { mic: busy("microphone"), camera: busy("webcam"), screen: busy("graphicsCaptureProgrammatic") }
}

/// Is any app under `path` (or `path\NonPackaged`) active right now?
fn in_use(path: &str, own: &Own) -> bool {
    let Some(key) = open(HKEY_CURRENT_USER, path) else { return false };
    let mut active = false;
    for name in subkeys(key) {
        let Some(sub) = open(key, &name) else { continue };
        if name == "NonPackaged" {
            active |= subkeys(sub).iter().filter(|n| !own.is(n, true)).any(|n| open(sub, n).is_some_and(|k| running_close(k)));
        } else if !own.is(&name, false) {
            active |= running(sub);
        }
        close(sub);
        if active {
            break;
        }
    }
    close(key);
    active
}

/// Start set and Stop = 0 → in use.
fn running(key: HKEY) -> bool {
    let start = qword(key, "LastUsedTimeStart");
    let stop = qword(key, "LastUsedTimeStop");
    start.is_some_and(|s| s > 0) && stop == Some(0)
}

fn running_close(key: HKEY) -> bool {
    let r = running(key);
    close(key);
    r
}

fn close(key: HKEY) {
    unsafe {
        let _ = RegCloseKey(key);
    }
}

fn open(parent: HKEY, path: &str) -> Option<HKEY> {
    let mut key = HKEY::default();
    let ok = unsafe { RegOpenKeyExW(parent, &HSTRING::from(path), Some(0), KEY_READ, &mut key) } == ERROR_SUCCESS;
    ok.then_some(key)
}

fn subkeys(key: HKEY) -> Vec<String> {
    let mut out = Vec::new();
    for i in 0.. {
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let status = unsafe { RegEnumKeyExW(key, i, Some(windows::core::PWSTR(buf.as_mut_ptr())), &mut len, None, None, None, None) };
        if status != ERROR_SUCCESS {
            break;
        }
        out.push(String::from_utf16_lossy(&buf[..len as usize]));
    }
    out
}

fn qword(key: HKEY, name: &str) -> Option<u64> {
    let mut value = 0u64;
    let mut size = 8u32;
    let name = HSTRING::from(name);
    let status = unsafe { RegQueryValueExW(key, PCWSTR(name.as_ptr()), None, None, Some(&mut value as *mut u64 as *mut u8), Some(&mut size)) };
    (status == ERROR_SUCCESS).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::Own;

    #[test]
    fn own_entries_are_skipped() {
        let own = Own { exe: Some(r"c:#program files#notnotch#notnotch.exe".into()), family: Some("latiefahmad.notnotch_abc123".into()) };
        assert!(own.is(r"C:#Program Files#NotNotch#notnotch.exe", true));
        assert!(own.is("Latiefahmad.NotNotch_abc123", false));
        // The exe path only counts under NonPackaged, the family only beside it.
        assert!(!own.is(r"C:#Program Files#NotNotch#notnotch.exe", false));
        assert!(!own.is("Latiefahmad.NotNotch_abc123", true));
        assert!(!own.is(r"C:#Program Files#Zoom#bin#Zoom.exe", true));
        assert!(!own.is("Microsoft.WindowsCamera_8wekyb3d8bbwe", false));
        assert!(!Own { exe: None, family: None }.is("", false));
    }
}
