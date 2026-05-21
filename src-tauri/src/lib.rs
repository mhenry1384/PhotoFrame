use exif;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, Window, WindowEvent,
};

static WINDOW_SAVE_ENABLED: AtomicBool = AtomicBool::new(false);

const SETTINGS_FILE_NAME: &str = "settings.json";
const WINDOW_STATE_FILE_NAME: &str = "window-state.json";
const WINDOW_COVERAGE_EVENT_NAME: &str = "photoframe://window-coverage";
const DEFAULT_INTERVAL_SECONDS: u32 = 60;
const DEFAULT_FOREGROUND_NUDGE_INTERVAL_MINUTES: u32 = 1;

fn default_foreground_nudge_interval_minutes() -> u32 {
    DEFAULT_FOREGROUND_NUDGE_INTERVAL_MINUTES
}

fn default_foreground_nudge_enabled() -> bool {
    true
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    directory_path: String,
    interval_seconds: u32,
    #[serde(default = "default_foreground_nudge_enabled")]
    foreground_nudge_enabled: bool,
    #[serde(default = "default_foreground_nudge_interval_minutes")]
    foreground_nudge_interval_minutes: u32,
    #[serde(default)]
    image_maximized: bool,
    #[serde(default = "default_true")]
    show_path_on_photo: bool,
    #[serde(default = "default_true")]
    show_date_on_photo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WindowState {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    maximized: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowCoverageEvent {
    covered: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            directory_path: String::new(),
            interval_seconds: DEFAULT_INTERVAL_SECONDS,
            foreground_nudge_enabled: true,
            foreground_nudge_interval_minutes: DEFAULT_FOREGROUND_NUDGE_INTERVAL_MINUTES,
            image_maximized: false,
            show_path_on_photo: true,
            show_date_on_photo: true,
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
fn raise_window_without_focus(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is not available.".to_string())?;

    window
        .show()
        .map_err(|error| format!("Failed to show window: {error}"))?;

    window
        .set_always_on_top(true)
        .map_err(|error| format!("Failed to raise window: {error}"))?;

    let window_clone = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        let _ = window_clone.set_always_on_top(false);
    });

    Ok(())
}

#[tauri::command]
fn debug_log(message: String) {
    println!("[PhotoFrame] {message}");
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

    let mut images = Vec::new();
    let mut dirs = std::collections::VecDeque::new();
    dirs.push_back(directory);

    while let Some(dir) = dirs.pop_front() {
        let entries = fs::read_dir(&dir)
            .map_err(|error| format!("Failed to read directory: {error}"))?;

        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                dirs.push_back(path);
            } else if is_supported_image(&path) {
                images.push(path.to_string_lossy().to_string());
            }
        }
    }

    images.sort_unstable();
    Ok(images)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageExif {
    date: Option<String>,
    description: Option<String>,
}

fn format_exif_date(exif: &exif::Exif) -> Option<String> {
    let field = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)?;
    let dt = if let exif::Value::Ascii(ref vec) = field.value {
        vec.first().and_then(|b| exif::DateTime::from_ascii(b).ok())?
    } else {
        return None;
    };
    let months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ];
    let month = months.get(dt.month as usize - 1)?;
    Some(format!("{month} {}, {}", dt.day, dt.year))
}

fn read_exif_description(exif: &exif::Exif) -> Option<String> {
    let field = exif.get_field(exif::Tag::ImageDescription, exif::In::PRIMARY)?;
    if let exif::Value::Ascii(ref vec) = field.value {
        let desc = String::from_utf8_lossy(vec.first()?).trim().to_string();
        if !desc.is_empty() { return Some(desc); }
    }
    None
}

fn read_gif_comment(path: &Path) -> Option<String> {
    let data = fs::read(path).ok()?;
    if data.len() < 13 {
        return None;
    }
    if &data[0..6] != b"GIF89a" && &data[0..6] != b"GIF87a" {
        return None;
    }
    let packed = data[10];
    let gct_size = if packed & 0x80 != 0 { 3 * (1usize << ((packed & 0x07) as usize + 1)) } else { 0 };
    let mut pos = 13 + gct_size;

    while pos + 1 < data.len() {
        match data[pos] {
            0x3B => break, // trailer
            0x2C => break, // image descriptor — comments come before images; stop here
            0x21 => {
                let label = data[pos + 1];
                pos += 2;
                let is_comment = label == 0xFE;
                let mut block_data = Vec::new();
                while pos < data.len() {
                    let block_len = data[pos] as usize;
                    pos += 1;
                    if block_len == 0 { break; }
                    if pos + block_len > data.len() { break; }
                    if is_comment { block_data.extend_from_slice(&data[pos..pos + block_len]); }
                    pos += block_len;
                }
                if is_comment {
                    let s = String::from_utf8_lossy(&block_data).trim().to_string();
                    if !s.is_empty() { return Some(s); }
                }
            }
            _ => break,
        }
    }
    None
}

