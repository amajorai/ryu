//! Appshots-style Clips quick attach.
//!
//! The native layer owns only the global bare-modifier gesture. It never reads
//! screen pixels, selected text, or clipboard contents. Once the gesture fires,
//! the desktop renderer fetches Clips' already-authorized recent-activity bundle
//! and stages it in a new chat.

#[cfg(target_os = "windows")]
mod windows;

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager, Runtime};

use crate::quick_capture::gesture::Trigger;

#[cfg(target_os = "macos")]
use crate::quick_capture::gesture::Modifier;
#[cfg(target_os = "macos")]
use crate::quick_capture::mac::spawn_modifier_listener;

const CONFIG_FILE: &str = "clips-quick-attach.json";

static STARTED: AtomicBool = AtomicBool::new(false);
static LISTENING: OnceLock<Arc<AtomicBool>> = OnceLock::new();
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
struct Config {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    destination: Destination,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Destination {
    #[default]
    Automatic,
    CurrentChat,
    NewChat,
}

#[derive(Debug, Serialize)]
pub struct Status {
    pub supported: bool,
    pub enabled: bool,
    pub destination: Destination,
    pub listening: bool,
    pub input_monitoring: bool,
    pub error: Option<String>,
}

fn listening_gate() -> Arc<AtomicBool> {
    LISTENING
        .get_or_init(|| Arc::new(AtomicBool::new(false)))
        .clone()
}

fn config_path() -> std::path::PathBuf {
    ryu_sidecar_runtime::layout::state_path(&crate::profile::ryu_home_dir(), CONFIG_FILE)
}

fn load_config() -> Config {
    load_config_at(&config_path())
}

fn load_config_at(path: &std::path::Path) -> Config {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_config(config: &Config) -> Result<(), String> {
    let path = config_path();
    save_config_at(&path, config)
}

fn save_config_at(path: &std::path::Path, config: &Config) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "couldn't resolve Clips quick attach config directory".to_owned())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let body = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temporary
        .write_all(body.as_bytes())
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

fn set_error(error: Option<String>) {
    if let Ok(mut slot) = LAST_ERROR.lock() {
        *slot = error;
    }
}

fn last_error() -> Option<String> {
    LAST_ERROR.lock().ok().and_then(|slot| slot.clone())
}

/// Start an enabled shortcut without prompting at app launch. Permission prompts
/// happen only after the user turns the setting on.
pub fn init<R: Runtime>(app: &tauri::AppHandle<R>) {
    let config = load_config();
    if !config.enabled {
        return;
    }
    if let Err(error) = start(app.clone()) {
        log::warn!("clips quick attach: {error}");
        set_error(Some(error));
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn start<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let listening = listening_gate();
    listening.store(true, Ordering::SeqCst);
    if STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let (tx, rx) = std::sync::mpsc::channel::<Trigger>();
    let listener_result = {
        #[cfg(target_os = "macos")]
        {
            spawn_modifier_listener(
                tx,
                Modifier::Command,
                "ryu-clips-quick-attach",
                listening.clone(),
            )
        }
        #[cfg(target_os = "windows")]
        {
            windows::spawn_listener(tx, listening.clone())
        }
    };

    if let Err(error) = listener_result {
        STARTED.store(false, Ordering::SeqCst);
        listening.store(false, Ordering::SeqCst);
        return Err(error);
    }

    std::thread::Builder::new()
        .name("ryu-clips-quick-attach-worker".into())
        .spawn(move || {
            while rx.recv().is_ok() {
                while rx.try_recv().is_ok() {}
                if listening.load(Ordering::SeqCst) {
                    let _ = app.emit("clips:quick-attach", ());
                }
            }
        })
        .map_err(|error| format!("couldn't start Clips quick attach worker: {error}"))?;

    set_error(None);
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn start<R: Runtime>(_app: tauri::AppHandle<R>) -> Result<(), String> {
    Err("Clips quick attach is supported on macOS and Windows only".into())
}

fn stop() {
    listening_gate().store(false, Ordering::SeqCst);
    set_error(None);
}

#[cfg(target_os = "macos")]
fn input_monitoring_granted() -> bool {
    ghost_permissions::granted(ghost_permissions::Capability::InputMonitoring)
}

#[cfg(not(target_os = "macos"))]
fn input_monitoring_granted() -> bool {
    true
}

#[tauri::command]
pub fn clips_quick_attach_status() -> Status {
    let config = load_config();
    Status {
        supported: cfg!(any(target_os = "macos", target_os = "windows")),
        enabled: config.enabled,
        destination: config.destination,
        listening: listening_gate().load(Ordering::SeqCst),
        input_monitoring: input_monitoring_granted(),
        error: last_error(),
    }
}

#[tauri::command]
pub fn clips_quick_attach_set_enabled<R: Runtime>(
    app: tauri::AppHandle<R>,
    enabled: bool,
) -> Result<Status, String> {
    let mut config = load_config();
    if enabled {
        start(app)?;
    } else {
        stop();
    }
    config.enabled = enabled;
    save_config(&config)?;
    Ok(clips_quick_attach_status())
}

#[tauri::command]
pub fn clips_quick_attach_set_destination(destination: Destination) -> Result<Status, String> {
    let mut config = load_config();
    config.destination = destination;
    save_config(&config)?;
    Ok(clips_quick_attach_status())
}

/// Bring the main window forward after the renderer has captured the original
/// frontmost app's context. Focusing before that fetch would make Shadow report
/// Ryu itself instead of the app the user wanted to attach.
#[tauri::command]
pub fn clips_quick_attach_focus<R: Runtime>(app: tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::{load_config_at, save_config_at, Config, Destination};

    #[test]
    fn existing_config_defaults_to_automatic_destination() {
        let config = serde_json::from_str::<Config>(r#"{"enabled":true}"#)
            .expect("existing quick attach config remains readable");

        assert!(config.enabled);
        assert_eq!(config.destination, Destination::Automatic);
    }

    #[test]
    fn destinations_use_the_frontend_wire_names() {
        assert_eq!(
            serde_json::to_string(&Destination::Automatic).unwrap(),
            "\"automatic\""
        );
        assert_eq!(
            serde_json::to_string(&Destination::CurrentChat).unwrap(),
            "\"current_chat\""
        );
        assert_eq!(
            serde_json::to_string(&Destination::NewChat).unwrap(),
            "\"new_chat\""
        );
    }

    #[test]
    fn destination_changes_replace_the_config_file_atomically() {
        let directory = tempfile::tempdir().expect("temporary config directory");
        let path = directory.path().join("clips-quick-attach.json");
        let original = Config::default();
        let updated = Config {
            enabled: true,
            destination: Destination::CurrentChat,
        };

        save_config_at(&path, &original).expect("write original config");
        save_config_at(&path, &updated).expect("replace original config");

        assert_eq!(load_config_at(&path), updated);
    }
}
