//! Engines, personas, the agent catalog and runtime installs, and agent/prompt versioning: `get_agent` through `CreateAgentVersionBody`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    get,
    path = "/api/agents/{id}",
    tag = "Agents",
    summary = "Get an agent by id",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_agent(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    if !crate::fleet::is_agent_available(&id) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("agent '{id}' not found") })),
        );
    }
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
        crate::acl::KIND_AGENT,
        &id,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: agent.view" })),
        );
    }
    match state.agent_store.get(&id).await {
        Ok(Some(record)) => {
            let source = serde_json::to_string_pretty(&record).unwrap_or_default();
            let mut body = json!({ "agent": record, "source": source });
            // An app's agent carries the mode its app last set and any mode a newer
            // app version asked for that waits for the user (`pending_mode`).
            if let Ok(Some(app_identity)) = state.agent_store.app_identity(&id).await {
                body["app_identity"] = json!(app_identity);
            }
            (StatusCode::OK, Json(body))
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("agent '{id}' not found") })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    put,
    path = "/api/agents/{id}",
    tag = "Agents",
    summary = "Update an agent",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn update_agent(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(patch): Json<UpdateAgent>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
        crate::acl::KIND_AGENT,
        &id,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: agent.edit" })),
        );
    }
    let lifecycle_change = patch.lifecycle_status;
    match state.agent_store.update(&id, patch).await {
        Ok(Some(record)) => {
            if !matches!(
                lifecycle_change,
                None | Some(crate::agents::AgentLifecycleStatus::Active)
            ) {
                if let Err(error) = disable_agent_schedules(&id) {
                    tracing::warn!(
                        "agent '{id}' entered {} but schedules could not be disabled: {error}",
                        record.lifecycle_status.as_str()
                    );
                }
            }
            let source = serde_json::to_string_pretty(&record).unwrap_or_default();
            (
                StatusCode::OK,
                Json(json!({ "agent": record, "source": source })),
            )
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("agent '{id}' not found") })),
        ),
        Err(e)
            if e.downcast_ref::<crate::agents::AgentUpdateConflict>()
                .is_some() =>
        {
            // Someone else saved this agent after the caller loaded it. Return the
            // current record so the client can reload and reapply its edit.
            let current = state.agent_store.get(&id).await.ok().flatten();
            (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": e.to_string(),
                    "code": "agent_revision_conflict",
                    "agent": current,
                })),
            )
        }
        Err(e) => {
            let msg = e.to_string();
            // The store returns an error whose message contains "locked" when the
            // agent is immutable. Surface this as 409 Conflict so the client can
            // distinguish a policy rejection from an internal error.
            let status = if msg.contains("locked") {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(json!({ "error": msg })))
        }
    }
}

#[derive(Debug, Deserialize, Default)]
pub(in crate::server) struct CreateAgentPromptVersionBody {
    /// Optional editor draft. When omitted, the stored system prompt is used.
    #[serde(default)]
    pub(in crate::server) prompt: Option<String>,
    #[serde(default)]
    pub(in crate::server) label: Option<String>,
}

/// `GET /api/agents/:id/prompt-versions` — list Prompt Studio snapshots.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/prompt-versions",
    tag = "Agents",
    summary = "List an agent's prompt versions",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_agent_prompt_versions(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    if let Err(status) = enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
        crate::acl::KIND_AGENT,
        &id,
    )
    .await
    {
        return (
            status,
            Json(json!({ "error": "insufficient permissions: agent.view" })),
        )
            .into_response();
    }
    match state.agent_store.list_prompt_versions(&id).await {
        Ok(versions) => Json(json!({ "versions": versions })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// `POST /api/agents/:id/prompt-versions` — save a Prompt Studio snapshot.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/prompt-versions",
    tag = "Agents",
    summary = "Save an agent prompt version",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_agent_prompt_version(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    body: Option<Json<CreateAgentPromptVersionBody>>,
) -> axum::response::Response {
    if let Err(status) = enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
        crate::acl::KIND_AGENT,
        &id,
    )
    .await
    {
        return (
            status,
            Json(json!({ "error": "insufficient permissions: agent.edit" })),
        )
            .into_response();
    }
    let body = body.map(|Json(value)| value).unwrap_or_default();
    let label = body
        .label
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    match state
        .agent_store
        .snapshot_prompt(&id, body.prompt.as_deref(), label.as_deref())
        .await
    {
        Ok(Some(version)) => Json(json!({ "version": version })).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "agent not found".to_owned()),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// `GET /api/agents/:id/prompt-versions/:version_id` — fetch one snapshot.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/prompt-versions/{version_id}",
    tag = "Agents",
    summary = "Get an agent prompt version",
    params(
        ("id" = String, Path),
        ("version_id" = String, Path),
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_agent_prompt_version(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((id, version_id)): Path<(String, String)>,
) -> axum::response::Response {
    if let Err(status) = enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
        crate::acl::KIND_AGENT,
        &id,
    )
    .await
    {
        return (
            status,
            Json(json!({ "error": "insufficient permissions: agent.view" })),
        )
            .into_response();
    }
    match state.agent_store.get_prompt_version(&id, &version_id).await {
        Ok(Some(version)) => Json(json!({
            "version": {
                "agent_id": version.agent_id,
                "created_at": version.created_at,
                "id": version.id,
                "label": version.label,
                "prompt": version.prompt,
                "source": version.prompt,
            }
        }))
        .into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "prompt version not found".to_owned()),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// `POST /api/agents/:id/prompt-versions/:version_id/restore` — restore a snapshot.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/prompt-versions/{version_id}/restore",
    tag = "Agents",
    summary = "Restore an agent prompt version",
    params(("id" = String, Path), ("version_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn restore_agent_prompt_version(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((id, version_id)): Path<(String, String)>,
) -> axum::response::Response {
    if let Err(status) = enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
        crate::acl::KIND_AGENT,
        &id,
    )
    .await
    {
        return (
            status,
            Json(json!({ "error": "insufficient permissions: agent.edit" })),
        )
            .into_response();
    }
    match state
        .agent_store
        .restore_prompt_version(&id, &version_id)
        .await
    {
        Ok(Some(prompt)) => Json(json!({
            "success": true,
            "prompt": prompt,
            "source": prompt.clone()
        }))
        .into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "prompt version not found".to_owned()),
        Err(error) => {
            let message = error.to_string();
            let status = if message.contains("locked") {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, message)
        }
    }
}

#[derive(Debug, Deserialize, Default)]
pub(in crate::server) struct CreateAgentVersionBody {
    /// Optional human-readable checkpoint label.
    #[serde(default)]
    pub(in crate::server) label: Option<String>,
}