#[tauri::command]
fn get_image_exif(image_path: String) -> ImageExif {
    let mut result = ImageExif { date: None, description: None };

    let path = PathBuf::from(image_path.trim());
    let ext = match path.extension() {
        Some(e) => e.to_string_lossy().to_lowercase(),
        None => return result,
    };

    if ext == "gif" {
        result.description = read_gif_comment(&path);
        return result;
    }

    if ext == "jpg" || ext == "jpeg" || ext == "png" {
        let file = match fs::File::open(&path) {
            Ok(f) => f,
            Err(_) => return result,
        };
        let mut reader = std::io::BufReader::new(file);
        if let Ok(exif) = exif::Reader::new().read_from_container(&mut reader) {
            result.date = format_exif_date(&exif);
            result.description = read_exif_description(&exif);
        }
    }

    result
}

#[tauri::command]
fn load_image_data_url(image_path: String) -> Result<String, String> {
    let path = PathBuf::from(image_path.trim());

    if !path.exists() {
        return Err("The requested image does not exist.".into());
    }

    if !path.is_file() {
        return Err("The requested image path is not a file.".into());
    }

    if !is_supported_image(&path) {
        return Err("The requested image format is not supported.".into());
    }

    let bytes = fs::read(&path)
        .map_err(|error| format!("Failed to read image {}: {error}", path.display()))?;
    let mime_type = image_mime_type(&path)?;
    let encoded = {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        STANDARD.encode(bytes)
    };

    Ok(format!("data:{mime_type};base64,{encoded}"))
}

fn validate_settings(settings: &AppSettings) -> Result<(), String> {
    if settings.interval_seconds == 0 {
        return Err("Interval must be at least 1 second.".into());
    }

    if settings.foreground_nudge_enabled && settings.foreground_nudge_interval_minutes == 0 {
        return Err("Foreground nudge interval must be at least 1 minute.".into());
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

fn image_mime_type(path: &Path) -> Result<&'static str, String> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg" | "jpeg") => Ok("image/jpeg"),
        Some("gif") => Ok("image/gif"),
        Some("png") => Ok("image/png"),
        Some("webp") => Ok("image/webp"),
        _ => Err("The requested image format is not supported.".into()),
    }
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
    if state.width <= 100.0 || state.height <= 100.0 {
        return Ok(());
    }

    // Reject the position if no monitor contains the window's top-left corner,
    // which catches stale off-screen state (e.g. a disconnected monitor) without
    // incorrectly rejecting legitimate negative X positions on left-side monitors.
    let monitors = window.available_monitors()
        .unwrap_or_default();
    let on_screen = monitors.iter().any(|m| {
        let sf = m.scale_factor();
        let pos = m.position().to_logical::<f64>(sf);
        let size = m.size().to_logical::<f64>(sf);
        state.x >= pos.x && state.x < pos.x + size.width
            && state.y >= pos.y && state.y < pos.y + size.height
    });
    if !on_screen {
        return Ok(());
    }

    window
        .set_position(Position::Logical(LogicalPosition::new(state.x, state.y)))
        .map_err(|error| format!("Failed to restore window position: {error}"))?;

    window
        .set_size(Size::Logical(LogicalSize::new(state.width, state.height)))
        .map_err(|error| format!("Failed to restore window size: {error}"))?;

    if state.maximized {
        window
            .maximize()
            .map_err(|error| format!("Failed to maximize window: {error}"))?;
    }

    Ok(())
}

fn save_window_state(window: &Window) -> Result<(), String> {
    if window.is_minimized().unwrap_or(false) {
        return Ok(());
    }

    let physical_size = window
        .outer_size()
        .map_err(|error| format!("Failed to read window size: {error}"))?;
    let physical_position = window
        .outer_position()
        .map_err(|error| format!("Failed to read window position: {error}"))?;
    let scale_factor = window
        .scale_factor()
        .map_err(|error| format!("Failed to read window scale factor: {error}"))?;

    let size = physical_size.to_logical::<f64>(scale_factor);
    let position = physical_position.to_logical::<f64>(scale_factor);

    if size.width <= 0.0 || size.height <= 0.0 {
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if let Some(window) = app_handle.get_webview_window("main") {
                    let host_window = window.as_ref().window();
                    let _ = restore_window_state(&host_window);
                    let _ = host_window.show();
                }

                WINDOW_SAVE_ENABLED.store(true, Ordering::Release);
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(is_focused) = event {
                let _ = window.emit(
                    WINDOW_COVERAGE_EVENT_NAME,
                    WindowCoverageEvent {
                        covered: !is_focused,
                    },
                );
            }

            if matches!(
                event,
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
            ) || (WINDOW_SAVE_ENABLED.load(Ordering::Acquire)
                && matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)))
            {
                let _ = save_window_state(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            raise_window_without_focus,
            debug_log,
            scan_images,
            get_image_exif,
            load_image_data_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
