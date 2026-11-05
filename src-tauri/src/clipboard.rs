//! Clipboard history.
//!
//! A thread polls `GetClipboardSequenceNumber` (cheap, no window needed; on a Mac the pasteboard's change count) and
//! reads the content on every change. Password manager content is skipped.
//! History lives in memory only and is empty after a restart (privacy).

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use arboard::{Clipboard, ImageData};
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(windows)]
use windows::core::w;
#[cfg(windows)]
use windows::Win32::Foundation::HGLOBAL;
#[cfg(windows)]
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW,
};
#[cfg(windows)]
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

use crate::now_ms;

// The Win32 name on a Mac too, so the call sites below are the same on both.
#[cfg(target_os = "macos")]
#[allow(non_snake_case)]
unsafe fn GetClipboardSequenceNumber() -> u32 {
    crate::macos::pasteboard_change_count()
}

const MAX_ITEMS: usize = 40;
/// Only the newest images are kept (stored as PNG, a screenshot is roughly 0.5–3 MB).
const MAX_IMAGES: usize = 8;
/// Texts above this (a whole log file) are not kept: 40 of them would sit in memory for days.
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
const THUMB_SIZE: u32 = 240;
const PREVIEW_CHARS: usize = 400;
const POLL: Duration = Duration::from_millis(300);
/// Larger image files are not loaded for a preview.
const MAX_THUMB_FILE_BYTES: u64 = 40 * 1024 * 1024;
const IMAGE_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico"];

enum Content {
    Text(String),
    Image(StoredImage),
    Files(Vec<PathBuf>),
}

/// A copied image, kept as PNG: raw RGBA held a 4K screenshot at 33 MB, so a few
/// screenshots in the history took hundreds of MB.
struct StoredImage {
    width: u32,
    height: u32,
    png: Vec<u8>,
    thumbnail: String,
}

impl StoredImage {
    fn new(img: ImageData<'_>) -> Option<Self> {
        let rgba = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned())?;
        let thumbnail = thumbnail(&rgba)?;
        let mut png = Vec::new();
        // Fast compression: a 4K screenshot takes well under a second on the poll thread.
        let encoder = image::codecs::png::PngEncoder::new_with_quality(
            &mut png,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Adaptive,
        );
        rgba.write_with_encoder(encoder).ok()?;
        Some(Self { width: rgba.width(), height: rgba.height(), png, thumbnail })
    }

    fn rgba(&self) -> Option<image::RgbaImage> {
        Some(image::load_from_memory_with_format(&self.png, image::ImageFormat::Png).ok()?.to_rgba8())
    }
}

struct Entry {
    id: u64,
    content: Content,
    item: ClipItem,
}

/// What the frontend sees, without the full data.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipItem {
    id: u64,
    /// "text" | "link" | "image" | "files"
    kind: &'static str,
    text: String,
    /// PNG preview as a data URL (images and copied image files).
    thumbnail: Option<String>,
    /// Files: how many entries are folders (for the icon).
    folders: usize,
    /// Unix time in ms.
    copied_at: u64,
}

#[derive(Default)]
pub struct ClipboardState {
    entries: Mutex<Vec<Entry>>,
    /// Last seen sequence number. Updated on our own copies so copying an entry back
    /// doesn't create a duplicate.
    last_seq: Mutex<u32>,
    next_id: Mutex<u64>,
    /// What gets recorded, see `Mode`. Set by the frontend from the enabled tools.
    mode: AtomicU8,
}

/// Recording modes. `ALL` is the default, so nothing is missed before the frontend reports.
/// Clipboard tool on: everything. Only Ask on (its quick actions use the latest text):
/// text only, so screenshots are never encoded. Both off: nothing is read.
const MODE_ALL: u8 = 0;
const MODE_TEXT: u8 = 1;
const MODE_OFF: u8 = 2;

#[tauri::command]
pub fn clipboard_list(state: State<'_, ClipboardState>) -> Vec<ClipItem> {
    items(&state)
}

/// `mode`: "all" | "text" | "off". Drops entries the new mode doesn't keep (frees the images).
#[tauri::command]
pub fn clipboard_mode(mode: &str, app: AppHandle, state: State<'_, ClipboardState>) {
    let mode = match mode {
        "off" => MODE_OFF,
        "text" => MODE_TEXT,
        _ => MODE_ALL,
    };
    if state.mode.swap(mode, Ordering::Relaxed) == mode {
        return;
    }
    let before = state.entries.lock().unwrap().len();
    state.entries.lock().unwrap().retain(|e| match mode {
        MODE_OFF => false,
        MODE_TEXT => matches!(e.content, Content::Text(_)),
        _ => true,
    });
    if state.entries.lock().unwrap().len() != before {
        emit(&app, &state);
    }
}

