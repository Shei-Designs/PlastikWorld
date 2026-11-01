// `register_listener` and `remove_listener` are what the webview calls to
// subscribe to the plugin's events; on Android they are answered by the
// Kotlin side, and they need permissions like any other command.
const COMMANDS: &[&str] = &["state", "register_listener", "remove_listener", "pick_folder", "pick_documents", "opened_files", "delete_document", "create_document", "mime_for", "share", "authorize", "clear_token"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
