//! MCP entries and tool calls from sidecars, ACP agents and host conversations: `list_mcp_tools_for` through `call_acp_tool`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

pub(crate) async fn list_mcp_tools_for(
    state: &ServerState,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    agent_id: Option<&str>,
    allowed_tool_ids: Option<&[String]>,
    snapshot_allowlist: Option<Option<&[String]>>,
) -> axum::response::Response {
    let caller = caller.cloned();
    if let Some(agent_id) = agent_id {
        if !crate::fleet::is_agent_available(agent_id) {
            return json_error(
                StatusCode::NOT_FOUND,
                format!("agent '{agent_id}' is not available under organization policy"),
            );
        }
        if let Err(response) = enforce_agent_resource_permission(
            state,
            &caller,
            crate::identity_verify::permissions::AGENT_VIEW,
            agent_id,
        )
        .await
        {
            return response;
        }
    } else if enforce_permission(
        state,
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
    let raw_tools = match agent_id {
        Some(agent_id) => {
            let resolved_allowlist = if snapshot_allowlist.is_none() {
                resolved_agent_tool_allowlist(&state, agent_id).await
            } else {
                None
            };
            let allowlist = snapshot_allowlist.unwrap_or_else(|| resolved_allowlist.as_deref());
            state.mcp.tools_for_agent(allowlist.as_deref()).await
        }
        None => state.mcp.list_all_tools().await,
    };

    // Filter: exclude tools whose slug is claimed only by disabled apps.
    let lifecycle = state.app_store.list().await.unwrap_or_default();
    let app_manifests_guard = state.app_manifests.read().await;
    let (disabled_claimed, enabled_claimed) = app_tool_claim_sets(&app_manifests_guard, &lifecycle);
    let hide_filters = app_tool_hide_filters(&app_manifests_guard, &lifecycle);
    drop(app_manifests_guard);

    let tools: Vec<_> = raw_tools
        .into_iter()
        .filter(|t| {
            if allowed_tool_ids.is_some_and(|allowed| !allowed.iter().any(|id| id == &t.id)) {
                return false;
            }
            // A tool is gated only if at least one app claims its slug.
            // If claimed by a disabled app AND NOT by any enabled app → exclude.
            // Standalone (unclaimed) tools are always visible.
            if disabled_claimed.contains(&t.name) && !enabled_claimed.contains(&t.name) {
                return false;
            }
            // Declarative tool-hide (`contributes.tool_filters`): drop anything an
            // enabled plugin asked to hide, so the model never sees it and cannot
            // waste a round-trip discovering it is denied. Patterns are matched by
            // the contract's own `matches` so the trailing-`*` rule has exactly one
            // implementation.
            if hide_filters.iter().any(|f| f.matches(&t.name)) {
                return false;
            }
            true
        })
        .collect();

    Json(json!({ "tools": tools })).into_response()
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct CallToolBody {
    /// Fully-qualified tool id: `<server>.<tool>`.
    pub(in crate::server) tool: String,
    #[serde(default)]
    pub(in crate::server) arguments: serde_json::Value,
    /// Optional agent id whose allowlist gates this call.
    #[serde(default)]
    pub(in crate::server) agent_id: Option<String>,
    /// Optional caller user id — selects the Composio entity (connected-account
    /// owner) and scopes per-user audit. Absent → env/`"default"` fallback.
    #[serde(default)]
    pub(in crate::server) user_id: Option<String>,
    /// Internal host conversation context forwarded by the Gateway exec plane
    /// (`POST /v1/exec/tool`). Direct managed-user callers may provide it only
    /// for a conversation they own; visibility or collaboration never delegates
    /// the owner's vault. The node-token path is accepted only with the
    /// process-local proof Core adds before its Gateway forward. Distinct from
    /// `user_id`, which is client-supplied and MUST NEVER be an authorization
    /// principal. Absent ⇒ fail-closed default on bound nodes (unbound nodes
    /// remain unrestricted).
    #[serde(default)]
    pub(in crate::server) host_conversation_id: Option<String>,
    /// Process-local proof attached by Core before its Gateway forward. It is
    /// never accepted from a normal client and is required when an anonymous
    /// node-token request carries `host_conversation_id` on a bound node.
    #[serde(default)]
    pub(in crate::server) host_conversation_proof: Option<String>,
    /// Optional Core-injected onboarding profile scopes. These are narrowing
    /// controls only; normal network callers cannot widen an agent's access by
    /// supplying them.
    #[serde(default)]
    pub(in crate::server) profile_composio_connection_scope:
        Option<Vec<crate::sidecar::adapters::ComposioConnectionBinding>>,
    #[serde(default)]
    pub(in crate::server) profile_conversation_scope: Option<Vec<String>>,
    /// The Gateway's chat tool loop sets this for a turn Core marked as spoken
    /// by an unverified caller. It only narrows the agent's allowlist to the
    /// untrusted-caller profile, so a caller can use it only to restrict its
    /// own call and it needs no proof.
    #[serde(default)]
    pub(in crate::server) untrusted_caller: bool,
    /// Internal ACP snapshot. Never deserialized from a network request; the
    /// dedicated broker fills it from the authority minted for the session.
    #[serde(skip)]
    pub(in crate::server) mcp_allowlist: Option<Vec<String>>,
    #[serde(skip)]
    pub(in crate::server) identity_profile_ids: Option<Vec<String>>,
    #[serde(skip)]
    pub(in crate::server) mcp_policy_snapshot: bool,
}

/// Generic app boundary: the credential selects the app; a separately verified
/// user selects the connected account. No caller/tenant fields are accepted.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SidecarToolCall {
    pub(in crate::server) tool: String,
    pub(in crate::server) agent_id: String,
    #[serde(default)]
    pub(in crate::server) arguments: serde_json::Value,
}

pub(crate) async fn call_tool_for_sidecar(
    state: ServerState,
    headers: axum::http::HeaderMap,
    body: SidecarToolCall,
) -> axum::response::Response {
    if let Err((status, message)) =
        crate::sidecar::ext_proxy::authorize_host_call(&state, &headers, "tools.invoke").await
    {
        return json_error(status, message.to_owned());
    }
    let Some(caller) = verified_caller_from_headers(&headers).await else {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "A verified user identity is required".to_owned(),
        );
    };
    if body.tool.is_empty()
        || body.tool.len() > 200
        || body.agent_id.is_empty()
        || body.agent_id.len() > 100
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Invalid tool or agent id".to_owned(),
        );
    }
    let call = CallToolBody {
        tool: body.tool,
        arguments: body.arguments,
        agent_id: Some(body.agent_id),
        user_id: Some(caller.user_id.clone()),
        host_conversation_id: None,
        host_conversation_proof: None,
        profile_composio_connection_scope: None,
        profile_conversation_scope: None,
        mcp_allowlist: None,
        identity_profile_ids: Some(Vec::new()),
        mcp_policy_snapshot: false,
        untrusted_caller: false,
    };
    crate::sidecar::mcp::with_verified_tool_caller(
        &caller,
        // Host calls already passed their declared/approved grant intersection;
        // the shared dispatcher still checks this verified user's agent permission.
        call_mcp_tool_inner(state, Some(caller.clone()), None, call),
    )
    .await
}