#[tauri::command]
pub fn clipboard_copy(id: u64, app: AppHandle, state: State<'_, ClipboardState>) -> Result<(), String> {
    {
        let mut entries = state.entries.lock().unwrap();
        let index = entries.iter().position(|e| e.id == id).ok_or("Entry not found")?;
        let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
        match &entries[index].content {
            Content::Text(t) => clipboard.set_text(t.clone()),
            Content::Image(img) => {
                let rgba = img.rgba().ok_or("Cannot read image")?;
                clipboard.set_image(ImageData { width: img.width as usize, height: img.height as usize, bytes: rgba.into_raw().into() })
            }
            Content::Files(files) => clipboard.set().file_list(files),
        }
        .map_err(|e| e.to_string())?;
        *state.last_seq.lock().unwrap() = unsafe { GetClipboardSequenceNumber() };

        // Move to the top with a fresh timestamp.
        let mut entry = entries.remove(index);
        entry.item.copied_at = now_ms();
        entries.insert(0, entry);
    }
    emit(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn clipboard_delete(id: u64, app: AppHandle, state: State<'_, ClipboardState>) {
    state.entries.lock().unwrap().retain(|e| e.id != id);
    emit(&app, &state);
}

#[tauri::command]
pub fn clipboard_clear(app: AppHandle, state: State<'_, ClipboardState>) {
    state.entries.lock().unwrap().clear();
    emit(&app, &state);
}

/// Large preview of an image entry (copied image or first image file).
#[derive(Serialize)]
pub struct Preview {
    src: String,
    width: u32,
    height: u32,
}

const PREVIEW_SIZE: u32 = 1400;

#[tauri::command]
pub async fn clipboard_preview(id: u64, state: State<'_, ClipboardState>) -> Result<Option<Preview>, String> {
    // Copy the image data and release the lock right away; encoding takes a while.
    enum Source {
        Png(Vec<u8>),
        File(PathBuf),
    }
    let source = {
        let entries = state.entries.lock().unwrap();
        let Some(entry) = entries.iter().find(|e| e.id == id) else { return Ok(None) };
        match &entry.content {
            Content::Image(img) => Some(Source::Png(img.png.clone())),
            Content::Files(files) => files.iter().find(|p| is_image_file(p)).cloned().map(Source::File),
            Content::Text(_) => None,
        }
    };
    let Some(source) = source else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || {
        let rgba = match source {
            Source::Png(png) => image::load_from_memory_with_format(&png, image::ImageFormat::Png).ok()?.to_rgba8(),
            Source::File(path) => image::open(path).ok()?.to_rgba8(),
        };
        let (width, height) = rgba.dimensions();
        let scale = (PREVIEW_SIZE as f32 / width.max(height) as f32).min(1.0);
        let (w, h) = (((width as f32 * scale) as u32).max(1), ((height as f32 * scale) as u32).max(1));
        let small = image::imageops::resize(&rgba, w, h, image::imageops::FilterType::Triangle);
        let mut png = Vec::new();
        small.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
        Some(Preview { src: format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)), width, height })
    })
    .await
    .map_err(|e| e.to_string())
}

/// Ctrl+V in Shelf/Converter: files from the clipboard as paths. A copied image
/// (screenshot) is saved as PNG under Pictures/NotNotch and that path is returned.
#[tauri::command]
pub async fn clipboard_paste_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    // The Pictures known folder: moved by the user or by OneDrive backup, it is not always ~/Pictures.
    let pictures = tauri::Manager::path(&app).picture_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
        if let Ok(files) = clipboard.get().file_list() {
            if !files.is_empty() {
                return Ok(files.iter().map(|p| p.display().to_string()).collect());
            }
        }
        let Ok(img) = clipboard.get_image() else { return Ok(vec![]) };
        let rgba = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned()).ok_or("Cannot read image")?;
        let dir = pictures.join("NotNotch");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("Pasted {}.png", local_stamp()));
        rgba.save(&path).map_err(|e| e.to_string())?;
        Ok(vec![path.display().to_string()])
    })
    .await
    .map_err(|e| e.to_string())?
}

