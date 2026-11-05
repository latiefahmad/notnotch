//! Files dropped on the notch (the Shelf): what kind each one is, and opening, copying,
//! previewing and revealing them. Originals are never modified.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

const IMAGE_IN: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif", "ico", "tif", "tiff", "dds", "tga"];
const AUDIO_IN: &[&str] = &["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "wma"];
const VIDEO_IN: &[&str] = &["mp4", "mov", "mkv", "avi", "webm", "wmv", "m4v"];
const DOC_IN: &[&str] = &["txt", "md", "markdown", "html", "htm", "pdf", "docx"];
const TABLE_IN: &[&str] = &["xlsx", "xlsm", "xls", "ods", "csv", "tsv"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    path: String,
    name: String,
    /// "image" | "audio" | "video" | "document" | "table" | "other"
    kind: &'static str,
    ext: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    files: Vec<FileInfo>,
}

#[tauri::command]
pub fn convert_probe(paths: Vec<String>) -> Probe {
    let files = paths
        .into_iter()
        .filter_map(|p| {
            let path = PathBuf::from(&p);
            let meta = std::fs::metadata(&path).ok().filter(|m| m.is_file())?;
            let ext = extension(&path);
            Some(FileInfo {
                name: path.file_name()?.to_string_lossy().into_owned(),
                kind: kind_of(&ext),
                ext,
                size: meta.len(),
                path: p,
            })
        })
        .collect();
    Probe { files }
}

/// Opens a file with its default app.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("Datei nicht mehr vorhanden".into());
    }
    // The associated app; not through `explorer <file>`, which splits a name with a comma.
    crate::open_url(&path)
}

/// Puts files on the clipboard (Ctrl+V in Explorer pastes them).
#[tauri::command]
pub fn copy_files(paths: Vec<String>) -> Result<(), String> {
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).filter(|p| p.exists()).collect();
    if files.is_empty() {
        return Err("Dateien nicht mehr vorhanden".into());
    }
    arboard::Clipboard::new().and_then(|mut c| c.set().file_list(&files)).map_err(|e| e.to_string())
}

/// Preview for image files (PNG data URL), otherwise None.
#[tauri::command]
pub async fn file_preview(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        crate::clipboard::is_image_file(p).then(|| crate::clipboard::file_thumbnail(p)).flatten()
    })
    .await
    .ok()
    .flatten()
}

/// Shows the file selected in Explorer.
#[tauri::command]
pub fn reveal_file(path: String) -> Result<(), String> {
    #[cfg(windows)]
    let opened = {
        use std::os::windows::process::CommandExt;
        if path.contains('"') {
            return Err("bad-path".into());
        }
        // Explorer only reads /select,"path"; std quotes the whole argument when the name has a space,
        // and Explorer then falls back to opening Documents.
        crate::opener().raw_arg(format!("/select,\"{path}\"")).spawn()
    };
    #[cfg(not(windows))]
    let opened = Command::new("open").arg("-R").arg(&path).spawn();
    opened.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(windows)]
pub(crate) fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

fn extension(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn kind_of(ext: &str) -> &'static str {
    if IMAGE_IN.contains(&ext) {
        "image"
    } else if AUDIO_IN.contains(&ext) {
        "audio"
    } else if VIDEO_IN.contains(&ext) {
        "video"
    } else if DOC_IN.contains(&ext) {
        "document"
    } else if TABLE_IN.contains(&ext) {
        "table"
    } else {
        "other"
    }
}