pub(crate) async fn install_bundle_for_sidecar(
    state: ServerState,
    headers: axum::http::HeaderMap,
    body: serde_json::Value,
) -> axum::response::Response {
    let caller_plugin_id =
        match crate::sidecar::ext_proxy::authorize_host_call(&state, &headers, "plugins:install")
            .await
        {
            Ok((plugin_id, _)) => plugin_id,
            Err((status, message)) => return json_error(status, message.to_owned()),
        };
    // Core knows the calling sidecar here, so it enforces the namespace itself:
    // a sidecar may never install over another app or into another's namespace.
    if let Some(denial) =
        app_bundle_guard::sidecar_bundle_namespace_denial(&caller_plugin_id, &body)
    {
        return json_error(StatusCode::FORBIDDEN, denial);
    }
    let caller = verified_caller_from_headers(&headers).await;
    // The installer preserves its managed-user lifecycle permission gate, native
    // manifest validation, external trust tier and disabled-by-default lifecycle.
    install_app_bundle(State(state), Extension(caller), Json(body)).await
}

#[derive(serde::Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(in crate::server) enum AcpToolCallBody {
    ListTools,
    CallTool {
        tool: String,
        #[serde(default)]
        arguments: serde_json::Value,
    },
    /// One assistant message's token usage (Pi's `Usage` shape), summed into
    /// the turn's stats — pi-acp forwards only context occupancy.
    ReportUsage {
        usage: serde_json::Value,
    },
}

