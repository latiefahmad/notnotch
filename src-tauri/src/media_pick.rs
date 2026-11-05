//! Which media session the notch shows. Pure, so the rules are tested without Windows:
//! `rustc --edition 2021 --test src-tauri/src/media_pick.rs`.
//!
//! - A pinned app with a session always wins, playing or not. With several sessions
//!   (two browser tabs) a playing one first, then the one shown before.
//! - Otherwise a playing one wins: Windows' current first, then the app shown before,
//!   then any. If nothing plays, the app shown before stays, so pausing with a media
//!   key doesn't make it jump to another app; then Windows' current.
//! - A pinned app without a session (closed) falls back to the rules above; the pin
//!   stays, so the app is shown again once it plays.
//! - The session shown before is the one with its app and title, else the first of its
//!   app. Controls and seeking go to the same one (`shown_session`).

pub struct Candidate<'a> {
    pub app_id: &'a str,
    /// Only read when an app has several sessions; empty otherwise.
    pub title: &'a str,
    pub playing: bool,
    /// Windows' current session.
    pub current: bool,
}

/// The session shown before: app and title, else the first of the app.
pub fn shown_session(all: &[Candidate], app_id: &str, title: &str) -> Option<usize> {
    if app_id.is_empty() {
        return None;
    }
    all.iter()
        .position(|c| c.app_id == app_id && c.title == title)
        .or_else(|| all.iter().position(|c| c.app_id == app_id))
}

/// Index of the session to show; `shown` = app ID and title shown so far.
pub fn choose(all: &[Candidate], shown: (&str, &str), pinned: Option<&str>) -> Option<usize> {
    let before = shown_session(all, shown.0, shown.1);
    if let Some(pin) = pinned.filter(|p| !p.is_empty()) {
        let of_pin = |c: &Candidate| c.app_id == pin;
        let found = all
            .iter()
            .position(|c| of_pin(c) && c.playing)
            .or_else(|| before.filter(|&i| of_pin(&all[i])))
            .or_else(|| all.iter().position(of_pin));
        if found.is_some() {
            return found;
        }
    }
    let current = all.iter().position(|c| c.current);
    if let Some(i) = current.filter(|&i| all[i].playing) {
        return Some(i);
    }
    before
        .filter(|&i| all[i].playing)
        .or_else(|| all.iter().position(|c| c.playing))
        .or(before)
        .or(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(app_id: &str, playing: bool, current: bool) -> Candidate<'_> {
        Candidate { app_id, title: "", playing, current }
    }

    fn t<'a>(app_id: &'a str, title: &'a str, playing: bool) -> Candidate<'a> {
        Candidate { app_id, title, playing, current: false }
    }

    #[test]
    fn pinned_wins_even_paused() {
        let all = [c("Spotify.exe", true, true), c("Chrome", false, false)];
        assert_eq!(choose(&all, ("Spotify.exe", ""), Some("Chrome")), Some(1));
    }

    #[test]
    fn missing_pin_falls_back() {
        let all = [c("Spotify.exe", false, false), c("Chrome", true, true)];
        assert_eq!(choose(&all, ("Spotify.exe", ""), Some("VLC")), Some(1));
        assert_eq!(choose(&all, ("Spotify.exe", ""), Some("")), Some(1));
    }

    #[test]
    fn pinned_app_with_several_sessions() {
        // A playing tab first, wherever it is.
        let all = [t("Chrome", "A", false), t("Spotify.exe", "S", true), t("Chrome", "B", true)];
        assert_eq!(choose(&all, ("Chrome", "A"), Some("Chrome")), Some(2));
        // None playing: the tab shown before, not the first one.
        let all = [t("Chrome", "A", false), t("Chrome", "B", false)];
        assert_eq!(choose(&all, ("Chrome", "B"), Some("Chrome")), Some(1));
        // Shown before was another app: the first tab.
        assert_eq!(choose(&all, ("Spotify.exe", "S"), Some("Chrome")), Some(0));
    }

    #[test]
    fn controls_follow_the_shown_session() {
        let all = [t("Chrome", "A", true), t("Chrome", "B", false), t("Spotify.exe", "", false)];
        assert_eq!(shown_session(&all, "Chrome", "B"), Some(1));
        // The title changed since (next video): the app still matches.
        assert_eq!(shown_session(&all, "Chrome", "C"), Some(0));
        assert_eq!(shown_session(&all, "VLC", "B"), None);
        assert_eq!(shown_session(&all, "", ""), None);
    }

    #[test]
    fn automatic_rules() {
        // Windows' current playing wins over the one shown before.
        assert_eq!(choose(&[c("A", true, false), c("B", true, true)], ("A", ""), None), Some(1));
        // Current paused: the shown one if it plays.
        assert_eq!(choose(&[c("A", true, false), c("B", false, true), c("C", true, false)], ("C", ""), None), Some(2));
        // Shown paused: any playing one.
        assert_eq!(choose(&[c("A", false, false), c("B", true, false)], ("A", ""), None), Some(1));
        // Nothing plays: the shown one stays.
        assert_eq!(choose(&[c("A", false, true), c("B", false, false)], ("B", ""), None), Some(1));
        // Nothing plays, nothing shown: Windows' current, else nothing.
        assert_eq!(choose(&[c("A", false, false), c("B", false, true)], ("", ""), None), Some(1));
        assert_eq!(choose(&[c("A", false, false)], ("", ""), None), None);
        assert_eq!(choose(&[], ("A", ""), Some("A")), None);
    }
}
