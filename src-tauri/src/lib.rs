// Everything about the world runs in the webview; the Rust side only provides
// the native window, the file dialogs, the worlds folder, and reading, writing
// and copying files. Files go through the commands below rather than the fs
// plugin's own, whose scope would refuse a world passed on the command line:
// the app is a document editor, and may open whatever the user points it at.
use std::borrow::Cow;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

const WORLD_EXTENSION: &str = "plastikworld";

/// WebKitGTK's DMA-BUF renderer crashes ("Error 71 (Protocol error) dispatching
/// to Wayland display") or shows a blank window with the proprietary NVIDIA
/// driver. Fall back to the compatible renderer there unless the user has
/// made their own choice.
#[cfg(target_os = "linux")]
fn apply_webkit_workarounds() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    let nvidia = Path::new("/proc/driver/nvidia/version").exists();
    if nvidia && std::env::var_os(VAR).is_none() {
        // Runs first thing in main, before any other thread exists.
        std::env::set_var(VAR, "1");
    }
}

/// Header values must be ASCII, so the webview percent-encodes the path.
fn percent_decode(input: &[u8]) -> Option<String> {
    let hex = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let mut out = Vec::with_capacity(input.len());
    let mut rest = input.iter().copied();
    while let Some(byte) = rest.next() {
        if byte == b'%' {
            out.push(hex(rest.next()?)? << 4 | hex(rest.next()?)?);
        } else {
            out.push(byte);
        }
    }
    String::from_utf8(out).ok()
}

/// Tells apart the temporary files of writes running at the same time in this
/// process, which the process id alone cannot.
static WRITE_SERIAL: AtomicU64 = AtomicU64::new(0);

/// A temporary sibling of `target` that no other write, in this process or
/// another, is using.
fn temp_sibling(target: &Path) -> io::Result<PathBuf> {
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a file path"))?;
    let serial = WRITE_SERIAL.fetch_add(1, Ordering::Relaxed);
    let mut tmp_name = OsString::from(".");
    tmp_name.push(name);
    tmp_name.push(format!(".{}.{}.tmp", std::process::id(), serial));
    Ok(target.with_file_name(tmp_name))
}

/// Write to a temporary sibling, then rename it over the target, so a crash
/// can never leave a half-written world behind.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    // The folder is made on the way if need be (an export that goes into a folder of its own).
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    // Replace the file a symlink points at, not the link itself.
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let tmp = temp_sibling(&target)?;

    // `create_new` refuses to reuse a file another write is still filling.
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    let result = (|| {
        file.write_all(bytes)?;
        // The data must be on disk before the rename makes it the only copy.
        file.sync_all()?;
        if let Ok(existing) = fs::metadata(&target) {
            fs::set_permissions(&tmp, existing.permissions())?;
        }
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    fs::read(&path).map(Response::new).map_err(|err| format!("Could not read {path}: {err}"))
}

/// The bytes of a request body: raw, or, where the webview cannot post a
/// binary body and Tauri falls back to a JSON array of numbers, those.
fn body_bytes(body: &InvokeBody) -> Option<Cow<'_, [u8]>> {
    match body {
        InvokeBody::Raw(bytes) => Some(Cow::Borrowed(bytes)),
        InvokeBody::Json(value) => value
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .map(|item| item.as_u64().and_then(|n| u8::try_from(n).ok()))
                    .collect::<Option<Vec<u8>>>()
            })
            .map(Cow::Owned),
    }
}

/// The file's bytes are the request body and its path is in the `path` header,
/// which spares a multi-megabyte mesh a round trip through JSON.
#[tauri::command]
async fn write_file(request: Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("path")
        .and_then(|value| percent_decode(value.as_bytes()))
        .ok_or("Could not write the file: no valid path was given")?;
    let bytes = body_bytes(request.body()).ok_or_else(|| format!("Could not write {path}: the data was not bytes"))?;
    write_atomic(Path::new(&path), &bytes).map_err(|err| format!("Could not write {path}: {err}"))
}

/// A world in the worlds folder, as the browser lists it.
#[derive(Serialize, Debug, PartialEq)]
struct WorldEntry {
    name: String,
    path: String,
    size: u64,
    /// Milliseconds since the epoch; 0 where the file system keeps no time.
    modified: f64,
}

fn is_world_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(WORLD_EXTENSION))
}

/// The worlds directly inside `dir`, which is created if it does not exist.
/// Hidden files (the temporaries of writes under way among them) are left out.
fn worlds_in(dir: &Path) -> io::Result<Vec<WorldEntry>> {
    fs::create_dir_all(dir)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !is_world_path(&path) {
            continue;
        }
        let Ok(meta) = fs::metadata(&path) else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0.0, |since| since.as_millis() as f64);
        out.push(WorldEntry { name, path: path.to_string_lossy().into_owned(), size: meta.len(), modified });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
async fn list_worlds(dir: String) -> Result<Vec<WorldEntry>, String> {
    worlds_in(Path::new(&dir)).map_err(|err| format!("Could not read the worlds folder {dir}: {err}"))
}

