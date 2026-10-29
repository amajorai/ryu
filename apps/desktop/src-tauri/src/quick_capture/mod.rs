//! Quick Capture: tap Shift twice anywhere and whatever you have selected is kept
//! on the Quests board, along with the app and page it came from.
//!
//! ## Why the desktop app owns this
//!
//! The gesture is a bare modifier double-tap, which is not something an
//! accelerator can express: a registered global shortcut needs a non-modifier key
//! code, and a double tap needs keydown/keyup *timing* that a shortcut callback
//! never sees. That rules out `tauri-plugin-global-shortcut`. It has to be an
//! event tap, and the desktop app is the right process to own one — it is the
//! signed, user-installed binary macOS attributes the TCC grants to (the same
//! reason [`crate::permissions`] lives here rather than in Core).
//!
//! ## Layering
//!
//! - [`gesture`] — the pure double-tap state machine. No OS types, fully tested.
//! - [`mac`] — the event tap, the selection readers, the pasteboard fallback.
//! - this module — config, the worker thread, and delivery.
//!
//! ## Delivery
//!
//! A capture is `POST <core>/api/quests/capture`, the public mount the `@ryu/quests`
//! manifest declares. This is the generic ext-proxy path, NOT a bespoke route: Core
//! carries no Quick Capture code, and the only app-specific thing here is the
//! destination URL — the same shape as the existing `app:@ryu/quests` deep link the
//! companion's settings gear already uses.
//!
//! `@ryu/quests` is **not pre-installed**, so on a fresh install that POST 404s
//! until the user installs and enables Quests from the Store. [`status`] reports
//! that explicitly rather than letting the gesture fail silently.

pub mod gesture;
#[cfg(target_os = "macos")]
pub(crate) mod mac;

use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;
#[cfg(target_os = "macos")]
use std::sync::atomic::Ordering;
use std::sync::Mutex;

/// Where a capture came from. Mirrors the `CaptureSource` the quests sidecar
/// stores; every field is best-effort and absent when the app publishes nothing.
#[derive(Debug, Default, Clone, Serialize)]
pub struct CaptureContext {
    pub app: Option<String>,
    pub title: Option<String>,
    pub url: Option<String>,
}

/// Which Shift key arms the gesture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Binding {
    /// Either Shift, double-tapped. The default — most people do not think about
    /// which Shift they used.
    #[default]
    Either,
    Left,
    Right,
}

impl Binding {
    fn accepts(self, side: gesture::Side) -> bool {
        match self {
            Binding::Either => true,
            Binding::Left => side == gesture::Side::Left,
            Binding::Right => side == gesture::Side::Right,
        }
    }
}

/// The persisted settings, in `<data dir>/state/quick-capture.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    /// OFF until the user turns it on. Deliberate: switching this on is what
    /// triggers the Input Monitoring prompt, and an unprompted permission dialog
    /// on first launch is mostly denied — which would leave the feature
    /// permanently broken with no obvious way back.
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub binding: Binding,
    /// What a capture is filed as. `null`/absent lets the sidecar infer it (a bare
    /// URL becomes a link, anything else a note).
    #[serde(default)]
    pub kind: Option<String>,
}

static STARTED: AtomicBool = AtomicBool::new(false);
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn config_path() -> std::path::PathBuf {
    ryu_sidecar_runtime::layout::state_path(&crate::profile::ryu_home_dir(), "quick-capture.json")
}

pub fn load_config() -> Config {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_config(config: &Config) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())
}

fn set_error(message: Option<String>) {
    if let Ok(mut slot) = LAST_ERROR.lock() {
        *slot = message;
    }
}

fn last_error() -> Option<String> {
    LAST_ERROR.lock().ok().and_then(|slot| slot.clone())
}

/// Start the listener at app launch when the user has it enabled. Never prompts —
/// a launch-time permission dialog is exactly what we do not want.
pub fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let config = load_config();
    if !config.enabled {
        return;
    }
    if let Err(err) = start(app.clone(), config) {
        // Non-fatal: the app runs fine without the gesture, and `status` surfaces
        // the reason in Settings.
        log::warn!("quick capture: {err}");
        set_error(Some(err));
    }
}

