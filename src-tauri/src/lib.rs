// Everything about the world runs in the webview; the Rust side only provides
// the native window, the file dialogs, the worlds folder, and reading, writing
// and copying files. Files go through the commands below rather than the fs
// plugin's own, whose scope would refuse a world passed on the command line:
// the app is a document editor, and may open whatever the user points it at.
// The fs plugin is still used from here to open what the Android pickers hand
// back, which are content URIs rather than paths. The Android pieces are
// PlastikCAD's (its `src-tauri/src/lib.rs` and `plugins/device`), lifted whole.
use std::borrow::Cow;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
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

/// A path or, from the Android pickers, a `content://` URI.
fn file_path(path: &str) -> FilePath {
    let Ok(parsed) = FilePath::from_str(path);
    parsed
}

#[tauri::command]
async fn read_file(app: AppHandle, path: String) -> Result<Response, String> {
    let read = app.fs().read(file_path(&path));
    #[cfg(target_os = "android")]
    let read = read.or_else(|err| {
        // A file of the app's own in the shared storage that the path would not open is reached through the media store.
        match if path.contains("://") { None } else { tauri_plugin_device::find_document(&app, &path) } {
            Some(uri) => app.fs().read(file_path(&uri)),
            None => Err(err),
        }
    });
    read.map(Response::new).map_err(|err| format!("Could not read {path}: {err}"))
}

/// Where a file really is: a path names itself; the `content://` URIs the
/// Android pickers hand out do not (a download is `msf:123`), but the
/// descriptor the provider opens usually points at the real file. Null where
/// it cannot be told.
#[tauri::command]
fn real_path(app: AppHandle, path: String) -> Option<String> {
    let parsed = file_path(&path);
    if let Ok(path) = parsed.clone().into_path() {
        return Some(path.to_string_lossy().into_owned());
    }
    #[cfg(target_os = "android")]
    {
        use std::os::fd::AsRawFd;
        let mut options = OpenOptions::new();
        options.read(true);
        let file = app.fs().open(parsed, options).ok()?;
        let target = fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()?;
        let target = target.to_string_lossy().into_owned();
        // The descriptor points into the system's own mount of the shared storage (`/mnt/user/0/emulated/0/…`),
        // which apps may not open; the same file is at `/storage/emulated/0/…`.
        return Some(match target.find("/emulated/") {
            Some(at) if !target.starts_with("/storage/") => format!("/storage{}", &target[at..]),
            _ => target,
        });
    }
    #[allow(unreachable_code)]
    {
        let _ = app;
        None
    }
}

/// The name of a file, extension included, or null if it has none.
#[tauri::command]
fn file_name(app: AppHandle, path: String) -> Option<String> {
    let real = real_path(app, path)?;
    Path::new(&real).file_name().map(|name| name.to_string_lossy().into_owned()).filter(|name| name.contains('.'))
}

/// A temporary file of the app's own holding `bytes`, for the device plugin to move into place.
#[cfg(target_os = "android")]
fn stage_bytes(app: &AppHandle, bytes: &[u8]) -> io::Result<PathBuf> {
    let dir = app.path().app_cache_dir().map_err(io::Error::other)?;
    fs::create_dir_all(&dir)?;
    let stamp = UNIX_EPOCH.elapsed().map(|d| d.as_nanos()).unwrap_or(0);
    let source = dir.join(format!("document-{stamp}.tmp"));
    fs::write(&source, bytes)?;
    Ok(source)
}

