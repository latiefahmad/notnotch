//! Last resort for apps that play audio but never register a GSMTC session (repackaged
//! Electron players such as ytbplus). Windows cannot tell NotNotch the track, so this reads the
//! app's window title instead.
//!
//! Rules, so a title is only used when it plausibly is a track:
//! - The app must be an audio session on the default output that is actually sounding: a muted
//!   or silent session is not "now playing", and its title is a page name, not a track.
//! - The title must look like one ("Artist - Title", "Title - Artist", or a bare title), so
//!   "New Tab", "Settings" or a bare app name never reach the notch.
//! - Nothing here invents a cover or a position: the notch shows what it has.

use windows::core::Interface;
use windows::Win32::Foundation::HWND;
use windows::Win32::Media::Audio::{
    eConsole, eRender, AudioSessionStateActive, AudioSessionStateInactive, IAudioSessionControl2, IAudioSessionManager2,
    IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible};

use crate::mixer::process_path;

/// What an app's window title says, whether or not it is a track.
pub struct Seen {
    pub app_id: String,
    /// The track the title stands for; `None` when it is the app itself or a page.
    pub track: Option<String>,
    /// Audio is flowing through the session: the track (if any) is playing.
    pub playing: bool,
}

/// Names a player or a browser puts after a dash, and shows alone when no track is loaded.
const APP_NAMES: &[&str] = &[
    "youtube", "youtube music", "ytbplus", "spotify", "chrome", "google chrome", "microsoft edge", "edge", "firefox", "brave", "opera",
    "vivaldi", "music", "apple music", "vlc", "itunes", "mediamonkey", "foobar2000", "aimp", "winamp", "groove music", "media player",
    "windows media player", "amazon music", "deezer", "tidal", "soundcloud",
];

/// Titles that are a page, a menu or the app itself, never a track.
const NOT_A_TRACK: &[&str] = &[
    "new tab", "settings", "preferences", "einstellungen", "home", "start", "startseite", "library", "bibliothek",
    "search", "explore", "trending", "subscriptions", "watch later", "history", "verlauf", "playlist", "album",
    "artist", "untitled", "loading", "laden", "no title", "login", "sign in", "anmelden",
];

/// Every app with an audio session on the default output, with the track its window title shows.
///
/// A paused app stays in the list: its title may still name the track (`playing = false`), and it
/// may have dropped back to the bare app name, which `track: None` reports.
///
/// `skip` holds app IDs GSMTC already knows: those are never guessed from a title.
pub fn scan(skip: &[String]) -> Vec<Seen> {
    let mut out = Vec::new();
    unsafe {
        // Own thread per call (spawn_blocking) → MTA; "already initialized" is fine.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(devices) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return out };
        let Ok(endpoint) = devices.GetDefaultAudioEndpoint(eRender, eConsole) else { return out };
        let Ok(manager) = endpoint.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { return out };
        let Ok(list) = manager.GetSessionEnumerator() else { return out };

        for i in 0..list.GetCount().unwrap_or(0) {
            let Ok(control) = list.GetSession(i) else { continue };
            let Ok(control) = control.cast::<IAudioSessionControl2>() else { continue };
            if control.IsSystemSoundsSession() == windows::Win32::Foundation::S_OK {
                continue;
            }
            // Expired is a closed player: nothing to show, and its title is stale.
            let Some(state) = control
                .GetState()
                .ok()
                .filter(|s| *s == AudioSessionStateActive || *s == AudioSessionStateInactive)
            else {
                continue;
            };
            let playing = state == AudioSessionStateActive;
            let Ok(pid) = control.GetProcessId() else { continue };
            if pid == 0 {
                continue;
            }
            // Muted: the app is open but deliberately silent, which is not "paused".
            if control.cast::<ISimpleAudioVolume>().is_ok_and(|v| v.GetMute().is_ok_and(|m| m.as_bool())) {
                continue;
            }
            let Some(path) = process_path(pid) else { continue };
            let exe = crate::mixer::file_name(&path);
            if skip.iter().any(|id| crate::mixer::matches(id, &exe)) {
                continue;
            }
            let Some((_hwnd, window_title)) = window_title_of(pid) else { continue };
            out.push(Seen { app_id: exe, track: as_track(&window_title), playing });
        }
        out
    }
}

/// The visible window with the longest title of that process: a browser's active tab or the
/// player's own title bar. Skips helper windows ("", "MSCTFIME UI", tiny tool windows).
fn window_title_of(pid: u32) -> Option<(HWND, String)> {
    let mut search = Search { pid, best: None };
    unsafe {
        let _ = EnumWindows(Some(collect), windows::Win32::Foundation::LPARAM(&mut search as *mut Search as isize));
    }
    search.best
}

struct Search {
    pid: u32,
    best: Option<(HWND, String)>,
}