/// Every file under `dir`, as paths relative to it with `/` separators, hidden
/// files and folders left out. The files of a robot package.
fn tree_of(dir: &Path) -> io::Result<Vec<String>> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let path = entry.path();
            let meta = fs::metadata(&path)?;
            if meta.is_dir() {
                walk(root, &path, out)?;
            } else if meta.is_file() {
                let rel = path.strip_prefix(root).unwrap_or(&path);
                out.push(rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out)?;
    out.sort();
    Ok(out)
}

#[tauri::command]
async fn read_tree(dir: String) -> Result<Vec<String>, String> {
    tree_of(Path::new(&dir)).map_err(|err| format!("Could not read the folder {dir}: {err}"))
}

/// Copies a folder and everything in it into `to` (made on the way), replacing
/// files already there. For the robot packages an export bundle carries.
fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let path = entry.path();
        let target = to.join(entry.file_name());
        let meta = fs::metadata(&path)?;
        if meta.is_dir() {
            copy_dir(&path, &target)?;
        } else if meta.is_file() {
            fs::copy(&path, &target)?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn copy_tree(from: String, to: String) -> Result<(), String> {
    copy_dir(Path::new(&from), Path::new(&to)).map_err(|err| format!("Could not copy {from} to {to}: {err}"))
}

#[tauri::command]
async fn remove_file(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|err| format!("Could not delete {path}: {err}"))
}

/// Where worlds live unless the user chose another folder.
#[derive(Serialize)]
struct WorldsHome {
    path: String,
    fixed: bool,
}

#[tauri::command]
fn default_worlds_dir(app: AppHandle) -> Result<WorldsHome, String> {
    let paths = app.path();
    let dir = paths
        .document_dir()
        .map(|dir| dir.join("PlastikCAD Worlds"))
        .or_else(|_| paths.app_data_dir().map(|dir| dir.join("worlds")));
    dir.map_err(|err| format!("Could not find a place for worlds: {err}"))
        .and_then(|dir| dir.into_os_string().into_string().map_err(|_| "The worlds folder has an unreadable name".to_owned()))
        .map(|path| WorldsHome { path, fixed: false })
}

/// Shows a file or folder in the system's file manager, or opens a link in the browser.
#[tauri::command]
fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().open_path(&path, None::<&str>).map_err(|err| format!("Could not open {path}: {err}"))
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener().open_url(&url, None::<&str>).map_err(|err| format!("Could not open {url}: {err}"))
}

/// The first argument that names a world, if any: the operating system passes
/// the path when a `.plastikworld` file is double-clicked.
fn startup_file_from(args: impl Iterator<Item = OsString>) -> Option<String> {
    args.map(PathBuf::from)
        .find(|path| is_world_path(path))
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn startup_file() -> Option<String> {
    startup_file_from(std::env::args_os().skip(1))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    apply_webkit_workarounds();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            list_worlds,
            read_tree,
            copy_tree,
            remove_file,
            default_worlds_dir,
            open_path,
            open_url,
            startup_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    static DIRS: AtomicUsize = AtomicUsize::new(0);

    /// A fresh directory per test, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let n = DIRS.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("plastikworld-test-{}-{n}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temporaries() {
        let dir = TempDir::new();
        let target = dir.path("a.plastikworld");
        write_atomic(&target, b"one").unwrap();
        write_atomic(&target, b"two").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"two");
        let names: Vec<_> = fs::read_dir(&dir.0).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(names, vec!["a.plastikworld"]);
    }

    #[test]
    fn lists_worlds_and_not_the_rest() {
        let dir = TempDir::new();
        fs::write(dir.path("b.plastikworld"), b"{}").unwrap();
        fs::write(dir.path("a.plastikworld"), b"{}").unwrap();
        fs::write(dir.path("notes.txt"), b"").unwrap();
        fs::write(dir.path(".a.plastikworld.1.2.tmp"), b"").unwrap();
        let names: Vec<_> = worlds_in(&dir.0).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["a.plastikworld", "b.plastikworld"]);
    }

    #[test]
    fn tree_and_copy_walk_folders() {
        let dir = TempDir::new();
        fs::create_dir_all(dir.path("pkg/meshes/visual")).unwrap();
        fs::write(dir.path("pkg/package.xml"), b"<package/>").unwrap();
        fs::write(dir.path("pkg/meshes/visual/Body.obj"), b"o Body").unwrap();
        fs::write(dir.path("pkg/.hidden"), b"").unwrap();
        assert_eq!(tree_of(&dir.path("pkg")).unwrap(), vec!["meshes/visual/Body.obj", "package.xml"]);
        copy_dir(&dir.path("pkg"), &dir.path("out/models/pkg")).unwrap();
        assert_eq!(fs::read(dir.path("out/models/pkg/meshes/visual/Body.obj")).unwrap(), b"o Body");
    }

    #[test]
    fn startup_file_is_the_world_among_the_arguments() {
        let args = ["--flag", "scene.plastikworld", "other.txt"].into_iter().map(OsString::from);
        assert_eq!(startup_file_from(args), Some("scene.plastikworld".to_owned()));
        assert_eq!(startup_file_from(["notes.txt"].into_iter().map(OsString::from)), None);
    }

    #[test]
    fn percent_decoding_restores_paths() {
        assert_eq!(percent_decode(b"/home/a%20b/w.plastikworld"), Some("/home/a b/w.plastikworld".to_owned()));
        assert_eq!(percent_decode(b"%zz"), None);
    }
}
