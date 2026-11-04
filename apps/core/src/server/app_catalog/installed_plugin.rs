//! App catalog browse, install-from-URL and hot reload: `persist_installed_plugin` through `update_installed_plugin_bundle`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Shared sink that persists a validated plugin manifest (+ optional
/// pre-validated `ui_code`) to disk and the lifecycle store, then hot-reloads.
/// Used by BOTH the local install-bundle path ([`install_app_bundle`]) and the
/// marketplace catalog-install path ([`install_plugin_from_catalog`]) so the two
/// never drift.
///
/// The caller owns any TRUST decision about `ui_code` (the local path trusts the
/// caller; the marketplace path has already run the signed-hash integrity gate in
/// `install_descriptor`). This function only validates id/semver/runnables,
/// enforces the size cap, rejects a duplicate id, writes the manifest WITHOUT the
/// `ui_code` (the loader contract), records the lifecycle row, and stores
/// `ui_code` on that row via the same `set_ui_code` sink the `ui-bundle` endpoint
/// reads. Returns the success JSON body, or `(status, msg)` on any failure.
pub(in crate::server) async fn persist_installed_plugin(
    state: &ServerState,
    manifest: crate::plugin_manifest::PluginManifest,
    ui_code: Option<String>,
    provenance: Option<crate::plugins::isolation::PluginProvenance>,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let provenance =
        provenance.map(|p| crate::plugins::lifecycle::capture_provenance(&manifest, &p));
    if let Some(provenance) = provenance.as_ref() {
        // Make the digest-bound official provenance visible to the same tier
        // resolver used by runtime serialization before applying HTTP authority.
        crate::plugins::builtins::record_verified_official_package(&manifest, provenance);
    }
    let allow_core_routes = crate::plugins::builtins::tier_for_manifest(&manifest)
        == crate::plugin_manifest::PluginTier::Core;
    if let Err(error) = manifest.validate_declarative_http_policy(allow_core_routes) {
        return Err((StatusCode::UNPROCESSABLE_ENTITY, error));
    }
    if crate::fleet::is_artifact_blocked(&manifest.id) {
        return Err((
            StatusCode::FORBIDDEN,
            format!("plugin '{}' is blocked by organization policy", manifest.id),
        ));
    }
    // Validate the id BEFORE it is ever used as a filesystem path component.
    if let Err(e) = crate::plugin_manifest::validate_plugin_id(&manifest.id) {
        return Err((StatusCode::UNPROCESSABLE_ENTITY, e));
    }
    if semver::Version::parse(&manifest.version).is_err() {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "manifest version '{}' is not valid semver",
                manifest.version
            ),
        ));
    }
    // HOST-FLOOR GATE, second line. `resolve_plugin_from_catalog` already refuses
    // an incompatible plugin on the catalog path, but this is the sink EVERY
    // install path shares — install-from-URL, install-bundle and the built-in
    // install-by-id never touch that resolver. Without a check here they would
    // write a plugin to disk and to the lifecycle store that the next manifest load
    // moves straight into the incompatible lane: installed, inert, and reported to
    // the user as a success.
    //
    // Blocking entries only, for the same reason as everywhere else — a floor
    // against a surface Core cannot observe must not make a plugin uninstallable.
    if let Some(engines) = &manifest.engines {
        let verdict = crate::plugin_manifest::node_host_versions().evaluate(Some(engines));
        if !verdict.compatible {
            let detail: Vec<String> = verdict
                .blocking()
                .map(|u| match u {
                    crate::plugin_manifest::UnmetRequirement::TooOld {
                        surface,
                        required,
                        present,
                    } => format!(
                        "{} {required} (this node has {present})",
                        surface.engines_key()
                    ),
                    crate::plugin_manifest::UnmetRequirement::HostApiTooOld {
                        required,
                        present,
                        ..
                    } => format!("host API {required} (this node serves {present})"),
                    other => format!("{} {}", other.surface().engines_key(), "requirement unmet"),
                })
                .collect();
            return Err((
                StatusCode::CONFLICT,
                format!(
                    "`{}` requires {} — update Ryu to install it",
                    manifest.id,
                    detail.join(", ")
                ),
            ));
        }
    }
    for entry in &manifest.runnables {
        if let Err(e) = crate::plugin_manifest::schema::validate_runnable(entry) {
            return Err((
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("Invalid runnable '{}': {e}", entry.id),
            ));
        }
    }
    if let Some(code) = &ui_code {
        if code.len() > MAX_UI_CODE_BYTES {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                "ui_code bundle is too large".to_owned(),
            ));
        }
    }
    // Same cap for the inline node-backend bundle (rides on the manifest, not the
    // `ui_code` carriage). Every install path funnels through here, so a
    // pathological backend is refused before it ever lands on disk.
    if let Some(code) = &manifest.backend_code {
        if code.len() > MAX_BACKEND_CODE_BYTES {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                "backend_code bundle is too large".to_owned(),
            ));
        }
    }

    {
        let already_loaded = state
            .app_manifests
            .read()
            .await
            .iter()
            .any(|entry| entry.id == manifest.id);
        let installed_record = state
            .app_store
            .get_record(&manifest.id)
            .await
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
        // Discovery alone does not establish installed lifecycle state.
        // Adopt a discovered package with no record through this validated sink.
        if already_loaded && installed_record.is_some() {
            return Err((
                StatusCode::CONFLICT,
                format!("Plugin '{}' is already installed", manifest.id),
            ));
        }
    }

    // Persist the manifest to disk (same resolver the loader reads) WITHOUT the
    // `ui_code` blob — the code lives on the lifecycle record, not the on-disk
    // manifest (which is the loader's contract + keeps manifests small).
    write_plugin_manifest_to_disk(&manifest).await?;

    reload_manifests_inner(state).await;

    // Adopt an orphaned lifecycle row when an upgrade is materializing a package
    // that used to exist only as a compiled manifest. Preserve its enabled bit and
    // approved grants; those are user state, not package material.
    if let Some(existing) = state
        .app_store
        .get_record(&manifest.id)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read plugin lifecycle record: {e}"),
            )
        })?
    {
        if let Err(e) = crate::plugins::lifecycle::update_app(
            &state.app_store,
            &manifest,
            ui_code.as_deref(),
            false,
        )
        .await
        {
            return Err((StatusCode::CONFLICT, e.to_string()));
        }
        if let Err(e) = state
            .app_store
            .set_provenance(&manifest.id, provenance.as_ref())
            .await
        {
            tracing::warn!(plugin = %manifest.id, "could not refresh adopted plugin provenance: {e}");
        }
        if ui_code.is_some() {
            state
                .app_store
                .set_ui_code(&manifest.id, ui_code.as_deref())
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Failed to store ui_code: {e}"),
                    )
                })?;
        }
        tracing::info!(plugin = %manifest.id, enabled = existing.enabled, "materialized package for existing lifecycle record");
    } else if let Err(e) = crate::plugins::lifecycle::install_app_with_provenance(
        &state.app_store,
        &manifest,
        provenance.as_ref(),
    )
    .await
    {
        let msg = e.to_string();
        return Err((StatusCode::INTERNAL_SERVER_ERROR, msg));
    }
    if let Some(code) = &ui_code {
        if let Err(e) = state.app_store.set_ui_code(&manifest.id, Some(code)).await {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to store ui_code: {e}"),
            ));
        }
    }

    Ok(json!({
        "success": true,
        "app": { "id": manifest.id, "name": manifest.name, "version": manifest.version },
        "has_ui": ui_code.is_some(),
    }))
}

