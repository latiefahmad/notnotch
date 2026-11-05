//! Now Playing via GlobalSystemMediaTransportControls (GSMTC).
//!
//! Covers everything Windows shows in its volume flyout: Spotify, browsers
//! (YouTube, SoundCloud …), Apple Music, VLC and so on. A thread polls the sessions
//! and emits `media://update` when something changes.
//! Polling instead of WinRT events: more robust when sessions switch, negligible cost.
//!
//! - The manager is requested fresh on every poll. A long-lived one goes stale when
//!   an app recreates its session (Spotify closed to the tray, reopened), and then
//!   keeps reporting the old status and position.
//! - Which session is shown: see media_pick.rs (a pinned app, else a playing one,
//!   else the app shown before).
//! - Controls go to the shown app, not to whatever Windows considers current.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Media::MediaPlaybackAutoRepeatMode as RepeatMode;
use windows::Storage::Streams::DataReader;

use crate::media_pick::{choose, shown_session, Candidate};

/// One media session, for the choice of player.
#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    app_id: String,
    is_playing: bool,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    title: String,
    artist: String,
    /// Cover as a data URL, `None` if the app provides none.
    artwork: Option<String>,
    is_playing: bool,
    /// Seconds, already extrapolated to the time of the query.
    position: f64,
    /// Seconds; 0 = unknown (e.g. live streams).
    duration: f64,
    /// Does the app allow seeking? (Spotify, YouTube: yes; some players: no)
    can_seek: bool,
    app_id: String,
    /// `None` = the app offers no shuffle (or repeat) control.
    shuffle: Option<bool>,
    /// "none", "track" or "list".
    repeat: Option<&'static str>,
    /// Every session, in Windows' order.
    sources: Vec<Source>,
}

/// Last emitted state and when it was emitted; the pinned app ID; lyrics on screen (see `media_lyrics`).
#[derive(Default)]
pub struct MediaState(Mutex<Option<(NowPlaying, SystemTime)>>, Mutex<Option<String>>, AtomicBool);

impl MediaState {
    fn pinned(&self) -> Option<String> {
        self.1.lock().unwrap().clone()
    }

    /// App ID and title of the shown session (mixer, "open the app").
    pub fn shown(&self) -> Option<(String, String)> {
        self.0.lock().unwrap().as_ref().map(|(np, _)| (np.app_id.clone(), np.title.clone()))
    }
}

/// The current state, with the position extrapolated to now.
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

// Async so the blocking `join()` doesn't stall the main thread.
#[tauri::command]
pub async fn media_control(state: State<'_, MediaState>, action: String, position: Option<f64>, on: Option<bool>) -> Result<(), String> {
    let (shown_app, shown_title) = state.shown().unwrap_or_default();
    let run = || -> windows::core::Result<()> {
        let manager = SessionManager::RequestAsync()?.join()?;
        // The shown session, also when its app has several (two tabs): a lyric click seeks the tab on screen.
        let all = sessions(&manager);
        let info = describe(&all);
        let session = match shown_session(&candidates(&info, None), &shown_app, &shown_title) {
            Some(i) => all[i].clone(),
            None => manager.GetCurrentSession()?,
        };
        match action.as_str() {
            "toggle" => session.TryTogglePlayPauseAsync()?.join()?,
            "next" => session.TrySkipNextAsync()?.join()?,
            "previous" => session.TrySkipPreviousAsync()?.join()?,
            "seek" => {
                // Position relative to the timeline start, in 100 ns ticks.
                let start = session.GetTimelineProperties()?.StartTime()?.Duration;
                let ticks = start + (position.unwrap_or(0.0).max(0.0) * 10_000_000.0) as i64;
                session.TryChangePlaybackPositionAsync(ticks)?.join()?
            }
            // The target comes from the interface, so a click while the state is still on its way doesn't undo itself.
            "shuffle" => session.TryChangeShuffleActiveAsync(on.unwrap_or(false))?.join()?,
            "repeat" => {
                // Off, all, one, like Spotify and Apple Music.
                let mode = session.GetPlaybackInfo()?.AutoRepeatMode().and_then(|v| v.Value()).unwrap_or(RepeatMode::None);
                let next = match mode {
                    RepeatMode::None => RepeatMode::List,
                    RepeatMode::List => RepeatMode::Track,
                    _ => RepeatMode::None,
                };
                session.TryChangeAutoRepeatModeAsync(next)?.join()?
            }
            _ => false,
        };
        Ok(())
    };
    run().map_err(|e| e.message())
}

