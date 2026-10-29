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

/// `GET /api/plugins/:id/uninstall-data` — return the optional data this app
/// currently owns. Counts are best-effort and never include secret values.
#[utoipa::path(
    get,
    path = "/api/plugins/{id}/uninstall-data",
    tag = "Plugins",
    summary = "Preview optional app data before uninstall",
    params(("id" = String, Path)),
    responses(
        (status = 200, description = "Optional data inventory", body = serde_json::Value),
        (status = 404, description = "Plugin is not installed or has no manifest")
    )
)]
pub async fn inventory_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    let installed = match state.app_store.get_record(&id).await {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": error.to_string() })),
            )
                .into_response();
        }
    };
    if !installed {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("app '{id}' is not installed") })),
        )
            .into_response();
    }

    let manifest = {
        let manifests = state.app_manifests.read().await;
        manifests.iter().find(|manifest| manifest.id == id).cloned()
    };
    let Some(manifest) = manifest else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("manifest for app '{id}' was not found") })),
        )
            .into_response();
    };
    let filter = caller_doc_filter(&caller);
    let value = inventory(&state, &manifest, filter).await;
    Json(value).into_response()
}

async fn inventory(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
    filter: crate::server::spaces::DocFilter<'_>,
) -> Value {
    let plugin_id = &manifest.id;
    let mut items = Vec::new();

    let keybinding_count = match state.preferences.get("keybindings").await {
        Ok(Some(raw)) => keybinding_overrides_for(plugin_id, &raw).len() as u64,
        _ => 0,
    };
    if keybinding_count > 0 {
        items.push(InventoryItem {
            id: CLEANUP_KEYBINDINGS.to_owned(),
            kind: "keybindings",
            label: "Keyboard shortcuts".to_owned(),
            description: format!(
                "{} saved shortcut override{} for {}.",
                keybinding_count,
                if keybinding_count == 1 { "" } else { "s" },
                manifest.name
            ),
            count: keybinding_count,
            bytes: None,
            details: None,
        });
    }

    let (preference_count, preference_bytes) = settings_usage(state, manifest).await;
    if preference_count > 0 {
        items.push(InventoryItem {
            id: CLEANUP_SETTINGS.to_owned(),
            kind: "settings",
            label: "Saved app settings".to_owned(),
            description: format!(
                "{} saved setting{} declared by {}.",
                preference_count,
                if preference_count == 1 { "" } else { "s" },
                manifest.name
            ),
            count: preference_count,
            bytes: Some(preference_bytes),
            details: None,
        });
    }
    // Saved secrets are not an optional row: uninstall always deletes them (see
    // `UninstallRequest::effective_cleanup`), which `automatic` below states.

    if let Some(storage) = crate::plugin_storage::global() {
        if let Ok((count, bytes)) = storage.usage(plugin_id).await {
            if count > 0 {
                items.push(InventoryItem {
                    id: CLEANUP_STORAGE.to_owned(),
                    kind: "storage",
                    label: "Plugin storage".to_owned(),
                    description: format!(
                        "{} key/value record{} stored by {}.",
                        count,
                        if count == 1 { "" } else { "s" },
                        manifest.name
                    ),
                    count,
                    bytes: Some(bytes),
                    details: None,
                });
            }
        }
    }

    let jobs: Vec<_> = crate::scheduler::store::list_jobs()
        .into_iter()
        .filter(|job| job.owner_app.as_deref() == Some(plugin_id.as_str()))
        .collect();
    if !jobs.is_empty() {
        let bytes = jobs
            .iter()
            .filter_map(|job| serde_json::to_vec(job).ok())
            .map(|value| value.len() as u64)
            .sum();
        items.push(InventoryItem {
            id: CLEANUP_SCHEDULER.to_owned(),
            kind: "scheduler",
            label: "Scheduled automations".to_owned(),
            description: format!(
                "{} paused automation{} created by {}. They will not run while the app is absent.",
                jobs.len(),
                if jobs.len() == 1 { "" } else { "s" },
                manifest.name
            ),
            count: jobs.len() as u64,
            bytes: Some(bytes),
            details: None,
        });
    }

    let oauth_count = match crate::identity::global() {
        Some(store) => store
            .list_mcp_oauth_connections_for_plugin(plugin_id)
            .await
            .map(|connections| connections.len() as u64)
            .unwrap_or(0),
        None => 0,
    };
    if oauth_count > 0 {
        items.push(InventoryItem {
            id: CLEANUP_OAUTH.to_owned(),
            kind: "oauth",
            label: "Connected accounts".to_owned(),
            description: format!(
                "{} connected account{} used by {}.",
                oauth_count,
                if oauth_count == 1 { "" } else { "s" },
                manifest.name
            ),
            count: oauth_count,
            bytes: None,
            details: None,
        });
    }

    if let Ok(spaces) = state.spaces.app_space_usage(plugin_id, filter).await {
        if !spaces.is_empty() {
            let details: Vec<SpaceDetail> = spaces
                .iter()
                .map(|space| SpaceDetail {
                    id: space.id.clone(),
                    name: space.name.clone(),
                    documents: space.document_count,
                    bytes: space.storage_bytes.max(0) as u64,
                    system: space.system,
                })
                .collect();
            let bytes = details.iter().map(|detail| detail.bytes).sum();
            items.push(InventoryItem {
                id: CLEANUP_SPACES.to_owned(),
                kind: "spaces",
                label: "App spaces and documents".to_owned(),
                description: format!(
                    "{} Space{} containing {} app document{}.",
                    details.len(),
                    if details.len() == 1 { "" } else { "s" },
                    details
                        .iter()
                        .map(|detail| detail.documents.max(0) as u64)
                        .sum::<u64>(),
                    if details
                        .iter()
                        .map(|detail| detail.documents.max(0) as u64)
                        .sum::<u64>()
                        == 1
                    {
                        ""
                    } else {
                        "s"
                    }
                ),
                count: details.len() as u64,
                bytes: Some(bytes),
                details: Some(details),
            });
        }
    }

    let data_dir = plugin_data_dir(plugin_id);
    let (file_count, file_bytes) = tokio::task::spawn_blocking(move || dir_usage(&data_dir))
        .await
        .unwrap_or((0, 0));
    if file_count > 0 {
        items.push(InventoryItem {
            id: CLEANUP_FILES.to_owned(),
            kind: "files",
            label: "App files".to_owned(),
            description: format!(
                "{} file{} (databases, media and caches) {} keeps on this node.",
                file_count,
                if file_count == 1 { "" } else { "s" },
                manifest.name
            ),
            count: file_count,
            bytes: Some(file_bytes),
            details: None,
        });
    }

    if let Some(contributes) = &manifest.contributes {
        for category in &contributes.data_categories {
            let Some(count) =
                crate::server::data_admin::app_category_count(state, manifest, &category.id).await
            else {
                continue;
            };
            if count == 0 {
                continue;
            }
            items.push(InventoryItem {
                id: format!("{CLEANUP_DATA_PREFIX}{}", category.id),
                kind: "app-data",
                label: category.title.clone(),
                description: category.detail.clone(),
                count,
                bytes: None,
                details: None,
            });
        }
    }

    json!({
        "app": plugin_id,
        "items": items,
        "automatic": [
            "The installed package, manifest, runtime contributions, approved permissions, and bundled skills are always removed.",
            "Sidecar binaries owned by this app are always removed.",
            "Saved secrets (encrypted credentials) for this app are always removed.",
            "Unchecked data stays on the node and can be restored if you install the app again."
        ]
    })
}

