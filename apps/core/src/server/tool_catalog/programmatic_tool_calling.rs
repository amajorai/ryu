//! Programmatic tool calling sandbox (#476, P4).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Programmatic tool calling sandbox (#476, P4) ─────────────────────────────

/// Body for `POST /api/tools/exec`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct ToolExecBody {
    /// Agent whose resolved allowlist gates the program's tool calls. Required;
    /// absent/unknown → rejected (fail-closed, mirrors `call_mcp_tool`).
    pub(in crate::server) agent_id: Option<String>,
    /// The JavaScript program to run.
    pub(in crate::server) code: String,
    /// Optional conversation id. Used **only** to select the Composio entity for
    /// per-user connected accounts (the `user_id` the invoker forwards to
    /// `call_tool_with_user`); it does not flow into the gateway audit
    /// `session_id`. Composio documents that this selector is not authenticated,
    /// so the caller must bind it to a real session upstream.
    #[serde(default)]
    pub(in crate::server) conversation_id: Option<String>,
    /// Core-validated server-derived host conversation for conversation-scoped
    /// tools. This is distinct from `conversation_id`, which remains the
    /// client-supplied Composio entity/audit selector for compatibility.
    #[serde(default)]
    pub(in crate::server) host_conversation_id: Option<String>,
    /// Process-local proof attached by Core's Gateway forwarder. A direct
    /// node-token caller cannot opt into another user's conversation scope.
    #[serde(default)]
    pub(in crate::server) host_conversation_proof: Option<String>,
}

/// Body for `POST /api/tools/exec/resume`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct ToolExecResumeBody {
    pub(in crate::server) agent_id: Option<String>,
    pub(in crate::server) execution_id: String,
    /// `accept | decline | cancel`.
    pub(in crate::server) action: String,
    #[serde(default)]
    pub(in crate::server) content: serde_json::Value,
}

/// `POST /api/tools/exec` — run a JS program in the sandbox, fanning out across
/// tools via the `tools` proxy. Returns the flattened [`ExecOutcome`]
/// (`completed` with the final value + logs, or `paused` awaiting a connect
/// step). The invoker carries the agent's resolved allowlist — no escalation.
#[utoipa::path(
    post,
    path = "/api/tools/exec",
    tag = "Tools",
    summary = "Run a programmatic tool-calling program",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Terminal or paused outcome", body = serde_json::Value),
        (status = 400, description = "Missing/unknown agent or no backend"),
    )
)]
pub(in crate::server) async fn tools_exec(
    State(state): State<ServerState>,
    axum::Extension(verified_caller): axum::Extension<
        Option<crate::identity_verify::VerifiedCaller>,
    >,
    axum::Extension(resolved): axum::Extension<ResolvedAuthorization>,
    Json(body): Json<ToolExecBody>,
) -> axum::response::Response {
    let host_conversation_id = match authorize_tool_host_conversation(
        &state,
        verified_caller.as_ref(),
        body.host_conversation_id.as_deref(),
        body.host_conversation_proof.as_deref(),
    )
    .await
    {
        Ok(value) => value,
        Err((status, message)) => return json_error(status, message),
    };
    if let Some(agent_id) = body.agent_id.as_deref() {
        if state
            .agent_store
            .get(agent_id)
            .await
            .ok()
            .flatten()
            .is_some_and(|record| {
                record.safety_profile == crate::agents::AgentSafetyProfile::VerifiedPlanOnly
            })
        {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error": "programmatic tool execution is disabled for verified-plan-only agents"})),
            )
                .into_response();
        }
    }
    let allowlist =
        match crate::tool_exec::resolve_agent_allowlist(&state.agents, body.agent_id.as_deref()) {
            Ok(Some(list)) => Some(list),
            Ok(None) => {
                let agent_id = body.agent_id.as_deref().unwrap_or_default();
                resolved_agent_tool_allowlist(&state, agent_id).await
            }
            Err(e) => {
                return (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response();
            }
        };
    // agent_id is guaranteed present + known by resolve_agent_allowlist.
    let agent_id = body.agent_id.unwrap_or_default();
    if !signed_agent_binding_allows(resolved.bindings.agent_id.as_deref(), &agent_id) {
        return json_error(
            StatusCode::FORBIDDEN,
            "agent differs from signed binding".to_owned(),
        );
    }
    if !crate::fleet::is_agent_available(&agent_id) {
        return json_error(StatusCode::FORBIDDEN, "agent is unavailable".to_owned());
    }
    if let Err(response) = enforce_agent_resource_permission(
        &state,
        &verified_caller,
        crate::identity_verify::permissions::AGENT_RUN,
        &agent_id,
    )
    .await
    {
        return response;
    }
    // Per-agent Identity Vault binding (epic #517): threaded into the invoker so a
    // program's tool call targeting a NEEDS_AUTH bound domain suspends and an
    // AUTHENTICATED one reads the credential under the gateway grant.
    let identity_profile_ids = state
        .agent_store
        .get(&agent_id)
        .await
        .ok()
        .flatten()
        .map(|rec| rec.identity_profile_ids)
        .unwrap_or_default();
    let caller: std::sync::Arc<dyn crate::tool_exec::ToolCaller> = state.mcp.clone();
    let invoker = std::sync::Arc::new(
        crate::tool_exec::SandboxToolInvoker::registry_with_identity_and_conversation(
            caller,
            agent_id.clone(),
            allowlist,
            body.conversation_id,
            identity_profile_ids,
            host_conversation_id,
        ),
    );
    let outcome = crate::tool_exec::execute_code(body.code, invoker, &agent_id).await;
    Json(serde_json::to_value(&outcome).unwrap_or_default()).into_response()
}

