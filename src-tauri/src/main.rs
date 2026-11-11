#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use tauri::{Manager, PhysicalPosition, PhysicalRect, PhysicalSize, State, WebviewWindow};
use tauri_plugin_fs::FsExt;
use tauri_plugin_window_state::StateFlags;

const IMAGE_EXTENSIONS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];
const WINDOWS_MAX_PATH: usize = 260;
const MAIN_WINDOW: &str = "main";

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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .setup(|app| {
            let launch_path = match resolve_launch_image(std::env::args_os().nth(1)) {
                Some(path) => {
                    app.fs_scope().allow_file(&path)?;
                    to_plain_path(&path)
                }
                None => None,
            };
            app.manage(LaunchFile(launch_path));
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                show_main_window(&window)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![launch_file])
        .run(tauri::generate_context!())
        .expect("Pixel Unslop failed to start");
}