/// `_config` is intentionally unused: the worker re-reads the config on every
/// trigger so a binding change applies without restarting the tap.
#[cfg(target_os = "macos")]
fn start<R: tauri::Runtime>(app: tauri::AppHandle<R>, _config: Config) -> Result<(), String> {
    mac::set_listening(true);
    if STARTED.swap(true, Ordering::SeqCst) {
        // The tap already exists; enabling is all that was needed.
        return Ok(());
    }

    let (tx, rx) = std::sync::mpsc::channel::<gesture::Trigger>();
    if let Err(err) = mac::spawn_listener(tx) {
        STARTED.store(false, Ordering::SeqCst);
        mac::set_listening(false);
        return Err(err);
    }

    // The worker: everything slow happens here, never in the tap callback.
    std::thread::Builder::new()
        .name("ryu-quick-capture-worker".into())
        .spawn(move || {
            while let Ok(trigger) = rx.recv() {
                // COALESCE a burst. One capture costs up to `COPY_WAIT_MS` of
                // pasteboard polling plus an HTTP round trip, so an impatient
                // double-double-tap would otherwise queue several captures — each
                // replaying a synthetic ⌘C seconds later against whatever app is
                // frontmost BY THEN, which is not the one the user was looking at.
                // Draining first turns a burst into a single capture of the current
                // selection. (The channel is unbounded, so nothing drops on its own.)
                while rx.try_recv().is_ok() {}

                let binding = load_config().binding;
                if !binding.accepts(trigger.side) {
                    continue;
                }
                handle_trigger(&app);
            }
        })
        .map_err(|e| format!("couldn't start the Quick Capture worker: {e}"))?;

    set_error(None);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn start<R: tauri::Runtime>(_app: tauri::AppHandle<R>, _config: Config) -> Result<(), String> {
    Err("Quick Capture is macOS-only for now".into())
}

#[cfg(target_os = "macos")]
fn handle_trigger<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(text) = mac::read_selection() else {
        // Nothing selected is the common case (someone brushed the key twice). Not
        // an error, and deliberately silent — a toast here would be noise.
        return;
    };
    let context = mac::capture_context();
    let kind = load_config().kind;

    match deliver(&text, &context, kind.as_deref()) {
        Ok(title) => {
            set_error(None);
            // The UI shows a toast; the payload is what was kept so the toast can
            // name it.
            let _ = tauri::Emitter::emit(
                app,
                "quick-capture:kept",
                serde_json::json!({ "title": title, "source": context }),
            );
        }
        Err(err) => {
            set_error(Some(err.clone()));
            let _ = tauri::Emitter::emit(
                app,
                "quick-capture:failed",
                serde_json::json!({ "error": err }),
            );
        }
    }
}