unsafe extern "system" fn collect(hwnd: HWND, lparam: windows::Win32::Foundation::LPARAM) -> windows::core::BOOL {
    use windows::Win32::Foundation::{GetLastError, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindow, GW_OWNER};

    let search = &mut *(lparam.0 as *mut Search);
    if !IsWindowVisible(hwnd).as_bool() || GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid()) {
        return TRUE;
    }
    let mut owner = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut owner));
    if owner != search.pid {
        return TRUE;
    }
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return TRUE;
    }
    let mut buf = vec![0u16; len as usize + 1];
    let n = GetWindowTextW(hwnd, &mut buf);
    let _ = GetLastError;
    if n <= 0 {
        return TRUE;
    }
    let text = String::from_utf16_lossy(&buf[..n as usize]);
    // The longest title wins: a player's track title beats a small window of the same app.
    if search.best.as_ref().is_none_or(|(_, best)| text.chars().count() > best.chars().count()) {
        search.best = Some((hwnd, text));
    }
    TRUE
}

/// The track a window title stands for, or None if it is a page name, a menu or the app itself.
///
/// Electron players put their track in the title as "Artist - Title" (YouTube), "Title - Artist"
/// (most taggers) or just "Title". The split is a guess, so the caller shows it as one line.
pub fn as_track(title: &str) -> Option<String> {
    let t = title.trim();
    if t.chars().count() < 2 || t.chars().count() > 300 {
        return None;
    }
    let lower = t.to_lowercase();
    if NOT_A_TRACK.iter().any(|x| lower == *x) {
        return None;
    }
    // The bare app name is a window that shows nothing, not a track.
    if APP_NAMES.iter().any(|x| lower == *x) {
        return None;
    }
    // A browser appends its own name: "Title - YouTube", "Title – Google Chrome".
    let t = strip_app_suffix(t);
    let t = t.trim();
    if t.chars().count() < 2 {
        return None;
    }
    Some(t.to_string())
}

/// Drops a trailing "- YouTube", "– Spotify", "| App" and the like.
fn strip_app_suffix(title: &str) -> String {
    for sep in [" - ", " – ", " — ", " | ", " · "] {
        if let Some((head, tail)) = title.rsplit_once(sep) {
            if APP_NAMES.iter().any(|a| tail.trim().to_lowercase().starts_with(a)) {
                return head.trim().to_string();
            }
        }
    }
    title.to_string()
}

/// Keeps the last track named per app, newest first, so the list cannot grow without end.
pub fn remember(last_tracks: &mut Vec<(String, String)>, app_id: &str, track: &str) {
    if last_tracks.iter().any(|(app, t)| app == app_id && t == track) {
        return;
    }
    last_tracks.retain(|(app, _)| app != app_id);
    last_tracks.insert(0, (app_id.to_string(), track.to_string()));
    last_tracks.truncate(8);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_titles_are_kept() {
        assert_eq!(as_track("Tinta Lirik - Yeni Inka ft. Yesa Oktavia - Laut Kidul - Lirik").unwrap(), "Tinta Lirik - Yeni Inka ft. Yesa Oktavia - Laut Kidul - Lirik");
        assert_eq!(as_track("Pulung").unwrap(), "Pulung");
        assert_eq!(as_track("  Blinding Lights  ").unwrap(), "Blinding Lights");
    }

    #[test]
    fn app_suffix_is_dropped() {
        assert_eq!(as_track("Blinding Lights - YouTube").unwrap(), "Blinding Lights");
        assert_eq!(as_track("One More Time – Spotify").unwrap(), "One More Time");
        assert_eq!(as_track("Lagu Favorit | YouTube Music").unwrap(), "Lagu Favorit");
        // A dash that is not an app name stays: it may be part of the track.
        assert_eq!(as_track("A - B - C").unwrap(), "A - B - C");
    }

    #[test]
    fn page_names_are_refused() {
        for t in ["New Tab", "Settings", "Home", "Untitled", "Loading", "Login", "", " ", "a"] {
            assert!(as_track(t).is_none(), "{t:?}");
        }
        // Only the app name left after the suffix is dropped: no track.
        assert!(as_track("YouTube").is_none());
    }

    /// ytbplus names the track while playing and drops back to "ytbplus" when paused: the title is
    /// no track then, which is what makes the caller fall back to the last one it saw.
    #[test]
    fn a_paused_app_stops_naming_its_track() {
        assert_eq!(as_track("Jasun Marju, Laila Ayu - Pamit Rabi").unwrap(), "Jasun Marju, Laila Ayu - Pamit Rabi");
        assert!(as_track("ytbplus").is_none());
        assert!(as_track("YTBPlus").is_none());
    }

    #[test]
    fn the_last_named_track_is_kept_per_app() {
        let mut last: Vec<(String, String)> = Vec::new();
        remember(&mut last, "ytbplus.exe", "Pamit Rabi");
        remember(&mut last, "ytbplus.exe", "Pamit Rabi");
        assert_eq!(last.len(), 1);

        remember(&mut last, "ytbplus.exe", "Sampek Tuwek");
        assert_eq!(last, vec![("ytbplus.exe".into(), "Sampek Tuwek".into())]);

        // Another app keeps its own last track, and the newest is first.
        remember(&mut last, "spotify.exe", "Blinding Lights");
        assert_eq!(last[0].0, "spotify.exe");
        assert_eq!(last[1].0, "ytbplus.exe");

        for i in 0..12 {
            remember(&mut last, "a.exe", &format!("track {i}"));
        }
        assert!(last.len() <= 8);
    }
}