/// "2026-10-04 22-41-03" in local time (for file names).
#[cfg(windows)]
fn local_stamp() -> String {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    let t = unsafe { GetLocalTime() };
    format!("{:04}-{:02}-{:02} {:02}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}

#[cfg(not(windows))]
fn local_stamp() -> String {
    jiff::Zoned::now().strftime("%Y-%m-%d %H-%M-%S").to_string()
}

pub fn spawn(app: AppHandle) {
    thread::spawn(move || {
        let formats = PrivateFormats::register();
        let state = app.state::<ClipboardState>();
        // Ignore whatever is already in the clipboard at startup.
        *state.last_seq.lock().unwrap() = unsafe { GetClipboardSequenceNumber() };

        loop {
            thread::sleep(POLL);
            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq == *state.last_seq.lock().unwrap() {
                continue;
            }

            let mode = state.mode.load(Ordering::Relaxed);
            // Another app may hold the clipboard briefly; try again next round.
            let content = if mode == MODE_OFF || formats.is_private() {
                Some(None)
            } else if mode == MODE_TEXT {
                read_text()
            } else {
                read_content()
            };
            let Some(content) = content else { continue };
            *state.last_seq.lock().unwrap() = seq;

            if let Some(content) = content {
                add(&state, content);
                emit(&app, &state);
            }
        }
    });
}

/// Formats password managers (KeePass, 1Password, Bitwarden …) use to mark content
/// as "don't record".
#[cfg(windows)]
struct PrivateFormats {
    /// Presence alone means: don't record.
    exclude: [u32; 2],
    /// Only a DWORD value of 0 means: keep out of history.
    can_include: u32,
}

#[cfg(windows)]
impl PrivateFormats {
    fn register() -> Self {
        unsafe {
            Self {
                exclude: [
                    RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing")),
                    RegisterClipboardFormatW(w!("Clipboard Viewer Ignore")),
                ],
                can_include: RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory")),
            }
        }
    }

    fn is_private(&self) -> bool {
        let available = |f: u32| f != 0 && unsafe { IsClipboardFormatAvailable(f) }.is_ok();
        if self.exclude.iter().any(|&f| available(f)) {
            return true;
        }
        available(self.can_include) && read_dword(self.can_include) == Some(0)
    }
}

/// On a Mac the marks are pasteboard types, read on each change (macos/mod.rs).
#[cfg(target_os = "macos")]
struct PrivateFormats;

#[cfg(target_os = "macos")]
impl PrivateFormats {
    fn register() -> Self {
        PrivateFormats
    }

    fn is_private(&self) -> bool {
        crate::macos::pasteboard_is_private()
    }
}

#[cfg(windows)]
fn read_dword(format: u32) -> Option<u32> {
    unsafe {
        OpenClipboard(None).ok()?;
        let value = GetClipboardData(format).ok().and_then(|handle| {
            let global = HGLOBAL(handle.0);
            let ptr = GlobalLock(global) as *const u32;
            let value = (!ptr.is_null() && GlobalSize(global) >= 4).then(|| *ptr);
            let _ = GlobalUnlock(global);
            value
        });
        let _ = CloseClipboard();
        value
    }
}

/// `None` = not readable right now (retry), `Some(None)` = nothing useful.
fn read_content() -> Option<Option<Content>> {
    let mut clipboard = Clipboard::new().ok()?;
    if let Ok(files) = clipboard.get().file_list() {
        if !files.is_empty() {
            return Some(Some(Content::Files(files)));
        }
    }
    let text = clipboard.get_text().ok().filter(|t| !t.trim().is_empty());
    if text.as_ref().is_some_and(|t| t.len() > MAX_TEXT_BYTES) {
        return Some(None);
    }
    // Browsers often add the image URL as text on "Copy image", so the image wins.
    // Office adds an image of the cells to text, so text wins there, and that image is not even decoded.
    let image = match &text {
        Some(t) if !is_url(t.trim()) => None,
        _ => clipboard.get_image().ok(),
    };

    Some(match (text, image) {
        (Some(_), Some(img)) => StoredImage::new(img).map(Content::Image),
        (Some(t), None) => Some(Content::Text(t)),
        (None, Some(img)) => StoredImage::new(img).map(Content::Image),
        (None, None) => None,
    })
}

/// Text only (no files, no image is read or encoded).
fn read_text() -> Option<Option<Content>> {
    let mut clipboard = Clipboard::new().ok()?;
    Some(clipboard.get_text().ok().filter(|t| !t.trim().is_empty() && t.len() <= MAX_TEXT_BYTES).map(Content::Text))
}

fn is_url(text: &str) -> bool {
    !text.contains(char::is_whitespace)
        && (text.starts_with("http://") || text.starts_with("https://") || text.starts_with("www."))
}

fn add(state: &ClipboardState, content: Content) {
    let mut entries = state.entries.lock().unwrap();

    // Same text copied again: move the existing entry to the top.
    if let Content::Text(new) = &content {
        if let Some(i) = entries.iter().position(|e| matches!(&e.content, Content::Text(t) if t == new)) {
            let mut entry = entries.remove(i);
            entry.item.copied_at = now_ms();
            entries.insert(0, entry);
            return;
        }
    }

    let id = {
        let mut next = state.next_id.lock().unwrap();
        *next += 1;
        *next
    };
    let Some(item) = describe(id, &content) else { return };
    entries.insert(0, Entry { id, content, item });

    let mut images = 0;
    entries.retain(|e| {
        if matches!(e.content, Content::Image(_)) {
            images += 1;
            images <= MAX_IMAGES
        } else {
            true
        }
    });
    entries.truncate(MAX_ITEMS);
}

fn describe(id: u64, content: &Content) -> Option<ClipItem> {
    let copied_at = now_ms();
    Some(match content {
        Content::Text(t) => {
            let trimmed = t.trim();
            ClipItem {
                id,
                kind: if is_url(trimmed) { "link" } else { "text" },
                text: trimmed.chars().take(PREVIEW_CHARS).collect(),
                thumbnail: None,
                folders: 0,
                copied_at,
            }
        }
        Content::Image(img) => {
            ClipItem {
                id,
                kind: "image",
                text: format!("{} × {}", img.width, img.height),
                thumbnail: Some(img.thumbnail.clone()),
                folders: 0,
                copied_at,
            }
        }
        Content::Files(files) => {
            let names: Vec<String> = files
                .iter()
                .map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string()))
                .collect();
            // First image file as preview, so copied photos look like photos.
            let thumbnail = files.iter().find(|p| is_image_file(p)).and_then(|p| file_thumbnail(p));
            let folders = files.iter().filter(|p| p.is_dir()).count();
            ClipItem { id, kind: "files", text: names.join("\n"), thumbnail, folders, copied_at }
        }
    })
}

