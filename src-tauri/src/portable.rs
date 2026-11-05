//! Portable copy: a `NotNotch.portable` file next to the executable keeps every file the app writes
//! (the WebView2 profile with settings and notes, the vault, caches) in a `data` folder beside it.
//! Secrets stay in Windows Credential Manager on purpose. The installer never ships the marker, so
//! an installed copy or a build output is never portable.
//!
//! Updating in place: the release's latest.json has a `windows-x86_64-portable` and a `windows-aarch64-portable`
//! entry for the portable zips with their minisign signatures; a copy reads the one of the architecture it was
//! built for. The updater plugin checks that entry and verifies the
//! download; the new executable is written as `NotNotch.exe.new`, the running one is renamed to
//! `NotNotch.exe.old` (Windows allows renaming a running executable), the new one takes its name and is
//! started with `--after-update <pid>`, which waits for this process to exit before it runs (the
//! single-instance lock) and removes the old file. notnotch-notify.exe next to it is swapped the same way first. A folder the user cannot write to (checked once
//! at start) keeps its data in the installed location and gets the download page instead.
//!
//! The Store build (feature `store`) is never portable and never updates itself: the Microsoft Store does that.

use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{App, AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

pub const MARKER: &str = "NotNotch.portable";
pub const DATA: &str = "data";
/// The latest.json platform key of the portable zip for this build's architecture (release.yml). An x64 copy running
/// emulated on an ARM PC stays on the x64 zip.
const TARGET: &str = if cfg!(target_arch = "aarch64") { "windows-aarch64-portable" } else { "windows-x86_64-portable" };
const DOWNLOAD_PAGE: &str = "https://github.com/latiefahmad/notnotch/releases/latest";
const AFTER_UPDATE: &str = "--after-update";
/// The command-line tool shipped next to NotNotch.exe (src/bin/notnotch-notify.rs), updated with it.
pub const NOTIFY_EXE: &str = "notnotch-notify.exe";

static EXE: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The running executable, read once at start, before an update renames it.
fn exe() -> Option<&'static Path> {
    EXE.get_or_init(|| std::env::current_exe().ok()).as_deref()
}

/// This copy, worked out once at start: its folder, whether the marker is there, and whether that folder can be written.
struct Copy {
    dir: PathBuf,
    portable: bool,
    writable: bool,
}

static COPY: OnceLock<Option<Copy>> = OnceLock::new();

fn copy() -> Option<&'static Copy> {
    COPY.get_or_init(|| {
        let dir = exe()?.parent()?.to_path_buf();
        let portable = !cfg!(feature = "store") && dir.join(MARKER).is_file();
        let writable = portable && can_write(&dir);
        Some(Copy { dir, portable, writable })
    })
    .as_ref()
}

/// Whether this copy is portable (the marker is next to the exe), writable or not.
pub fn is_portable() -> bool {
    copy().is_some_and(|c| c.portable)
}

/// The data folder of a copy in `dir`: next to the exe for a portable copy whose folder can be written. A read-only portable copy
/// (a CD, a locked share, Program Files) uses the installed data location instead, since WebView2 could not start there.
pub fn data_dir_for(dir: &Path, portable: bool, writable: bool) -> Option<PathBuf> {
    (portable && writable).then(|| dir.join(DATA))
}

/// The portable data folder of this copy, None when installed or read-only.
pub fn data_dir() -> Option<PathBuf> {
    let c = copy()?;
    data_dir_for(&c.dir, c.portable, c.writable)
}

/// Where the app keeps its own files: the portable data folder or the usual app data folder.
pub fn app_data_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    match data_dir() {
        Some(dir) => Ok(dir),
        None => app.path().app_data_dir(),
    }
}

/// `NotNotch.exe` → `NotNotch.exe.<suffix>`.
pub fn sibling(exe: &Path, suffix: &str) -> PathBuf {
    let mut name = exe.as_os_str().to_owned();
    name.push(".");
    name.push(suffix);
    name.into()
}