/// Android: writes an export into the app's folder in Downloads. The bytes are
/// the request body; `folder`, `name` and `mime` travel in headers, percent-encoded.
#[tauri::command]
async fn save_export(app: AppHandle, request: Request<'_>) -> Result<tauri_plugin_device::Exported, String> {
    let header = |key: &str| request.headers().get(key).and_then(|value| percent_decode(value.as_bytes()));
    let (folder, name, mime) = (header("folder").unwrap_or_default(), header("name"), header("mime"));
    let (Some(name), Some(mime)) = (name, mime) else {
        return Err("Could not write the export: no name was given".into());
    };
    let bytes = body_bytes(request.body()).ok_or("Could not write the export: the data was not understood")?;
    #[cfg(target_os = "android")]
    {
        let source = stage_bytes(&app, &bytes).map_err(|err| format!("Could not write {name}: {err}"))?;
        return tauri_plugin_device::export_to_downloads(&app, &folder, &name, &mime, &source).map_err(|err| format!("Could not write {name}: {err}"));
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, folder, name, mime, bytes);
        Err("Exports go to Downloads only on Android".into())
    }
}

/// Writes the request body into `share/<name>` under the app's cache folder,
/// for the device plugin to hand to other apps, and returns its path. The
/// name travels in a header, percent-encoded. Earlier staged files go.
#[tauri::command]
async fn stage_share(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let name = request
        .headers()
        .get("name")
        .and_then(|value| percent_decode(value.as_bytes()))
        .filter(|name| !name.is_empty() && !name.contains(['/', '\\']))
        .ok_or("Could not prepare the file to share: no valid name was given")?;
    let bytes = body_bytes(request.body()).ok_or_else(|| format!("Could not prepare {name}: the data was not bytes"))?;
    let dir = app.path().app_cache_dir().map_err(|err| format!("Could not prepare {name}: {err}"))?.join("share");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|err| format!("Could not prepare {name}: {err}"))?;
    let path = dir.join(&name);
    fs::write(&path, &bytes).map_err(|err| format!("Could not prepare {name}: {err}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn write_bytes(app: &AppHandle, path: &str, bytes: &[u8]) -> io::Result<()> {
    let parsed = file_path(path);
    match parsed.clone().into_path() {
        Ok(path) => write_atomic(&path, bytes),
        Err(_) => write_document(app, path, bytes),
    }
}

/// A document picked on Android: the bytes go to a file of the app's own
/// first, and the plugin copies them in through the document's provider, so
/// the provider learns the new size (through a raw descriptor it would not,
/// and the Files app would show the export as 0 B).
#[cfg(target_os = "android")]
fn write_document(app: &AppHandle, uri: &str, bytes: &[u8]) -> io::Result<()> {
    let source = stage_bytes(app, bytes)?;
    tauri_plugin_device::write_document(app, uri, &source).map_err(io::Error::other)
}

#[cfg(not(target_os = "android"))]
fn write_document(app: &AppHandle, uri: &str, bytes: &[u8]) -> io::Result<()> {
    // Elsewhere a URL names a file; written through the descriptor the fs plugin opens.
    let mut options = OpenOptions::new();
    options.read(false).write(true).truncate(true).create(true);
    let mut file = app.fs().open(file_path(uri), options)?;
    file.write_all(bytes)?;
    file.sync_all()
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
async fn write_file(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("path")
        .and_then(|value| percent_decode(value.as_bytes()))
        .ok_or("Could not write the file: no valid path was given")?;
    let bytes = body_bytes(request.body()).ok_or_else(|| format!("Could not write {path}: the data was not bytes"))?;
    write_bytes(&app, &path, &bytes).map_err(|err| format!("Could not write {path}: {err}"))
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

/// The first `limit` bytes of a file: a world's header, for the worlds browser,
/// without reading the assets behind it.
#[tauri::command]
async fn read_head(path: String, limit: u64) -> Result<Response, String> {
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .and_then(|file| file.take(limit).read_to_end(&mut bytes))
        .map(|_| Response::new(bytes))
        .map_err(|err| format!("Could not read {path}: {err}"))
}

/// Moves a file, within a folder or to another one, never over an existing file.
fn move_path(from: &Path, to: &Path) -> io::Result<()> {
    if to.exists() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "a file of that name already exists"));
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    // Another file system: copy, then remove the original once the copy is whole.
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(from, to)?;
    fs::remove_file(from)
}

#[tauri::command]
async fn move_file(from: String, to: String) -> Result<(), String> {
    move_path(Path::new(&from), Path::new(&to)).map_err(|err| format!("Could not move {from} to {to}: {err}"))
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
    // On Android worlds stay in the app's own storage, as PlastikCAD's projects do: there is no folder to pick.
    #[cfg(mobile)]
    let (dir, fixed) = (paths.app_data_dir().map(|dir| dir.join("worlds")), true);
    #[cfg(not(mobile))]
    let (dir, fixed) = (
        paths
            .document_dir()
            .map(|dir| dir.join("PlastikCAD Worlds"))
            .or_else(|_| paths.app_data_dir().map(|dir| dir.join("worlds"))),
        false,
    );
    dir.map_err(|err| format!("Could not find a place for worlds: {err}"))
        .and_then(|dir| dir.into_os_string().into_string().map_err(|_| "The worlds folder has an unreadable name".to_owned()))
        .map(|path| WorldsHome { path, fixed })
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

/// `~` and `~/` at the front of a path mean the home folder, as a shell would read them.
fn expand_home(path: &str) -> PathBuf {
    if path == "~" || path.starts_with("~/") || path.starts_with("~\\") {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return PathBuf::from(home).join(&path[2.min(path.len())..]);
        }
    }
    PathBuf::from(path)
}

/// Where a program is: a path (checked as given, `~` expanded), or a name
/// searched along `path_var` the way a shell searches the PATH, with `.exe`
/// tried as well on Windows.
fn find_in(program: &str, path_var: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let program = program.trim();
    if program.is_empty() {
        return None;
    }
    let candidates = |dir: &Path| -> Vec<PathBuf> {
        let plain = dir.join(program);
        if cfg!(windows) {
            vec![plain.clone(), dir.join(format!("{program}.exe"))]
        } else {
            vec![plain]
        }
    };
    let is_file = |p: &PathBuf| p.is_file();
    if program.contains('/') || program.contains('\\') || program.starts_with('~') {
        let path = expand_home(program);
        return if path.is_file() { Some(path) } else { None };
    }
    let path_var = path_var?;
    std::env::split_paths(path_var).flat_map(|dir| candidates(&dir)).find(is_file)
}

/// Where a program is, for the export panel to say whether an engine can be started.
#[tauri::command]
fn find_program(program: String) -> Option<String> {
    find_in(&program, std::env::var_os("PATH").as_deref()).map(|p| p.to_string_lossy().into_owned())
}

/// Starts a program in a folder and leaves it running on its own (its own
/// process group, so closing the app does not take it down), with its output
/// in launch.log in that folder, where a failure to start an engine can be read.
#[tauri::command]
fn launch_program(program: String, args: Vec<String>, cwd: String) -> Result<u32, String> {
    let resolved = find_in(&program, std::env::var_os("PATH").as_deref()).ok_or_else(|| format!("{program} was not found on the PATH"))?;
    let log = fs::File::create(Path::new(&cwd).join("launch.log")).map_err(|err| format!("Could not write launch.log in {cwd}: {err}"))?;
    let err_log = log.try_clone().map_err(|err| err.to_string())?;
    let mut command = std::process::Command::new(&resolved);
    command.args(&args).current_dir(&cwd).stdin(std::process::Stdio::null()).stdout(log).stderr(err_log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let child = command.spawn().map_err(|err| format!("Could not start {}: {err}", resolved.display()))?;
    Ok(child.id())
}

// --- signing in to a cloud account (PlastikCAD's, lifted) ---------------------
//
// OAuth for an installed app: the sign-in page opens in the system browser and
// sends the browser back to a loopback address the app listens on for a
// moment. The webview does the rest (token exchange, PKCE) over HTTPS.

/// Sign-ins waiting for the browser to come back, by port.
#[derive(Default)]
struct SignIns(Mutex<HashMap<u16, (TcpListener, Arc<AtomicBool>)>>);

/// How long the browser is given before the sign-in is abandoned.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

/// Listens on a free loopback port and returns it, for the redirect address.
#[tauri::command]
fn oauth_start(app: AppHandle) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|err| format!("Could not listen for the sign-in: {err}"))?;
    listener.set_nonblocking(true).map_err(|err| err.to_string())?;
    let port = listener.local_addr().map_err(|err| err.to_string())?.port();
    app.state::<SignIns>().0.lock().unwrap().insert(port, (listener, Arc::new(AtomicBool::new(false))));
    Ok(port)
}

