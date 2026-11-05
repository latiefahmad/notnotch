fn main() {
    // The exe icon is embedded as a resource. Without this, a new icon from `tauri icon`
    // only shows up once Cargo happens to rerun the build script.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    // Media Foundation (recording) is missing on Windows N editions without the Media Feature Pack: loaded on first use instead of
    // at start, so NotNotch still starts there; capture::media_foundation checks for it before the first call. x64 and ARM64 alike.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        for dll in ["mfplat.dll", "mfreadwrite.dll"] {
            println!("cargo:rustc-link-arg-bin=notnotch=/DELAYLOAD:{dll}");
        }
        println!("cargo:rustc-link-arg-bin=notnotch=delayimp.lib");
    }
    tauri_build::build()
}