/// Dedicated managed-Pi callback. The capability is not accepted by the normal
/// auth middleware or any other Core route. The body intentionally contains no
/// caller, agent, conversation, or profile fields; all of those come from the
/// server-side capability record before a catalog read or tool call re-enters
/// its normal owner. Tool calls additionally carry Pi's native session id, which
/// the broker compares with the id captured when Core created the ACP session.
pub(in crate::server) async fn call_acp_tool(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<AcpToolCallBody>,
) -> axum::response::Response {
    let require_native_session = matches!(&body, AcpToolCallBody::CallTool { .. });
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty());
    let session_id = headers
        .get("x-ryu-acp-session-id")
        .and_then(|value| value.to_str().ok());
    let native_session_id = headers
        .get("x-ryu-acp-native-session-id")
        .and_then(|value| value.to_str().ok());
    let Some(authorization) = token.and_then(|token| {
        acp_tool_broker::authorize_call(
            token,
            session_id,
            native_session_id,
            require_native_session,
        )
    }) else {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "invalid or expired ACP tool session".to_owned(),
        );
    };

    if let AcpToolCallBody::ReportUsage { usage } = &body {
        // Keyed by the capability's own conversation and agent, never by
        // anything in the body, so a session can only report into itself.
        return if crate::sidecar::adapters::acp::record_reported_usage(
            &authorization.conversation_id,
            &authorization.agent_id,
            usage,
        ) {
            StatusCode::NO_CONTENT.into_response()
        } else {
            json_error(
                StatusCode::BAD_REQUEST,
                "usage must carry input or output token counts".to_owned(),
            )
        };
    }
    if matches!(&body, AcpToolCallBody::ListTools) {
        return list_mcp_tools_for(
            &state,
            authorization.caller.as_ref(),
            Some(&authorization.agent_id),
            None,
            Some(authorization.mcp_allowlist.as_deref()),
        )
        .await;
    }
    let AcpToolCallBody::CallTool { tool, arguments } = body else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "unsupported ACP tool operation".to_owned(),
        );
    };

    let call = CallToolBody {
        tool,
        arguments,
        agent_id: Some(authorization.agent_id),
        user_id: authorization
            .caller
            .as_ref()
            .map(|caller| caller.user_id.clone()),
        host_conversation_id: Some(authorization.conversation_id),
        host_conversation_proof: None,
        profile_composio_connection_scope: authorization.profile_composio_connection_scope,
        profile_conversation_scope: authorization.profile_conversation_scope,
        mcp_allowlist: authorization.mcp_allowlist,
        identity_profile_ids: Some(authorization.identity_profile_ids),
        mcp_policy_snapshot: true,
        untrusted_caller: false,
    };
    call_mcp_tool_inner(
        state,
        authorization.caller,
        Some(call.agent_id.clone().unwrap_or_default()),
        call,
    )
    .await
}