/// Purge the app-declared data categories (`data:<category>` rows) the user
/// checked, through the app's own `data.purge`. Runs BEFORE the uninstall
/// deactivates the app: the capability broker only reaches an enabled provider,
/// so purging after teardown is always refused. Errors are display-safe strings;
/// a failed purge never blocks the uninstall.
pub async fn purge_app_data(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
    selected: &[String],
) -> Vec<String> {
    let selected: HashSet<&str> = selected.iter().map(String::as_str).collect();
    let mut errors = Vec::new();
    if let Some(contributes) = &manifest.contributes {
        for category in &contributes.data_categories {
            let selection = format!("{CLEANUP_DATA_PREFIX}{}", category.id);
            if !selected.contains(selection.as_str()) {
                continue;
            }
            if let Err(error) =
                crate::server::data_admin::clear_app_category(state, manifest, &category.id).await
            {
                errors.push(format!("{}: {error}", category.title));
            }
        }
    }
    errors
}

/// Apply the optional Core-held cleanup rows the user checked (everything but
/// app-declared data categories, which [`purge_app_data`] handles before
/// teardown). Errors are returned as display-safe strings so uninstall itself
/// can still complete.
pub async fn apply_cleanup(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
    selected: &[String],
    filter: crate::server::spaces::DocFilter<'_>,
) -> Vec<String> {
    let selected: HashSet<&str> = selected.iter().map(String::as_str).collect();
    let plugin_id = &manifest.id;
    let mut errors = Vec::new();

    if selected.contains(CLEANUP_KEYBINDINGS) {
        if let Err(error) = clear_keybindings(state, plugin_id).await {
            errors.push(format!("Keyboard shortcuts: {error}"));
        }
    }

    if selected.contains(CLEANUP_SETTINGS) {
        if let Err(error) = clear_settings(state, manifest).await {
            errors.push(format!("Saved app settings: {error}"));
        }
    }

    if selected.contains(CLEANUP_SECRETS) {
        if let Some(store) = crate::plugin_secrets::global() {
            if let Err(error) = store.delete_plugin(plugin_id).await {
                errors.push(format!("Saved credentials: {error}"));
            }
        }
    }

    if selected.contains(CLEANUP_STORAGE) {
        if let Some(store) = crate::plugin_storage::global() {
            if let Err(error) = store.delete_plugin(plugin_id).await {
                errors.push(format!("Plugin storage: {error}"));
            }
        }
    }

    if selected.contains(CLEANUP_SCHEDULER) {
        for job in crate::scheduler::store::list_jobs()
            .into_iter()
            .filter(|job| job.owner_app.as_deref() == Some(plugin_id.as_str()))
        {
            if let Err(error) = crate::scheduler::store::delete_job(&job.id) {
                errors.push(format!("Scheduled automation '{}': {error}", job.name));
            }
        }
    }

    if selected.contains(CLEANUP_OAUTH) {
        match crate::mcp_oauth::global()
            .disconnect_plugin(plugin_id)
            .await
        {
            Ok(unconfirmed) if !unconfirmed.is_empty() => errors.push(format!(
                "Connected accounts: local credentials removed, but remote revocation was not confirmed for {} account{}.",
                unconfirmed.len(),
                if unconfirmed.len() == 1 { "" } else { "s" }
            )),
            Ok(_) => {}
            Err(error) => errors.push(format!("Connected accounts: {error}")),
        }
    }

    if selected.contains(CLEANUP_SPACES) {
        if let Err(error) = state.spaces.delete_app_data(plugin_id, filter).await {
            errors.push(format!("App spaces and documents: {error}"));
        }
    }

    if selected.contains(CLEANUP_FILES) {
        let data_dir = plugin_data_dir(plugin_id);
        match tokio::fs::remove_dir_all(&data_dir).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => errors.push(format!("App files: {error}")),
        }
    }

    errors
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

async fn settings_usage(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
) -> (u64, u64) {
    let (preference_keys, _) = settings_keys(manifest);
    let mut preference_count = 0;
    let mut preference_bytes = 0;
    for key in preference_keys {
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
        if !shared_keys.contains(&key) {
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
