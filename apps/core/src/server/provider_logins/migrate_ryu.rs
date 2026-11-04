//! Ryu Pi config, subscription OAuth login and published agents: `migrate_to_ryu` through `active_published_agent_source`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/agents/:id/migrate-to-ryu`
///
/// Reads the source agent (persona/tools/model), then creates-or-updates the
/// Ryu agent (id = "ryu", engine = "acp:pi") with those slots. The source
/// agent is never modified; migration is a copy. Returns the updated Ryu agent
/// and a summary of the fields that were carried over.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/migrate-to-ryu",
    tag = "Agents",
    summary = "Migrate an agent onto the Ryu engine",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn migrate_to_ryu(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(source_id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    if crate::sidecar::control_plane::is_managed_node()
        || crate::sidecar::control_plane::registered_org().is_some()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "agent migration is disabled on managed nodes until source and destination ACLs are bound"
            })),
        );
    }
    if enforce_agent_resource_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
        &source_id,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: agent.view" })),
        );
    }
    // Fetch the full source record (includes tools, which the list endpoint omits).
    let source = match state.agent_store.get(&source_id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("agent '{source_id}' not found") })),
            );
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            );
        }
    };

    // Deny migrating the Ryu agent onto itself.
    if source_id == RYU_AGENT_ID {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "cannot migrate the Ryu agent to itself" })),
        );
    }

    // Collect the fields that will be carried over for the summary.
    let carried = {
        let mut c = vec![];
        if source.system_prompt.is_some() {
            c.push("system_prompt");
        }
        if !source.tools.is_empty() {
            c.push("tools");
        }
        if source.model.is_some() {
            c.push("model");
        }
        if source.persona.is_some() {
            c.push("persona");
        }
        c
    };

    // Create-or-update the Ryu agent. Ryu is always bound to acp:pi.
    let ryu_agent = match state.agent_store.get(RYU_AGENT_ID).await {
        Ok(Some(_existing)) => {
            // Update the existing Ryu card with the source agent's slots.
            let patch = crate::agents::UpdateAgent {
                name: Some(format!("Ryu (migrated from {})", source.name)),
                description: Some(format!(
                    "Ryu agent — Pi + Gateway. Migrated from '{}'.",
                    source.name
                )),
                system_prompt: Some(source.system_prompt.clone().unwrap_or_default()),
                tools: Some(source.tools.clone()),
                model: source.model.clone(),
                engine: Some("acp:pi".to_owned()),
                persona: source.persona.clone(),
                ..Default::default()
            };
            match state.agent_store.update(RYU_AGENT_ID, patch).await {
                Ok(Some(r)) => r,
                Ok(None) => {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(json!({ "error": "Ryu agent disappeared during update" })),
                    );
                }
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "error": e.to_string() })),
                    );
                }
            }
        }
        Ok(None) => {
            // No Ryu agent yet — create it under the stable well-known id so the
            // UI can always refer to it by "ryu" rather than a random uuid.
            let input = crate::agents::CreateAgent {
                name: format!("Ryu (migrated from {})", source.name),
                description: Some(format!(
                    "Ryu agent — Pi + Gateway. Migrated from '{}'.",
                    source.name
                )),
                system_prompt: source.system_prompt.clone(),
                tools: source.tools.clone(),
                model: source.model.clone(),
                engine: Some("acp:pi".to_owned()),
                persona: source.persona.clone(),
                ..Default::default()
            };
            match state
                .agent_store
                .create_with_id(RYU_AGENT_ID.to_owned(), input)
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "error": e.to_string() })),
                    );
                }
            }
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            );
        }
    };

    (
        StatusCode::OK,
        Json(json!({
            "ryu_agent": ryu_agent,
            "source_id": source_id,
            "carried": carried,
        })),
    )
}

/// `GET /api/agents/:id/export`
///
/// Returns a portable agent template JSON that captures name, version, system
/// prompt, tools, engine, and per-attribute slots. The template can be imported
/// via `POST /api/agents/import` to create a new, unlocked copy with a fresh id.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/export",
    tag = "Agents",
    summary = "Export an agent as a template",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn export_agent(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
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
        return no_store_response(
            (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "insufficient permissions: agent.view" })),
            )
                .into_response(),
        );
    }
    let response = match state.agent_store.get(&id).await {
        Ok(Some(record)) => {
            let mut template = record.to_template();
            template.agent_config.schedules = agent_schedule_templates(&id);
            (StatusCode::OK, Json(json!({ "template": template }))).into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("agent '{id}' not found") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    };
    no_store_response(response)
}

/// `POST /api/agents/import`
///
/// Creates a new agent from a portable agent template (as produced by
/// `GET /api/agents/:id/export`). The imported agent always gets a fresh
/// server-assigned id and starts unlocked — the caller owns their copy and
/// can edit it freely. Name, version, system prompt, tools, engine, and
/// per-attribute slots are all round-tripped from the template.
#[utoipa::path(
    post,
    path = "/api/agents/import",
    tag = "Agents",
    summary = "Import an agent from a template",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn import_agent(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    // Same RBAC gate as `create_agent`: route admission alone (AgentsManage) is
    // held by every node-token caller, so a bound node must still check the role.
    // The `audit_agent_control` route layer records the `agent.import` row.
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: agent.edit" })),
        );
    }
    // Accept both `{ "template": { ... } }` (export envelope) and a bare template.
    let raw_template = body.get("template").cloned().unwrap_or(body);
    let template: AgentTemplate = match serde_json::from_value(raw_template) {
        Ok(t) => t,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid agent template: {e}") })),
            );
        }
    };
    if template.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "template name is required" })),
        );
    }
    if let Err(error) = validate_agent_schedules(&template.agent_config.schedules) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": error })));
    }
    let mut schedules = template.agent_config.schedules.clone();
    retain_caller_owned_schedule_conversations(&state, &caller, &mut schedules).await;
    let input = template.into_create_agent();
    match state.agent_store.create(input).await {
        Ok(record) => {
            if let Err(error) =
                persist_agent_schedules(&record.id, &record.name, &schedules, caller.as_ref())
            {
                let _ = state.agent_store.delete(&record.id).await;
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(
                        json!({ "error": format!("agent created, but schedules could not be saved: {error}") }),
                    ),
                );
            }
            (StatusCode::CREATED, Json(json!({ "agent": record })))
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// The active [`CatalogKind::Agent`] source (defaults to the built-in primary).
pub(in crate::server) async fn active_published_agent_source(
    state: &ServerState,
) -> Option<crate::catalog_source::Source> {
    state
        .catalog_sources
        .get_active(
            crate::catalog_source::CatalogKind::Agent,
            &state.preferences,
        )
        .await
}
