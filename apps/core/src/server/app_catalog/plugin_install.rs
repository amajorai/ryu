//! App catalog browse, install-from-URL and hot reload: `install_fleet_plugin` through `write_plugin_manifest_to_disk`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Fleet adapter into the existing plugin lifecycle. Desired state never calls
/// Core's own HTTP API, and this remains generic over every manifest-backed app.
pub(crate) async fn install_fleet_plugin(
    state: &ServerState,
    manifest: crate::plugin_manifest::PluginManifest,
    ui_code: Option<String>,
    enable: bool,
) -> Result<(), String> {
    if crate::fleet::is_artifact_blocked(&manifest.id) {
        return Err(format!(
            "plugin '{}' is blocked by organization policy",
            manifest.id
        ));
    }
    let existing_record = state
        .app_store
        .get_record(&manifest.id)
        .await
        .map_err(|error| error.to_string())?;
    let already_installed = existing_record.is_some();
    if let Some(record) = &existing_record {
        if record.version != manifest.version {
            let fleet_owned = record
                .provenance
                .as_ref()
                .and_then(|provenance| provenance.source_id.as_deref())
                == Some("fleet");
            if !fleet_owned {
                return Err(format!(
                    "plugin '{}' is user-owned at version {}; preserving it instead of replacing it with managed version {}",
                    manifest.id, record.version, manifest.version
                ));
            }
            let old_manifest = state
                .app_manifests
                .read()
                .await
                .iter()
                .find(|loaded| loaded.id == manifest.id)
                .cloned();
            write_plugin_manifest_to_disk(&manifest)
                .await
                .map_err(|(_, error)| error)?;
            if let Err(error) = crate::plugins::lifecycle::update_app(
                &state.app_store,
                &manifest,
                ui_code.as_deref(),
                true,
            )
            .await
            {
                if let Some(old_manifest) = old_manifest {
                    let _ = write_plugin_manifest_to_disk(&old_manifest).await;
                }
                reload_manifests_inner(state).await;
                return Err(error.to_string());
            }
            let kept_agents = old_manifest
                .as_ref()
                .map(|old_manifest| app_agents_kept_by_update(old_manifest, &manifest))
                .unwrap_or_default();
            if record.enabled {
                if let Some(old_manifest) = &old_manifest {
                    let _ =
                        deactivate_plugin_keeping_agents(state, old_manifest, &kept_agents).await;
                }
            }
            reload_manifests_inner(state).await;
            if record.enabled {
                if let Some(updated_record) = state
                    .app_store
                    .get_record(&manifest.id)
                    .await
                    .map_err(|error| error.to_string())?
                {
                    // Fleet updates have no caller to report to; what this
                    // narrows or leaves pending is logged and kept on the
                    // agent's `app_identity`.
                    let _ = reconcile_app_agent_identities(&state.agent_store, &manifest).await;
                    let _ = activate_plugin(state, &manifest, &updated_record).await;
                    refresh_kept_app_agents(&state.agent_store, &manifest, &kept_agents).await;
                }
            }
            state.mcp.clear_ext_api_routes(&manifest.id);
            state.realtime.broadcast_event(
                "system:plugins",
                "plugin.contributions.changed",
                json!({"type": "contributions_changed"}),
            );
        }
    }
    if !already_installed {
        let already_loaded = state
            .app_manifests
            .read()
            .await
            .iter()
            .any(|loaded| loaded.id == manifest.id);
        if already_loaded {
            crate::plugins::lifecycle::install_app_with_provenance(
                &state.app_store,
                &manifest,
                Some(&crate::plugins::isolation::PluginProvenance {
                    // A manifest that was already on disk is user-owned. The
                    // lifecycle row is managed for activation, but fleet
                    // removal must never delete the existing bytes.
                    source_id: Some("fleet-adopted".to_owned()),
                    captured_at: Some(chrono::Utc::now().to_rfc3339()),
                    ..Default::default()
                }),
            )
            .await
            .map_err(|error| error.to_string())?;
        } else {
            persist_installed_plugin(
                state,
                manifest.clone(),
                ui_code,
                Some(crate::plugins::isolation::PluginProvenance {
                    source_id: Some("fleet".to_owned()),
                    captured_at: Some(chrono::Utc::now().to_rfc3339()),
                    ..Default::default()
                }),
            )
            .await
            .map_err(|(_, error)| error)?;
        }
    }
    if !enable {
        return Ok(());
    }
    if state
        .app_store
        .get_record(&manifest.id)
        .await
        .map_err(|error| error.to_string())?
        .is_some_and(|record| record.enabled)
    {
        return Ok(());
    }
    let all_manifests = state.app_manifests.read().await.clone();
    let outcome = crate::plugins::lifecycle::enable_app(
        &state.app_store,
        &manifest,
        &all_manifests,
        &crate::sidecar::gateway::gateway_url(),
        crate::sidecar::gateway::gateway_token().as_deref(),
        &state.client,
    )
    .await
    .map_err(|error| error.to_string())?;
    for record in outcome.in_enable_order() {
        let active_manifest = if record.id == manifest.id {
            &manifest
        } else {
            all_manifests
                .iter()
                .find(|candidate| candidate.id == record.id)
                .ok_or_else(|| format!("missing manifest for dependency '{}'", record.id))?
        };
        let _ = activate_plugin(state, active_manifest, record).await;
    }
    state.realtime.broadcast_event(
        "system:plugins",
        "plugin.contributions.changed",
        json!({"type": "contributions_changed"}),
    );
    Ok(())
}

/// Write a plugin's manifest to its on-disk `manifest.json` (the resolver the loader
/// reads), creating the directory if needed. The `PluginManifest` struct carries no
/// `ui_code` field, so the bundle is never written here — it lives on the lifecycle
/// record. Shared by the install sink ([`persist_installed_plugin`]) and the update
/// handler so the two never drift on how a manifest lands on disk.
pub(in crate::server) async fn write_plugin_manifest_to_disk(
    manifest: &crate::plugin_manifest::PluginManifest,
) -> Result<(), (StatusCode, String)> {
    let plugin_dir = crate::plugin_manifest::PluginManifestLoader::plugins_dir()
        .join(crate::plugin_manifest::plugin_dir_name(&manifest.id));
    tokio::fs::create_dir_all(&plugin_dir).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to create plugin directory: {e}"),
        )
    })?;
    let manifest_json = serde_json::to_string_pretty(manifest).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to serialize manifest: {e}"),
        )
    })?;
    // Atomic replace: this also rewrites an installed plugin's manifest on
    // update/rollback, and a torn write would make the plugin vanish on reload.
    let manifest_path = plugin_dir.join(crate::plugin_manifest::MANIFEST_FILE_NAME);
    tokio::task::spawn_blocking(move || {
        crate::atomic_file::write_atomic(&manifest_path, manifest_json.as_bytes())
    })
    .await
    .map_err(std::io::Error::other)
    .and_then(|result| result)
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to write manifest: {e}"),
        )
    })?;
    Ok(())
}
