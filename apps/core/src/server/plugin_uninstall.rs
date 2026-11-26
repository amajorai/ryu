//! Inventory and opt-in cleanup for the app/plugin uninstall confirmation.
//!
//! The lifecycle endpoint owns the mandatory part of uninstalling an app: stop
//! runtime contributions, remove the lifecycle record, and delete the installed
//! package. This module owns the optional, user-data part. Keeping the two seams
//! separate makes an empty selection safe and lets a user reinstall an app later
//! without losing its paused automations or saved configuration by surprise.

use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

use super::{caller_doc_filter, ServerState};

// The uninstall preview lives in `inventory.rs` and the two cleanup entry points live in
// `cleanup.rs`. Both start with `use super::*;`, so the imports above and the private
// helpers below reach them exactly as they did in the single file.
mod cleanup;
mod inventory;

pub use cleanup::*;
pub use inventory::*;

pub const CLEANUP_KEYBINDINGS: &str = "keybindings";
pub const CLEANUP_SETTINGS: &str = "settings";
pub const CLEANUP_SECRETS: &str = "secrets";
pub const CLEANUP_STORAGE: &str = "storage";
pub const CLEANUP_SCHEDULER: &str = "scheduler";
pub const CLEANUP_OAUTH: &str = "oauth";
pub const CLEANUP_SPACES: &str = "spaces";
/// The app's own data folder, `<data dir>/plugin-data/<dir>` (its databases,
/// preferences, media and caches).
pub const CLEANUP_FILES: &str = "files";
const CLEANUP_DATA_PREFIX: &str = "data:";

#[derive(Debug, Default, Deserialize)]
pub struct UninstallRequest {
    #[serde(default)]
    pub cleanup: Vec<String>,
    /// Also delete the app's key-value storage. Off by default: storage is kept so
    /// a reinstall finds the app's saved data again. Equivalent to selecting the
    /// `storage` cleanup row.
    #[serde(default, alias = "deleteStorage")]
    pub delete_storage: bool,
}

impl UninstallRequest {
    /// The cleanup rows uninstall actually applies: the user's selection, plus
    /// the app's saved secrets (always removed: a credential must not outlive
    /// the app that was trusted with it), plus storage when `delete_storage` is
    /// set. Deduplicated, selection order first.
    pub fn effective_cleanup(&self) -> Vec<String> {
        let mut rows: Vec<String> = Vec::with_capacity(self.cleanup.len() + 2);
        let mut push = |row: &str| {
            if !rows.iter().any(|existing| existing == row) {
                rows.push(row.to_owned());
            }
        };
        for row in &self.cleanup {
            push(row);
        }
        push(CLEANUP_SECRETS);
        if self.delete_storage {
            push(CLEANUP_STORAGE);
        }
        rows
    }
}

#[derive(Debug, Serialize)]
struct SpaceDetail {
    id: String,
    name: String,
    documents: i64,
    bytes: u64,
    system: bool,
}

#[derive(Debug, Serialize)]
struct InventoryItem {
    id: String,
    kind: &'static str,
    label: String,
    description: String,
    count: u64,
    bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Vec<SpaceDetail>>,
}

/// `<data dir>/plugin-data/<dir>` — the folder Core gives the app's sidecars as
/// `RYU_PLUGIN_DATA_DIR`.
fn plugin_data_dir(plugin_id: &str) -> std::path::PathBuf {
    ryu_sidecar_runtime::layout::plugin_data_dir(&crate::paths::ryu_dir(), plugin_id)
}

/// Regular-file count and total bytes under `dir` (symlinks are not followed).
fn dir_usage(dir: &std::path::Path) -> (u64, u64) {
    let mut count = 0;
    let mut bytes = 0;
    let mut pending = vec![dir.to_path_buf()];
    while let Some(current) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                count += 1;
                bytes += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            }
        }
    }
    (count, bytes)
}

fn keybinding_overrides_for(plugin_id: &str, raw: &str) -> Map<String, Value> {
    let Ok(Value::Object(overrides)) = serde_json::from_str(raw) else {
        return Map::new();
    };
    let prefix = format!("plugin:{plugin_id}");
    overrides
        .into_iter()
        .filter(|(key, _)| key == &prefix || key.starts_with(&format!("{prefix}:")))
        .collect()
}

async fn clear_keybindings(state: &ServerState, plugin_id: &str) -> anyhow::Result<()> {
    // Held across the read and the write so a concurrent shortcut edit is kept.
    let _edit = crate::server::preferences::lock_keybinding_edits().await;
    let Some(raw) = state.preferences.get("keybindings").await? else {
        return Ok(());
    };
    let Ok(Value::Object(mut overrides)) = serde_json::from_str::<Value>(&raw) else {
        return Ok(());
    };
    let prefix = format!("plugin:{plugin_id}");
    overrides.retain(|key, _| key != &prefix && !key.starts_with(&format!("{prefix}:")));
    state
        .preferences
        .set("keybindings", &serde_json::to_string(&overrides)?)
        .await?;
    Ok(())
}

/// Whether the uninstall cleanup may remove the preference `key` when an app's
/// manifest names it as one of the app's saved settings.
///
/// A manifest names its settings keys freely, so it can name a key that belongs
/// to Core and not to the app. The member folder list of a shared node is such a
/// key. Every turn on that node is bounded by the copy of the list Core holds in
/// memory, and only the preference route, with its `nodes.manage` check, writes
/// the list and loads it again. An uninstall that deleted the stored list would
/// change it behind that copy, so no uninstall removes it.
///
/// This function is the one place that decides it. The cleanup and the uninstall
/// preview both ask it, so the preview never counts a key the cleanup will leave.
fn cleanup_may_remove_preference(key: &str) -> bool {
    key != crate::server::chat_checkpoints::turn_folders::MEMBER_WORKSPACE_ROOTS_PREF_KEY
}

