//! One-step plugin rollback: `POST /api/plugins/:id/rollback`.
//!
//! The update handler saves the version it is about to replace
//! ([`snapshot_before_update`]); this endpoint restores it through the same
//! store transition an update uses ([`crate::plugins::lifecycle::update_app`]),
//! so the enabled bit is preserved and approved grants are reconciled against
//! the restored manifest (a grant the older version never declared is dropped,
//! never added). The replaced version becomes the new snapshot, so a second
//! rollback re-applies the update. Gated by the same `app.update` lifecycle
//! permission as `POST /api/plugins/:id/update`.

use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

use super::{
    enforce_app_lifecycle_permission, find_manifest, json_error, reload_manifests_inner,
    write_plugin_manifest_to_disk, ServerState,
};
use crate::plugin_manifest::PluginManifest;
use crate::plugins::rollback::{self, RollbackSnapshot};
use crate::plugins::PluginRecord;

/// Optional body for `POST /api/plugins/:id/rollback`.
#[derive(Debug, Default, Deserialize)]
pub struct RollbackAppBody {
    /// Validate and report the rollback without changing state.
    #[serde(default, rename = "dryRun")]
    pub dry_run: bool,
    /// Roll back even when an installed dependent declares a version range the
    /// restored version does not satisfy.
    #[serde(default)]
    pub force: bool,
}

/// Save the currently installed version of `record` as its rollback snapshot.
/// Called by the update handler before it mutates anything. A plugin with no
/// resolvable manifest has nothing to restore and is skipped.
pub(super) async fn snapshot_before_update(
    state: &ServerState,
    record: &PluginRecord,
    old_manifest: Option<&PluginManifest>,
) -> Result<(), (StatusCode, String)> {
    let Some(manifest) = old_manifest else {
        tracing::debug!(plugin = %record.id, "no installed manifest to snapshot before update");
        return Ok(());
    };
    let ui_code = state
        .app_store
        .get_ui_code(&record.id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let snapshot = RollbackSnapshot {
        manifest: manifest.clone(),
        ui_code,
        channel: record.channel.clone(),
        provenance: record.provenance.clone(),
        captured_at: chrono::Utc::now().to_rfc3339(),
    };
    rollback::save(&rollback::default_dir(), &snapshot)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("could not keep the previous version for rollback: {e}"),
            )
        })
}

/// Drop the rollback snapshot of an uninstalled plugin. Best-effort.
pub(super) async fn discard(plugin_id: &str) {
    if let Err(error) = rollback::remove(&rollback::default_dir(), plugin_id).await {
        tracing::warn!(plugin = %plugin_id, %error, "could not remove rollback snapshot");
    }
}

/// `POST /api/plugins/:id/rollback` — restore the version the last update
/// replaced.
#[utoipa::path(
    post,
    path = "/api/plugins/{id}/rollback",
    tag = "Plugins",
    summary = "Roll a plugin back to the version its last update replaced",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 404, description = "Plugin not installed or no previous version kept"),
        (status = 409, description = "Already at that version, or a dependent would break"),
    )
)]
pub async fn rollback_app_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    body: Option<Json<RollbackAppBody>>,
) -> Response {
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_UPDATE,
    )
    .await
    {
        return response;
    }
    let body = body.map(|b| b.0).unwrap_or_default();
    let id = id.trim().to_owned();

    let record = match state.app_store.get(&id).await {
        Ok(Some(record)) => record,
        Ok(None) => {
            return json_error(
                StatusCode::NOT_FOUND,
                format!("app '{id}' is not installed"),
            );
        }
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let snapshot = match rollback::load(&rollback::default_dir(), &id).await {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => {
            return json_error(
                StatusCode::NOT_FOUND,
                format!("app '{id}' has no previous version to roll back to"),
            );
        }
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if snapshot.version() == record.version {
        return json_error(
            StatusCode::CONFLICT,
            format!("app '{id}' is already at version {}", record.version),
        );
    }

    // Same reverse-dependency gate as an update: restoring an older version must
    // not silently break an installed dependent's declared range.
    if !body.force {
        let installed_now: Vec<PluginManifest> = state.app_manifests.read().await.clone();
        if let Err(dep_err) =
            crate::plugins::graph::validate_dependents_of_update(&snapshot.manifest, &installed_now)
        {
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "success": false,
                    "error": dep_err.to_string(),
                    "dependency_error": dep_err,
                    "hint": "pass force=true to roll back anyway",
                })),
            )
                .into_response();
        }
    }

    if body.dry_run {
        return Json(json!({
            "success": true,
            "dryRun": true,
            "action": "rollback",
            "app": record,
            "fromVersion": record.version,
            "toVersion": snapshot.version(),
        }))
        .into_response();
    }

    // The version being rolled back FROM becomes the next snapshot.
    let current_manifest = find_manifest(&state, &id).await;
    let current_ui_code = state.app_store.get_ui_code(&id).await.ok().flatten();

    if let Err((status, msg)) = write_plugin_manifest_to_disk(&snapshot.manifest).await {
        return json_error(status, msg);
    }
    let restored = match crate::plugins::lifecycle::update_app(
        &state.app_store,
        &snapshot.manifest,
        snapshot.ui_code.as_deref(),
        true,
    )
    .await
    {
        Ok(restored) => restored,
        Err(e) => {
            if let Some(current) = &current_manifest {
                let _ = write_plugin_manifest_to_disk(current).await;
            }
            reload_manifests_inner(&state).await;
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    };
    let restored = match state
        .app_store
        .set_channel(&id, Some(snapshot.channel.as_str()))
        .await
    {
        Ok(Some(updated)) => updated,
        Ok(None) | Err(_) => restored,
    };
    let restored = match state
        .app_store
        .set_provenance(&id, snapshot.provenance.as_ref())
        .await
    {
        Ok(Some(updated)) => updated,
        Ok(None) | Err(_) => restored,
    };

    if let Some(manifest) = current_manifest {
        let next = RollbackSnapshot {
            manifest,
            ui_code: current_ui_code,
            channel: record.channel.clone(),
            provenance: record.provenance.clone(),
            captured_at: chrono::Utc::now().to_rfc3339(),
        };
        if let Err(error) = rollback::save(&rollback::default_dir(), &next).await {
            tracing::warn!(plugin = %id, %error, "could not keep the rolled-back version");
        }
    }

    // Same post-transition refresh as an update: reload manifests, THEN clear
    // the derived ext-API tools so they re-lower against the restored routes.
    reload_manifests_inner(&state).await;
    state.mcp.clear_ext_api_routes(&id);
    // The restored version's agent identity modes follow the same rule as an
    // update's: only a narrowing the user never overrode applies by itself.
    let agent_identity =
        super::reconcile_app_agent_identities(&state.agent_store, &snapshot.manifest).await;
    state.realtime.broadcast_event(
        "system:plugins",
        "plugin.contributions.changed",
        json!({"type": "contributions_changed"}),
    );
    crate::plugin_host::dispatch_plugin_update(
        &state,
        &id,
        &record.version,
        snapshot.version(),
        "rollback",
    )
    .await;

    let mut payload = json!({
        "success": true,
        "app": restored,
        "from_version": record.version,
        "to_version": snapshot.version(),
    });
    if !agent_identity.is_empty() {
        payload["agent_identity"] = json!(agent_identity);
    }
    Json(payload).into_response()
}
