//! Camera tool: WebView2 asks the host app before a page may use the camera. NotNotch's own page gets it, for
//! video only; the microphone and every other page (a plugin frame, anything navigated to) are refused, so
//! WebView2 never shows its own prompt either. The grant is not saved in the profile: each request is decided here.

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2PermissionRequestedEventArgs3, COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
};
use webview2_com::PermissionRequestedEventHandler;
use windows::core::{Interface, PWSTR};

pub fn install(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let page = uri.to_string().unwrap_or_default();
            windows::Win32::System::Com::CoTaskMemFree(Some(uri.0 as _));
            let Some(allow) = verdict(kind, &page) else { return Ok(()) };
            if let Ok(args3) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                let _ = args3.SetSavesInProfile(false);
            }
            args.SetState(if allow { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY })
        }));
        let mut token = Default::default();
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
}

/// Allow, deny, or None to leave other kinds (clipboard and the rest) as they were.
fn verdict(kind: COREWEBVIEW2_PERMISSION_KIND, uri: &str) -> Option<bool> {
    match kind {
        COREWEBVIEW2_PERMISSION_KIND_CAMERA => Some(tauri::Url::parse(uri).is_ok_and(|u| crate::own_page(&u))),
        // The Camera tool asks for video only, and no page of NotNotch records sound.
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ;

    #[test]
    fn camera_only_for_notnotchs_own_page() {
        assert_eq!(verdict(COREWEBVIEW2_PERMISSION_KIND_CAMERA, "http://tauri.localhost/"), Some(true));
        assert_eq!(verdict(COREWEBVIEW2_PERMISSION_KIND_CAMERA, "http://notnotchplugin.localhost/demo/index.html"), Some(false));
        assert_eq!(verdict(COREWEBVIEW2_PERMISSION_KIND_CAMERA, "https://example.com/"), Some(false));
        assert_eq!(verdict(COREWEBVIEW2_PERMISSION_KIND_CAMERA, "not a url"), Some(false));
        assert_eq!(verdict(COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, "http://tauri.localhost/"), Some(false));
        assert_eq!(verdict(COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ, "http://tauri.localhost/"), None);
    }
}
