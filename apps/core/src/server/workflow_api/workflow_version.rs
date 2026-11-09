//! Workflow handlers and sub-agent delegation: `delete_workflow` through `RunWorkflowBody`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    delete,
    path = "/workflows/{id}",
    tag = "Workflows",
    summary = "Delete a workflow",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn delete_workflow(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::WORKFLOW_DELETE,
        crate::acl::KIND_WORKFLOW,
        &id,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: workflow.delete" })),
        );
    }
    match crate::workflow::store::delete_workflow(&id) {
        Ok(true) => {
            // Tear down the trigger resources the workflow created so a deleted
            // workflow stops firing (otherwise its `wf-sched-*` job keeps ticking
            // and `load_workflow` fails forever). Best-effort.
            crate::workflow::triggers::delete_schedule_jobs(&id);
            if let Some(store) = crate::composio_triggers::global() {
                if let Err(e) = store.delete_for_workflow(&id).await {
                    tracing::warn!(workflow = %id, error = %e, "clearing composio subs on workflow delete");
                }
            }
            (StatusCode::OK, Json(json!({ "success": true })))
        }
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "workflow not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

/// `GET /workflows/:id/versions` — list a workflow's saved versions (newest
/// first, metadata only).
#[utoipa::path(
    get,
    path = "/workflows/{id}/versions",
    tag = "Workflows",
    summary = "List workflow versions",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_workflow_versions(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::WORKFLOW_VIEW,
        crate::acl::KIND_WORKFLOW,
        &id,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: workflow.view" })),
        );
    }
    match crate::workflow::store::list_workflow_versions(&id) {
        Ok(versions) => (StatusCode::OK, Json(json!({ "versions": versions }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct CreateWorkflowVersionBody {
    #[serde(default)]
    pub(in crate::server) label: Option<String>,
    /// Exact revision returned by the workflow save acknowledgement.
    #[serde(default, rename = "expectedRevision")]
    pub(in crate::server) expected_revision: Option<String>,
}

#[cfg(test)]
pub(crate) fn isolated_plugin_hook_test_state(directory: &std::path::Path) -> ServerState {
    workflow_version_revision_tests::handler_state(directory)
}

/// `POST /workflows/:id/versions` — checkpoint the workflow's current definition
/// in the local Git history. An explicit label is retained as a named checkpoint
/// even when the definition is unchanged.
#[utoipa::path(
    post,
    path = "/workflows/{id}/versions",
    tag = "Workflows",
    summary = "Snapshot a workflow version",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_workflow_version(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    body: Option<Json<CreateWorkflowVersionBody>>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::WORKFLOW_EDIT,
        crate::acl::KIND_WORKFLOW,
        &id,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: workflow.edit" })),
        );
    }
    let body = body.map(|Json(body)| body);
    let expected_revision = body
        .as_ref()
        .and_then(|body| body.expected_revision.as_deref());
    let label = body
        .as_ref()
        .and_then(|body| body.label.as_ref())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    match crate::workflow::store::checkpoint_current_workflow(
        &id,
        expected_revision,
        label.as_deref(),
    ) {
        Ok(meta) => (StatusCode::OK, Json(json!({ "version": meta }))),
        Err(crate::workflow::store::WorkflowCheckpointError::RevisionConflict(
            current_updated_at,
        )) => (
            StatusCode::CONFLICT,
            Json(json!({
                "success": false,
                "code": "workflow_revision_conflict",
                "error": "workflow revision conflict: it was changed since it was saved",
                "current_updated_at": current_updated_at,
            })),
        ),
        Err(crate::workflow::store::WorkflowCheckpointError::Store(error))
            if error.kind() == std::io::ErrorKind::NotFound =>
        {
            (
                StatusCode::NOT_FOUND,
                Json(json!({ "success": false, "error": "workflow not found" })),
            )
        }
        Err(crate::workflow::store::WorkflowCheckpointError::Store(error)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": error.to_string() })),
        ),
    }
}

/// `GET /workflows/:id/versions/:version_id` — fetch one version in full
/// (including its captured definition).
#[utoipa::path(
    get,
    path = "/workflows/{id}/versions/{version_id}",
    tag = "Workflows",
    summary = "Get a workflow version",
    params(("id" = String, Path), ("version_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_workflow_version(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((id, version_id)): axum::extract::Path<(String, String)>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::WORKFLOW_VIEW,
        crate::acl::KIND_WORKFLOW,
        &id,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: workflow.view" })),
        );
    }
    match crate::workflow::store::load_workflow_version(&id, &version_id) {
        Ok(Some(mut version)) => {
            version.workflow = crate::workflow::secrets::redact_for_listing(version.workflow);
            (StatusCode::OK, Json(json!({ "version": version })))
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "version not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

/// `POST /workflows/:id/versions/:version_id/restore` — restore a version as the
/// workflow's current definition. The current definition is checkpointed first as
/// a named undo point so a restore is itself undoable.
#[utoipa::path(
    post,
    path = "/workflows/{id}/versions/{version_id}/restore",
    tag = "Workflows",
    summary = "Restore a workflow version",
    params(
        ("id" = String, Path),
        ("version_id" = String, Path),
        ("dryRun" = Option<bool>, Query, description = "Preview the restore without changing the workflow or triggers"),
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn restore_workflow_version(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((id, version_id)): axum::extract::Path<(String, String)>,
    Query(query): Query<WorkflowDryRunQuery>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::WORKFLOW_EDIT,
        crate::acl::KIND_WORKFLOW,
        &id,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: workflow.edit" })),
        );
    }
    // Load the target version first — fail fast if it is gone.
    let version = match crate::workflow::store::load_workflow_version(&id, &version_id) {
        Ok(Some(v)) => v,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "success": false, "error": "version not found" })),
            );
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": e.to_string() })),
            );
        }
    };
    if query.dry_run {
        let current_exists = crate::workflow::store::load_workflow(&id).is_ok();
        return (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "dryRun": true,
                "action": "restore",
                "workflowId": id,
                "versionId": version_id,
                "currentExists": current_exists,
                "target": crate::workflow::secrets::redact_for_listing(version.workflow),
                "writes": ["workflow definition", "workflow triggers", "undo checkpoint"],
            })),
        );
    }
    // Snapshot the current definition so the restore can be undone (best-effort:
    // a brand-new workflow with no on-disk file simply has nothing to snapshot).
    if let Ok(current) = crate::workflow::store::load_workflow(&id) {
        let _ = crate::workflow::store::save_workflow_version(&current, Some("Before restore"));
    }
    // Re-persist the captured definition through the shared write path so triggers
    // reconcile and `updated_at` is re-stamped.
    let saver = caller.as_ref().map(|caller| caller.user_id.as_str());
    match crate::workflow::persist_workflow_as(version.workflow, saver).await {
        Ok(workflow) => (
            StatusCode::OK,
            Json(
                json!({ "success": true, "workflow": crate::workflow::secrets::redact_for_client(workflow) }),
            ),
        ),
        Err(e) => {
            let status = if e.contains("cycle")
                || e.contains("unknown node")
                || e.contains("duplicate node")
                || e.contains("sent a redacted")
                || e.contains("Composio trigger")
            {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(json!({ "success": false, "error": e })))
        }
    }
}

#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct WorkflowDryRunQuery {
    #[serde(rename = "dryRun", default)]
    pub(in crate::server) dry_run: bool,
}

#[derive(serde::Deserialize, Default, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct RunWorkflowBody {
    /// Initial input map (key → value) for `Input` nodes.
    #[serde(default)]
    pub(in crate::server) input: std::collections::HashMap<String, String>,
    /// Optional run id to create or resume. Generated when absent.
    #[serde(default, alias = "run_id")]
    pub(in crate::server) run_id: Option<String>,
    /// Evaluate in memory without creating run history or invoking effectful
    /// nodes. The supplied `runId` is ignored in this mode.
    #[serde(default, alias = "dry_run")]
    pub(in crate::server) dry_run: bool,
}
