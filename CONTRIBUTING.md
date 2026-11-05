# Contributing to NotNotch

Bug reports, ideas and pull requests are welcome. For anything larger than a small fix, open an issue first so we can agree on the approach. Before a pull request, run `npm run typecheck`, `npm test`, `npm run i18n` and `cargo test`, and keep interface text in English. Contributions are released under the GPL-3.0, like the rest of the project.

## Build from source

Built with **Tauri 2, React 19, TypeScript, Motion and Tailwind 4**. The app uses WebView2 instead of bundling Chromium, which keeps the release build at a few megabytes. Animations stay smooth because the window itself never resizes. Only the content inside it moves.

Prerequisites:

- Node.js 24. Node 22 or newer builds the app; `npm test` runs the TypeScript test files directly, which needs Node 22.18 or later.
- Rust (stable).
- WebView2 (part of Windows 11; on Windows 10 the installer fetches it).
- On Windows, the Visual Studio Build Tools with the C++ workload and a Windows 11 SDK, required for linking.

```bash
npm install
npm run dev        # browser with a fake desktop, ?slow=4 slows animations for tuning
npm run tauri dev  # the real app, run it in PowerShell
npm test           # frontend tests
npm run typecheck  # before every commit
npm run i18n       # finds missing English strings (add --fix for TODO entries)
cd src-tauri && cargo test   # backend tests
```

In the browser, `?showcase` switches to English with curated demo data (music, Discord call, portfolio, chat).

To build a standalone executable:

```bash
npx tauri build --no-bundle   # result: src-tauri/target/release/notnotch.exe
```

Run Tauri and Cargo commands from PowerShell. In Git Bash, `/usr/bin/link` shadows the MSVC linker and the build fails.

### Microsoft Store build

The Store gets its own package, built with the `store` Cargo feature:

```powershell
powershell -File scripts/store-package.ps1               # result: dist-store/NotNotch-<version>-x64.msix
powershell -File scripts/store-package.ps1 -Arch arm64   # dist-store/NotNotch-<version>-arm64.msix
powershell -File scripts/store-package.ps1 -Bundle       # both, and dist-store/NotNotch-<version>.msixbundle
powershell -File scripts/store-package.ps1 -TestSign     # also a self-signed copy to install on this PC
```

An arm64 package cross-compiles on an x64 PC when Visual Studio has the "MSVC ARM64 build tools" and "C++ Clang compiler for Windows" components (ring, a TLS dependency, compiles its ARM64 code with clang). Partner Center takes the x64 and arm64 `.msix` side by side in one submission, or the `.msixbundle` in their place; the steps are at the top of the script.

The script needs a Windows SDK for `makeappx` and `signtool` and takes the newest one under `C:\Program Files (x86)\Windows Kits\10\bin`. It builds into `src-tauri/target-store`, apart from the normal build, and gives the package the version from `tauri.conf.json` with a fourth part of 0. The manifest is `packaging/store/AppxManifest.xml`; NotNotch's entry also carries an alias for notnotch-notify, so `notnotch-notify` runs by name from any terminal once the package is installed. Upload the unsigned `.msix` to Partner Center, which signs Store packages itself.

The Store build never updates itself: the updater plugin is not loaded, and Settings, General, Updates says that updates come from the Microsoft Store instead of offering a check. It is never portable, whatever sits next to the exe. Start with Windows goes through the package's startup task, which Task Manager lists under Startup apps, and stays off until the user turns it on. If the user switched it off there, Windows keeps it off and Settings tells them where to turn it back on.

`-TestSign` creates a self-signed certificate in your user store the first time, with the package's Publisher as its subject, exports it to your temp folder and signs a copy of the package. Installing that copy needs the certificate in `LocalMachine\TrustedPeople`, which takes an elevated PowerShell. The script prints that command and the install command but runs nothing elevated.

### Releasing

Releases are built by GitHub Actions (`.github/workflows/release.yml`). Bump the version, commit and push:

```bash
npm run bump 1.0.1
git commit -am "Release 1.0.1"
git push
```

The workflow builds the signed installers and portable zips for x64 and arm64 (arm64 cross-compiled on the x64 runner) and publishes release `notnotch-v1.0.1` with them, their signatures and `latest.json`, which installed apps and portable copies use to offer the update. A last job adds `SHA256SUMS` with the SHA-256 of every file of the release. Pushes without a version bump don't create a release. The signing key lives in the repository secret `TAURI_SIGNING_PRIVATE_KEY`.

### Project layout

```
src/            React frontend: notch shape, tools, design tokens, i18n
src-tauri/      Rust backend: window, hit testing, tray and the Windows APIs
scripts/        Helper scripts such as the version bump and the i18n check
docs/           Longer guides, such as live notices and notnotch-notify
```
