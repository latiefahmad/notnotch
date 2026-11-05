//! Now Playing on a Mac: Spotify and Music over AppleScript.
//!
//! macOS has no public API for "whatever is playing": MediaRemote is private and from macOS 15.4 answers only Apple's own
//! apps. Both players have a scripting dictionary instead, so a thread asks the running ones once a second (`osascript`,
//! only for a player that is running, so none is ever launched) and emits `media://update` like media.rs does on Windows.
//! The first question to each player makes macOS ask for the Automation permission.

use std::collections::HashMap;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime};

use base64::Engine;
use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager, State};

/// The players asked, by process name, which is also their AppleScript name and the app id the frontend sees.
const PLAYERS: [&str; 2] = ["Spotify", "Music"];
const POLL: Duration = Duration::from_secs(1);
/// Drift beyond which a position counts as a seek and is sent again (as on Windows).
const SEEK_THRESHOLD: f64 = 1.5;
const LYRICS_RESYNC: Duration = Duration::from_secs(5);

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    app_id: String,
    is_playing: bool,
}

/// The same shape as media.rs, so the frontend reads both alike.
#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    title: String,
    artist: String,
    artwork: Option<String>,
    is_playing: bool,
    position: f64,
    duration: f64,
    can_seek: bool,
    app_id: String,
    shuffle: Option<bool>,
    repeat: Option<&'static str>,
    sources: Vec<Source>,
}

/// Last emitted state and when; the pinned app; lyrics on screen.
#[derive(Default)]
pub struct MediaState(Mutex<Option<(NowPlaying, SystemTime)>>, Mutex<Option<String>>, AtomicBool);

#[tauri::command]
pub fn media_get(state: State<'_, MediaState>) -> Option<NowPlaying> {
    let (mut np, at) = state.0.lock().unwrap().clone()?;
    if np.is_playing {
        np.position += at.elapsed().map(|d| d.as_secs_f64()).unwrap_or(0.0);
        if np.duration > 0.0 {
            np.position = np.position.min(np.duration);
        }
    }
    Some(np)
}

