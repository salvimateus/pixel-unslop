#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, State, WebviewWindow};
use tauri_plugin_fs::FsExt;
use tauri_plugin_window_state::StateFlags;

/// The image and video types that the UI opens; the same lists as `isImageFile` and `isVideoFile`.
const OPEN_EXTENSIONS: [&str; 8] = ["png", "jpg", "jpeg", "webp", "mp4", "m4v", "mov", "webm"];
const WINDOWS_MAX_PATH: usize = 260;
const MAIN_WINDOW: &str = "main";
/// Tells the UI that a later launch gave a file: the UI then takes it with `launch_file`.
const LAUNCH_EVENT: &str = "launch-file";

/// The file given to the exe ("Open with", a drop on the icon) that the UI did not take yet, in the form that the
/// UI passes back to the fs plugin.
struct LaunchFile(Mutex<Option<String>>);

/// Gives the waiting launch file once: a second call returns `None` until another launch gives a file.
#[tauri::command]
fn launch_file(launch: State<'_, LaunchFile>) -> Option<String> {
    launch.0.lock().unwrap_or_else(PoisonError::into_inner).take()
}

fn has_open_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            OPEN_EXTENSIONS
                .iter()
                .any(|accepted| extension.eq_ignore_ascii_case(accepted))
        })
}

/// The canonical path of the first argument that names an existing file, relative to `cwd`. Flags are skipped.
fn resolve_launch_file(arguments: impl IntoIterator<Item = OsString>, cwd: &Path) -> Option<PathBuf> {
    arguments
        .into_iter()
        .filter(|argument| !argument.to_string_lossy().starts_with('-'))
        .find_map(|argument| {
            let canonical = std::fs::canonicalize(cwd.join(argument)).ok()?;
            canonical.is_file().then_some(canonical)
        })
}

/// Makes the file the waiting launch file. Only a type that the UI opens enters the fs scope; the UI rejects any
/// other type by its name, as it rejects a drop, and never reads it.
fn accept_launch_file(app: &AppHandle, path: &Path) -> tauri::Result<bool> {
    let Some(plain) = to_plain_path(path) else {
        return Ok(false);
    };
    if has_open_extension(path) {
        app.fs_scope().allow_file(path)?;
    }
    *app.state::<LaunchFile>().0.lock().unwrap_or_else(PoisonError::into_inner) = Some(plain);
    Ok(true)
}

/// A later launch: the running window takes its file and comes to the front, so only one window ever exists.
fn on_second_launch(app: &AppHandle, arguments: Vec<String>, cwd: String) {
    let file = resolve_launch_file(arguments.into_iter().skip(1).map(OsString::from), Path::new(&cwd));
    if let Some(path) = file {
        if matches!(accept_launch_file(app, &path), Ok(true)) {
            let _ = app.emit_to(MAIN_WINDOW, LAUNCH_EVENT, ());
        }
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
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

/// Keeps the window inside the work area of its monitor. A window larger than the work area shrinks to it and is
/// centered; a window that only sticks out moves back inside. The side and bottom borders may overhang by the
/// border thickness, because on Windows the outer rectangle includes invisible resize borders.
fn fit_to_work_area(window: &WebviewWindow, area: &PhysicalRect<i32, u32>) -> tauri::Result<()> {
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    let frame_width = outer.width.saturating_sub(inner.width);
    let frame_height = outer.height.saturating_sub(inner.height);
    let border = frame_width / 2;
    let room_width = area.size.width + 2 * border;
    let room_height = area.size.height + border;

    let too_large = outer.width > room_width || outer.height > room_height;
    let (outer_width, outer_height) = if too_large {
        let width = outer.width.min(room_width);
        let height = outer.height.min(room_height);
        window.set_size(PhysicalSize::new(width.saturating_sub(frame_width), height.saturating_sub(frame_height)))?;
        (width, height)
    } else {
        (outer.width, outer.height)
    };

    let left = area.position.x - border as i32;
    let top = area.position.y;
    let free_x = room_width.saturating_sub(outer_width) as i32;
    let free_y = room_height.saturating_sub(outer_height) as i32;
    let current = window.outer_position()?;
    let target = if too_large {
        PhysicalPosition::new(left + free_x / 2, top + free_y / 2)
    } else {
        PhysicalPosition::new(current.x.clamp(left, left + free_x), current.y.clamp(top, top + free_y))
    };
    if target != current {
        window.set_position(target)?;
    }
    Ok(())
}

fn fit_to_screen(window: &WebviewWindow) -> tauri::Result<()> {
    if window.is_maximized()? || window.is_fullscreen()? {
        return Ok(());
    }
    let monitor = match window.current_monitor()? {
        Some(monitor) => Some(monitor),
        None => window.primary_monitor()?,
    };
    match monitor {
        Some(monitor) => fit_to_work_area(window, monitor.work_area()),
        None => Ok(()),
    }
}

/// The main window starts hidden: the window-state plugin restores its size, position and maximized state when it
/// is created, then this fits it to the screen and shows it, so it never jumps after it appears. A failed fit still
/// shows the window, as restored.
fn show_main_window(window: &WebviewWindow) -> tauri::Result<()> {
    let _ = fit_to_screen(window);
    window.show()?;
    window.set_focus()
}

fn main() {
    tauri::Builder::default()
        // The first plugin, as the plugin requires: a second launch hands over its file and exits before the others start.
        .plugin(tauri_plugin_single_instance::init(on_second_launch))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .manage(LaunchFile(Mutex::new(None)))
        .setup(|app| {
            let cwd = std::env::current_dir().unwrap_or_default();
            // A launch file that fails here leaves the app on the drop screen, never without a window.
            if let Some(path) = resolve_launch_file(std::env::args_os().skip(1), &cwd) {
                let _ = accept_launch_file(app.handle(), &path);
            }
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                show_main_window(&window)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![launch_file])
        .run(tauri::generate_context!())
        .expect("Pixel Unslop failed to start");
}
