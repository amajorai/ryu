//! App lifecycle handlers: isolation, revocation, install, enable, activation, contributions and policies: `install_app_handler` through `install_app_handler`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/apps/:id/install` — record the app as installed (disabled).
#[utoipa::path(
    post,
    path = "/api/plugins/{id}/install",
    tag = "Plugins",
    summary = "Install a built-in plugin by id or preview the install",
    params(("id" = String, Path)),
    request_body = LifecycleDryRunBody,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn install_app_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    body: Option<Json<LifecycleDryRunBody>>,
) -> axum::response::Response {
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_INSTALL,
    )
    .await
    {
        return response;
    }

    let Some(manifest) = find_manifest(&state, &id).await else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("no manifest found for app '{id}'; ensure the ryu.json is loaded"),
        );
    };
    let dry_run = body.is_some_and(|body| body.0.dry_run);
    if dry_run {
        let installed = match state.app_store.get(&id).await {
            Ok(record) => record,
            Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };
        return Json(json!({
            "success": true,
            "dryRun": true,
            "action": "install",
            "app": {
                "id": manifest.id,
                "name": manifest.name,
                "version": manifest.version,
            },
            "currentlyInstalled": installed.is_some(),
            "wouldInstall": installed.is_none(),
            "enabledAfterInstall": false,
        }))
        .into_response();
    }

    // Register the add in the download center, the same way the catalog-resolve
    // path does (`resolve_plugin_from_catalog`), under the SAME `plugin:<id>` row
    // id so a retry dedupes onto one row and the store button can find its own
    // progress by id.
    //
    // Without this, the whole built-in branch was invisible to the global tracker:
    // `/api/plugins/:id/install` is a bare store write with nothing to download,
    // and it is the branch the desktop takes for every `source === "built-in"`
    // listing — i.e. most shipped items. So "install a plugin" was the one
    // long-running action in the app that the download center never mentioned.
    //
    // The wrapped future is deliberately just the store write: it is small and
    // idempotent, because `register_indeterminate_as` races it against a Cancel
    // watch and a Cancel must not be able to tear a half-written record.
    let is_compiled_builtin = crate::plugins::builtins::is_compiled_in_manifest(&manifest.id)
        && crate::plugins::builtins::tier_for_manifest(&manifest)
            == crate::plugin_manifest::PluginTier::Core;
    let ui_code = if is_compiled_builtin {
        crate::plugins::seed::compiled_in_ui_code(&manifest.id).map(str::to_owned)
    } else {
        None
    };
    let provenance = is_compiled_builtin.then(crate::plugins::isolation::PluginProvenance::builtin);
    let installed = state
        .downloads
        .register_indeterminate_as(
            format!("plugin:{id}"),
            crate::downloads::DownloadKind::Other,
            crate::downloads::DownloadRole::Plugin,
            id.clone(),
            async {
                // Built-in opt-in apps are compiled into Core but are deliberately
                // absent from the runtime manifest set until the user installs
                // them. Use the shared persisted-package sink here so the manifest
                // becomes live, the compiled Companion carriage is attached, and
                // subsequent `/api/plugins` reads and enable calls see the same
                // state as every catalog/bundle install.
                persist_installed_plugin(&state, manifest.clone(), ui_code, provenance)
                    .await
                    .map_err(|(_, message)| anyhow::anyhow!(message))?;
                state
                    .app_store
                    .get(&id)
                    .await
                    .map_err(|error| anyhow::anyhow!("Failed to read installed app: {error}"))?
                    .ok_or_else(|| anyhow::anyhow!("app '{id}' disappeared after install"))
            },
        )
        .await;

    match installed {
        Ok(record) => {
            if is_compiled_builtin {
                crate::stats_beacon::refresh_public_marketplace_catalog("app").await;
                crate::stats_beacon::witness_runtime_definition(
                    "app",
                    &id,
                    &manifest.id,
                    &manifest,
                );
                crate::stats_beacon::record_marketplace_event("app", &id, true);
            }
            // Live contributions refresh — same lossy `system:plugins` nudge as
            // the enable handler, so a newly installed plugin's presence reaches
            // subscribed shells immediately.
            state.realtime.broadcast_event(
                "system:plugins",
                "plugin.contributions.changed",
                json!({"type": "contributions_changed"}),
            );
            crate::events::publish_system_notification(
                "App installed",
                format!("{} is installed and ready to enable.", manifest.name),
                "success",
            );
            Json(json!({ "success": true, "app": record })).into_response()
        }
        Err(e) => {
            let msg = e.to_string();
            // Conflict: already installed.
            let status = if msg.contains("UNIQUE constraint") || msg.contains("already") {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, msg)
        }
    }
}