/// Opens the sign-in page and waits for the browser to be sent back to the port; returns that request's query string.
#[tauri::command]
async fn oauth_wait(app: AppHandle, port: u16, url: String) -> Result<String, String> {
    let (listener, cancelled) = app
        .state::<SignIns>()
        .0
        .lock()
        .unwrap()
        .remove(&port)
        .ok_or("No sign-in is waiting on that port")?;
    // Cancel can still reach it while it waits.
    app.state::<SignIns>().0.lock().unwrap().insert(port, (listener.try_clone().map_err(|err| err.to_string())?, cancelled.clone()));
    app.opener().open_url(&url, None::<&str>).map_err(|err| format!("Could not open the browser: {err}"))?;
    let result = tauri::async_runtime::spawn_blocking(move || wait_for_redirect(&listener, &cancelled, SIGN_IN_TIMEOUT))
        .await
        .map_err(|err| err.to_string())?;
    app.state::<SignIns>().0.lock().unwrap().remove(&port);
    result.map_err(|err| err.to_string())
}

/// Gives up a sign-in that is waiting.
#[tauri::command]
fn oauth_cancel(app: AppHandle, port: u16) {
    if let Some((_, cancelled)) = app.state::<SignIns>().0.lock().unwrap().get(&port) {
        cancelled.store(true, Ordering::Relaxed);
    }
}

