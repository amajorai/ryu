//! MCP server CRUD, the MCP catalog and OpenAPI/GraphQL tool import: `resolved_agent_tool_allowlist` through `enforce_mcp_configuration`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Resolve the effective MCP tool scope for an agent. The operator environment
/// override wins over the persisted agent card. When
/// neither is configured, the card's empty legacy value and `*` marker both
/// resolve to unrestricted access; an explicit no-capabilities marker resolves
/// to an empty allowlist.
pub(in crate::server) async fn resolved_agent_tool_allowlist(
    state: &ServerState,
    agent_id: &str,
) -> Option<Vec<String>> {
    if let Some(allowlist) = state.agents.allowlist_for(agent_id) {
        return Some(allowlist);
    }
    state
        .agent_store
        .get(agent_id)
        .await
        .ok()
        .flatten()
        .and_then(|record| record.mcp_tool_allowlist())
}

pub(in crate::server) async fn oauth_discovery_identity(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    agent: Option<&str>,
) -> Result<Option<crate::sidecar::mcp::catalog::AgentDiscovery>, axum::response::Response> {
    if !crate::mcp_oauth::remote_configured() {
        return Ok(None);
    }
    let Some(agent) = agent else {
        return Ok(None);
    };
    enforce_permission_on(
        state,
        caller,
        crate::identity_verify::permissions::AGENT_VIEW,
        crate::acl::KIND_AGENT,
        agent,
    )
    .await
    .map_err(|status| json_error(status, "agent discovery is not permitted".to_owned()))?;
    let owner = crate::mcp_oauth::owner_for_caller(caller.as_ref())
        .map_err(|_| json_error(StatusCode::FORBIDDEN, "verified user required".to_owned()))?;
    let record = state.agent_store.get(agent).await.map_err(|_| {
        json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "agent lookup unavailable".to_owned(),
        )
    })?;
    if !mcp_principal_resolves(
        agent,
        record.is_some(),
        state.agents.entries.iter().map(|entry| entry.id.as_str()),
    ) {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "unknown agent".to_owned(),
        ));
    }
    let allowlist = state.agents.allowlist_for(agent).or_else(|| {
        record
            .as_ref()
            .and_then(|record| record.mcp_tool_allowlist())
    });
    Ok(Some(crate::sidecar::mcp::catalog::AgentDiscovery {
        owner_user_id: owner,
        agent_id: agent.to_owned(),
        profile_ids: record
            .map(|record| record.identity_profile_ids)
            .unwrap_or_default(),
        allowlist,
    }))
}

#[utoipa::path(
    get,
    path = "/api/agents/{id}/tools",
    tag = "Agents",
    summary = "List an agent's tools + MCP tools",
    params(("id" = String, Path)),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent view permission required", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn list_tools(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
) -> axum::response::Response {
    if !crate::fleet::is_agent_available(&agent_id) {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("agent '{agent_id}' is not available under organization policy"),
        );
    }
    // Tools the ACP agent has actually invoked this run...
    let observed = match run_after_agent_resource_permission(
        enforce_agent_resource_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_VIEW,
            &agent_id,
        ),
        async { state.agents.tools_for(&agent_id) },
    )
    .await
    {
        Ok(observed) => observed,
        Err(response) => return response,
    };
    // ...plus the registered MCP tools this agent is allowed to use. The
    // persisted agent card supplies the default scope and the registry config
    // can provide an operator override.
    let allowlist = resolved_agent_tool_allowlist(&state, &agent_id).await;
    let mcp = match oauth_discovery_identity(&state, &caller, Some(&agent_id)).await {
        Ok(Some(identity)) => state.mcp.tools_for_discovery_identity(&identity).await,
        Ok(None) => state.mcp.tools_for_agent(allowlist.as_deref()).await,
        Err(response) => return response,
    };
    Json(json!({ "tools": observed, "mcpTools": mcp })).into_response()
}

/// `GET /api/mcp/servers` — list the MCP servers registered in Core config.
#[utoipa::path(
    get,
    path = "/api/mcp/servers",
    tag = "MCP",
    summary = "List configured MCP servers",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_mcp_servers(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::GATEWAY_VIEW,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: gateway.view".to_owned(),
        );
    }
    Json(json!({ "servers": state.mcp.server_summaries() })).into_response()
}

/// Body accepted by `POST /api/mcp/servers`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct CreateMcpServerBody {
    /// The key used to register the server (unique, no `__` separator).
    pub(in crate::server) name: String,
    /// Executable to spawn (e.g. `npx`, `/usr/local/bin/my-mcp`). Omit for a
    /// remote server and send `url` instead.
    #[serde(default)]
    pub(in crate::server) command: Option<String>,
    /// Transport: `stdio`, `http`, `streamable-http`, or `sse`. Optional — the
    /// transport is inferred from `command` vs `url` when omitted. Accepted (and
    /// named `type`) so a body copied out of a Cursor / Claude Desktop
    /// `mcp.json` entry posts unchanged.
    #[serde(default, rename = "type")]
    pub(in crate::server) transport: Option<String>,
    /// Endpoint URL for a remote server.
    #[serde(default)]
    pub(in crate::server) url: Option<String>,
    /// Request headers sent with every call to a remote server — this is where a
    /// pasted `"Authorization": "Bearer …"` belongs.
    #[serde(default)]
    pub(in crate::server) headers: std::collections::BTreeMap<String, String>,
    /// Arguments forwarded to the command.
    #[serde(default)]
    pub(in crate::server) args: Vec<String>,
    /// Extra environment variables for the server process.
    #[serde(default)]
    pub(in crate::server) env: std::collections::BTreeMap<String, String>,
    /// Optional human description shown in the Tools page.
    #[serde(default)]
    pub(in crate::server) description: Option<String>,
}

/// MCP server definitions are node-wide configuration, not per-caller data.
/// Every mutating route shares this gate so a caller cannot bypass the desktop
/// settings UI by writing `mcp.json` through a different HTTP verb.
pub(in crate::server) async fn enforce_mcp_configuration(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> Result<(), axum::response::Response> {
    if enforce_permission(
        state,
        caller,
        crate::identity_verify::permissions::GATEWAY_CONFIGURE,
    )
    .await
    .is_err()
    {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: gateway.configure".to_owned(),
        ));
    }
    Ok(())
}
