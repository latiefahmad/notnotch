//! Find on screen: every monitor copied in memory and read with Windows' own OCR
//! (Windows.Media.Ocr, in the user's profile languages, else English). Nothing is written
//! to disk; each copy is dropped once read, and the text only goes to the Find page.
//! NotNotch's windows are kept out of the copies, as for screenshots.

use std::sync::Once;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use windows::core::{h, w, Result};
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Security::Cryptography::CryptographicBuffer;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{CombineRgn, CreateRoundRectRgn, CreateSolidBrush, DeleteObject, SetWindowRgn, RGN_DIFF};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::*;

use super::math::{intersect, line_rect, Rect};
use super::{exclude, monitors, shot, CaptureState};

/// OCR of a few screens takes about a second; past this the page says so instead of waiting.
const TIMEOUT: Duration = Duration::from_secs(15);
const HIGHLIGHT_FOR: Duration = Duration::from_secs(2);

#[derive(Serialize)]
pub struct FoundLine {
    text: String,
    /// Index in the Capture tool's order: primary first, then left to right.
    monitor: usize,
    /// Physical pixels of the virtual screen, with a margin for the highlight.
    rect: Rect,
}

#[tauri::command]
pub async fn find_scan(app: AppHandle) -> std::result::Result<Vec<FoundLine>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    // Its own thread: on a timeout it finishes on its own and drops what it read.
    std::thread::spawn(move || {
        let _ = tx.send(scan(&app));
    });
    match tokio::time::timeout(TIMEOUT, rx).await {
        Ok(Ok(lines)) => lines,
        Ok(Err(_)) => Err("failed".into()),
        Err(_) => Err("timeout".into()),
    }
}

fn scan(app: &AppHandle) -> std::result::Result<Vec<FoundLine>, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let engine = engine().map_err(|_| "no-ocr")?;
    let list = monitors();
    let recording = app.state::<CaptureState>().excluded();
    if !recording {
        exclude(app, true);
        // Let the compositor drop the windows from the next frame.
        std::thread::sleep(Duration::from_millis(60));
    }
    let shots: Vec<_> = list.iter().map(|m| shot::grab(m.rect)).collect();
    if !recording {
        exclude(app, false);
    }
    let mut out = Vec::new();
    for (i, (m, dib)) in list.iter().zip(shots).enumerate() {
        let Ok(dib) = dib else { continue };
        let mut dpi = (96u32, 96u32);
        let _ = unsafe { GetDpiForMonitor(m.handle, MDT_EFFECTIVE_DPI, &mut dpi.0, &mut dpi.1) };
        // shortcut: a monitor past OcrEngine::MaxImageDimension (10000 px) is skipped, downscale it if such screens show up.
        let Ok(lines) = read(&engine, dib, m.rect, dpi.0 as f32 / 96.0) else { continue };
        out.extend(lines.into_iter().map(|(text, rect)| FoundLine { text, monitor: i, rect }));
    }
    Ok(out)
}

/// OCR in the user's profile languages, else English.
fn engine() -> Result<OcrEngine> {
    OcrEngine::TryCreateFromUserProfileLanguages().or_else(|_| OcrEngine::TryCreateFromLanguage(&Language::CreateLanguage(h!("en-US"))?))
}

/// The lines in a copy of `monitor` taken at `scale`, as text and screen rectangle. Takes the copy to drop it once handed to OCR.
fn read(engine: &OcrEngine, dib: shot::Dib, monitor: Rect, scale: f32) -> Result<Vec<(String, Rect)>> {
    // GDI leaves the alpha byte at 0: ignored, or the copy would count as transparent.
    let bitmap = CryptographicBuffer::CreateFromByteArray(dib.pixels()).and_then(|b| SoftwareBitmap::CreateCopyWithAlphaFromBuffer(&b, BitmapPixelFormat::Bgra8, dib.w, dib.h, BitmapAlphaMode::Ignore));
    drop(dib);
    let result = engine.RecognizeAsync(&bitmap?)?.join()?;
    let mut out = Vec::new();
    for line in result.Lines()? {
        let words: Vec<_> = line.Words().into_iter().flatten().filter_map(|w| w.BoundingRect().ok()).map(|r| (r.X, r.Y, r.Width, r.Height)).collect();
        if let (Ok(text), Some(rect)) = (line.Text(), line_rect(&words, monitor, scale)) {
            out.push((text.to_string(), rect));
        }
    }
    Ok(out)
}