/// Lyrics are on screen: send the position every few seconds while playing (only then).
#[tauri::command]
pub fn media_lyrics(on: bool, state: State<'_, MediaState>) {
    state.2.store(on, Ordering::Relaxed);
}

/// Pins the app to show (`None` = automatic). The frontend sends it at start and on change.
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

/// Every session with its track, for the player menu (only read while it is open).
#[tauri::command]
pub async fn media_sources() -> Result<Vec<SourceInfo>, String> {
    let run = || -> windows::core::Result<Vec<SourceInfo>> {
        let manager = SessionManager::RequestAsync()?.join()?;
        Ok(sessions(&manager)
            .iter()
            .map(|s| {
                let text = |h: windows::core::Result<windows::core::HSTRING>| h.map(|h| h.to_string()).unwrap_or_default();
                let (title, artist) = s
                    .TryGetMediaPropertiesAsync()
                    .and_then(|op| op.join())
                    .map(|p| (text(p.Title()), text(p.Artist())))
                    .unwrap_or_default();
                SourceInfo { app_id: app_id(s), title, artist, is_playing: is_playing(s) }
            })
            .collect())
    };
    tauri::async_runtime::spawn_blocking(move || run().map_err(|e| e.message())).await.map_err(|e| e.to_string())?
}

const POLL: Duration = Duration::from_millis(400);
/// How long after a track change the cover keeps being re-read, so a late one replaces
/// whatever Windows showed first.
const ARTWORK_SETTLE: Duration = Duration::from_secs(10);
/// Drift beyond which a position counts as a seek and is sent again.
const SEEK_THRESHOLD: f64 = 1.5;
/// How often the position is sent anyway while lyrics are on screen.
const LYRICS_RESYNC: Duration = Duration::from_secs(5);

pub fn spawn(app: AppHandle) {
    thread::spawn(move || {
        let mut last: Option<NowPlaying> = None;
        let mut last_sent_at = SystemTime::now();
        let mut artwork = Artwork { key: String::new(), since: Instant::now(), data: None };
        // Requested once and reused: a new manager per poll is a cross-process
        // round trip every 400 ms. Dropped (and requested again) on an error.
        let mut manager: Option<SessionManager> = None;

        loop {
            if manager.is_none() {
                manager = SessionManager::RequestAsync().and_then(|op| op.join()).ok();
            }
            let Some(manager_ref) = manager.as_ref() else {
                thread::sleep(Duration::from_secs(2));
                continue;
            };
            let shown = last.as_ref().map(|np| (np.app_id.as_str(), np.title.as_str())).unwrap_or_default();
            let pinned = app.state::<MediaState>().pinned();
            let (session, sources) = pick(manager_ref, shown, pinned.as_deref());
            let current = session.and_then(|session| read(&session, &mut artwork).ok()).map(|np| NowPlaying { sources, ..np });
            // Nothing found: is the manager still alive (e.g. after an Explorer restart)?
            if current.is_none() && manager_ref.GetSessions().is_err() {
                manager = None;
            }

            // While lyrics show, the frontend's extrapolated position is refreshed now and then, so lines don't drift.
            let resync = app.state::<MediaState>().2.load(Ordering::Relaxed)
                && current.as_ref().is_some_and(|np| np.is_playing)
                && last_sent_at.elapsed().is_ok_and(|d| d > LYRICS_RESYNC);
            if resync || changed(&last, &current, last_sent_at) {
                last_sent_at = SystemTime::now();
                *app.state::<MediaState>().0.lock().unwrap() = current.clone().map(|np| (np, last_sent_at));
                let _ = app.emit("media://update", &current);
                last = current;
            }
            thread::sleep(POLL);
        }
    });
}

