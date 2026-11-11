#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use tauri::{Manager, State};
use tauri_plugin_fs::FsExt;

const IMAGE_EXTENSIONS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];
const WINDOWS_MAX_PATH: usize = 260;

/// Image path given as the first program argument, in the form that the UI passes back to the fs plugin.
struct LaunchFile(Option<String>);

#[tauri::command]
fn launch_file(launch: State<'_, LaunchFile>) -> Option<String> {
    launch.0.clone()
}

fn has_image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            IMAGE_EXTENSIONS
                .iter()
                .any(|accepted| extension.eq_ignore_ascii_case(accepted))
        })
}

/// Returns the canonical path of the argument when it names an existing image file.
fn resolve_launch_image(argument: Option<OsString>) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(argument?).ok()?;
    (canonical.is_file() && has_image_extension(&canonical)).then_some(canonical)
}

/// Removes the Windows verbatim prefix (`\\?\`) that `canonicalize` adds, while the plain form stays a valid path.
fn to_plain_path(path: &Path) -> Option<String> {
    let text = path.to_str()?;
    let plain = if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{share}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(text).to_owned()
    };
    Some(if plain.len() < WINDOWS_MAX_PATH { plain } else { text.to_owned() })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let launch_path = match resolve_launch_image(std::env::args_os().nth(1)) {
                Some(path) => {
                    app.fs_scope().allow_file(&path)?;
                    to_plain_path(&path)
                }
                None => None,
            };
            app.manage(LaunchFile(launch_path));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![launch_file])
        .run(tauri::generate_context!())
        .expect("Pixel Unslop failed to start");
}