/// Accepts connections until one is the browser coming back with a query (a `code` or an `error`), the cancel flag is set, or the time is up.
fn wait_for_redirect(listener: &TcpListener, cancelled: &AtomicBool, timeout: Duration) -> io::Result<String> {
    let deadline = Instant::now() + timeout;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(query) = answer_browser(stream)? {
                    return Ok(query);
                }
            }
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(io::Error::new(io::ErrorKind::Interrupted, "The sign-in was cancelled"));
                }
                if Instant::now() >= deadline {
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "The sign-in took too long. Try again."));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(err) => return Err(err),
        }
    }
}

/// Reads one request; answers with a page to close when it carries the sign-in's query, 404 otherwise (a favicon request, say).
fn answer_browser(mut stream: TcpStream) -> io::Result<Option<String>> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_nonblocking(false)?;
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buffer.windows(4).any(|w| w == b"\r\n\r\n") && buffer.len() < 16 * 1024 {
        let n = match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(err) if err.kind() == io::ErrorKind::WouldBlock || err.kind() == io::ErrorKind::TimedOut => break,
            Err(err) => return Err(err),
        };
        buffer.extend_from_slice(&chunk[..n]);
    }
    let request = String::from_utf8_lossy(&buffer);
    let target = request.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("");
    let query = target.split_once('?').map(|(_, q)| q.to_owned());
    let ours = query.as_deref().is_some_and(|q| q.split('&').any(|p| p.starts_with("code=") || p.starts_with("error=")));
    let (status, body) = if ours {
        ("200 OK", "<!doctype html><meta charset=utf-8><title>PlastikWorld</title><body style=\"font-family:sans-serif;padding:2em\"><h2>Signed in</h2><p>You can close this page and go back to PlastikWorld.</p>")
    } else {
        ("404 Not Found", "")
    };
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.flush();
    Ok(if ours { query } else { None })
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
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_device::init())
        .manage(SignIns::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            file_name,
            real_path,
            save_export,
            stage_share,
            write_file,
            list_worlds,
            read_head,
            move_file,
            read_tree,
            copy_tree,
            remove_file,
            default_worlds_dir,
            open_path,
            open_url,
            find_program,
            launch_program,
            oauth_start,
            oauth_wait,
            oauth_cancel,
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
    fn the_sign_in_comes_back_through_the_loopback_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        // A favicon request first, which is answered 404 and ignored, then the browser coming back with the code.
        let browser = std::thread::spawn(move || {
            let mut answers = Vec::new();
            for target in ["/favicon.ico", "/?state=st&code=abc"] {
                let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
                write!(stream, "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
                let mut answer = String::new();
                stream.read_to_string(&mut answer).unwrap();
                answers.push(answer);
            }
            answers
        });
        let query = wait_for_redirect(&listener, &AtomicBool::new(false), Duration::from_secs(5)).unwrap();
        assert_eq!(query, "state=st&code=abc");
        let answers = browser.join().unwrap();
        assert!(answers[0].starts_with("HTTP/1.1 404"));
        assert!(answers[1].starts_with("HTTP/1.1 200") && answers[1].contains("Signed in"));
        // Cancelled while waiting.
        let cancelled = AtomicBool::new(true);
        let err = wait_for_redirect(&listener, &cancelled, Duration::from_secs(5)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::Interrupted);
    }

    #[test]
    fn startup_file_is_the_world_among_the_arguments() {
        let args = ["--flag", "scene.plastikworld", "other.txt"].into_iter().map(OsString::from);
        assert_eq!(startup_file_from(args), Some("scene.plastikworld".to_owned()));
        assert_eq!(startup_file_from(["notes.txt"].into_iter().map(OsString::from)), None);
    }

    #[test]
    fn programs_are_found_on_the_path_or_by_their_own_path() {
        let dir = TempDir::new();
        fs::create_dir_all(dir.path("bin")).unwrap();
        fs::write(dir.path("bin/gz"), b"#!/bin/sh\n").unwrap();
        let path_var = std::env::join_paths([dir.path("nowhere"), dir.path("bin")]).unwrap();
        assert_eq!(find_in("gz", Some(path_var.as_os_str())), Some(dir.path("bin/gz")));
        assert_eq!(find_in("ros2", Some(path_var.as_os_str())), None);
        assert_eq!(find_in("", Some(path_var.as_os_str())), None);
        assert_eq!(find_in("gz", None), None);
        // A path is taken as it is, not searched for.
        let own = dir.path("bin/gz").to_string_lossy().into_owned();
        assert_eq!(find_in(&own, None), Some(dir.path("bin/gz")));
        assert_eq!(find_in(&dir.path("bin/missing").to_string_lossy(), None), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_launched_program_runs_in_its_folder_with_its_output_in_the_log() {
        let dir = TempDir::new();
        let cwd = dir.0.to_string_lossy().into_owned();
        let pid = launch_program("sh".into(), vec!["-c".into(), "pwd; echo started >&2".into()], cwd.clone()).unwrap();
        assert!(pid > 0);
        // The process runs on its own; give it a moment and read what it wrote.
        let mut log = String::new();
        for _ in 0..50 {
            std::thread::sleep(std::time::Duration::from_millis(20));
            log = fs::read_to_string(dir.path("launch.log")).unwrap_or_default();
            if log.contains("started") {
                break;
            }
        }
        assert!(log.contains(&fs::canonicalize(&dir.0).unwrap().to_string_lossy().into_owned()), "{log}");
        assert!(log.contains("started"), "{log}");
        assert!(launch_program("no-such-program-here".into(), vec![], cwd).unwrap_err().contains("not found on the PATH"));
    }

    #[test]
    fn a_tilde_means_home() {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap();
        assert_eq!(expand_home("~/isaacsim-env/bin/python"), home.join("isaacsim-env/bin/python"));
        assert_eq!(expand_home("/usr/bin/python3"), PathBuf::from("/usr/bin/python3"));
    }

    #[test]
    fn percent_decoding_restores_paths() {
        assert_eq!(percent_decode(b"/home/a%20b/w.plastikworld"), Some("/home/a b/w.plastikworld".to_owned()));
        assert_eq!(percent_decode(b"%zz"), None);
    }
}