fn sessions(manager: &SessionManager) -> Vec<Session> {
    manager.GetSessions().map(|list| list.into_iter().collect()).unwrap_or_default()
}

fn app_id(session: &Session) -> String {
    session.SourceAppUserModelId().map(|id| id.to_string()).unwrap_or_default()
}

fn is_playing(session: &Session) -> bool {
    session.GetPlaybackInfo().and_then(|p| p.PlaybackStatus()).is_ok_and(|s| s == PlaybackStatus::Playing)
}

/// App ID, title and play state of each session. The title is only read for an app with several sessions (two
/// browser tabs), where the app alone can't tell them apart; reading it is a round trip per session.
fn describe(all: &[Session]) -> Vec<(String, String, bool)> {
    let ids: Vec<String> = all.iter().map(app_id).collect();
    all.iter()
        .zip(&ids)
        .map(|(s, id)| {
            let shared = ids.iter().filter(|other| *other == id).count() > 1;
            let title = if shared {
                s.TryGetMediaPropertiesAsync().and_then(|op| op.join()).and_then(|p| p.Title()).map(|h| h.to_string()).unwrap_or_default()
            } else {
                String::new()
            };
            (id.clone(), title, is_playing(s))
        })
        .collect()
}

fn candidates<'a>(info: &'a [(String, String, bool)], current: Option<&str>) -> Vec<Candidate<'a>> {
    info.iter().map(|(id, title, playing)| Candidate { app_id: id, title, playing: *playing, current: current == Some(id.as_str()) }).collect()
}

/// The session to show (`shown` = app and title shown so far, see media_pick.rs) and every app's state.
fn pick(manager: &SessionManager, shown: (&str, &str), pinned: Option<&str>) -> (Option<Session>, Vec<Source>) {
    let current = manager.GetCurrentSession().ok().map(|s| app_id(&s));
    let all = sessions(manager);
    let info = describe(&all);
    let chosen = choose(&candidates(&info, current.as_deref()), shown, pinned).map(|i| all[i].clone());
    // One row per app in the menu; two sessions of one browser are one choice.
    let mut unique: Vec<Source> = Vec::new();
    for s in info.into_iter().map(|(app_id, _, is_playing)| Source { app_id, is_playing }) {
        match unique.iter_mut().find(|u| u.app_id == s.app_id) {
            Some(u) => u.is_playing |= s.is_playing,
            None => unique.push(s),
        }
    }
    (chosen, unique)
}

/// Cover of the shown track: reloaded on a track change and for a while after it.
struct Artwork {
    key: String,
    since: Instant,
    data: Option<String>,
}

