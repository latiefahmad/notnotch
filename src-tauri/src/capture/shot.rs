//! Screenshots: a GDI copy of the whole virtual screen, cropped to a monitor or to a
//! region the user drags in an overlay.
//!
//! The overlay is a plain Win32 popup over all monitors that shows the frozen screen
//! dimmed and the selection at full brightness. Drag to select, click to take the
//! monitor under the cursor, Esc or right click to cancel. The thread runs per-monitor
//! DPI aware, so every coordinate is a physical pixel, also across monitors with
//! different scaling.

use std::sync::Once;

use windows::core::{w, Result};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture, VK_ESCAPE};
use windows::Win32::UI::WindowsAndMessaging::*;

use super::math::{drag_rect, intersect, Rect};

/// A 32-bit top-down bitmap selected into its own memory DC.
pub struct Dib {
    pub(super) dc: HDC,
    bmp: HBITMAP,
    old: HGDIOBJ,
    bits: *mut u8,
    pub w: i32,
    pub h: i32,
}

impl Dib {
    pub fn new(w: i32, h: i32) -> Result<Dib> {
        unsafe {
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let dc = CreateCompatibleDC(None);
            let mut bits = std::ptr::null_mut();
            let bmp = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
                Ok(b) => b,
                Err(e) => {
                    let _ = DeleteDC(dc);
                    return Err(e);
                }
            };
            let old = SelectObject(dc, bmp.into());
            Ok(Dib { dc, bmp, old, bits: bits as *mut u8, w, h })
        }
    }

    /// BGRA, 4 bytes per pixel, rows top to bottom.
    pub fn pixels(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.bits, (self.w * self.h * 4) as usize) }
    }

    fn pixels_mut(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.bits, (self.w * self.h * 4) as usize) }
    }

    /// The crop `r` (bitmap coordinates) as an RGBA image.
    pub fn crop_rgba(&self, r: Rect) -> image::RgbaImage {
        let px = self.pixels();
        let mut out = Vec::with_capacity((r.w * r.h * 4) as usize);
        for y in r.y..r.bottom() {
            let row = &px[((y * self.w + r.x) * 4) as usize..((y * self.w + r.right()) * 4) as usize];
            for p in row.chunks_exact(4) {
                out.extend_from_slice(&[p[2], p[1], p[0], 255]);
            }
        }
        image::RgbaImage::from_raw(r.w as u32, r.h as u32, out).expect("size matches")
    }
}

impl Drop for Dib {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old);
            let _ = DeleteObject(self.bmp.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

/// The virtual screen (all monitors) in physical pixels.
pub fn virtual_screen() -> Rect {
    unsafe {
        Rect {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            w: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            h: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

/// Copies what is on all screens right now. CAPTUREBLT includes layered windows (menus, tooltips).
pub fn grab(screen: Rect) -> Result<Dib> {
    let dib = Dib::new(screen.w, screen.h)?;
    unsafe {
        let src = GetDC(None);
        let done = BitBlt(dib.dc, 0, 0, screen.w, screen.h, Some(src), screen.x, screen.y, SRCCOPY | CAPTUREBLT);
        ReleaseDC(None, src);
        done?;
    }
    Ok(dib)
}

struct Overlay<'a> {
    shot: &'a Dib,
    dim: Dib,
    /// Monitors in bitmap coordinates, for a click without drag.
    monitors: Vec<Rect>,
    start: Option<(i32, i32)>,
    cur: (i32, i32),
    /// Some(None) = cancelled, Some(Some(r)) = picked.
    result: Option<Option<Rect>>,
}

impl Overlay<'_> {
    fn selection(&self) -> Option<Rect> {
        self.start.and_then(|s| drag_rect(s, self.cur, Rect { x: 0, y: 0, w: self.shot.w, h: self.shot.h }, 1))
    }
}

const CLASS: windows::core::PCWSTR = w!("NotNotchCaptureOverlay");
/// Room the size label below the selection needs, so its old position gets repainted.
const LABEL_W: i32 = 160;
const LABEL_H: i32 = 28;

/// Lets the user pick a region of `shot` (whose pixel 0,0 is `screen`'s top left).
/// Returns it in bitmap coordinates, or None when cancelled.
/// `owner` (the notch window, 0 for none) keeps the overlay above it: an owned window always sits over its owner.
pub fn pick_region(shot: &Dib, screen: Rect, monitors: &[Rect], owner: isize) -> Result<Option<Rect>> {
    let mut dim = Dib::new(shot.w, shot.h)?;
    for (d, s) in dim.pixels_mut().iter_mut().zip(shot.pixels()) {
        *d = (*s as u16 * 9 / 20) as u8;
    }
    let monitors = monitors.iter().filter_map(|m| super::math::to_bitmap(*m, screen)).collect();
    // Owned through the raw pointer the window keeps, so the window procedure and this loop never hold two borrows.
    let state = Box::into_raw(Box::new(Overlay { shot, dim, monitors, start: None, cur: (0, 0), result: None }));

    static REGISTER: Once = Once::new();
    unsafe {
        let instance = GetModuleHandleW(None)?;
        REGISTER.call_once(|| {
            let class = WNDCLASSW {
                lpfnWndProc: Some(proc),
                hInstance: instance.into(),
                lpszClassName: CLASS,
                hCursor: LoadCursorW(None, IDC_CROSS).unwrap_or_default(),
                ..Default::default()
            };
            RegisterClassW(&class);
        });
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            CLASS,
            w!("NotNotch capture"),
            WS_POPUP,
            screen.x,
            screen.y,
            screen.w,
            screen.h,
            (owner != 0).then_some(HWND(owner as *mut _)),
            None,
            Some(instance.into()),
            None,
        );
        let hwnd = match hwnd {
            Ok(h) => h,
            Err(e) => {
                drop(Box::from_raw(state));
                return Err(e);
            }
        };
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, state as isize);
        // Never in a recording that runs while a region is picked.
        let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);

        let mut msg = MSG::default();
        while (*state).result.is_none() && GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        let _ = DestroyWindow(hwnd);
        Ok(Box::from_raw(state).result.flatten())
    }
}

