//! Reading a plugin from a folder or a .zip into memory, with every path checked, before anything is written.
//! Nothing is followed outside the source: links and junctions refuse the plugin, zip names that could climb out of
//! the folder (`..`, a root, a drive, a backslash) too, and sizes are capped on what is actually read, not on what
//! an archive claims.

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use super::manifest::{self, Manifest, MANIFEST};

pub const MAX_FILES: usize = 200;
pub const MAX_FILE: u64 = 5 * 1024 * 1024;
pub const MAX_TOTAL: u64 = 10 * 1024 * 1024;
const MAX_ZIP: u64 = 20 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 1000;
/// What a plugin may contain; the protocol serves each with its type (plugins.rs). A name without an extension
/// (LICENSE) is plain text.
pub const EXTENSIONS: &[&str] = &["html", "js", "mjs", "css", "json", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico", "woff", "woff2", "ttf", "otf", "txt", "md"];

pub struct Bundle {
    pub manifest: Manifest,
    /// Paths relative to the plugin folder, `/` between names.
    pub files: Vec<(String, Vec<u8>)>,
}

/// The extension a name is served by, lowercase; "" for none.
pub fn extension(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

/// A folder the user picked. Names starting with a dot (.git, .DS_Store) are left out.
pub fn from_dir(root: &Path) -> Result<Bundle, String> {
    let meta = fs::symlink_metadata(root).map_err(|_| "not-found")?;
    if meta.file_type().is_symlink() {
        return Err("symlink".into());
    }
    if !meta.is_dir() {
        return Err("not-found".into());
    }
    let base = fs::canonicalize(root).map_err(|_| "not-found")?;
    let mut files = Vec::new();
    let mut total = 0;
    walk(&base, &base, "", 0, &mut files, &mut total)?;
    finish(files)
}

fn walk(base: &Path, dir: &Path, prefix: &str, depth: usize, files: &mut Vec<(String, Vec<u8>)>, total: &mut u64) -> Result<(), String> {
    if depth >= 8 {
        return Err("path".into());
    }
    let mut entries: Vec<_> = fs::read_dir(dir).map_err(|_| "read")?.collect::<Result<_, _>>().map_err(|_| "read")?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().into_string().map_err(|_| "path")?;
        if name.starts_with('.') {
            continue;
        }
        if !manifest::valid_component(&name) {
            return Err(format!("path:{prefix}{name}"));
        }
        let path = entry.path();
        // symlink_metadata does not follow: a link or a junction shows as one.
        let meta = fs::symlink_metadata(&path).map_err(|_| "read")?;
        let rel = format!("{prefix}{name}");
        if meta.file_type().is_symlink() {
            return Err(format!("symlink:{rel}"));
        }
        // Whatever the entry is, it must still be inside the folder once resolved.
        if !fs::canonicalize(&path).map_err(|_| "read")?.starts_with(base) {
            return Err(format!("symlink:{rel}"));
        }
        if meta.is_dir() {
            walk(base, &path, &format!("{rel}/"), depth + 1, files, total)?;
        } else if meta.is_file() {
            if meta.len() > MAX_FILE {
                return Err(format!("too-large:{rel}"));
            }
            let mut bytes = Vec::new();
            fs::File::open(&path).map_err(|_| "read")?.take(MAX_FILE + 1).read_to_end(&mut bytes).map_err(|_| "read")?;
            add(files, total, rel, bytes)?;
        } else {
            return Err(format!("path:{rel}"));
        }
    }
    Ok(())
}

fn add(files: &mut Vec<(String, Vec<u8>)>, total: &mut u64, rel: String, bytes: Vec<u8>) -> Result<(), String> {
    if bytes.len() as u64 > MAX_FILE {
        return Err(format!("too-large:{rel}"));
    }
    *total += bytes.len() as u64;
    if *total > MAX_TOTAL {
        return Err("too-large".into());
    }
    if files.len() >= MAX_FILES {
        return Err("too-many-files".into());
    }
    files.push((rel, bytes));
    Ok(())
}

/// A .zip the user picked. The plugin may sit at the archive's root or in one folder at the top (a zipped folder).
pub fn from_zip(path: &Path) -> Result<Bundle, String> {
    let meta = fs::metadata(path).map_err(|_| "not-found")?;
    if meta.len() > MAX_ZIP {
        return Err("too-large".into());
    }
    let file = fs::File::open(path).map_err(|_| "not-found")?;
    read_zip(file)
}

pub fn read_zip<R: Read + std::io::Seek>(reader: R) -> Result<Bundle, String> {
    let mut zip = zip::ZipArchive::new(reader).map_err(|_| "zip")?;
    if zip.len() > MAX_ZIP_ENTRIES {
        return Err("too-many-files".into());
    }
    let mut files = Vec::new();
    let mut total = 0;
    for i in 0..zip.len() {
        // An encrypted entry fails here.
        let entry = zip.by_index(i).map_err(|_| "zip")?;
        let name = entry.name().to_string();
        if entry.is_symlink() {
            return Err(format!("symlink:{name}"));
        }
        // Directories only matter through the files in them; their names are checked there.
        if entry.is_dir() {
            continue;
        }
        let parts: Vec<&str> = name.split('/').collect();
        if parts.iter().any(|p| *p == "." || *p == "..") {
            return Err(format!("path:{name}"));
        }
        // Hidden files and the folder macOS adds are left out, as in a folder.
        if parts.iter().any(|p| p.starts_with('.') || *p == "__MACOSX") {
            continue;
        }
        if manifest::rel_path(&name).is_none() {
            return Err(format!("path:{name}"));
        }
        if entry.size() > MAX_FILE {
            return Err(format!("too-large:{name}"));
        }
        let mut bytes = Vec::new();
        entry.take(MAX_FILE + 1).read_to_end(&mut bytes).map_err(|_| "zip")?;
        add(&mut files, &mut total, name, bytes)?;
    }
    // A zipped folder: everything under one top folder that holds the manifest.
    if !files.iter().any(|(p, _)| p == MANIFEST) {
        if let Some(top) = files.first().and_then(|(p, _)| p.split_once('/')).map(|(t, _)| format!("{t}/")) {
            if files.iter().all(|(p, _)| p.starts_with(&top)) {
                for (p, _) in &mut files {
                    *p = p[top.len()..].to_string();
                }
            }
        }
    }
    finish(files)
}

/// The files read: no two names that Windows would treat as the same, only known types, a valid manifest at the top
/// and its entry page among them.
fn finish(files: Vec<(String, Vec<u8>)>) -> Result<Bundle, String> {
    let mut seen = HashSet::new();
    for (p, _) in &files {
        if !seen.insert(p.to_ascii_lowercase()) {
            return Err(format!("duplicate:{p}"));
        }
        let name = p.rsplit('/').next().unwrap_or(p);
        let ext = extension(name);
        if name.contains('.') && !EXTENSIONS.contains(&ext.as_str()) {
            return Err(format!("file-type:{p}"));
        }
    }
    // A file "a" and a folder "a/" would clash on disk.
    let dirs: HashSet<&str> = seen.iter().flat_map(|l| l.match_indices('/').map(move |(i, _)| &l[..i])).collect();
    if let Some((p, _)) = files.iter().find(|(p, _)| dirs.contains(p.to_ascii_lowercase().as_str())) {
        return Err(format!("duplicate:{p}"));
    }
    let bytes = files.iter().find(|(p, _)| p == MANIFEST).map(|(_, b)| b).ok_or("no-manifest")?;
    let manifest = manifest::parse(bytes)?;
    if !files.iter().any(|(p, _)| *p == manifest.entry) {
        return Err("no-entry".into());
    }
    Ok(Bundle { manifest, files })
}

/// Writes the files into `dir`, which must not exist yet. Names were checked, and each file is created new.
pub fn write(bundle: &Bundle, dir: &Path) -> std::io::Result<()> {
    fs::create_dir(dir)?;
    for (rel, bytes) in &bundle.files {
        let path = rel.split('/').fold(dir.to_path_buf(), |p, c| p.join(c));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::OpenOptions::new().write(true).create_new(true).open(&path)?.write_all(bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    const MANIFEST_JSON: &str = r#"{"id":"hello-notnotch","name":"Hello","version":"1.0.0","entry":"index.html","size":{"w":520,"h":260}}"#;

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            w.start_file(*name, SimpleFileOptions::default()).unwrap();
            w.write_all(bytes).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    fn read(entries: &[(&str, &[u8])]) -> Result<Bundle, String> {
        read_zip(Cursor::new(zip_of(entries)))
    }

    #[test]
    fn zip_ok() {
        let b = read(&[(MANIFEST, MANIFEST_JSON.as_bytes()), ("index.html", b"<p>hi"), ("js/app.js", b"1"), (".DS_Store", b"x"), ("LICENSE", b"GPL")]).unwrap();
        assert_eq!(b.manifest.id, "hello-notnotch");
        let names: Vec<&str> = b.files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(names, [MANIFEST, "index.html", "js/app.js", "LICENSE"]);
        // A zipped folder.
        let b = read(&[("hello/notnotch-plugin.json", MANIFEST_JSON.as_bytes()), ("hello/index.html", b"x"), ("__MACOSX/hello/._index.html", b"x")]).unwrap();
        assert!(b.files.iter().any(|(p, _)| p == "index.html"));
    }

    #[test]
    fn zip_slip_refused() {
        for evil in ["../evil.js", "a/../../evil.js", "/abs.js", "C:/Windows/evil.js", "a\\..\\evil.js", "a//b.js", "CON.js", "a%2f..%2fb.js", "x/./y.js"] {
            let r = read(&[(MANIFEST, MANIFEST_JSON.as_bytes()), ("index.html", b"x"), (evil, b"x")]);
            assert!(r.as_ref().is_err_and(|e| e.starts_with("path")), "{evil}: {:?}", r.err());
        }
    }

    #[test]
    fn zip_symlink_refused() {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        w.start_file(MANIFEST, SimpleFileOptions::default()).unwrap();
        w.write_all(MANIFEST_JSON.as_bytes()).unwrap();
        w.start_file("index.html", SimpleFileOptions::default()).unwrap();
        w.add_symlink("secret.txt", "../../../../Users/x/.ssh/id_rsa", SimpleFileOptions::default()).unwrap();
        let bytes = w.finish().unwrap().into_inner();
        assert!(read_zip(Cursor::new(bytes)).is_err_and(|e| e.starts_with("symlink")));
    }

    #[test]
    fn zip_limits() {
        // Six megabytes of zeros compress to almost nothing: the bound is on what is read.
        let big = vec![0u8; MAX_FILE as usize + 1];
        assert!(read(&[(MANIFEST, MANIFEST_JSON.as_bytes()), ("index.html", &big)]).is_err_and(|e| e.starts_with("too-large")));
        let names: Vec<String> = (0..MAX_FILES + 1).map(|i| format!("f{i}.txt")).collect();
        let mut entries: Vec<(&str, &[u8])> = vec![(MANIFEST, MANIFEST_JSON.as_bytes()), ("index.html", b"x")];
        entries.extend(names.iter().map(|n| (n.as_str(), &b"x"[..])));
        assert_eq!(read(&entries).err().as_deref(), Some("too-many-files"));
        assert!(read(&[(MANIFEST, MANIFEST_JSON.as_bytes()), ("index.html", b"x"), ("tool.exe", b"MZ")]).is_err_and(|e| e.starts_with("file-type")));
        assert!(read(&[(MANIFEST, MANIFEST_JSON.as_bytes()), ("index.html", b"x"), ("INDEX.html", b"x")]).is_err_and(|e| e.starts_with("duplicate")));
        assert!(read(&[(MANIFEST, MANIFEST_JSON.as_bytes()), ("index.html", b"x"), ("a", b"x"), ("a/b.js", b"x")]).is_err_and(|e| e.starts_with("duplicate")));
        assert_eq!(read(&[("index.html", b"x")]).err().as_deref(), Some("no-manifest"));
        assert_eq!(read(&[(MANIFEST, MANIFEST_JSON.as_bytes())]).err().as_deref(), Some("no-entry"));
        assert_eq!(read_zip(Cursor::new(b"not a zip".to_vec())).err().as_deref(), Some("zip"));
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("notnotch-plugin-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn folder_round_trip() {
        let src = scratch("src");
        fs::write(src.join(MANIFEST), MANIFEST_JSON).unwrap();
        fs::write(src.join("index.html"), "<p>hi").unwrap();
        fs::create_dir_all(src.join(".git")).unwrap();
        fs::write(src.join(".git").join("config"), "x").unwrap();
        fs::create_dir_all(src.join("img")).unwrap();
        fs::write(src.join("img").join("a.png"), [1, 2, 3]).unwrap();
        let b = from_dir(&src).unwrap();
        assert_eq!(b.files.len(), 3);
        let out = scratch("out").join("hello-notnotch");
        write(&b, &out).unwrap();
        assert_eq!(fs::read(out.join("img").join("a.png")).unwrap(), [1, 2, 3]);
        // Writing again over an existing folder is refused.
        assert!(write(&b, &out).is_err());
        fs::write(src.join("bad name.js"), "x").unwrap();
        assert!(from_dir(&src).is_err_and(|e| e.starts_with("path")));
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(out.parent().unwrap());
    }

    /// The sample in examples/plugins passes the same checks as any install.
    #[test]
    fn sample_plugin() {
        let b = from_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/plugins/hello-notnotch")).unwrap();
        assert_eq!((b.manifest.id.as_str(), b.manifest.permissions.network.as_slice()), ("hello-notnotch", &["api.github.com".to_string()][..]));
    }

    /// A junction (no rights needed to make one) inside the folder pointing out of it refuses the plugin.
    #[test]
    fn folder_junction_refused() {
        let src = scratch("junction");
        let outside = scratch("outside");
        fs::write(outside.join("secret.txt"), "x").unwrap();
        fs::write(src.join(MANIFEST), MANIFEST_JSON).unwrap();
        fs::write(src.join("index.html"), "x").unwrap();
        let link = src.join("assets");
        let made = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"]).arg(&link).arg(&outside).output().is_ok_and(|o| o.status.success());
        if made {
            assert!(from_dir(&src).is_err_and(|e| e.starts_with("symlink")), "junction followed");
            assert!(from_dir(&link).is_err_and(|e| e == "symlink"), "a junction as the folder itself");
        }
        let _ = fs::remove_dir(&link);
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&outside);
    }
}
