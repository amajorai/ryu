//! Workflow handlers (DAG engine).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Workflow handlers (DAG engine) ──────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/workflows",
    tag = "Workflows",
    summary = "List workflows",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_workflows(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::WORKFLOW_VIEW,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: workflow.view".to_owned(),
        );
    }
    let workflows = crate::workflow::store::list_workflows();
    // Attach the chat-triggerable flag so the desktop composer can filter to
    // the workflows that actually consume a typed message, from the same
    // definition of "has a chat input" Core's `workflow_id` turn route enforces.
    let mut visible_workflows = Vec::new();
    for wf in workflows {
        if enforce_permission_on(
            &state,
            &caller,
            crate::identity_verify::permissions::WORKFLOW_VIEW,
            crate::acl::KIND_WORKFLOW,
            &wf.id,
        )
        .await
        .is_err()
        {
            continue;
        }
        visible_workflows.push(wf);
    }
    let workflows: Vec<serde_json::Value> = visible_workflows
        .into_iter()
        .map(|wf| {
            let chat_input = crate::workflow::accepts_chat_input(&wf);
            serde_json::to_value(crate::workflow::secrets::redact_for_listing(wf))
                .map(|mut v| {
                    v["chat_input"] = serde_json::Value::Bool(chat_input);
                    v
                })
                .unwrap_or(serde_json::Value::Null)
        })
        .collect();
    Json(json!({ "workflows": workflows })).into_response()
}

/// `GET /api/workflows/catalog` — list the curated workflow templates
/// (metadata only). The desktop "Workflow Templates" store section renders these.
#[utoipa::path(
    get,
    path = "/api/workflows/catalog",
    tag = "Workflows",
    summary = "List workflow templates",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_workflow_templates() -> Json<serde_json::Value> {
    Json(json!({ "templates": crate::workflow::templates::catalog_meta() }))
}

/// `GET /api/workflows/catalog/:id` — one template's detail, including a preview
/// graph (the nodes + edges of its primary workflow).
#[utoipa::path(
    get,
    path = "/api/workflows/catalog/{id}",
    tag = "Workflows",
    summary = "Get a workflow template",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_workflow_template(
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::workflow::templates::find(&id) {
        Some(t) => (
            StatusCode::OK,
            Json(json!({
                "template": {
                    "id": t.meta.id,
                    "name": t.meta.name,
                    "description": t.meta.description,
                    "category": t.meta.category,
                    "pattern": t.meta.pattern,
                    "icon": t.meta.icon,
                    "node_count": t.meta.node_count,
                    "tags": t.meta.tags,
                    "source_url": t.meta.source_url,
                    // Preview graph: the primary workflow's nodes + edges.
                    "nodes": t.primary.nodes,
                    "edges": t.primary.edges,
                }
            })),
        ),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "template not found" })),
        ),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct InstallTemplateBody {
    pub(in crate::server) template_id: String,
    #[serde(rename = "dryRun", default)]
    pub(in crate::server) dry_run: bool,
}

/// `POST /api/workflows/catalog/install` — install a template into the user's
/// workflows. Mints fresh ids for the primary + any body workflows, patches the
/// durable `while` body references, persists them all, and returns the primary
/// workflow id (navigate to `/workflows/:id`).
#[utoipa::path(
    post,
    path = "/api/workflows/catalog/install",
    tag = "Workflows",
    summary = "Install a workflow template or preview the new workflows",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn install_workflow_template(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<InstallTemplateBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(response) = enforce_app_lifecycle_permission_json(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_INSTALL,
    )
    .await
    {
        return response;
    }
    if body.dry_run {
        let Some(template) = crate::workflow::templates::find(&body.template_id) else {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "success": false, "error": "template not found" })),
            );
        };
        return (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "dryRun": true,
                "action": "install",
                "templateId": body.template_id,
                "primary": template.meta,
                "bodyCount": template.bodies.len(),
                "wouldCreate": template.bodies.len() + 1,
                "writes": ["workflow definitions", "workflow trigger schedules"],
            })),
        );
    }
    match crate::workflow::templates::install(&body.template_id).await {
        Ok(workflow) => {
            let workflow_id = workflow.id.clone();
            crate::stats_beacon::witness_public_marketplace_install("workflow", &body.template_id)
                .await;
            crate::stats_beacon::associate_marketplace_runtime(
                "workflow",
                &body.template_id,
                &workflow_id,
            );
            crate::stats_beacon::witness_runtime_definition(
                "workflow",
                &body.template_id,
                &workflow_id,
                &workflow,
            );
            crate::stats_beacon::record_marketplace_event("workflow", &body.template_id, true);
            (StatusCode::OK, Json(json!({ "workflow_id": workflow_id })))
        }
        Err(e) => {
            let status = if e.contains("unknown template") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(json!({ "success": false, "error": e })))
        }
    }
}

