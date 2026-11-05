//! Shelf: drag files or text out of the notch into other apps, and clipboard text for text cards.
//!
//! Files go out in the shell's own data object (SHCreateDataObject over their ID lists), the
//! same object Explorer hands out: CF_HDROP, shell ID lists and the drag image all come with
//! it, so Explorer, mail clients, chats and browsers accept the drop. Text goes out in an
//! empty shell data object with CF_UNICODETEXT. SHDoDragDrop brings its own drop source.
//! Only copy and link are offered, so a drop never moves a file away from where the shelf
//! expects it.

use std::mem::ManuallyDrop;

use tauri::{AppHandle, WebviewWindow};
use windows::core::HSTRING;
use windows::Win32::Foundation::{GlobalFree, HWND};
use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{IDropSource, OleInitialize, OleUninitialize, CF_UNICODETEXT, DROPEFFECT_COPY, DROPEFFECT_LINK};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{ILFree, SHCreateDataObject, SHDoDragDrop, SHParseDisplayName};

/// Runs the drag; resolves once it is dropped or cancelled. Called by the frontend while the
/// left button is still down over a shelf card.
#[tauri::command]
pub async fn shelf_drag_out(paths: Vec<String>, text: Option<String>, window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let (tx, rx) = tokio::sync::oneshot::channel();
    // OLE drag and drop needs the UI thread; its modal loop keeps the window responsive.
    app.run_on_main_thread(move || {
        let _ = tx.send(drag(HWND(hwnd as _), &paths, text.as_deref()));
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

/// Text on the clipboard for a text card ("" when there is none).
#[tauri::command]
pub async fn shelf_clipboard_text() -> String {
    tauri::async_runtime::spawn_blocking(|| arboard::Clipboard::new().and_then(|mut c| c.get_text()).unwrap_or_default())
        .await
        .unwrap_or_default()
}

fn drag(hwnd: HWND, paths: &[String], text: Option<&str>) -> Result<(), String> {
    unsafe {
        // Balanced below; a second call on the already initialised UI thread only counts up.
        let ole = OleInitialize(None).is_ok();
        let result = (|| {
            let data = if paths.is_empty() { text_object(text.unwrap_or_default())? } else { files_object(paths)? };
            SHDoDragDrop(Some(hwnd), &data, None::<&IDropSource>, DROPEFFECT_COPY | DROPEFFECT_LINK)
                .map(|_| ())
                .map_err(|e| e.to_string())
        })();
        if ole {
            OleUninitialize();
        }
        result
    }
}

unsafe fn files_object(paths: &[String]) -> Result<IDataObject, String> {
    let mut pidls: Vec<*mut ITEMIDLIST> = Vec::new();
    for path in paths {
        let mut pidl = std::ptr::null_mut();
        if SHParseDisplayName(&HSTRING::from(path.as_str()), None, &mut pidl, 0, None).is_ok() && !pidl.is_null() {
            pidls.push(pidl);
        }
    }
    if pidls.is_empty() {
        return Err("Files no longer exist".into());
    }
    // Absolute ID lists under the desktop (the empty list), so files from different folders work together.
    let desktop = ITEMIDLIST::default();
    let children: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| *p as *const _).collect();
    let data = SHCreateDataObject(Some(&desktop as *const _), Some(&children), None::<&IDataObject>);
    for pidl in pidls {
        ILFree(Some(pidl));
    }
    data.map_err(|e| e.to_string())
}

unsafe fn text_object(text: &str) -> Result<IDataObject, String> {
    let data: IDataObject = SHCreateDataObject(None, None, None::<&IDataObject>).map_err(|e| e.to_string())?;
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let global = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).map_err(|e| e.to_string())?;
    let ptr = GlobalLock(global) as *mut u16;
    if ptr.is_null() {
        let _ = GlobalFree(Some(global));
        return Err("Out of memory".into());
    }
    std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
    let _ = GlobalUnlock(global);
    let format = FORMATETC { cfFormat: CF_UNICODETEXT.0, ptd: std::ptr::null_mut(), dwAspect: DVASPECT_CONTENT.0, lindex: -1, tymed: TYMED_HGLOBAL.0 as u32 };
    let medium = STGMEDIUM { tymed: TYMED_HGLOBAL.0 as u32, u: STGMEDIUM_0 { hGlobal: global }, pUnkForRelease: ManuallyDrop::new(None) };
    // fRelease = true: the data object owns the memory from here on.
    if let Err(e) = data.SetData(&format, &medium, true) {
        let _ = GlobalFree(Some(global));
        return Err(e.to_string());
    }
    Ok(data)
}