/// Creates the notch window from tauri.conf.json ("create": false there), with the portable data folder for WebView2 when there is one.
pub fn create_window(app: &App) -> tauri::Result<WebviewWindow> {
    let config = app.config().app.windows.iter().find(|w| w.label == "notch").cloned().expect("window 'notch' missing");
    let mut builder = WebviewWindowBuilder::from_config(app.handle(), &config)?.on_navigation(crate::own_page);
    if let Some(dir) = data_dir() {
        builder = builder.data_directory(dir);
    }
    builder.build()
}

/// For main.rs, before the app starts: after an update, wait for the old process to exit and remove its file; at any start, remove what an update left behind.
pub fn after_update(args: &[String]) {
    if let [_, flag, pid] = args {
        if flag == AFTER_UPDATE {
            if let Ok(pid) = pid.parse::<u32>() {
                wait_for_exit(pid);
            }
        }
    }
    if let Some(exe) = exe() {
        for file in [exe.to_path_buf(), exe.with_file_name(NOTIFY_EXE)] {
            let _ = fs::remove_file(sibling(&file, "old"));
            let _ = fs::remove_file(sibling(&file, "new"));
        }
    }
}

#[cfg(windows)]
fn wait_for_exit(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE};
    unsafe {
        if let Ok(process) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            // As long as it takes: the new version must not start beside the old one.
            WaitForSingleObject(process, INFINITE);
            let _ = CloseHandle(process);
        }
    }
}

/// A Mac copy is never portable, so nothing starts it with `--after-update`.
#[cfg(not(windows))]
fn wait_for_exit(_: u32) {}

fn can_write(dir: &Path) -> bool {
    let probe = dir.join(".notnotch-write-test");
    let ok = fs::OpenOptions::new().write(true).create_new(true).open(&probe).is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

/// The executables from a portable zip: the app's (its one `.exe` other than notnotch-notify; the zip wraps the files in a folder and the
/// copy may have been renamed) and notnotch-notify's when the zip has it.
pub fn exes_from_zip(zip: &[u8]) -> Result<(Vec<u8>, Option<Vec<u8>>), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip)).map_err(|e| e.to_string())?;
    let (mut app, mut notify) = (None, None);
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let path = entry.enclosed_name().ok_or("unsafe path in the update")?;
        if !entry.is_file() || !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) {
            continue;
        }
        let is_notify = path.file_name().is_some_and(|n| n.eq_ignore_ascii_case(NOTIFY_EXE));
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if is_notify {
            notify = Some(bytes);
        } else if app.is_none() {
            app = Some(bytes);
        }
    }
    app.map(|a| (a, notify)).ok_or_else(|| "no executable in the update".into())
}
/// Puts the new executable in place of the running one; on any error the old one stays where it was.
pub fn swap(exe: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let staged = sibling(exe, "new");
    let old = sibling(exe, "old");
    fs::write(&staged, bytes)?;
    let _ = fs::remove_file(&old);
    if let Err(e) = fs::rename(exe, &old) {
        let _ = fs::remove_file(&staged);
        return Err(e);
    }
    if let Err(e) = fs::rename(&staged, exe) {
        let _ = fs::rename(&old, exe);
        let _ = fs::remove_file(&staged);
        return Err(e);
    }
    Ok(())
}

#[derive(Serialize)]
pub struct PortableInfo {
    portable: bool,
    /// The folder can be written: the data stays next to the exe and the copy updates itself.
    writable: bool,
}

#[tauri::command]
pub fn portable_info() -> PortableInfo {
    PortableInfo { portable: is_portable(), writable: copy().is_some_and(|c| c.writable) }
}

const STORE_UPDATES: &str = "the Store build is updated by the Microsoft Store";

/// The newer version of the portable package, None when up to date.
#[tauri::command]
pub async fn portable_check(app: AppHandle) -> Result<Option<String>, String> {
    if cfg!(feature = "store") {
        return Err(STORE_UPDATES.into());
    }
    let update = app.updater_builder().target(TARGET).build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| u.version))
}

