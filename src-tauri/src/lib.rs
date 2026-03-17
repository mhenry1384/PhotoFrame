use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, Window, WindowEvent,
};

const SETTINGS_FILE_NAME: &str = "settings.json";
const WINDOW_STATE_FILE_NAME: &str = "window-state.json";
const DEFAULT_INTERVAL_SECONDS: u32 = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    directory_path: String,
    interval_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            directory_path: String::new(),
            interval_seconds: DEFAULT_INTERVAL_SECONDS,
        }
    }
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    let settings_path = app_file_path(&app, SETTINGS_FILE_NAME)?;

    if !settings_path.exists() {
        let defaults = AppSettings::default();
        write_json_file(&settings_path, &defaults)?;
        return Ok(defaults);
    }

    let settings: AppSettings = read_json_file(&settings_path)?;
    validate_settings(&settings)?;
    Ok(settings)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    validate_settings(&settings)?;

    let settings_path = app_file_path(&app, SETTINGS_FILE_NAME)?;
    write_json_file(&settings_path, &settings)?;

    Ok(settings)
}

#[tauri::command]
fn scan_images(directory_path: String) -> Result<Vec<String>, String> {
    let directory = PathBuf::from(directory_path.trim());

    if !directory.exists() {
        return Err("The configured directory does not exist.".into());
    }

    if !directory.is_dir() {
        return Err("The configured path is not a directory.".into());
    }

    let mut images = fs::read_dir(&directory)
        .map_err(|error| format!("Failed to read directory: {error}"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_supported_image(path))
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    images.sort_unstable();
    Ok(images)
}

fn validate_settings(settings: &AppSettings) -> Result<(), String> {
    if settings.interval_seconds == 0 {
        return Err("Interval must be at least 1 second.".into());
    }

    let directory_path = settings.directory_path.trim();
    if directory_path.is_empty() {
        return Ok(());
    }

    let directory = Path::new(directory_path);
    if !directory.exists() {
        return Err("The configured directory does not exist.".into());
    }

    if !directory.is_dir() {
        return Err("The configured path is not a directory.".into());
    }

    Ok(())
}

fn is_supported_image(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("jpg" | "jpeg" | "gif" | "png" | "webp")
    )
}

fn app_file_path(app: &AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Failed to resolve config directory: {error}"))?;

    fs::create_dir_all(&config_dir)
        .map_err(|error| format!("Failed to create config directory: {error}"))?;

    Ok(config_dir.join(file_name))
}

fn read_json_file<T>(path: &Path) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;

    serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))
}

fn write_json_file<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    let contents = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;

    fs::write(path, format!("{contents}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

fn restore_window_state(window: &Window) -> Result<(), String> {
    let state_path = app_file_path(&window.app_handle(), WINDOW_STATE_FILE_NAME)?;
    if !state_path.exists() {
        return Ok(());
    }

    let state: WindowState = read_json_file(&state_path)?;
    if state.width == 0 || state.height == 0 {
        return Ok(());
    }

    if !window_state_is_visible(window, &state)? {
        return Ok(());
    }

    window
        .set_size(Size::Physical(PhysicalSize::new(state.width, state.height)))
        .map_err(|error| format!("Failed to restore window size: {error}"))?;

    window
        .set_position(Position::Physical(PhysicalPosition::new(state.x, state.y)))
        .map_err(|error| format!("Failed to restore window position: {error}"))?;

    if state.maximized {
        window
            .maximize()
            .map_err(|error| format!("Failed to maximize window: {error}"))?;
    }

    Ok(())
}

fn window_state_is_visible(window: &Window, state: &WindowState) -> Result<bool, String> {
    let window_left = state.x;
    let window_top = state.y;
    let window_right = state.x + state.width as i32;
    let window_bottom = state.y + state.height as i32;

    let monitors = window
        .available_monitors()
        .map_err(|error| format!("Failed to query monitors: {error}"))?;

    Ok(monitors.iter().any(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        let monitor_left = position.x;
        let monitor_top = position.y;
        let monitor_right = position.x + size.width as i32;
        let monitor_bottom = position.y + size.height as i32;

        window_left < monitor_right
            && window_right > monitor_left
            && window_top < monitor_bottom
            && window_bottom > monitor_top
    }))
}

fn save_window_state(window: &Window) -> Result<(), String> {
    let size = window
        .outer_size()
        .map_err(|error| format!("Failed to read window size: {error}"))?;
    let position = window
        .outer_position()
        .map_err(|error| format!("Failed to read window position: {error}"))?;

    if size.width == 0 || size.height == 0 {
        return Ok(());
    }

    let state = WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
    };

    let state_path = app_file_path(&window.app_handle(), WINDOW_STATE_FILE_NAME)?;
    write_json_file(&state_path, &state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let host_window = window.as_ref().window();
                let _ = restore_window_state(&host_window);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::CloseRequested { .. }
            ) {
                let _ = save_window_state(window);
            }
        })
        .invoke_handler(tauri::generate_handler![load_settings, save_settings, scan_images])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