pub fn is_image_file(path: &Path) -> bool {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.as_str()))
}

pub fn file_thumbnail(path: &Path) -> Option<String> {
    if std::fs::metadata(path).ok()?.len() > MAX_THUMB_FILE_BYTES {
        return None;
    }
    thumbnail(&image::open(path).ok()?.to_rgba8())
}

pub(crate) fn thumbnail(rgba: &image::RgbaImage) -> Option<String> {
    let scale = (THUMB_SIZE as f32 / rgba.width().max(rgba.height()) as f32).min(1.0);
    let (w, h) = (((rgba.width() as f32 * scale) as u32).max(1), ((rgba.height() as f32 * scale) as u32).max(1));
    let small = image::imageops::thumbnail(rgba, w, h);
    let mut png = Vec::new();
    small.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
}

fn items(state: &ClipboardState) -> Vec<ClipItem> {
    state.entries.lock().unwrap().iter().map(|e| e.item.clone()).collect()
}

fn emit(app: &AppHandle, state: &ClipboardState) {
    let _ = app.emit("clipboard://update", items(state));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A UI-like tile: flat panels with rows of pseudo-random "glyphs" (fixed seed), like a window of text.
    fn ui_tile() -> image::RgbaImage {
        let mut seed = 0x2545_f491u32;
        let mut next = move || { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; seed };
        let glyphs: Vec<u32> = (0..64 * 40).map(|_| next()).collect();
        image::RgbaImage::from_fn(512, 320, |x, y| {
            let panel = if x < 140 { [32, 33, 38, 255] } else { [24, 24, 28, 255] };
            let (col, row) = (x / 8, y / 8);
            let ink = y % 8 < 6 && x % 8 < 6 && glyphs[(row * 64 + col) as usize % glyphs.len()] % 3 != 0;
            image::Rgba(if ink && y > 24 { [220, 222, 228, 255] } else { panel })
        })
    }

    /// A 4K "screenshot" tiled from a UI-like tile: round trip is lossless and far smaller than RGBA.
    #[test]
    fn stored_image_is_lossless_and_compact() {
        let tile = ui_tile();
        let (w, h) = (3840, 2160);
        let shot = image::RgbaImage::from_fn(w, h, |x, y| *tile.get_pixel(x % tile.width(), y % tile.height()));
        let raw = shot.as_raw().len();

        let started = std::time::Instant::now();
        let stored = StoredImage::new(ImageData { width: w as usize, height: h as usize, bytes: shot.as_raw().clone().into() }).unwrap();
        let encode = started.elapsed();
        let started = std::time::Instant::now();
        let back = stored.rgba().unwrap();
        let decode = started.elapsed();

        println!("raw {} MB → png {:.2} MB, encode {encode:?}, decode {decode:?}", raw / 1_048_576, stored.png.len() as f64 / 1_048_576.0);
        assert_eq!((stored.width, stored.height), (w, h));
        assert!(back == shot, "pixels changed");
        assert!(stored.png.len() * 5 < raw, "not compressed enough");
        assert!(stored.thumbnail.starts_with("data:image/png;base64,"));
    }
}