async fn settings_usage(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
) -> (u64, u64) {
    let (preference_keys, _) = settings_keys(manifest);
    let mut preference_count = 0;
    let mut preference_bytes = 0;
    for key in preference_keys {
        if !cleanup_may_remove_preference(&key) {
            continue;
        }
        if let Ok(Some(value)) = state.preferences.get(&key).await {
            preference_count += 1;
            preference_bytes += value.len() as u64;
        }
    }
    (preference_count, preference_bytes)
}

async fn clear_settings(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
) -> anyhow::Result<()> {
    let (preference_keys, _) = settings_keys(manifest);
    let installed_ids: HashSet<String> = state
        .app_store
        .list_all_records()
        .await?
        .into_iter()
        .map(|record| record.id)
        .collect();
    let mut shared_keys = HashSet::new();
    let manifests = state.app_manifests.read().await;
    for other in manifests.iter() {
        if other.id == manifest.id || !installed_ids.contains(&other.id) {
            continue;
        }
        shared_keys.extend(settings_keys(other).0);
    }
    drop(manifests);

    for key in preference_keys {
        if cleanup_may_remove_preference(&key) && !shared_keys.contains(&key) {
            state.preferences.delete(&key).await?;
        }
    }
    Ok(())
}

fn settings_keys(
    manifest: &crate::plugin_manifest::PluginManifest,
) -> (Vec<String>, HashSet<String>) {
    let mut preference_keys = HashSet::new();
    let mut secret_keys = HashSet::new();
    let Some(tabs) = manifest
        .contributes
        .as_ref()
        .map(|contributes| &contributes.settings_tabs)
    else {
        return (Vec::new(), HashSet::new());
    };
    for tab in tabs {
        collect_setting_keys(tab, &mut preference_keys, &mut secret_keys);
    }
    let mut preference_keys: Vec<_> = preference_keys.into_iter().collect();
    preference_keys.sort();
    (preference_keys, secret_keys)
}

fn collect_setting_keys(
    value: &Value,
    preference_keys: &mut HashSet<String>,
    secret_keys: &mut HashSet<String>,
) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_setting_keys(value, preference_keys, secret_keys);
            }
        }
        Value::Object(object) => {
            let key = object
                .get("pref_key")
                .or_else(|| object.get("prefKey"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            if let Some(key) = key {
                if object.get("type").and_then(Value::as_str) == Some("secret") {
                    secret_keys.insert(key);
                } else {
                    preference_keys.insert(key);
                }
            }
            for value in object.values() {
                collect_setting_keys(value, preference_keys, secret_keys);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod settings_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keybinding_inventory_only_matches_the_requested_plugin() {
        let raw = r#"{
            "plugin:com.example.notes": "Cmd+N",
            "plugin:com.example.notes:open": "Cmd+O",
            "plugin:com.example.notebook": "Cmd+B",
            "chat.new": "Cmd+Shift+N"
        }"#;
        let matches = keybinding_overrides_for("com.example.notes", raw);
        assert_eq!(matches.len(), 2);
        assert!(matches.contains_key("plugin:com.example.notes"));
        assert!(matches.contains_key("plugin:com.example.notes:open"));
        assert!(!matches.contains_key("plugin:com.example.notebook"));
    }

    #[test]
    fn uninstall_always_removes_secrets_and_keeps_storage_unless_asked() {
        let default: UninstallRequest = serde_json::from_value(json!({})).unwrap();
        assert_eq!(default.effective_cleanup(), vec![CLEANUP_SECRETS]);

        let with_storage: UninstallRequest =
            serde_json::from_value(json!({ "delete_storage": true })).unwrap();
        assert_eq!(
            with_storage.effective_cleanup(),
            vec![CLEANUP_SECRETS, CLEANUP_STORAGE]
        );
        let camel: UninstallRequest =
            serde_json::from_value(json!({ "deleteStorage": true })).unwrap();
        assert!(camel.delete_storage);

        let selected: UninstallRequest = serde_json::from_value(json!({
            "cleanup": ["settings", "secrets", "data:monitors"]
        }))
        .unwrap();
        assert_eq!(
            selected.effective_cleanup(),
            vec!["settings", CLEANUP_SECRETS, "data:monitors"]
        );
    }

    #[test]
    fn malformed_keybindings_are_treated_as_empty() {
        assert!(keybinding_overrides_for("com.example.notes", "not json").is_empty());
    }

    #[test]
    fn app_files_usage_counts_nested_regular_files() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("app.db"), b"12345").unwrap();
        std::fs::create_dir_all(root.path().join("media")).unwrap();
        std::fs::write(root.path().join("media").join("a.pcm"), b"123").unwrap();
        assert_eq!(dir_usage(root.path()), (2, 8));
        assert_eq!(dir_usage(&root.path().join("missing")), (0, 0));
    }

    #[test]
    fn app_files_live_in_the_plugin_data_dir() {
        assert_eq!(
            plugin_data_dir("@ryu/meetings"),
            crate::paths::ryu_dir()
                .join("plugin-data")
                .join("@ryu+meetings")
        );
    }
}