unsafe fn state_ref<'a>(hwnd: HWND) -> Option<&'a mut Overlay<'a>> {
    let p = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut Overlay;
    unsafe { p.as_mut() }
}

fn point(lparam: LPARAM) -> (i32, i32) {
    ((lparam.0 & 0xffff) as i16 as i32, ((lparam.0 >> 16) & 0xffff) as i16 as i32)
}

/// The area a selection and its label cover on screen.
fn dirty(r: Option<Rect>) -> Option<RECT> {
    r.map(|r| RECT { left: r.x - 2, top: r.y - 2, right: (r.right() + 2).max(r.x + LABEL_W), bottom: r.bottom() + LABEL_H })
}

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let Some(s) = (unsafe { state_ref(hwnd) }) else { return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) } };
    unsafe {
        match msg {
            WM_LBUTTONDOWN => {
                s.start = Some(point(lparam));
                s.cur = point(lparam);
                SetCapture(hwnd);
            }
            WM_MOUSEMOVE if s.start.is_some() => {
                let before = dirty(s.selection());
                s.cur = point(lparam);
                for r in [before, dirty(s.selection())].into_iter().flatten() {
                    let _ = InvalidateRect(Some(hwnd), Some(&r), false);
                }
            }
            WM_LBUTTONUP if s.start.is_some() => {
                let _ = ReleaseCapture();
                s.cur = point(lparam);
                let start = s.start.take().unwrap_or(s.cur);
                let bounds = Rect { x: 0, y: 0, w: s.shot.w, h: s.shot.h };
                // A drag picks the region, a click the monitor under the cursor.
                let picked = drag_rect(start, s.cur, bounds, 4).or_else(|| {
                    let (x, y) = s.cur;
                    s.monitors.iter().copied().find(|m| x >= m.x && x < m.right() && y >= m.y && y < m.bottom())
                });
                s.result = Some(picked);
            }
            WM_RBUTTONDOWN => s.result = Some(None),
            WM_KEYDOWN if wparam.0 == VK_ESCAPE.0 as usize => s.result = Some(None),
            // Alt+Tab or a click into another app cancels, as in the Snipping Tool.
            WM_ACTIVATE if (wparam.0 & 0xffff) as u32 == WA_INACTIVE => s.result = Some(None),
            WM_ERASEBKGND => return LRESULT(1),
            WM_PAINT => paint(hwnd, s),
            _ => return DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
    LRESULT(0)
}

/// Paints only the invalid part, through a back buffer of that size, so dragging over
/// a large virtual screen stays smooth.
unsafe fn paint(hwnd: HWND, s: &Overlay) {
    unsafe {
        let mut ps = PAINTSTRUCT::default();
        let hdc = BeginPaint(hwnd, &mut ps);
        let p = ps.rcPaint;
        let (pw, ph) = (p.right - p.left, p.bottom - p.top);
        if pw > 0 && ph > 0 {
            let back = CreateCompatibleDC(Some(hdc));
            let bmp = CreateCompatibleBitmap(hdc, pw, ph);
            let old = SelectObject(back, bmp.into());
            let _ = BitBlt(back, 0, 0, pw, ph, Some(s.dim.dc), p.left, p.top, SRCCOPY);
            if let Some(sel) = s.selection() {
                if let Some(i) = intersect(sel, Rect { x: p.left, y: p.top, w: pw, h: ph }) {
                    let _ = BitBlt(back, i.x - p.left, i.y - p.top, i.w, i.h, Some(s.shot.dc), i.x, i.y, SRCCOPY);
                }
                let frame = RECT { left: sel.x - p.left, top: sel.y - p.top, right: sel.right() - p.left, bottom: sel.bottom() - p.top };
                let white = CreateSolidBrush(COLORREF(0x00ff_ffff));
                FrameRect(back, &frame, white);
                let _ = DeleteObject(white.into());
                let label: Vec<u16> = format!("{} \u{00d7} {}", sel.w, sel.h).encode_utf16().collect();
                SetBkMode(back, TRANSPARENT);
                SetTextColor(back, COLORREF(0x00ff_ffff));
                let font = SelectObject(back, GetStockObject(DEFAULT_GUI_FONT));
                let _ = TextOutW(back, frame.left, frame.bottom + 6, &label);
                SelectObject(back, font);
            }
            let _ = BitBlt(hdc, p.left, p.top, pw, ph, Some(back), 0, 0, SRCCOPY);
            SelectObject(back, old);
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(back);
        }
        let _ = EndPaint(hwnd, &ps);
    }
}