/// `POST /api/tools/exec/resume` — continue a paused execution after the user
/// completed the auth/consent step. Unknown id → `404 execution_not_found`.
#[utoipa::path(
    post,
    path = "/api/tools/exec/resume",
    tag = "Tools",
    summary = "Resume a paused programmatic execution",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Terminal or paused outcome", body = serde_json::Value),
        (status = 400, description = "Missing/unknown agent or bad action"),
        (status = 404, description = "execution_not_found"),
    )
)]
pub(in crate::server) async fn tools_exec_resume(
    State(state): State<ServerState>,
    axum::Extension(verified_caller): axum::Extension<
        Option<crate::identity_verify::VerifiedCaller>,
    >,
    axum::Extension(resolved): axum::Extension<ResolvedAuthorization>,
    Json(body): Json<ToolExecResumeBody>,
) -> axum::response::Response {
    if let Some(agent_id) = body.agent_id.as_deref() {
        if state
            .agent_store
            .get(agent_id)
            .await
            .ok()
            .flatten()
            .is_some_and(|record| {
                record.safety_profile == crate::agents::AgentSafetyProfile::VerifiedPlanOnly
            })
        {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error": "programmatic tool execution is disabled for verified-plan-only agents"})),
            )
                .into_response();
        }
    }
    // Validate the agent (fail-closed) — an unknown agent must not be able to
    // poke someone else's parked execution. The resolved agent id is then
    // ownership-checked against the parked execution inside `resume_parked`
    // (security M2): a different known agent gets a 404, not someone else's run.
    if let Err(e) =
        crate::tool_exec::resolve_agent_allowlist(&state.agents, body.agent_id.as_deref())
    {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response();
    }
    let agent_id = body.agent_id.unwrap_or_default();
    if !signed_agent_binding_allows(resolved.bindings.agent_id.as_deref(), &agent_id) {
        return json_error(
            StatusCode::FORBIDDEN,
            "agent differs from signed binding".to_owned(),
        );
    }
    if !crate::fleet::is_agent_available(&agent_id) {
        return json_error(StatusCode::FORBIDDEN, "agent is unavailable".to_owned());
    }
    if let Err(response) = enforce_agent_resource_permission(
        &state,
        &verified_caller,
        crate::identity_verify::permissions::AGENT_RUN,
        &agent_id,
    )
    .await
    {
        return response;
    }
    let Some(decision) = crate::tool_exec::ResumeDecision::parse(&body.action) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "action must be accept|decline|cancel" })),
        )
            .into_response();
    };
    match crate::tool_exec::resume_execution_opt(
        body.execution_id,
        &agent_id,
        decision,
        body.content,
    )
    .await
    {
        Some(outcome) => Json(serde_json::to_value(&outcome).unwrap_or_default()).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "execution_not_found" })),
        )
            .into_response(),
    }
}