#[tauri::command]
pub async fn media_control(state: State<'_, MediaState>, action: String, position: Option<f64>, on: Option<bool>) -> Result<(), String> {
    let Some(app) = state.0.lock().unwrap().as_ref().map(|(np, _)| np.app_id.clone()) else { return Ok(()) };
    let spotify = app == "Spotify";
    let command = match action.as_str() {
        "toggle" => "playpause".to_string(),
        "next" => "next track".to_string(),
        "previous" => "previous track".to_string(),
        "seek" => format!("set player position to {:.3}", position.unwrap_or(0.0).max(0.0)),
        "shuffle" if spotify => format!("set shuffling to {}", on.unwrap_or(false)),
        "shuffle" => format!("set shuffle enabled to {}", on.unwrap_or(false)),
        // Spotify has repeat on or off; Music cycles off, all, one like the Windows players.
        "repeat" if spotify => "set repeating to not repeating".to_string(),
        "repeat" => "if song repeat is off then\nset song repeat to all\nelse if song repeat is all then\nset song repeat to one\nelse\nset song repeat to off\nend if".to_string(),
        _ => return Ok(()),
    };
    let script = format!("tell application \"{app}\"\n{command}\nend tell");
    tauri::async_runtime::spawn_blocking(move || run(&script).map(|_| ())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn media_lyrics(on: bool, state: State<'_, MediaState>) {
    state.2.store(on, Ordering::Relaxed);
}

#[tauri::command]
pub fn media_pin(app_id: Option<String>, state: State<'_, MediaState>) {
    *state.1.lock().unwrap() = app_id.filter(|id| !id.is_empty());
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    app_id: String,
    title: String,
    artist: String,
    is_playing: bool,
}

#[tauri::command]
pub async fn media_sources() -> Result<Vec<SourceInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        running()
            .into_iter()
            .filter_map(read)
            .map(|t| SourceInfo { app_id: t.app.into(), title: t.title, artist: t.artist, is_playing: t.playing })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// One player's answer.
struct Track {
    app: &'static str,
    playing: bool,
    title: String,
    artist: String,
    position: f64,
    duration: f64,
    artwork_url: String,
    shuffle: bool,
    repeat: &'static str,
}

/// Fields separated by tabs; the numbers as AppleScript writes them (a decimal comma on some systems).
fn script_for(player: &str) -> String {
    let (duration, artwork, shuffle, repeat) = if player == "Spotify" {
        ("(duration of t) / 1000", "artwork url of t", "shuffling", "repeating")
    } else {
        ("duration of t", "\"\"", "shuffle enabled", "song repeat")
    };
    format!(
        "tell application \"{player}\"\nif player state is stopped then return \"\"\nset t to current track\n\
         return (player state as text) & tab & (name of t) & tab & (artist of t) & tab & (player position as text) & tab & \
         ({duration} as text) & tab & ({artwork}) & tab & ({shuffle} as text) & tab & ({repeat} as text)\nend tell"
    )
}

fn parse(app: &'static str, line: &str) -> Option<Track> {
    let f: Vec<&str> = line.trim_end_matches(['\n', '\r']).split('\t').collect();
    let [state, title, artist, position, duration, artwork, shuffle, repeat] = f.as_slice() else { return None };
    let number = |s: &str| s.trim().replace(',', ".").parse::<f64>().unwrap_or(0.0);
    Some(Track {
        app,
        playing: *state == "playing",
        title: title.to_string(),
        artist: artist.to_string(),
        position: number(position),
        duration: number(duration),
        artwork_url: artwork.to_string(),
        shuffle: *shuffle == "true",
        repeat: match *repeat {
            "true" | "all" => "list",
            "one" => "track",
            _ => "none",
        },
    })
}

fn run(script: &str) -> Result<String, String> {
    let out = Command::new("osascript").arg("-e").arg(script).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn read(player: &'static str) -> Option<Track> {
    parse(player, &run(&script_for(player)).ok()?)
}

/// The players running right now; a player that isn't is never asked (that would launch it).
fn running() -> Vec<&'static str> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    PLAYERS.into_iter().filter(|p| sys.processes_by_exact_name(p.as_ref()).next().is_some()).collect()
}

/// The pinned player when it has a track, else a playing one (the shown one first), else the shown one, else the first.
fn pick(tracks: &[Track], shown: Option<&str>, pinned: Option<&str>) -> Option<usize> {
    let find = |app: Option<&str>| app.and_then(|a| tracks.iter().position(|t| t.app == a));
    find(pinned)
        .or_else(|| find(shown).filter(|&i| tracks[i].playing))
        .or_else(|| tracks.iter().position(|t| t.playing))
        .or_else(|| find(shown))
        .or(if tracks.is_empty() { None } else { Some(0) })
}

/// Spotify gives the cover as a link; the page may only show data URLs, so it is fetched once per link.
fn artwork(url: &str, cache: &mut HashMap<String, Option<String>>) -> Option<String> {
    if !url.starts_with("https://") {
        return None;
    }
    if let Some(hit) = cache.get(url) {
        return hit.clone();
    }
    let fetched = tauri::async_runtime::block_on(async {
        let bytes = reqwest::get(url).await.ok()?.error_for_status().ok()?.bytes().await.ok()?;
        Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    });
    // One cover is enough to keep: a new track replaces it.
    cache.clear();
    cache.insert(url.to_string(), fetched.clone());
    fetched
}

fn changed(last: &Option<NowPlaying>, current: &Option<NowPlaying>, last_sent_at: SystemTime) -> bool {
    match (last, current) {
        (None, None) => false,
        (Some(a), Some(b)) => {
            if (NowPlaying { position: b.position, ..a.clone() }) != *b {
                return true;
            }
            let elapsed = last_sent_at.elapsed().map(|d| d.as_secs_f64()).unwrap_or(0.0);
            let expected = if a.is_playing { a.position + elapsed } else { a.position };
            (expected - b.position).abs() > SEEK_THRESHOLD
        }
        _ => true,
    }
}

pub fn spawn(app: AppHandle) {
    thread::spawn(move || {
        let mut last: Option<NowPlaying> = None;
        let mut last_sent_at = SystemTime::now();
        let mut covers = HashMap::new();
        loop {
            let tracks: Vec<Track> = running().into_iter().filter_map(read).collect();
            let state = app.state::<MediaState>();
            let pinned = state.1.lock().unwrap().clone();
            let shown = last.as_ref().map(|np| np.app_id.clone());
            let sources: Vec<Source> = tracks.iter().map(|t| Source { app_id: t.app.into(), is_playing: t.playing }).collect();
            let current = pick(&tracks, shown.as_deref(), pinned.as_deref()).map(|i| {
                let t = &tracks[i];
                NowPlaying {
                    title: t.title.clone(),
                    artist: t.artist.clone(),
                    artwork: artwork(&t.artwork_url, &mut covers),
                    is_playing: t.playing,
                    position: t.position,
                    duration: t.duration,
                    can_seek: t.duration > 0.0,
                    app_id: t.app.into(),
                    shuffle: Some(t.shuffle),
                    repeat: Some(t.repeat),
                    sources,
                }
            });
            let resync = state.2.load(Ordering::Relaxed)
                && current.as_ref().is_some_and(|np| np.is_playing)
                && last_sent_at.elapsed().is_ok_and(|d| d > LYRICS_RESYNC);
            if resync || changed(&last, &current, last_sent_at) {
                last_sent_at = SystemTime::now();
                *state.0.lock().unwrap() = current.clone().map(|np| (np, last_sent_at));
                let _ = app.emit("media://update", &current);
                last = current;
            }
            thread::sleep(POLL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_both_players_and_a_decimal_comma() {
        let t = parse("Spotify", "playing\tSong\tArtist\t12,5\t200.0\thttps://i.scdn.co/x\tfalse\ttrue\n").unwrap();
        assert!(t.playing);
        assert_eq!((t.position, t.duration, t.repeat), (12.5, 200.0, "list"));
        let m = parse("Music", "paused\tSong\tArtist\t3.25\t180\t\ttrue\tone").unwrap();
        assert!(!m.playing && m.shuffle);
        assert_eq!(m.repeat, "track");
        assert!(parse("Music", "").is_none());
    }

    #[test]
    fn a_pinned_player_wins_then_a_playing_one() {
        let track = |app, playing| Track { app, playing, title: String::new(), artist: String::new(), position: 0.0, duration: 0.0, artwork_url: String::new(), shuffle: false, repeat: "none" };
        let tracks = [track("Spotify", false), track("Music", true)];
        assert_eq!(pick(&tracks, Some("Spotify"), None), Some(1));
        assert_eq!(pick(&tracks, None, Some("Spotify")), Some(0));
        assert_eq!(pick(&[], None, None), None);
    }
}