/// A frame around `rect` (from `find_scan`) for two seconds: always on top, click-through, never in captures.
#[tauri::command]
pub fn find_highlight(rect: Rect) {
    std::thread::spawn(move || {
        let _ = highlight(rect);
    });
}

const CLASS: windows::core::PCWSTR = w!("NotNotchFindHighlight");

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn highlight(rect: Rect) -> Result<()> {
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    // The page sends the rectangle back: keep it on the screens.
    let Some(r) = intersect(rect, shot::virtual_screen()) else { return Ok(()) };
    static REGISTER: Once = Once::new();
    unsafe {
        let instance = GetModuleHandleW(None)?;
        REGISTER.call_once(|| {
            let class = WNDCLASSW {
                lpfnWndProc: Some(proc),
                hInstance: instance.into(),
                lpszClassName: CLASS,
                // Orange, the window's only paint: the region below leaves just a frame of it.
                hbrBackground: CreateSolidBrush(COLORREF(0x000a_9fff)),
                ..Default::default()
            };
            RegisterClassW(&class);
        });
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            CLASS,
            w!("NotNotch highlight"),
            WS_POPUP,
            r.x,
            r.y,
            r.w,
            r.h,
            None,
            None,
            Some(instance.into()),
            None,
        )?;
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 235, LWA_ALPHA);
        // A rounded frame as thick as a tenth of the line, 2 to 6 px.
        let (t, round) = ((r.h / 10).clamp(2, 6), (r.h / 3).max(6));
        let outer = CreateRoundRectRgn(0, 0, r.w + 1, r.h + 1, round, round);
        let inner = CreateRoundRectRgn(t, t, r.w - t + 1, r.h - t + 1, round - t, round - t);
        CombineRgn(Some(outer), Some(outer), Some(inner), RGN_DIFF);
        let _ = DeleteObject(inner.into());
        // The window owns the region from here.
        SetWindowRgn(hwnd, Some(outer), false);
        let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let until = Instant::now() + HIGHLIGHT_FOR;
        let mut msg = MSG::default();
        while Instant::now() < until {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            std::thread::sleep(Duration::from_millis(16));
        }
        let _ = DestroyWindow(hwnd);
    }
    Ok(())
}

#[cfg(test)]
mod live {
    //! Reads text drawn into a bitmap, without the screen. Needs an OCR language installed:
    //! `cargo test --lib capture::find::live -- --ignored`.
    use super::*;
    use windows::Win32::Graphics::Gdi::{PatBlt, SetBkMode, SetTextColor, TextOutW, TRANSPARENT, WHITENESS};

    #[test]
    #[ignore]
    fn reads_drawn_text() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let dib = shot::Dib::new(800, 200).unwrap();
        let text: Vec<u16> = "Invoice number 2026".encode_utf16().collect();
        unsafe {
            let font = windows::Win32::Graphics::Gdi::CreateFontW(48, 0, 0, 0, 400, 0, 0, 0, Default::default(), Default::default(), Default::default(), Default::default(), 0, w!("Segoe UI"));
            let _ = PatBlt(dib.dc, 0, 0, 800, 200, WHITENESS);
            windows::Win32::Graphics::Gdi::SelectObject(dib.dc, font.into());
            SetBkMode(dib.dc, TRANSPARENT);
            SetTextColor(dib.dc, COLORREF(0));
            let _ = TextOutW(dib.dc, 40, 60, &text);
        }
        let monitor = Rect { x: -1920, y: 100, w: 800, h: 200 };
        let lines = read(&engine().unwrap(), dib, monitor, 1.0).unwrap();
        eprintln!("{lines:?}");
        let (found, rect) = lines.iter().find(|(t, _)| t.contains("Invoice")).expect("line read");
        assert!(found.contains("2026"), "{found}");
        // Drawn at 40, 60 on a monitor at -1920, 100: the frame lies around it, moved onto that monitor.
        assert!((-1890..=-1870).contains(&rect.x) && (150..=175).contains(&rect.y) && rect.w > 300 && rect.h > 30, "{rect:?}");
    }
}