/// Downloads and verifies the portable package, puts its executable in place and starts it; `portable://progress` reports 0..1 in
/// whole percents. A folder that cannot be written opens the download page instead and returns true (the app keeps running).
#[tauri::command]
pub async fn portable_install(app: AppHandle) -> Result<bool, String> {
    if cfg!(feature = "store") {
        return Err(STORE_UPDATES.into());
    }
    let exe = exe().ok_or("no executable path")?;
    if !copy().is_some_and(|c| c.writable) {
        return crate::open_url(DOWNLOAD_PAGE).map(|_| true);
    }
    let update = app.updater_builder().target(TARGET).build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else { return Err("no update".into()) };
    let (mut done, mut shown) = (0usize, 0u64);
    // download() checks the minisign signature against the key in tauri.conf.json before it returns.
    let zip = update
        .download(
            |chunk, total| {
                done += chunk;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let percent = (done as u64 * 100 / total).min(100);
                    if percent != shown {
                        shown = percent;
                        let _ = app.emit("portable://progress", percent as f64 / 100.0);
                    }
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    let (bytes, notify) = exes_from_zip(&zip)?;
    // notnotch-notify first: if it fails, the app's own exe is still untouched. A missing one (an older copy) is simply written.
    if let Some(notify) = notify {
        let path = exe.with_file_name(NOTIFY_EXE);
        if path.exists() { swap(&path, &notify) } else { fs::write(&path, &notify) }.map_err(|e| e.to_string())?;
    }
    swap(exe, &bytes).map_err(|e| e.to_string())?;
    Command::new(exe).arg(AFTER_UPDATE).arg(std::process::id().to_string()).spawn().map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Windows paths: the portable copy only exists on Windows.
    #[cfg(windows)]
    #[test]
    fn data_next_to_the_exe_only_when_portable_and_writable() {
        let dir = Path::new(r"D:\Tools\NotNotch");
        assert_eq!(data_dir_for(dir, true, true), Some(PathBuf::from(r"D:\Tools\NotNotch\data")));
        // Read-only portable copy: the installed data location.
        assert_eq!(data_dir_for(dir, true, false), None);
        assert_eq!(data_dir_for(dir, false, true), None);
    }

    #[test]
    fn write_probe_leaves_nothing_behind() {
        let dir = std::env::temp_dir().join(format!("notnotch-probe-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert!(can_write(&dir));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        assert!(!can_write(&dir.join("missing")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn portable_entry_matches_the_architecture() {
        // The keys release.yml writes: windows-x86_64-portable and windows-aarch64-portable.
        assert_eq!(TARGET, format!("windows-{}-portable", std::env::consts::ARCH));
    }

    #[test]
    fn siblings_keep_the_name() {
        let exe = Path::new(r"C:\a\NotNotch.exe");
        assert_eq!(sibling(exe, "new"), PathBuf::from(r"C:\a\NotNotch.exe.new"));
        assert_eq!(sibling(exe, "old"), PathBuf::from(r"C:\a\NotNotch.exe.old"));
    }

    #[test]
    fn swap_replaces_and_keeps_the_old_file_aside() {
        let dir = std::env::temp_dir().join(format!("notnotch-portable-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("NotNotch.exe");
        fs::write(&exe, b"old").unwrap();
        swap(&exe, b"new").unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"new");
        assert_eq!(fs::read(sibling(&exe, "old")).unwrap(), b"old");
        assert!(!sibling(&exe, "new").exists());
        // Nothing to replace: an error, and nothing left behind.
        assert!(swap(&dir.join("missing.exe"), b"x").is_err());
        assert!(!dir.join("missing.exe.new").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn exe_is_found_inside_the_folder_of_the_zip() {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("NotNotch/README-portable.txt", options).unwrap();
            std::io::Write::write_all(&mut zip, b"note").unwrap();
            zip.start_file("NotNotch/notnotch-notify.exe", options).unwrap();
            std::io::Write::write_all(&mut zip, b"notify").unwrap();
            zip.start_file("NotNotch/NotNotch.exe", options).unwrap();
            std::io::Write::write_all(&mut zip, b"binary").unwrap();
            zip.finish().unwrap();
        }
        let bytes = buf.into_inner();
        let (app, notify) = exes_from_zip(&bytes).unwrap();
        assert_eq!(app, b"binary");
        assert_eq!(notify.as_deref(), Some(&b"notify"[..]));
        assert!(exes_from_zip(b"not a zip").is_err());
    }
}
