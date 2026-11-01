//! What the app runs on. On Android the Kotlin side reports whether a hardware
//! keyboard is attached and whether the on-screen keypad is showing (and how
//! tall it is), sends a `change` event whenever either changes, and writes
//! the documents the system pickers hand out, and asks Google Play services
//! for the Drive authorization. Everywhere else there is a keyboard, no
//! keypad, and documents are plain files.
use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Runtime};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputState {
    pub hardware_keyboard: bool,
    pub keypad_visible: bool,
    /// Height of the keypad over the page, in CSS pixels.
    pub keypad_height: u32,
}

#[cfg(target_os = "android")]
struct Handle<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[tauri::command]
async fn state<R: Runtime>(app: AppHandle<R>) -> Result<InputState, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.state::<Handle<R>>()
            .0
            .run_mobile_plugin::<InputState>("state", ())
            .map_err(|err| err.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(InputState { hardware_keyboard: true, ..Default::default() })
    }
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteDocument<'a> {
    uri: &'a str,
    /// A file holding the bytes, which the Kotlin side copies in and then deletes.
    source: &'a str,
}

/// Android only: copies the file at `source` into the document at `uri`
/// through its provider, which then learns the document's new size. (Writing
/// through a raw descriptor leaves the Files app showing 0 B.) The source
/// file is deleted afterwards.
#[cfg(target_os = "android")]
pub fn write_document<R: Runtime>(app: &AppHandle<R>, uri: &str, source: &std::path::Path) -> Result<(), String> {
    use tauri::Manager;
    let source = source.to_string_lossy();
    app.state::<Handle<R>>()
        .0
        .run_mobile_plugin::<()>("writeDocument", WriteDocument { uri, source: &source })
        .map_err(|err| err.to_string())
}

/// An export written into the app's folder in Downloads: its content URI (for sharing) and its path as the Files app shows it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Exported {
    pub uri: String,
    pub path: String,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct ExportArgs<'a> {
    folder: &'a str,
    name: &'a str,
    mime: &'a str,
    source: &'a str,
}

/// Android only: moves the file at `source` into `Download/PlastikWorld/<folder>/<name>`
/// through the media store, replacing a file of that name. The source file is deleted afterwards.
#[cfg(target_os = "android")]
pub fn export_to_downloads<R: Runtime>(app: &AppHandle<R>, folder: &str, name: &str, mime: &str, source: &std::path::Path) -> Result<Exported, String> {
    use tauri::Manager;
    let source = source.to_string_lossy();
    app.state::<Handle<R>>()
        .0
        .run_mobile_plugin::<Exported>("exportToDownloads", ExportArgs { folder, name, mime, source: &source })
        .map_err(|err| err.to_string())
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct FindDocument<'a> {
    path: &'a str,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct Found {
    uri: Option<String>,
}

/// Android only: the content URI of a file of the app's own in the shared
/// storage (such as an export), given its path, for reading where the path
/// itself cannot be opened. None if the media store does not know it.
#[cfg(target_os = "android")]
pub fn find_document<R: Runtime>(app: &AppHandle<R>, path: &str) -> Option<String> {
    use tauri::Manager;
    app.state::<Handle<R>>()
        .0
        .run_mobile_plugin::<Found>("findDocument", FindDocument { path })
        .ok()?
        .uri
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("device")
        .invoke_handler(tauri::generate_handler![state])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = api.register_android_plugin("com.sheidesigns.plastikworld.device", "DevicePlugin")?;
                app.manage(Handle(handle));
            }
            let _ = (app, &api);
            Ok(())
        })
        .build()
}