/// POST the capture to the quests sidecar through Core's public mount. Returns the
/// title the sidecar derived, for the toast.
#[cfg(target_os = "macos")]
fn deliver(text: &str, context: &CaptureContext, kind: Option<&str>) -> Result<String, String> {
    let url = format!("{}/api/quests/capture", crate::profile::core_base_url());
    let mut body = serde_json::json!({
        "body": text,
        "source": {
            "app": context.app,
            "title": context.title,
            "url": context.url,
        },
    });
    if let Some(kind) = kind {
        body["kind"] = serde_json::Value::String(kind.to_string());
    }

    // The worker is a plain OS thread (not a runtime thread), so driving the async
    // client to completion here is safe and avoids pulling in reqwest's `blocking`
    // feature, which would stand up a second runtime inside the app.
    let token = crate::nodes::read_local_node_token();
    tauri::async_runtime::block_on(async move {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;
        let mut request = client.post(&url).json(&body);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("couldn't reach Ryu Core: {e}"))?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(
                "the Quests app is turned off — enable it from the Store and try again".to_string(),
            );
        }
        if !status.is_success() {
            return Err(format!("Ryu Core rejected the capture ({status})"));
        }
        let parsed: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
        Ok(parsed["quest"]["title"]
            .as_str()
            .unwrap_or("Kept")
            .to_string())
    })
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// Everything Settings needs to render the row honestly: whether the platform
/// supports it, whether each of the TWO permissions is granted, whether the
/// destination app is on, and the last failure if there was one.
#[derive(Debug, Serialize)]
pub struct Status {
    pub supported: bool,
    pub enabled: bool,
    pub listening: bool,
    pub binding: Binding,
    pub input_monitoring: bool,
    pub accessibility: bool,
    pub quests_enabled: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub fn quick_capture_status() -> Status {
    let config = load_config();
    Status {
        supported: cfg!(target_os = "macos"),
        enabled: config.enabled,
        listening: listening(),
        binding: config.binding,
        input_monitoring: ghost_permissions::granted(
            ghost_permissions::Capability::InputMonitoring,
        ),
        accessibility: ghost_permissions::granted(ghost_permissions::Capability::Accessibility),
        quests_enabled: quests_reachable(),
        error: last_error(),
    }
}

#[cfg(target_os = "macos")]
fn listening() -> bool {
    mac::is_listening()
}

#[cfg(not(target_os = "macos"))]
fn listening() -> bool {
    false
}

/// Whether Core is serving `/api/quests` at all — i.e. whether the app is enabled.
/// A 404 here is the one failure the user can fix themselves, so it is worth a
/// dedicated field rather than a generic error string.
fn quests_reachable() -> bool {
    let url = format!("{}/api/quests", crate::profile::core_base_url());
    let token = crate::nodes::read_local_node_token();
    tauri::async_runtime::block_on(async move {
        let Ok(client) = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
        else {
            return false;
        };
        let mut request = client.get(&url);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        request
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    })
}

/// Turn the gesture on or off. Turning it ON is what surfaces the Input Monitoring
/// prompt (the tap creation does), which is why this is user-initiated.
#[tauri::command]
pub fn quick_capture_set_enabled<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    enabled: bool,
) -> Result<Status, String> {
    let mut config = load_config();
    config.enabled = enabled;

    if enabled {
        // Start FIRST, persist second. Writing `enabled: true` before the tap is
        // known to exist strands the user: on a machine without the Input Monitoring
        // grant the start fails, but the saved config still says on — so the switch
        // comes back already checked and toggling it "on" is a no-op, with nothing
        // on screen explaining why. Persisting only on success keeps the switch an
        // honest report of whether the gesture is live.
        start(app, config.clone())?;
    } else {
        stop();
        set_error(None);
    }
    save_config(&config)?;
    Ok(quick_capture_status())
}

/// Change which Shift key arms the gesture.
#[tauri::command]
pub fn quick_capture_set_binding(binding: Binding) -> Result<Status, String> {
    let mut config = load_config();
    config.binding = binding;
    save_config(&config)?;
    Ok(quick_capture_status())
}

#[cfg(target_os = "macos")]
fn stop() {
    mac::set_listening(false);
}

#[cfg(not(target_os = "macos"))]
fn stop() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binding_either_accepts_both_sides() {
        assert!(Binding::Either.accepts(gesture::Side::Left));
        assert!(Binding::Either.accepts(gesture::Side::Right));
    }

    #[test]
    fn a_side_binding_rejects_the_other_shift() {
        assert!(Binding::Left.accepts(gesture::Side::Left));
        assert!(!Binding::Left.accepts(gesture::Side::Right));
        assert!(Binding::Right.accepts(gesture::Side::Right));
        assert!(!Binding::Right.accepts(gesture::Side::Left));
    }

    #[test]
    fn config_defaults_to_off_with_either_shift() {
        let config = Config::default();
        assert!(!config.enabled);
        assert_eq!(config.binding, Binding::Either);
        assert!(config.kind.is_none());
    }

    #[test]
    fn a_config_file_missing_newer_fields_still_loads() {
        let config: Config = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(config.enabled);
        assert_eq!(config.binding, Binding::Either);
    }
}