#[utoipa::path(
    post,
    path = "/workflows",
    tag = "Workflows",
    summary = "Create a workflow",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_workflow(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(workflow): Json<crate::workflow::Workflow>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::WORKFLOW_EDIT,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: workflow.edit" })),
        );
    }
    // Saving over an existing workflow is an edit of THAT workflow, so the
    // per-resource ACL applies exactly as it does to the other by-id routes; the
    // role check above alone would let a member overwrite a workflow an explicit
    // overwrite denies them.
    let stored = if workflow.id.is_empty() {
        None
    } else {
        crate::workflow::store::load_workflow(&workflow.id).ok()
    };
    if stored.is_some()
        && enforce_permission_on(
            &state,
            &caller,
            crate::identity_verify::permissions::WORKFLOW_EDIT,
            crate::acl::KIND_WORKFLOW,
            &workflow.id,
        )
        .await
        .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: workflow.edit" })),
        );
    }
    if let Some(current_updated_at) = crate::workflow::stale_revision(stored.as_ref(), &workflow) {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "success": false,
                "code": "workflow_revision_conflict",
                "error": "workflow revision conflict: it was changed since it was loaded",
                "current_updated_at": current_updated_at,
                "workflow": stored.map(crate::workflow::secrets::redact_for_client),
            })),
        );
    }
    // Validate → stamp → save → reconcile triggers via the single shared write
    // path so the REST handler and the chat-driven workflow_builder behave
    // identically. A DAG-validation failure surfaces as a 400; any other error
    // (e.g. a disk write failure) as a 500.
    let workflow_id_for_conflict = workflow.id.clone();
    let saver = caller.as_ref().map(|caller| caller.user_id.as_str());
    match crate::workflow::persist_workflow_guarded_as(workflow, saver).await {
        Ok(workflow) => (
            StatusCode::OK,
            Json(
                json!({ "success": true, "workflow": crate::workflow::secrets::redact_for_client(workflow) }),
            ),
        ),
        Err(crate::workflow::WorkflowPersistError::RevisionConflict(current_updated_at)) => (
            StatusCode::CONFLICT,
            Json(json!({
                "success": false,
                "code": "workflow_revision_conflict",
                "error": "workflow revision conflict: it was changed since it was loaded",
                "current_updated_at": current_updated_at,
                "workflow": crate::workflow::store::load_workflow(&workflow_id_for_conflict)
                    .ok()
                    .map(crate::workflow::secrets::redact_for_client),
            })),
        ),
        Err(crate::workflow::WorkflowPersistError::Invalid(e)) => {
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

#[utoipa::path(
    get,
    path = "/workflows/{id}",
    tag = "Workflows",
    summary = "Get a workflow",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_workflow(
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
    match crate::workflow::store::load_workflow(&id) {
        Ok(wf) => (
            StatusCode::OK,
            Json(
                json!({ "workflow": workflow_access::workflow_view_for_caller(&state, &caller, &id, wf).await }),
            ),
        ),
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "workflow not found" })),
        ),
    }
}
