//! Theme files: the `themes` folder in the app data folder, where export writes and import reads.
//!
//! No file dialogs: a native dialog is a window of its own, which blurs and closes the notch. The
//! frontend validates the text (src/features/themes/themes.ts); this side only lists, reads and writes.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;

/// Same limit as the frontend check, so a huge file is never read into memory.
const MAX_BYTES: u64 = 64 * 1024;
/// More files than this are not read in one import.
const MAX_FILES: usize = 100;

#[derive(Serialize)]
pub struct ThemeFileText {
    file: String,
    text: Option<String>,
    /// English, like the other backend error texts.
    error: Option<String>,
}

fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::portable::app_data_dir(app).map_err(|e| e.to_string())?.join("themes");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The folder's path, created if missing.
#[tauri::command]
pub async fn themes_folder(app: AppHandle) -> Result<String, String> {
    Ok(folder(&app)?.to_string_lossy().into_owned())
}

/// Every `*.json` in the folder, sorted by name.
#[tauri::command]
pub async fn themes_read(app: AppHandle) -> Result<Vec<ThemeFileText>, String> {
    let mut paths: Vec<PathBuf> = fs::read_dir(folder(&app)?)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("json")))
        .collect();
    paths.sort();
    let skipped = paths.len().saturating_sub(MAX_FILES);
    let mut files: Vec<ThemeFileText> = paths
        .into_iter()
        .take(MAX_FILES)
        .map(|path| {
            let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let too_big = fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false);
            if too_big {
                return ThemeFileText { file, text: None, error: Some("File larger than 64 KB".into()) };
            }
            match fs::read_to_string(&path) {
                // A BOM from Notepad would break JSON.parse.
                Ok(text) => ThemeFileText { file, text: Some(text.trim_start_matches('\u{feff}').to_string()), error: None },
                Err(_) => ThemeFileText { file, text: None, error: Some("Cannot read file".into()) },
            }
        })
        .collect();
    // Reported like a failed file, so the import's list says what was left out.
    if skipped > 0 {
        files.push(ThemeFileText {
            file: format!("{skipped} more"),
            text: None,
            error: Some(format!("Not read: only the first {MAX_FILES} files in the folder are imported")),
        });
    }
    Ok(files)
}

/// Writes `<id>.json` (overwriting an earlier export of the same theme) and returns its path.
#[tauri::command]
pub async fn themes_write(app: AppHandle, id: String, text: String) -> Result<String, String> {
    if text.len() as u64 > MAX_BYTES {
        return Err("File larger than 64 KB".into());
    }
    let name = safe_name(&id).ok_or("Invalid theme id")?;
    let path = folder(&app)?.join(format!("{name}.json"));
    fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Only lowercase ASCII letters, digits, `-`, `_` and inner dots, at most 64 characters: no path can leave the folder.
/// Windows' reserved device names (`con`, `nul`, `com1`, also as `con.x`) are refused.
fn safe_name(id: &str) -> Option<String> {
    let stem = id.split('.').next().unwrap_or("");
    let reserved = matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    let ok = !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('.')
        && !id.ends_with('.')
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
        && !id.contains("..")
        && !reserved;
    ok.then(|| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn names() {
        assert_eq!(safe_name("one-dark-pro").as_deref(), Some("one-dark-pro"));
        assert_eq!(safe_name("console").as_deref(), Some("console"));
        assert_eq!(safe_name("com0").as_deref(), Some("com0"));
        for bad in ["", "..", "../x", "a/b", "a\\b", "C:x", ".hidden", "x.", "UPPER", "a..b", "con", "nul", "aux.json", "prn", "com1", "lpt9"] {
            assert_eq!(safe_name(bad), None, "{bad}");
        }
    }
}