fn read(session: &Session, artwork: &mut Artwork) -> windows::core::Result<NowPlaying> {
    let props = session.TryGetMediaPropertiesAsync()?.join()?;
    let title = props.Title()?.to_string();
    let artist = props.Artist()?.to_string();
    let app_id = session.SourceAppUserModelId()?.to_string();

    let key = format!("{app_id}\u{1}{title}\u{1}{artist}");
    if artwork.key != key {
        artwork.key = key;
        artwork.since = Instant::now();
        artwork.data = props.Thumbnail().ok().and_then(|t| load_thumbnail(&t).ok());
    } else if artwork.data.is_none() || artwork.since.elapsed() < ARTWORK_SETTLE {
        // Some apps deliver the cover shortly after the title, and until then
        // Windows may still hand out the previous track's cover (Spotifast).
        artwork.data = props.Thumbnail().ok().and_then(|t| load_thumbnail(&t).ok());
    }

    let playback = session.GetPlaybackInfo()?;
    let is_playing = playback.PlaybackStatus()? == PlaybackStatus::Playing;
    let controls = playback.Controls().ok();
    let can_seek = controls.as_ref().and_then(|c| c.IsPlaybackPositionEnabled().ok()).unwrap_or(false);
    let offers = |f: fn(&windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackControls) -> windows::core::Result<bool>| {
        controls.as_ref().and_then(|c| f(c).ok()).unwrap_or(false)
    };
    // Apps that offer the control but report no state count as off.
    let shuffle = offers(|c| c.IsShuffleEnabled()).then(|| playback.IsShuffleActive().and_then(|v| v.Value()).unwrap_or(false));
    let repeat = offers(|c| c.IsRepeatEnabled()).then(|| match playback.AutoRepeatMode().and_then(|v| v.Value()) {
        Ok(RepeatMode::Track) => "track",
        Ok(RepeatMode::List) => "list",
        _ => "none",
    });
    let timeline = session.GetTimelineProperties()?;
    let duration = ticks_to_secs(timeline.EndTime()?.Duration - timeline.StartTime()?.Duration);
    let mut position = ticks_to_secs(timeline.Position()?.Duration);

    // GSMTC reports the position only sporadically, so extrapolate to now.
    if is_playing {
        let updated = timeline.LastUpdatedTime()?.UniversalTime;
        let elapsed = ticks_to_secs(now_filetime() - updated);
        if updated > 0 && (0.0..86_400.0).contains(&elapsed) {
            position += elapsed;
        }
    }
    if duration > 0.0 {
        position = position.clamp(0.0, duration);
    }

    Ok(NowPlaying { title, artist, artwork: artwork.data.clone(), is_playing, position, duration, can_seek, app_id, shuffle, repeat, sources: Vec::new() })
}

fn load_thumbnail(reference: &windows::Storage::Streams::IRandomAccessStreamReference) -> windows::core::Result<String> {
    let stream = reference.OpenReadAsync()?.join()?;
    let size = stream.Size()? as u32;
    if size == 0 {
        return Err(windows::core::Error::empty());
    }
    let reader = DataReader::CreateDataReader(&stream)?;
    reader.LoadAsync(size)?.join()?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes)?;
    Ok(format!("data:{};base64,{}", image_mime(&bytes), base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// MIME type from the image bytes. The stream's ContentType can't be trusted: for a file
/// without an extension (Spotifast's cover cache) Windows reports "image/jpeg,image/jpe,image/jpg",
/// and the commas break the data URL (issue #1).
fn image_mime(bytes: &[u8]) -> &'static str {
    match image::guess_format(bytes) {
        Ok(image::ImageFormat::Jpeg) => "image/jpeg",
        Ok(image::ImageFormat::WebP) => "image/webp",
        Ok(image::ImageFormat::Gif) => "image/gif",
        Ok(image::ImageFormat::Bmp) => "image/bmp",
        _ => "image/png",
    }
}

/// Only emit when something visible changed or the user seeked.
fn changed(last: &Option<NowPlaying>, current: &Option<NowPlaying>, last_sent_at: SystemTime) -> bool {
    match (last, current) {
        (None, None) => false,
        (Some(a), Some(b)) => {
            if a.title != b.title || a.artist != b.artist || a.is_playing != b.is_playing
                || a.artwork != b.artwork || a.duration != b.duration || a.app_id != b.app_id
                || a.can_seek != b.can_seek || a.shuffle != b.shuffle || a.repeat != b.repeat || a.sources != b.sources
            {
                return true;
            }
            let elapsed = last_sent_at.elapsed().map(|d| d.as_secs_f64()).unwrap_or(0.0);
            let expected = if a.is_playing { a.position + elapsed } else { a.position };
            (expected - b.position).abs() > SEEK_THRESHOLD
        }
        _ => true,
    }
}

/// WinRT times are 100 ns ticks.
fn ticks_to_secs(ticks: i64) -> f64 {
    ticks as f64 / 10_000_000.0
}

/// Now as FILETIME (100 ns ticks since 1601), matching `DateTime::UniversalTime`.
fn now_filetime() -> i64 {
    const EPOCH_DIFF_SECS: i64 = 11_644_473_600;
    let since_unix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    (since_unix.as_secs() as i64 + EPOCH_DIFF_SECS) * 10_000_000 + since_unix.subsec_nanos() as i64 / 100
}
