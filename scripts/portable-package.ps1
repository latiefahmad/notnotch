# Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), scripts/PortablePackage.ps1.
# Builds the portable zip from the release executables: one folder with NotNotch.exe, notnotch-notify.exe, the NotNotch.portable marker
# (with it the app keeps its data in a data folder next to the exe and updates itself in place, see
# src-tauri/src/portable.rs) and a short note about the WebView2 runtime.
#   pwsh scripts/portable-package.ps1 -Exe src-tauri/target/release/notnotch.exe -Destination NotNotch-1.0.1-Portable-x64.zip
# notnotch-notify.exe is taken from the same folder as -Exe unless -Notify names it.
param(
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string]$Destination,
    [string]$Notify = (Join-Path (Split-Path -Parent $Exe) 'notnotch-notify.exe'),
    [string]$Folder = 'NotNotch'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$marker = "Portable copy of NotNotch: settings, notes and the vault are kept in the data folder next to NotNotch.exe.`r`nDelete this file to use the data of an installed NotNotch instead.`r`n"
$readme = @"
NotNotch portable

Unzip the folder anywhere you can write to and run NotNotch.exe. Nothing is installed.
Settings, notes and caches stay in the data folder next to NotNotch.exe and travel with the
folder to another PC or a USB drive. The vault file travels too, but it is locked to the
Windows user and PC that created it (DPAPI): elsewhere it does not open. API keys stay in
Windows Credential Manager of each PC and have to be entered again there.

In a folder NotNotch cannot write to (a locked share, Program Files) it still starts, keeps its
data in your user profile like an installed copy, and updates open the download page.

notnotch-notify.exe sends your own notices to NotNotch from scripts and builds; add this folder to
your PATH to call it by name.

Updates: Settings, General, Updates downloads the new portable package, checks its
signature and replaces NotNotch.exe and notnotch-notify.exe on restart.

An installed and a portable NotNotch on the same PC share one single-instance lock (only one
runs at a time) and one "Start with Windows" entry: switching it on in one points it at
that copy. Start with Windows is off for a new portable copy; switch it on in the tray
menu if wanted.

NotNotch needs the Microsoft Edge WebView2 Runtime. Windows 10 and 11 normally include it.
If NotNotch does not start, install the Evergreen runtime from
https://developer.microsoft.com/microsoft-edge/webview2/
"@

if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination }
$zip = [IO.Compression.ZipFile]::Open([IO.Path]::GetFullPath($Destination), [IO.Compression.ZipArchiveMode]::Create)
try {
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Resolve-Path -LiteralPath $Exe).Path, "$Folder/NotNotch.exe", [IO.Compression.CompressionLevel]::Optimal)
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Resolve-Path -LiteralPath $Notify).Path, "$Folder/notnotch-notify.exe", [IO.Compression.CompressionLevel]::Optimal)
    foreach ($entry in @(@{ Name = 'NotNotch.portable'; Text = $marker }, @{ Name = 'README-portable.txt'; Text = $readme -replace "`r?`n", "`r`n" })) {
        $writer = [IO.StreamWriter]::new($zip.CreateEntry("$Folder/$($entry.Name)").Open(), [Text.UTF8Encoding]::new($false))
        try { $writer.Write($entry.Text) } finally { $writer.Dispose() }
    }
}
finally { $zip.Dispose() }
Get-Item -LiteralPath $Destination
