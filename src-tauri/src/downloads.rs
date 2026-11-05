//! Downloads in progress in the user's Downloads folder, for the closed row's Downloads part and the notice when one is done.
//! Browsers write to a partial file and rename it at the end. NotNotch watches the folder's file names (not its subfolders) with
//! ReadDirectoryChangesW and reads the partial files' sizes once a second while one exists; with none the thread only waits.
//! There is no reliable total size, so there is no percentage either.

use std::collections::VecDeque;

use serde::Serialize;

/// Chromium and Edge, Firefox, Safari-style and other tools.
const SUFFIXES: [&str; 4] = [".crdownload", ".part", ".download", ".partial"];
/// Speed is averaged over this long.
const WINDOW_MS: u64 = 3000;
/// A partial file removed without a rename gets this long for its final file to show up.
const GRACE_MS: u64 = 2000;

/// The final name of a browser's partial file, or None for any other file. Chrome's "Unconfirmed 12345.crdownload",
/// written before the real name is known, gives "".
pub fn final_name(file: &str) -> Option<String> {
    let lower = file.to_ascii_lowercase();
    let suffix = SUFFIXES.iter().find(|s| lower.len() > s.len() && lower.ends_with(*s))?;
    let name = &file[..file.len() - suffix.len()];
    let unconfirmed = name.strip_prefix("Unconfirmed ").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    Some(if unconfirmed { String::new() } else { name.to_string() })
}

/// Size samples of one download, oldest first, reaching back WINDOW_MS.
#[derive(Default)]
struct Samples(VecDeque<(u64, u64)>);

impl Samples {
    fn push(&mut self, at: u64, size: u64) {
        self.0.push_back((at, size));
        // Keeps the newest sample at or before the window's start, so the average spans the whole window.
        while self.0.len() > 1 && self.0[1].0 + WINDOW_MS <= at {
            self.0.pop_front();
        }
    }

    /// Bytes per second from the oldest to the newest sample; 0 until two samples lie apart.
    fn speed(&self) -> f64 {
        match (self.0.front(), self.0.back()) {
            (Some(&(t0, s0)), Some(&(t1, s1))) if t1 > t0 => s1.saturating_sub(s0) as f64 * 1000.0 / (t1 - t0) as f64,
            _ => 0.0,
        }
    }

    fn size(&self) -> u64 {
        self.0.back().map_or(0, |s| s.1)
    }
}

struct Download {
    /// The partial file's name in the folder.
    file: String,
    name: String,
    samples: Samples,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Progress {
    /// "" while Chrome has not named it yet.
    pub name: String,
    pub size: u64,
    /// Bytes per second.
    pub speed: f64,
}

/// How a download ended, with its final file name.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    Finished(String),
    Cancelled(String),
}

/// The downloads in the folder, from its file name changes. Pure: the watcher feeds it events, sizes and the time.
#[derive(Default)]
pub struct Tracker {
    active: Vec<Download>,
    /// Removed partial files waiting for their final file: name and deadline.
    pending: Vec<(String, u64)>,
}

impl Tracker {
    pub fn busy(&self) -> bool {
        !self.active.is_empty() || !self.pending.is_empty()
    }

    /// A file appeared (created, or renamed to from a file outside the folder). A partial one is a new download;
    /// any other may be the final file of a removed partial one.
    pub fn added(&mut self, file: &str) -> Option<Outcome> {
        match final_name(file) {
            Some(name) => {
                if !self.active.iter().any(|d| d.file == file) {
                    self.active.push(Download { file: file.into(), name, samples: Samples::default() });
                }
                None
            }
            None => {
                let i = self.pending.iter().position(|(name, _)| !name.is_empty() && name.eq_ignore_ascii_case(file))?;
                self.pending.remove(i);
                Some(Outcome::Finished(file.into()))
            }
        }
    }

    pub fn removed(&mut self, file: &str, now: u64) {
        if let Some(i) = self.active.iter().position(|d| d.file == file) {
            let d = self.active.remove(i);
            self.pending.push((d.name, now + GRACE_MS));
        }
    }

    pub fn renamed(&mut self, old: &str, new: &str) -> Option<Outcome> {
        let Some(i) = self.active.iter().position(|d| d.file == old) else { return self.added(new) };
        match final_name(new) {
            // Chrome naming an Unconfirmed download: the same download goes on.
            Some(name) => {
                let d = &mut self.active[i];
                d.file = new.into();
                d.name = name;
                None
            }
            None => {
                self.active.remove(i);
                Some(Outcome::Finished(new.into()))
            }
        }
    }

