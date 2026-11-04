//! Engines, personas, the agent catalog and runtime installs, and agent/prompt versioning: `list_agent_versions` through `restore_agent_version`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/agents/:id/versions` — list complete agent-definition snapshots.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/versions",
    tag = "Agents",
    summary = "List an agent's configuration versions",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_agent_versions(
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
    match state.agent_store.list_config_versions(&id).await {
        Ok(versions) => Json(json!({ "versions": versions })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// `POST /api/agents/:id/versions` — checkpoint the current complete agent
/// definition in the local immutable source history.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/versions",
    tag = "Agents",
    summary = "Save an agent configuration version",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_agent_version(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    body: Option<Json<CreateAgentVersionBody>>,
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
    let label = body
        .and_then(|Json(value)| value.label)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    match state
        .agent_store
        .snapshot_config_version(&id, label.as_deref())
        .await
    {
        Ok(Some(version)) => Json(json!({ "version": version })).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "agent not found".to_owned()),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// `GET /api/agents/:id/versions/:version_id` — fetch one complete agent
/// configuration version, including the canonical source used for diffing.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/versions/{version_id}",
    tag = "Agents",
    summary = "Get an agent configuration version",
    params(("id" = String, Path), ("version_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_agent_version(
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
    match state.agent_store.get_config_version(&id, &version_id).await {
        Ok(Some(version)) => Json(json!({ "version": version })).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "version not found".to_owned()),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// `POST /api/agents/:id/versions/:version_id/restore` — restore a complete
/// agent definition. The current definition is checkpointed first, making the
/// restore itself undoable through the same history endpoint.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/versions/{version_id}/restore",
    tag = "Agents",
    summary = "Restore an agent configuration version",
    params(("id" = String, Path), ("version_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn restore_agent_version(
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
        .restore_config_version(&id, &version_id)
        .await
    {
        Ok(Some(record)) => {
            record_gateway_control_attributed(
                &state,
                "agent.version.restore",
                &format!("agent:{id}"),
                Some(&format!("restored agent version {version_id}")),
                &caller,
                Some(&id),
            )
            .await;
            let source = serde_json::to_string_pretty(&record).unwrap_or_default();
            Json(json!({ "success": true, "agent": record, "source": source })).into_response()
        }
        Ok(None) => json_error(StatusCode::NOT_FOUND, "version not found".to_owned()),
        Err(error) => {
            let message = error.to_string();
            let status = if message.contains("locked")
                || message.contains("lifecycle")
                || message.contains("identity")
            {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, message)
        }
    }
}
