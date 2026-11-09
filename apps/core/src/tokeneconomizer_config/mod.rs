//! Settings bridge for the `@ryu/tokeneconomizer` plugin.
//!
//! The plugin's Pi extension (`plugins-store/plugins/tokeneconomizer/pi-extensions/
//! ryu-tokeneconomizer.ts`) runs the user's own TokenEconomizer install. A Pi
//! extension cannot read Core preferences, so Core turns the plugin's three
//! settings into one pointer file in the managed Pi config dir
//! (`<pi-agent>/tokeneconomizer.json`), which the extension reads when its Pi
//! process starts.
//!
//! ## Posture (mirrors [`crate::rtk_config`])
//!
//! - **BYO, nothing downloaded.** The user names a TokenEconomizer clone; Core
//!   only checks that it holds the dispatcher (`plugin/scripts/te-hook`).
//! - **Off unless configured.** No folder, or a folder without the dispatcher,
//!   removes the pointer file, and the extension stays inert.
//! - **Managed agent only.** The file is written into [`crate::pi_config::config_dir`]
//!   alone. Limited agents' config dirs are rebuilt from an allowlist and never
//!   receive it, so TokenEconomizer never runs inside a confined agent.
//! - **Best-effort.** A write failure is logged by the caller and never blocks a
//!   preference write or boot.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// The TokenEconomizer clone (or its `plugin/` folder) the user named.
pub const FOLDER_PREF_KEY: &str = "tokeneconomizer-folder";
/// Micro-skills mode override for the managed Pi.
pub const MICROSKILLS_PREF_KEY: &str = "tokeneconomizer-microskills";
/// Loop-guard mode override for the managed Pi.
pub const LOOPGUARD_PREF_KEY: &str = "tokeneconomizer-loopguard";
/// The pointer file the Pi extension reads (`POINTER_FILE` in the extension).
pub const POINTER_FILE: &str = "tokeneconomizer.json";

const MICROSKILLS_MODES: &[&str] = &["on", "off", "envfacts"];
const LOOPGUARD_MODES: &[&str] = &["on", "off"];

/// Whether `key` is one of this plugin's preferences.
pub fn is_pref_key(key: &str) -> bool {
    matches!(
        key,
        FOLDER_PREF_KEY | MICROSKILLS_PREF_KEY | LOOPGUARD_PREF_KEY
    )
}

/// The plugin's settings as the desktop stored them.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Settings {
    pub folder: String,
    pub microskills: String,
    pub loopguard: String,
}

/// Resolve the folder setting to TokenEconomizer's `plugin/` folder: the clone
/// root (`<root>/plugin/scripts/te-hook`) or the plugin folder itself
/// (`<dir>/scripts/te-hook`). `None` for an empty, relative or incomplete path.
pub fn resolve_plugin_dir(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return None;
    }
    let has_dispatcher = |dir: &Path| dir.join("scripts").join("te-hook").is_file();
    let nested = path.join("plugin");
    if has_dispatcher(&nested) {
        return Some(nested);
    }
    has_dispatcher(&path).then_some(path)
}

/// A mechanism mode the dispatcher accepts, or `None` for "default" (leave it to
/// TokenEconomizer's own config) and anything unrecognised.
fn mode<'a>(raw: &'a str, allowed: &[&str]) -> Option<&'a str> {
    let value = raw.trim();
    allowed.contains(&value).then_some(value)
}

/// The pointer file's JSON, or `None` when the bridge is off. Pure.
pub fn pointer_json(settings: &Settings, pi_cli: Option<&Path>) -> Option<Value> {
    let plugin_dir = resolve_plugin_dir(&settings.folder)?;
    let mut body = Map::new();
    body.insert("pluginDir".to_owned(), json!(plugin_dir.to_string_lossy()));
    if let Some(cli) = pi_cli {
        body.insert("piCli".to_owned(), json!(cli.to_string_lossy()));
    }
    if let Some(value) = mode(&settings.microskills, MICROSKILLS_MODES) {
        body.insert("microskills".to_owned(), json!(value));
    }
    if let Some(value) = mode(&settings.loopguard, LOOPGUARD_MODES) {
        body.insert("loopguard".to_owned(), json!(value));
    }
    Some(Value::Object(body))
}

/// Write (or remove) the pointer file in `agent_dir`. Returns whether the bridge
/// is now on. The write is atomic so a starting Pi never reads half a file.
pub fn apply_in(
    agent_dir: &Path,
    settings: &Settings,
    pi_cli: Option<&Path>,
) -> anyhow::Result<bool> {
    let path = agent_dir.join(POINTER_FILE);
    let Some(body) = pointer_json(settings, pi_cli) else {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        return Ok(false);
    };
    std::fs::create_dir_all(agent_dir)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&body)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(true)
}

/// Read the plugin's settings from preferences (missing keys read as empty).
async fn read_settings(preferences: &crate::server::preferences::PreferencesStore) -> Settings {
    let get = |key: &'static str| async move {
        preferences
            .get(key)
            .await
            .ok()
            .flatten()
            .unwrap_or_default()
    };
    Settings {
        folder: get(FOLDER_PREF_KEY).await,
        microskills: get(MICROSKILLS_PREF_KEY).await,
        loopguard: get(LOOPGUARD_PREF_KEY).await,
    }
}

/// Reconcile the managed Pi's pointer file with the current preferences. Called
/// at boot and whenever one of this plugin's preferences changes. Changes reach
/// the next Pi process (a new chat), like every other Pi extension setting.
pub async fn reconcile(
    preferences: &crate::server::preferences::PreferencesStore,
) -> anyhow::Result<bool> {
    let settings = read_settings(preferences).await;
    let pi_cli = crate::sidecar::adapters::acp::managed_pi_binary();
    let pi_cli = pi_cli.exists().then_some(pi_cli);
    let on = apply_in(
        &crate::pi_config::config_dir(),
        &settings,
        pi_cli.as_deref(),
    )?;
    tracing::info!(on, "tokeneconomizer: reconciled managed Pi pointer file");
    Ok(on)
}

#[cfg(test)]
mod tests;