    /// Reads each download's size. A partial file that is gone counts as removed, in case its change was missed.
    pub fn sample(&mut self, now: u64, size_of: impl Fn(&str) -> Option<u64>) {
        let mut gone = Vec::new();
        for d in &mut self.active {
            match size_of(&d.file) {
                Some(size) => d.samples.push(now, size),
                None => gone.push(d.file.clone()),
            }
        }
        for file in gone {
            self.removed(&file, now);
        }
    }

    /// Removed downloads whose grace ran out: finished if their final file is there, else cancelled.
    pub fn expire(&mut self, now: u64, exists: impl Fn(&str) -> bool) -> Vec<Outcome> {
        let (due, wait): (Vec<_>, Vec<_>) = self.pending.drain(..).partition(|p| p.1 <= now);
        self.pending = wait;
        due.into_iter().map(|(name, _)| if !name.is_empty() && exists(&name) { Outcome::Finished(name) } else { Outcome::Cancelled(name) }).collect()
    }

    pub fn snapshot(&self) -> Vec<Progress> {
        self.active.iter().map(|d| Progress { name: d.name.clone(), size: d.samples.size(), speed: d.samples.speed() }).collect()
    }
}

/// From the settings: watch while the Downloads part or the notice is on.
#[tauri::command]
pub fn downloads_configure(app: tauri::AppHandle, on: bool) {
    #[cfg(windows)]
    watch::configure(app, on);
    #[cfg(not(windows))]
    let _ = (app, on);
}

#[cfg(windows)]
mod watch {
    use super::{Outcome, Tracker};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use tauri::{AppHandle, Emitter};
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::Storage::FileSystem::*;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::Threading::{CreateEventW, ResetEvent, SetEvent, WaitForMultipleObjects, INFINITE};
    use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
    use windows::Win32::UI::Shell::{FOLDERID_Downloads, SHGetKnownFolderPath, KF_FLAG_DEFAULT};

    /// Sizes are read this often while a download runs.
    const TICK_MS: u64 = 1000;

    /// A handle closed when the last owner lets go.
    struct Owned(HANDLE);
    // A kernel handle may be used and closed from any thread.
    unsafe impl Send for Owned {}
    unsafe impl Sync for Owned {}
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    /// The running watcher's stop event.
    static STOP: Mutex<Option<Arc<Owned>>> = Mutex::new(None);

    pub fn configure(app: AppHandle, on: bool) {
        let mut stop = STOP.lock().unwrap_or_else(|e| e.into_inner());
        if on && stop.is_none() {
            let Ok(h) = (unsafe { CreateEventW(None, true, false, None) }) else { return };
            let event = Arc::new(Owned(h));
            *stop = Some(event.clone());
            thread::spawn(move || run(app, event));
        } else if !on {
            if let Some(event) = stop.take() {
                unsafe {
                    let _ = SetEvent(event.0);
                }
            }
        }
    }

