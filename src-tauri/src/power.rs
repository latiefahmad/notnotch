//! Keep awake and the Windows power plan.
//!
//! - Keep awake: `SetThreadExecutionState` on a thread of its own, since the flag belongs to the thread that set it and
//!   ends with it. The thread waits for a new deadline or the end of the current one, then clears the flag and exits.
//! - Power plan: the schemes from `PowerEnumerate`, their names, the active one, and switching to one of the listed ones.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::core::GUID;
use windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL};
use windows::Win32::System::Power::{
    PowerEnumerate, PowerGetActiveScheme, PowerReadFriendlyName, PowerSetActiveScheme, SetThreadExecutionState, ACCESS_SCHEME, ES_CONTINUOUS, ES_DISPLAY_REQUIRED,
    ES_SYSTEM_REQUIRED,
};

/// The running keep-awake thread: a new deadline (None = until turned off) goes down the channel; dropping it ends the thread.
static AWAKE: Mutex<Option<(Sender<Option<Instant>>, JoinHandle<()>)>> = Mutex::new(None);

/// On with `minutes` (None = until turned off), or off.
#[tauri::command]
pub fn keep_awake_set(on: bool, minutes: Option<u32>) {
    let mut awake = AWAKE.lock().unwrap_or_else(|e| e.into_inner());
    if !on {
        if let Some((tx, handle)) = awake.take() {
            drop(tx);
            let _ = handle.join();
        }
        return;
    }
    let deadline = minutes.map(|m| Instant::now() + Duration::from_secs(u64::from(m) * 60));
    // A thread whose time ran out has dropped its receiver, so the send fails and a new one starts.
    if let Some((tx, _)) = awake.as_ref() {
        if tx.send(deadline).is_ok() {
            return;
        }
    }
    let (tx, rx) = mpsc::channel();
    *awake = Some((tx, thread::spawn(move || hold(rx, deadline))));
}

/// For the app's exit: clears the flag before the process ends.
pub fn keep_awake_stop() {
    keep_awake_set(false, None);
}

fn hold(rx: Receiver<Option<Instant>>, mut deadline: Option<Instant>) {
    unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) };
    loop {
        let next = match deadline {
            Some(d) => rx.recv_timeout(d.saturating_duration_since(Instant::now())),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match next {
            Ok(d) => deadline = d,
            Err(_) => break,
        }
    }
    unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
}

#[derive(Serialize)]
pub struct Plan {
    id: String,
    name: String,
}

#[derive(Serialize)]
pub struct Plans {
    plans: Vec<Plan>,
    active: Option<String>,
}

fn guid_id(g: &GUID) -> String {
    format!("{g:?}").to_ascii_lowercase()
}

/// Only a scheme Windows listed may be set.
fn find(schemes: &[GUID], id: &str) -> Option<GUID> {
    schemes.iter().copied().find(|g| guid_id(g) == id.to_ascii_lowercase())
}

fn schemes() -> Vec<GUID> {
    let mut out = Vec::new();
    for index in 0.. {
        let mut guid = GUID::zeroed();
        let mut size = std::mem::size_of::<GUID>() as u32;
        if unsafe { PowerEnumerate(None, None, None, ACCESS_SCHEME, index, Some(&mut guid as *mut GUID as *mut u8), &mut size) } != ERROR_SUCCESS {
            break;
        }
        out.push(guid);
    }
    out
}

fn friendly_name(g: &GUID) -> Option<String> {
    let mut size = 0u32;
    let _ = unsafe { PowerReadFriendlyName(None, Some(g), None, None, None, &mut size) };
    if size < 2 {
        return None;
    }
    let mut buf = vec![0u16; size as usize / 2];
    if unsafe { PowerReadFriendlyName(None, Some(g), None, None, Some(buf.as_mut_ptr() as *mut u8), &mut size) } != ERROR_SUCCESS {
        return None;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..end]))
}

fn active() -> Option<GUID> {
    let mut p: *mut GUID = std::ptr::null_mut();
    if unsafe { PowerGetActiveScheme(None, &mut p) } != ERROR_SUCCESS || p.is_null() {
        return None;
    }
    let g = unsafe { *p };
    unsafe { LocalFree(Some(HLOCAL(p.cast()))) };
    Some(g)
}

fn read() -> Plans {
    let plans = schemes().iter().map(|g| Plan { id: guid_id(g), name: friendly_name(g).unwrap_or_else(|| guid_id(g)) }).collect();
    Plans { plans, active: active().as_ref().map(guid_id) }
}

#[tauri::command]
pub async fn power_plans() -> Plans {
    tauri::async_runtime::spawn_blocking(read).await.unwrap_or(Plans { plans: Vec::new(), active: None })
}

#[tauri::command]
pub async fn power_plan_set(id: String) -> Result<Plans, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let g = find(&schemes(), &id).ok_or("unknown plan")?;
        let e = unsafe { PowerSetActiveScheme(None, Some(&g)) };
        if e != ERROR_SUCCESS {
            return Err(format!("PowerSetActiveScheme failed: {}", e.0));
        }
        Ok(read())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const BALANCED: GUID = GUID::from_u128(0x381b4222_f694_41f0_9685_ff5bb260df2e);
    const HIGH: GUID = GUID::from_u128(0x8c5e7fda_e8bf_4a96_9a85_a6e23a8c635c);

    #[test]
    fn only_listed_plans_are_found() {
        assert_eq!(guid_id(&BALANCED), "381b4222-f694-41f0-9685-ff5bb260df2e");
        let list = [BALANCED, HIGH];
        assert_eq!(find(&list, "381b4222-f694-41f0-9685-ff5bb260df2e"), Some(BALANCED));
        assert_eq!(find(&list, "8C5E7FDA-E8BF-4A96-9A85-A6E23A8C635C"), Some(HIGH));
        assert_eq!(find(&[BALANCED], "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"), None);
        assert_eq!(find(&list, ""), None);
        assert_eq!(find(&list, "{381b4222-f694-41f0-9685-ff5bb260df2e}"), None);
    }
}
