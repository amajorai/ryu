//! Per-plugin BYOK secrets, app update and uninstall, and update-time dependency installs: `disable_app_handler` through `UninstallAppParams`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/apps/:id/disable` — disable the app and clear its approved grants.
#[utoipa::path(
    post,
    path = "/api/plugins/{id}/disable",
    tag = "Plugins",
    summary = "Disable a plugin",
    params(
        ("id" = String, Path),
        ("cascade" = Option<bool>, Query,
         description = "Also disable every enabled plugin that depends on this one \
                        (reverse-topological order). Default false: a disable that \
                        would break a dependent is refused with 409 and the blockers \
                        named in `dependency_error.dependents`."),
        ("dryRun" = Option<bool>, Query,
         description = "Validate and return the disable blast radius without changing state."),
    ),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 404, description = "Plugin is not installed"),
        (status = 409, description = "Enabled plugins depend on this one; retry with ?cascade=true"),
    )
)]
pub(in crate::server) async fn disable_app_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<DisableAppParams>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    use crate::plugins::lifecycle::{disable_app, plan_disable_app, DisableError};

    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_DISABLE,
    )
    .await
    {
        return response;
    }

    let all_manifests: Vec<crate::plugin_manifest::PluginManifest> =
        state.app_manifests.read().await.clone();

    let outcome = if params.dry_run {
        plan_disable_app(
            &state.app_store,
            &id,
            &all_manifests,
            params.cascade,
            params.force,
        )
        .await
    } else {
        disable_app(
            &state.app_store,
            &id,
            &all_manifests,
            params.cascade,
            params.force,
        )
        .await
    };
    match outcome {
        Ok(outcome) => {
            if params.dry_run {
                let disabled_ids: Vec<String> = outcome
                    .disabled
                    .iter()
                    .map(|record| record.id.clone())
                    .collect();
                return Json(json!({
                    "success": true,
                    "dryRun": true,
                    "action": "disable",
                    "app": outcome.target(),
                    "wouldDisable": disabled_ids,
                    "cascade": params.cascade,
                }))
                .into_response();
            }
            // Deactivate every plugin this call disabled, in disable order
            // (dependents first, the target last) — so a dependent is never left
            // running for even an instant against a torn-down dependency.
            let mut disabled_ids: Vec<String> = Vec::new();
            let mut policy_outcome = PolicyApplyOutcome::default();
            for record in &outcome.disabled {
                if let Some(manifest) = all_manifests.iter().find(|m| m.id == record.id) {
                    policy_outcome =
                        policy_outcome.merge(deactivate_plugin(&state, manifest).await);
                }
                disabled_ids.push(record.id.clone());
            }
            // Live contributions refresh — same lossy `system:plugins` nudge as
            // the enable handler, so a disabled plugin's contributions disappear
            // from subscribed shells immediately.
            state.realtime.broadcast_event(
                "system:plugins",
                "plugin.contributions.changed",
                json!({"type": "contributions_changed"}),
            );
            let mut body = json!({
                "success": true,
                "app": outcome.target(),
                // Every plugin disabled by this call (the target plus, when
                // `?cascade=true`, its dependents), in disable order.
                "disabled": disabled_ids,
            });
            // If disabling flipped a gateway policy OFF but the gateway is externally
            // managed, the running gateway was NOT reconfigured — say so.
            attach_gateway_policy_notice(&mut body, policy_outcome);
            Json(body).into_response()
        }
        Err(DisableError::NotInstalled { id }) => json_error(
            StatusCode::NOT_FOUND,
            format!("app '{id}' is not installed"),
        ),
        // Mandatory plugin: required for Core, refused with no override. 403 rather
        // than the 409 below because 409 is the "retry differently" status the
        // desktop's force/cascade prompts key off, and there is no retry here — the
        // client should never have offered the control in the first place (the
        // catalog entry carries `mandatory: true` for exactly that reason).
        Err(DisableError::Mandatory { id }) => (
            StatusCode::FORBIDDEN,
            Json(json!({
                "success": false,
                "error": format!("app '{id}' is required for Ryu to run and cannot be disabled"),
                "code": "mandatory",
                "hint": "this app is part of Core; force does not override it",
            })),
        )
            .into_response(),
        // Load-bearing plugin (engines/durable): disabling it breaks a core function
        // every install relies on, so it is refused unless `?force=true`. 409 with a
        // stable machine code so the desktop can render a "force disable?" prompt.
        Err(DisableError::LoadBearing { id }) => (
            StatusCode::CONFLICT,
            Json(json!({
                "success": false,
                "error": format!(
                    "app '{id}' is load-bearing and cannot be disabled without force"
                ),
                "code": "load_bearing",
                "hint": "retry with ?force=true to disable anyway (this breaks a core function)",
            })),
        )
            .into_response(),
        // Other ENABLED plugins depend on this one. Refuse (the default) with the
        // typed blast radius so the desktop can render "Disable Meetings,
        // Whiteboard, Canvas first" — or re-issue with `?cascade=true`.
        Err(DisableError::Dependency(e)) => (
            StatusCode::CONFLICT,
            Json(json!({
                "success": false,
                "error": e.to_string(),
                "dependency_error": e,
            })),
        )
            .into_response(),
        Err(DisableError::Other(e)) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Immediately suppress a blocked fleet artifact without deleting its local
/// manifest, data, or user-owned lifecycle record.
pub(crate) async fn apply_fleet_plugin_block(state: &ServerState, id: &str) -> Result<(), String> {
    let records = state
        .app_store
        .list_all_records()
        .await
        .map_err(|error| error.to_string())?;
    let Some(record) = records.iter().find(|record| record.id == id) else {
        return Ok(());
    };
    if !record.enabled {
        return Ok(());
    }
    let all_manifests = state.app_manifests.read().await.clone();
    let outcome =
        crate::plugins::lifecycle::disable_app(&state.app_store, id, &all_manifests, true, false)
            .await
            .map_err(|error| error.to_string())?;
    for disabled in &outcome.disabled {
        if let Some(manifest) = all_manifests
            .iter()
            .find(|manifest| manifest.id == disabled.id)
        {
            let _ = deactivate_plugin(state, manifest).await;
        }
    }
    state.realtime.broadcast_event(
        "system:plugins",
        "plugin.contributions.changed",
        json!({"type": "contributions_changed"}),
    );
    Ok(())
}

/// Remove an app only when Fleet originally created its local installation.
/// User installs and adopted on-disk manifests are deliberately preserved.
pub(crate) async fn remove_fleet_owned_plugin(
    state: &ServerState,
    id: &str,
) -> Result<bool, String> {
    let record = state
        .app_store
        .get_record(id)
        .await
        .map_err(|error| error.to_string())?;
    let fleet_owned = record
        .as_ref()
        .and_then(|record| record.provenance.as_ref())
        .and_then(|provenance| provenance.source_id.as_deref())
        == Some("fleet");
    if !fleet_owned {
        return Ok(false);
    }
    let all_manifests = state.app_manifests.read().await.clone();
    let outcome =
        crate::plugins::lifecycle::uninstall_app(&state.app_store, id, &all_manifests, false)
            .await
            .map_err(|error| error.to_string())?;
    for disabled in &outcome.disabled {
        if let Some(manifest) = all_manifests
            .iter()
            .find(|manifest| manifest.id == disabled.id)
        {
            let _ = deactivate_plugin(state, manifest).await;
        }
    }
    if let Some(manifest) = all_manifests
        .iter()
        .find(|manifest| manifest.id == outcome.removed)
    {
        sync_mcp_entry_for_record(state, manifest, McpEntryMutation::Remove).await;
        crate::sidecar::manifest_sidecar::remove_local_sidecar_binaries(manifest).await;
    }
    let removed_id = outcome.removed.clone();
    let removed_for_skills = removed_id.clone();
    let _ = tokio::task::spawn_blocking(move || {
        crate::skills_catalog::plugin_skills::remove_plugin_skills(&removed_for_skills)
    })
    .await;
    if crate::plugin_manifest::validate_plugin_id(&removed_id).is_ok() {
        let plugin_dir = crate::plugin_manifest::PluginManifestLoader::plugins_dir()
            .join(crate::plugin_manifest::plugin_dir_name(&removed_id));
        if plugin_dir.exists() {
            tokio::fs::remove_dir_all(&plugin_dir)
                .await
                .map_err(|error| error.to_string())?;
        }
        reload_manifests_inner(state).await;
    }
    state.realtime.broadcast_event(
        "system:plugins",
        "plugin.contributions.changed",
        json!({"type": "contributions_changed"}),
    );
    Ok(true)
}

/// Query params for `POST /api/plugins/:id/disable`.
#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct DisableAppParams {
    /// When `true`, also disable every ENABLED plugin that depends on this one
    /// (in reverse-topological order, deepest dependent first).
    ///
    /// Defaults to `false`: a disable that would break a dependent is REFUSED
    /// (409) with the blockers named, rather than silently cascading. Destroying
    /// state the user did not ask to destroy is the worse failure, so the cascade
    /// is an explicit opt-in.
    #[serde(default)]
    pub(in crate::server) cascade: bool,
    /// When `true`, override the load-bearing guard and disable a core plugin
    /// (`engines`/`durable`) anyway. Defaults to `false`: disabling one of these
    /// breaks a core function (local chat engine / durable workflow execution), so
    /// it is refused (409, `code: "load_bearing"`) unless explicitly forced.
    #[serde(default)]
    pub(in crate::server) force: bool,
    /// When `true`, resolve the same dependency and safety checks but do not
    /// change lifecycle state or tear down runtime contributions.
    #[serde(rename = "dryRun", default)]
    pub(in crate::server) dry_run: bool,
}

#[derive(serde::Deserialize, Default, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct LifecycleDryRunBody {
    #[serde(default)]
    pub(in crate::server) dry_run: bool,
}

/// Query params for `POST /api/plugins/:id/uninstall`.
#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct UninstallAppParams {
    /// When `true`, disable every ENABLED plugin that depends on this one before
    /// removing the target (reverse-topological order). Defaults to `false`: an
    /// uninstall blocked by an enabled dependent is REFUSED (409) with the blockers
    /// named — the same posture as the disable cascade.
    #[serde(default)]
    pub(in crate::server) cascade: bool,
    /// When `true`, resolve the uninstall blast radius without removing the
    /// lifecycle record, scheduler jobs, or plugin files.
    #[serde(rename = "dryRun", default)]
    pub(in crate::server) dry_run: bool,
}
