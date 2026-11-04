//! Per-plugin BYOK secrets, app update and uninstall, and update-time dependency installs: `uninstall_app_handler` through `uninstall_app_handler`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/plugins/:id/uninstall` — disable the plugin (and, with
/// `?cascade=true`, its enabled dependents), tear down its runtime contributions,
/// then remove its lifecycle record. An optional body `{ "cleanup": [...] }`
/// deletes only the app-data rows named by the user in the uninstall review.
///
/// The app's saved secrets are always deleted. Its key-value storage is kept
/// unless the body sets `"delete_storage": true`. Selected app-declared data
/// categories (`data:<id>`) are purged through the app's own `data.purge`
/// BEFORE teardown, while the app can still answer; a failed purge is reported
/// in `cleanup_errors` and never blocks the uninstall.
///
/// # Semantics
///
/// Auto-disable-then-remove (see [`crate::plugins::lifecycle::uninstall_app`]):
/// uninstalling first tears the plugin down through the same path a manual disable
/// takes (reusing [`deactivate_plugin`]'s per-`RunnableKind` teardown + sidecar
/// stop + policy-off), then deletes the record.
///
/// # Refusals
///
/// - **Built-in / pre-installed plugins** → 409 `code: "built_in"`. Their manifest is
///   compiled into the binary and the startup seed would resurrect a removed
///   pre-installed record, so they can only be disabled, never uninstalled — matching
///   how `SystemAppCard` already offers no uninstall.
/// - **Enabled dependents** → 409 with `dependency_error.dependents`, unless
///   `?cascade=true`.
#[utoipa::path(
    post,
    path = "/api/plugins/{id}/uninstall",
    tag = "Plugins",
    summary = "Uninstall a plugin (disable + remove its record)",
    params(
        ("id" = String, Path),
        ("cascade" = Option<bool>, Query,
         description = "Also disable every enabled plugin that depends on this one \
                        before removing it. Default false: an uninstall blocked by a \
                        dependent is refused with 409."),
        ("dryRun" = Option<bool>, Query,
         description = "Validate and return the uninstall blast radius without changing state."),
    ),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 404, description = "Plugin is not installed"),
        (status = 409, description = "Built-in (cannot uninstall) or has enabled dependents"),
    )
)]
pub(in crate::server) async fn uninstall_app_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<UninstallAppParams>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    body: Bytes,
) -> axum::response::Response {
    use crate::plugins::lifecycle::{plan_uninstall_app, uninstall_app, UninstallError};

    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_UNINSTALL,
    )
    .await
    {
        return response;
    }

    let request = if body.is_empty() {
        plugin_uninstall::UninstallRequest::default()
    } else {
        match serde_json::from_slice::<plugin_uninstall::UninstallRequest>(&body) {
            Ok(request) => request,
            Err(error) => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    format!("invalid uninstall cleanup body: {error}"),
                );
            }
        }
    };
    let cleanup = request.effective_cleanup();
    let all_manifests: Vec<crate::plugin_manifest::PluginManifest> =
        state.app_manifests.read().await.clone();

    // Validate first (protected / not installed / dependents) so a refused
    // uninstall never purges anything. Then purge the selected app-declared data
    // while the app is still enabled: `data.purge` goes through the capability
    // broker, which refuses a deactivated provider.
    let plan = plan_uninstall_app(&state.app_store, &id, &all_manifests, params.cascade).await;
    let mut purge_errors = Vec::new();
    let outcome = match plan {
        Ok(plan) if params.dry_run => Ok(plan),
        Ok(_) => {
            if let Some(manifest) = all_manifests.iter().find(|m| m.id == id) {
                purge_errors = plugin_uninstall::purge_app_data(&state, manifest, &cleanup).await;
            }
            uninstall_app(&state.app_store, &id, &all_manifests, params.cascade).await
        }
        Err(error) => Err(error),
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
                    "action": "uninstall",
                    "wouldRemove": outcome.removed,
                    "wouldDisable": disabled_ids,
                    "cascade": params.cascade,
                    "cleanup": cleanup,
                    "cleanupErrors": Vec::<String>::new(),
                }))
                .into_response();
            }
            // Tear down every plugin the uninstall disabled, in disable order
            // (dependents first, target last) — reusing the SAME per-RunnableKind
            // teardown a disable runs. The record was already removed by
            // `uninstall_app`; `deactivate_plugin` operates on the in-memory
            // manifest + subsystems, not the store row, so the order is safe.
            let mut policy_outcome = PolicyApplyOutcome::default();
            for record in &outcome.disabled {
                if let Some(manifest) = all_manifests.iter().find(|m| m.id == record.id) {
                    policy_outcome =
                        policy_outcome.merge(deactivate_plugin(&state, manifest).await);
                }
            }
            // Optional app-data deletion happens only for the rows the user
            // checked in the uninstall confirmation. Mandatory package/runtime
            // teardown remains above; an optional cleanup failure is reported in
            // the 200 response so the app is still fully uninstalled and the user
            // can retry the specific cleanup later after reinstalling if needed.
            let mut cleanup_errors = purge_errors;
            if let Some(manifest) = all_manifests.iter().find(|m| m.id == outcome.removed) {
                cleanup_errors.extend(
                    plugin_uninstall::apply_cleanup(
                        &state,
                        manifest,
                        &cleanup,
                        caller_doc_filter(&caller),
                    )
                    .await,
                );
            } else {
                cleanup_errors.push(format!(
                    "Optional cleanup skipped: manifest for '{}' was not found",
                    outcome.removed
                ));
            }
            // ONE plugin model: uninstalling a synth MCP-server record must also
            // remove its `~/.ryu/mcp.json` entry, else the server keeps running and
            // its tools stay listed/callable — a misleading Uninstall that removed
            // only the governance record. `deactivate_plugin` above already cleared
            // the enabled flag; this drops the entry outright. Best-effort + a
            // no-op for every non-MCP-server manifest.
            if let Some(manifest) = all_manifests.iter().find(|m| m.id == outcome.removed) {
                sync_mcp_entry_for_record(&state, manifest, McpEntryMutation::Remove).await;
                // Remove the app's downloaded `~/.ryu/bin` sidecar binary (the
                // uninstall counterpart to download-on-enable). Disable never reaches
                // here, so a merely-disabled app keeps its bin for an instant
                // re-enable. No-op for apps without a `Local` sidecar.
                crate::sidecar::manifest_sidecar::remove_local_sidecar_binaries(manifest).await;
            }
            // An uninstalled plugin has nothing to roll back to.
            plugin_rollback::discard(&outcome.removed).await;
            // Delete the plugin's bundled Agent Skills from `~/.claude/skills`.
            // `deactivate_plugin` (above) only flipped them inactive + left the
            // files (mirroring a disable); uninstall is where the owner-marked
            // directories are actually removed. Owned-only (never touches a user's
            // hand-installed skill). A no-op for a plugin that bundled none.
            {
                let removed_id = outcome.removed.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    crate::skills_catalog::plugin_skills::remove_plugin_skills(&removed_id)
                })
                .await;
            }
            // Complete the on-disk teardown for the removed target. `uninstall_app`
            // dropped only the lifecycle row; the disk-backed Community plugins that
            // are the ONLY things this path reaches (built-ins are refused earlier)
            // still have their `<plugins_dir>/<id>/manifest.json` on disk and their
            // manifest in `state.app_manifests`. Without this, `list_apps` keeps
            // showing the plugin (installed:false), the orphan `manifest.json` survives
            // reboot, and a reinstall hits the `app_manifests` duplicate guard and
            // 409s. Mirror `rollback_plugin_install`'s dir-removal + reload (the
            // store row is already gone, so we skip its `store.remove`). The id is
            // re-validated before it is used as a path component, and the removal is
            // `exists()`-guarded (a no-op for any compiled-in built-in without a dir).
            if crate::plugin_manifest::validate_plugin_id(&outcome.removed).is_ok() {
                let plugin_dir = crate::plugin_manifest::PluginManifestLoader::plugins_dir()
                    .join(crate::plugin_manifest::plugin_dir_name(&outcome.removed));
                if plugin_dir.exists() {
                    if let Err(e) = tokio::fs::remove_dir_all(&plugin_dir).await {
                        tracing::warn!(
                            plugin = %outcome.removed,
                            "uninstall: failed to remove plugin directory: {e}"
                        );
                    }
                }
                reload_manifests_inner(&state).await;
            } else {
                tracing::warn!(
                    plugin = %outcome.removed,
                    "uninstall: skipping on-disk teardown for a plugin with an invalid id"
                );
            }
            // Live contributions refresh — same lossy `system:plugins` nudge as
            // the enable/disable handlers, so an uninstalled plugin disappears
            // from subscribed shells immediately.
            state.realtime.broadcast_event(
                "system:plugins",
                "plugin.contributions.changed",
                json!({"type": "contributions_changed"}),
            );
            let disabled_ids: Vec<String> = outcome.disabled.iter().map(|r| r.id.clone()).collect();
            let mut body = json!({
                "success": true,
                "removed": outcome.removed,
                // Plugins disabled as part of the uninstall (the target plus, under
                // `?cascade=true`, its dependents). Cascaded dependents stay
                // installed-but-disabled; only the target's record is removed.
                "disabled": disabled_ids,
                "cleanup": cleanup,
                "cleanup_errors": cleanup_errors,
            });
            attach_gateway_policy_notice(&mut body, policy_outcome);
            Json(body).into_response()
        }
        Err(UninstallError::NotInstalled { id }) => json_error(
            StatusCode::NOT_FOUND,
            format!("app '{id}' is not installed"),
        ),
        // Built-in / pre-installed: can only be disabled. 409 with a stable machine
        // code so the desktop renders a "disable instead" affordance.
        Err(UninstallError::Protected { id }) => (
            StatusCode::CONFLICT,
            Json(json!({
                "success": false,
                "error": format!(
                    "app '{id}' is a built-in and can only be disabled, not uninstalled"
                ),
                "code": "built_in",
                "hint": "built-in plugins ship in the binary; disable it instead of uninstalling",
            })),
        )
            .into_response(),
        // Enabled dependents block the uninstall — same typed blast radius a disable
        // uses; retry with `?cascade=true`.
        Err(UninstallError::Dependency(e)) => (
            StatusCode::CONFLICT,
            Json(json!({
                "success": false,
                "error": e.to_string(),
                "dependency_error": e,
            })),
        )
            .into_response(),
        Err(UninstallError::Other(e)) => {
            json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        }
    }
}