    /// The Downloads folder, wherever the user moved it.
    fn downloads_dir() -> Option<PathBuf> {
        unsafe {
            let p = SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_DEFAULT, None).ok()?;
            let dir = p.to_string().ok().map(PathBuf::from);
            CoTaskMemFree(Some(p.0 as _));
            dir
        }
    }

    fn finished(app: &AppHandle, dir: &Path, outcomes: Vec<Outcome>) {
        for o in outcomes {
            // A cancelled download has nothing to show; it already left the progress list.
            if let Outcome::Finished(name) = o {
                let _ = app.emit("downloads://finished", serde_json::json!({ "name": name, "path": dir.join(&name) }));
            }
        }
    }

    fn run(app: AppHandle, stop: Arc<Owned>) {
        watch(&app, &stop);
        // Started again later only if a new configure finds no watcher.
        let mut current = STOP.lock().unwrap_or_else(|e| e.into_inner());
        if current.as_ref().is_some_and(|s| Arc::ptr_eq(s, &stop)) {
            *current = None;
        }
    }

    fn watch(app: &AppHandle, stop: &Owned) {
        let Some(dir) = downloads_dir() else { return };
        let share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
        let flags = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED;
        let Ok(h) = (unsafe { CreateFileW(&HSTRING::from(dir.as_os_str()), FILE_LIST_DIRECTORY.0, share, None, OPEN_EXISTING, flags, None) }) else { return };
        let folder = Owned(h);
        let Ok(h) = (unsafe { CreateEventW(None, true, false, None) }) else { return };
        let ready = Owned(h);

        let mut tracker = Tracker::default();
        // Downloads that were already running.
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            if let Some(name) = entry.file_name().to_str() {
                tracker.added(name);
            }
        }
        // u32 for the alignment FILE_NOTIFY_INFORMATION needs; 64 KB, the most a network folder takes.
        let mut buf = vec![0u32; 16 * 1024];
        let mut ov: OVERLAPPED;
        let (mut next_tick, mut shown) = (0u64, false);
        'read: loop {
            ov = OVERLAPPED { hEvent: ready.0, ..Default::default() };
            let armed = unsafe {
                let _ = ResetEvent(ready.0);
                ReadDirectoryChangesW(folder.0, buf.as_mut_ptr() as _, (buf.len() * 4) as u32, false, FILE_NOTIFY_CHANGE_FILE_NAME, None, Some(&mut ov), None)
            };
            if armed.is_err() {
                break;
            }
            loop {
                let now = crate::now_ms();
                if tracker.busy() && now >= next_tick {
                    tracker.sample(now, |f| std::fs::metadata(dir.join(f)).ok().map(|m| m.len()));
                    finished(app, &dir, tracker.expire(now, |f| dir.join(f).is_file()));
                    next_tick = now + TICK_MS;
                }
                let list = tracker.snapshot();
                if shown || !list.is_empty() {
                    shown = !list.is_empty();
                    let _ = app.emit("downloads://progress", list);
                }
                // Without a download there is nothing to sample: wait for a change or the stop.
                let timeout = if tracker.busy() { next_tick.saturating_sub(crate::now_ms()).max(1) as u32 } else { INFINITE };
                let woke = unsafe { WaitForMultipleObjects(&[ready.0, stop.0], false, timeout) };
                if woke == WAIT_TIMEOUT {
                    continue;
                }
                if woke != WAIT_OBJECT_0 {
                    break 'read;
                }
                let mut bytes = 0u32;
                if unsafe { GetOverlappedResult(folder.0, &ov, &mut bytes, false) }.is_err() {
                    break 'read;
                }
                // 0 bytes: the buffer overflowed and these changes are lost; sampling still notices a partial file that went away.
                let now = crate::now_ms();
                let mut outcomes = Vec::new();
                let mut old: Option<String> = None;
                let mut at = 0usize;
                while (at as u32) < bytes {
                    let (action, name, step) = unsafe {
                        let info = (buf.as_ptr() as *const u8).add(at) as *const FILE_NOTIFY_INFORMATION;
                        let len = (*info).FileNameLength as usize / 2;
                        let name = String::from_utf16_lossy(std::slice::from_raw_parts(std::ptr::addr_of!((*info).FileName) as *const u16, len));
                        ((*info).Action, name, (*info).NextEntryOffset as usize)
                    };
                    if action == FILE_ACTION_ADDED {
                        outcomes.extend(tracker.added(&name));
                    } else if action == FILE_ACTION_REMOVED {
                        tracker.removed(&name, now);
                    } else if action == FILE_ACTION_RENAMED_OLD_NAME {
                        old = Some(name);
                    } else if action == FILE_ACTION_RENAMED_NEW_NAME {
                        outcomes.extend(match old.take() {
                            Some(old) => tracker.renamed(&old, &name),
                            None => tracker.added(&name),
                        });
                    }
                    if step == 0 {
                        break;
                    }
                    at += step;
                }
                finished(app, &dir, outcomes);
                continue 'read;
            }
        }
        // The read may still be running: cancel it and wait, since it writes into `buf` and `ov`.
        unsafe {
            if CancelIoEx(folder.0, Some(&ov)).is_ok() {
                let mut bytes = 0u32;
                let _ = GetOverlappedResult(folder.0, &ov, &mut bytes, true);
            }
        }
        if shown {
            let _ = app.emit("downloads://progress", Vec::<super::Progress>::new());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_names() {
        assert_eq!(final_name("report.pdf.crdownload").as_deref(), Some("report.pdf"));
        assert_eq!(final_name("setup.exe.part").as_deref(), Some("setup.exe"));
        assert_eq!(final_name("song.mp3.download").as_deref(), Some("song.mp3"));
        assert_eq!(final_name("disk.iso.partial").as_deref(), Some("disk.iso"));
        assert_eq!(final_name("Photo.JPG.CRDOWNLOAD").as_deref(), Some("Photo.JPG"));
        assert_eq!(final_name("Unconfirmed 123456.crdownload").as_deref(), Some(""));
        // Only digits after "Unconfirmed " are Chrome's placeholder.
        assert_eq!(final_name("Unconfirmed plans.pdf.crdownload").as_deref(), Some("Unconfirmed plans.pdf"));
        assert_eq!(final_name("Unconfirmed .crdownload").as_deref(), Some("Unconfirmed "));
        assert_eq!(final_name("report.pdf"), None);
        assert_eq!(final_name("notes.parts"), None);
        assert_eq!(final_name(".part"), None);
    }

    #[test]
    fn speed_is_averaged_over_the_window() {
        let mut s = Samples::default();
        assert_eq!(s.speed(), 0.0);
        s.push(0, 0);
        assert_eq!(s.speed(), 0.0);
        s.push(1000, 4_000_000);
        assert_eq!(s.speed(), 4_000_000.0);
        s.push(2000, 4_000_000);
        assert_eq!(s.speed(), 2_000_000.0);
        s.push(3000, 9_000_000);
        assert_eq!(s.speed(), 3_000_000.0);
        // The sample at 0 leaves the window; 1000 to 4000 is 3 s.
        s.push(4000, 13_000_000);
        assert_eq!(s.0.front().unwrap().0, 1000);
        assert_eq!(s.speed(), 3_000_000.0);
        assert_eq!(s.size(), 13_000_000);
        // A file that starts over never gives a negative speed.
        s.push(5000, 0);
        assert_eq!(s.speed(), 0.0);
    }

    #[test]
    fn rename_to_the_final_name_finishes() {
        let mut t = Tracker::default();
        assert_eq!(t.added("Unconfirmed 4711.crdownload"), None);
        assert_eq!(t.renamed("Unconfirmed 4711.crdownload", "a.zip.crdownload"), None);
        t.sample(0, |_| Some(10));
        assert_eq!(t.snapshot(), vec![Progress { name: "a.zip".into(), size: 10, speed: 0.0 }]);
        assert_eq!(t.renamed("a.zip.crdownload", "a.zip"), Some(Outcome::Finished("a.zip".into())));
        assert!(!t.busy());
        // Other files in the folder change nothing.
        assert_eq!(t.added("b.txt"), None);
        assert_eq!(t.renamed("b.txt", "c.txt"), None);
        assert!(!t.busy());
    }

    #[test]
    fn removed_then_final_file_finishes() {
        let mut t = Tracker::default();
        t.added("a.zip.part");
        t.removed("a.zip.part", 100);
        assert!(t.snapshot().is_empty());
        assert_eq!(t.added("a.zip"), Some(Outcome::Finished("a.zip".into())));
        assert!(!t.busy());
        // A removal that was missed: sampling finds the file gone.
        t.added("b.zip.part");
        t.sample(0, |_| None);
        assert!(t.snapshot().is_empty());
        assert_eq!(t.expire(GRACE_MS, |_| false), vec![Outcome::Cancelled("b.zip".into())]);
    }

    #[test]
    fn removed_without_final_file_is_cancelled_after_the_grace() {
        let mut t = Tracker::default();
        t.added("a.zip.part");
        t.added("b.zip.part");
        t.removed("a.zip.part", 0);
        t.removed("b.zip.part", 0);
        assert!(t.expire(GRACE_MS - 1, |_| true).is_empty());
        let mut out = t.expire(GRACE_MS, |f| f == "b.zip");
        out.sort_by_key(|o| format!("{o:?}"));
        assert_eq!(out, vec![Outcome::Cancelled("a.zip".into()), Outcome::Finished("b.zip".into())]);
        assert!(!t.busy());
        // An Unconfirmed download has no final name to find.
        t.added("Unconfirmed 1.crdownload");
        t.removed("Unconfirmed 1.crdownload", 0);
        assert_eq!(t.expire(GRACE_MS, |_| true), vec![Outcome::Cancelled(String::new())]);
    }
}
