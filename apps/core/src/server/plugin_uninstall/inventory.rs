//! The uninstall preview: the optional data an app currently owns on this node.
// test-exempt: moved verbatim out of server/plugin_uninstall.rs by the module split, no behaviour change; the tests of the helpers it calls stay in the parent file.

use super::*;

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