/// Replace an installed app with an explicitly supplied local carriage. This is
/// the update half of the standalone host contract: the local bundle has already
/// passed the same manifest, code-source, size, and hash validation as install,
/// so it does not need a Marketplace re-resolve. Existing enabled state, grants,
/// and provenance remain user state.
pub(in crate::server) async fn update_installed_plugin_bundle(
    state: &ServerState,
    manifest: crate::plugin_manifest::PluginManifest,
    ui_code: Option<String>,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let id = manifest.id.clone();
    let old_manifest = state
        .app_manifests
        .read()
        .await
        .iter()
        .find(|candidate| candidate.id == id)
        .cloned()
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("App '{id}' is not installed"),
            )
        })?;
    let old_record = state
        .app_store
        .get_record(&id)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("App '{id}' has no lifecycle record"),
            )
        })?;

    write_plugin_manifest_to_disk(&manifest).await?;
    reload_manifests_inner(state).await;

    let update_result = if old_record.version == manifest.version {
        state
            .app_store
            .set_ui_code(&id, ui_code.as_deref())
            .await
            .map(|_| ())
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
    } else {
        crate::plugins::lifecycle::update_app(&state.app_store, &manifest, ui_code.as_deref(), true)
            .await
            .map(|_| ())
            .map_err(|error| (StatusCode::CONFLICT, error.to_string()))
    };
    if let Err(error) = update_result {
        let _ = write_plugin_manifest_to_disk(&old_manifest).await;
        reload_manifests_inner(state).await;
        return Err(error);
    }

    let kept_agents = app_agents_kept_by_update(&old_manifest, &manifest);
    if old_record.enabled {
        let _ = deactivate_plugin_keeping_agents(state, &old_manifest, &kept_agents).await;
    }
    let updated = state
        .app_store
        .get_record(&id)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("App '{id}' disappeared during standalone update"),
            )
        })?;
    let mut agent_identity = Vec::new();
    if updated.enabled {
        // Activate the manifest Core loaded after the disk write, rather than the
        // raw bundle carriage. The loader applies canonical IDs, code hydration,
        // and the same normalization used for compiled trust decisions; using the
        // unnormalized request here can downgrade a built-in bundle to Community
        // and make the Gateway withhold its reviewed sidecar grant.
        let activation_manifest = state
            .app_manifests
            .read()
            .await
            .iter()
            .find(|candidate| candidate.id == id)
            .cloned()
            .unwrap_or(manifest.clone());
        // Reconcile the kept agents' identity modes before activation, so the
        // response can report what the update narrowed or left pending
        // (activation then finds them settled).
        agent_identity =
            reconcile_app_agent_identities(&state.agent_store, &activation_manifest).await;
        let _ = activate_plugin(state, &activation_manifest, &updated).await;
        refresh_kept_app_agents(&state.agent_store, &activation_manifest, &kept_agents).await;
    }
    state.mcp.clear_ext_api_routes(&id);
    state.realtime.broadcast_event(
        "system:plugins",
        "plugin.contributions.changed",
        json!({"type": "contributions_changed"}),
    );

    let mut body = json!({
        "success": true,
        "app": updated,
        "has_ui": ui_code.is_some(),
    });
    if !agent_identity.is_empty() {
        body["agent_identity"] = json!(agent_identity);
    }
    Ok(body)
}
