//! Streaming privacy mode, detected from the local process table.
//!
//! Core owns the versioned, node-local `streaming-mode.json` settings and polls
//! local process names every five seconds. Missing or malformed settings fall
//! back to schema version 1; unknown JSON fields are ignored. The detector only
//! reports whether a configured app is running, not whether its broadcast is live.
//! App names are non-secret local settings and never leave this node.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const SCAN_INTERVAL: Duration = Duration::from_secs(5);
const SETTINGS_FILE: &str = "streaming-mode.json";
const SETTINGS_VERSION: u32 = 1;
const MAX_APPS: usize = 64;
const MAX_APP_CHARS: usize = 128;

const DEFAULT_STREAMING_APPS: &[&str] = &[
    "obs",
    "obs64",
    "streamlabs",
    "streamlabs desktop",
    "tiktoklivestudio",
    "xsplit.core",
    "vmix",
    "wirecast",
];

/// Persisted preferences for automatic Streaming status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct StreamingSettings {
    /// Settings schema version. Version 1 defaults on for built-in app names.
    #[serde(default = "settings_version")]
    pub schema_version: u32,
    /// Switch to Streaming while a configured streaming app is running.
    pub detection_enabled: bool,
    /// Exact process names (with or without `.exe`) that activate Streaming.
    pub apps: Vec<String>,
}

impl Default for StreamingSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_VERSION,
            detection_enabled: true,
            apps: DEFAULT_STREAMING_APPS
                .iter()
                .map(|app| (*app).to_owned())
                .collect(),
        }
    }
}

impl StreamingSettings {
    fn normalized(mut self) -> Self {
        self.schema_version = SETTINGS_VERSION;
        self.apps = normalize_apps(&self.apps);
        self
    }
}

/// A configured streaming app currently present in the local process table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DetectedStreamingApp {
    pub name: String,
    pub since_ms: u64,
}

/// Streaming status and its node-local settings.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StreamingSnapshot {
    pub active: bool,
    pub detected_app: Option<DetectedStreamingApp>,
    pub settings: StreamingSettings,
}

static SETTINGS: OnceLock<RwLock<StreamingSettings>> = OnceLock::new();
static DETECTED: RwLock<Option<DetectedStreamingApp>> = RwLock::new(None);
static SPAWNED: AtomicBool = AtomicBool::new(false);

fn settings_version() -> u32 {
    SETTINGS_VERSION
}

fn settings_path() -> std::path::PathBuf {
    crate::paths::state_path(SETTINGS_FILE)
}

fn settings_cell() -> &'static RwLock<StreamingSettings> {
    SETTINGS.get_or_init(|| {
        let loaded = std::fs::read(settings_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<StreamingSettings>(&bytes).ok())
            .filter(|settings| settings.schema_version == SETTINGS_VERSION)
            .map(StreamingSettings::normalized)
            .unwrap_or_default();
        RwLock::new(loaded)
    })
}

/// Current persisted preferences.
pub fn settings() -> StreamingSettings {
    settings_cell()
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

/// Replace the preferences, persist them, and immediately clear disabled detection.
pub fn set_settings(next: StreamingSettings) -> std::io::Result<StreamingSettings> {
    if next.schema_version != SETTINGS_VERSION {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "unsupported streaming settings version",
        ));
    }
    let next = next.normalized();
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(&next).map_err(std::io::Error::other)?;
    write_settings_atomic(&path, &bytes)?;
    if let Ok(mut guard) = settings_cell().write() {
        *guard = next.clone();
    }
    if !next.detection_enabled {
        set_detected(None);
    }
    Ok(next)
}

fn write_settings_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("streaming settings path has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".streaming-mode.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, bytes)?;
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

/// The app currently found by process detection, if any.
pub fn detected_app() -> Option<DetectedStreamingApp> {
    DETECTED.read().ok().and_then(|guard| guard.clone())
}

/// Whether process detection or a desktop's manual status has enabled privacy mode.
pub fn is_active() -> bool {
    detected_app().is_some() || crate::presence::reported_streaming()
}

/// Snapshot for Core's presence API.
pub fn snapshot() -> StreamingSnapshot {
    StreamingSnapshot {
        active: is_active(),
        detected_app: detected_app(),
        settings: settings(),
    }
}

fn normalize_apps(apps: &[String]) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    apps.iter()
        .map(|app| normalize_process_name(app))
        .filter(|app| !app.is_empty() && seen.insert(app.clone()))
        .take(MAX_APPS)
        .collect()
}

fn normalize_process_name(name: &str) -> String {
    let trimmed = name.trim();
    let base = trimmed
        .rsplit(|character| character == '/' || character == '\\')
        .next()
        .unwrap_or(trimmed);
    let lowered = base.to_lowercase();
    lowered
        .strip_suffix(".exe")
        .map(str::to_owned)
        .unwrap_or(lowered)
        .trim()
        .chars()
        .take(MAX_APP_CHARS)
        .collect::<String>()
        .to_owned()
}

/// Match a running executable name against the user's exact process-name list.
/// Returning the process-table spelling makes the active status understandable.
fn classify_process(name: &str, exe: Option<&std::path::Path>, apps: &[String]) -> Option<String> {
    let process_name = normalize_process_name(name);
    let executable_name = exe
        .and_then(|path| path.file_name())
        .and_then(|file_name| file_name.to_str())
        .map(normalize_process_name);
    if process_name.is_empty() {
        return None;
    }
    apps.iter()
        .any(|app| app == &process_name || executable_name.as_ref() == Some(app))
        .then(|| name.trim().trim_end_matches(".exe").to_owned())
}

fn scan_for_streaming_app(sys: &mut sysinfo::System, apps: &[String]) -> Option<String> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
    let mut found: Vec<String> = sys
        .processes()
        .values()
        .filter_map(|process| {
            classify_process(&process.name().to_string_lossy(), process.exe(), apps)
        })
        .collect();
    found.sort();
    found.into_iter().next()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn set_detected(name: Option<String>) {
    if let Ok(mut guard) = DETECTED.write() {
        let next = name.map(|name| DetectedStreamingApp {
            name,
            since_ms: now_ms(),
        });
        if guard.as_ref().map(|app| &app.name) != next.as_ref().map(|app| &app.name) {
            *guard = next;
        }
    }
}

/// Start the node-local streaming-app detector once per process.
pub fn spawn() {
    if SPAWNED.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        let mut sys = sysinfo::System::new();
        let mut ticker = tokio::time::interval(SCAN_INTERVAL);
        loop {
            ticker.tick().await;
            let prefs = settings();
            if prefs.detection_enabled && crate::server::node_org_id().is_none() {
                let found = scan_for_streaming_app(&mut sys, &prefs.apps);
                let current = detected_app();
                match (found, current) {
                    (Some(name), Some(existing)) if existing.name == name => {}
                    (next, _) => set_detected(next),
                }
            } else {
                set_detected(None);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn defaults_cover_common_streaming_apps() {
        let settings = StreamingSettings::default();
        for process in [
            "obs64.exe",
            "Streamlabs Desktop.exe",
            "TikTokLiveStudio.exe",
        ] {
            assert!(classify_process(process, None, &settings.apps).is_some());
        }
    }

    #[test]
    fn custom_names_match_exactly_and_can_match_executable_path() {
        let apps = vec!["my-streamer".to_owned()];
        assert!(classify_process("my-streamer.exe", None, &apps).is_some());
        assert!(classify_process(
            "unknown",
            Some(Path::new("/Applications/my-streamer.app/my-streamer")),
            &apps
        )
        .is_some());
        assert!(classify_process("my-streamer-helper.exe", None, &apps).is_none());
    }

    #[test]
    fn settings_normalize_and_dedupe_process_names() {
        let settings = StreamingSettings {
            schema_version: SETTINGS_VERSION,
            detection_enabled: true,
            apps: vec![" OBS64.exe ".into(), "obs64".into(), String::new()],
        }
        .normalized();
        assert_eq!(settings.apps, ["obs64"]);
    }

    #[test]
    fn settings_version_defaults_for_older_files_and_ignores_unknown_fields() {
        let settings: StreamingSettings = serde_json::from_value(serde_json::json!({
            "detectionEnabled": true,
            "apps": ["obs64"],
            "futureField": "ignored"
        }))
        .unwrap();
        assert_eq!(settings.schema_version, SETTINGS_VERSION);
        assert_eq!(settings.apps, ["obs64"]);
    }

    #[test]
    fn app_lists_and_entries_are_bounded() {
        let apps = (0..MAX_APPS + 5)
            .map(|index| format!("app-{index}"))
            .collect::<Vec<_>>();
        let normalized = normalize_apps(&apps);
        assert_eq!(normalized.len(), MAX_APPS);

        let long = "x".repeat(MAX_APP_CHARS + 10);
        assert_eq!(normalize_process_name(&long).len(), MAX_APP_CHARS);
    }

    #[test]
    fn settings_writes_replace_atomically() {
        let path = std::env::temp_dir().join(format!(
            "ryu-streaming-settings-{}.json",
            uuid::Uuid::new_v4()
        ));
        write_settings_atomic(&path, br#"{"schemaVersion":1}"#).unwrap();
        write_settings_atomic(&path, br#"{"schemaVersion":1,"detectionEnabled":false}"#).unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["detectionEnabled"], false);
        std::fs::remove_file(path).unwrap();
    }
}
