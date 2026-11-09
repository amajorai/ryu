//! MCP entries and tool calls from sidecars, ACP agents and host conversations: `serve_acp_mcp` through `signed_agent_binding_allows`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/acp/mcp` — Core's governed MCP bridge for a managed Pi session.
///
/// Authenticated exactly like [`call_acp_tool`]: only a Core-minted, session-bound
/// capability is accepted, and every principal (caller, conversation, agent,
/// allowlist, Composio actions, profile scopes) comes from the broker record,
/// never from the request. Discovery (`initialize`, `tools/list`) needs only the
/// capability; `tools/call` also requires the native Pi session id the broker
/// bound at `session/new`, so a capability replayed by another ACP session is
/// refused.
pub(in crate::server) async fn serve_acp_mcp(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    body: String,
) -> axum::response::Response {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) else {
        return Json(json!({
            "jsonrpc": "2.0",
            "id": serde_json::Value::Null,
            "error": { "code": -32_700, "message": "invalid JSON" },
        }))
        .into_response();
    };
    if let Some(refusal) = mcp_batch_refusal(&parsed) {
        return Json(refusal).into_response();
    }
    let require_native_session =
        parsed.get("method").and_then(serde_json::Value::as_str) == Some("tools/call");
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

    let scope = crate::sidecar::adapters::mcp_bridge::AcpSessionMcpScope {
        agent_id: authorization.agent_id,
        conversation_id: authorization.conversation_id,
        allowlist: authorization.mcp_allowlist,
        composio_actions: authorization.composio_actions,
        identity_profile_ids: authorization.identity_profile_ids,
        composio_connection_scope: authorization.profile_composio_connection_scope,
        conversation_scope: authorization.profile_conversation_scope,
        events: authorization.events,
    };
    match crate::sidecar::adapters::mcp_bridge::serve_acp_session_jsonrpc(
        Arc::clone(&state.mcp),
        scope,
        &parsed,
    )
    .await
    {
        Some(response) => Json(response).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct CallActionBody {
    #[serde(default)]
    pub(in crate::server) arguments: serde_json::Value,
    /// The calling agent is required so Core can apply its exact allowlist and
    /// approval posture; the node bearer alone authenticates only the machine.
    pub(in crate::server) agent_id: Option<String>,
    /// Optional Composio entity/audit selector. This is never an auth principal.
    #[serde(default)]
    pub(in crate::server) user_id: Option<String>,
}

pub(in crate::server) fn is_billable_composio_tool(tool_id: &str) -> bool {
    tool_id.starts_with("composio.") || tool_id.starts_with("composio__")
}

/// `POST /api/mcp/tools/call` — invoke a registered MCP tool. This is the path
/// the chat tool loop (U12) uses to execute a tool the agent requested.
pub(in crate::server) async fn authorize_tool_host_conversation(
    state: &ServerState,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    raw_id: Option<&str>,
    host_conversation_proof: Option<&str>,
) -> Result<Option<String>, (StatusCode, String)> {
    let Some(raw_id) = raw_id else {
        return Ok(None);
    };
    if !crate::sidecar::adapters::acp::is_safe_host_conversation_id(raw_id) {
        return Err((
            StatusCode::BAD_REQUEST,
            "host_conversation_id must be 1-128 ASCII letters, digits, '.', '_' or '-'".to_owned(),
        ));
    }

    // A managed-user JWT identifies the human who is making this direct Core
    // request. A shared or collaborator-visible conversation is not enough to
    // select that conversation owner's vault: the caller must own the host
    // conversation. An anonymous node-token request may carry this context only
    // with the process-local proof Core created before its Gateway forward;
    // otherwise a direct node-token caller could omit the user JWT and select
    // another owner's vault.
    // A scoped credential (a paired device, say) on an unbound node is held to
    // the bound-node rule: it may not name the owner's conversation and consume
    // the owner's in-chat grants without owning it or the forwarder proof.
    let node_bound = crate::sidecar::control_plane::registered_org().is_some()
        || crate::sidecar::control_plane::is_managed_node()
        || tool_ingress_authority::request_admitted_without_owner_token();
    if let Some(caller) = caller {
        let meta = match state.conversations.get_access_meta(raw_id).await {
            Ok(Some(meta)) => meta,
            Ok(None) => {
                return Err((
                    StatusCode::FORBIDDEN,
                    "host conversation is not owned by the caller".to_owned(),
                ));
            }
            Err(error) => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("host conversation lookup failed: {error}"),
                ));
            }
        };
        if !caller_owns_host_conversation(caller, &meta)
            && !local_unowned_host_conversation_allowed(&meta, node_bound)
        {
            return Err((
                StatusCode::FORBIDDEN,
                "host conversation is not owned by the caller".to_owned(),
            ));
        }
    } else if !anonymous_host_conversation_allowed(
        node_bound,
        host_conversation_proof
            .is_some_and(|proof| host_conversation_proof_is_valid(raw_id, proof)),
    ) {
        return Err((
            StatusCode::FORBIDDEN,
            "host conversation requires a verified caller or trusted forwarder".to_owned(),
        ));
    }
    Ok(Some(raw_id.to_owned()))
}

pub(in crate::server) fn anonymous_host_conversation_allowed(
    node_bound: bool,
    trusted_forwarder: bool,
) -> bool {
    trusted_forwarder || !node_bound
}

pub(in crate::server) fn local_unowned_host_conversation_allowed(
    meta: &crate::identity_verify::ResourceTenancy,
    node_bound: bool,
) -> bool {
    !node_bound && meta.owner_user_id.is_none() && meta.org_id.is_none()
}

/// Prove that a host conversation id came from this Core's own Gateway forward
/// path. The key is process-local and never leaves Core; the Gateway only relays
/// the proof. A direct node-token caller therefore cannot opt into the trusted
/// host-context path by copying a public header or body flag.
pub(crate) fn host_conversation_proof(conversation_id: &str) -> String {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};

    static KEY: std::sync::OnceLock<[u8; 16]> = std::sync::OnceLock::new();
    let key = KEY.get_or_init(|| *uuid::Uuid::new_v4().as_bytes());
    let mut digest = Sha256::new();
    digest.update(b"ryu-host-conversation-proof-v1\0");
    digest.update(key);
    digest.update(conversation_id.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest.finalize())
}

/// Accepts the bare proof and the turn-bound `<proof>.<turn_token>` form
/// (`gateway_turn_sender`). Only the base part is checked here; base64url
/// never contains '.', so the split is unambiguous.
pub(in crate::server) fn host_conversation_proof_is_valid(
    conversation_id: &str,
    proof: &str,
) -> bool {
    let base = proof.split_once('.').map_or(proof, |(base, _)| base);
    ct_eq(base, &host_conversation_proof(conversation_id))
}

pub(in crate::server) fn caller_owns_host_conversation(
    caller: &crate::identity_verify::VerifiedCaller,
    meta: &crate::identity_verify::ResourceTenancy,
) -> bool {
    meta.owner_user_id.as_deref() == Some(caller.user_id.as_str())
        && meta.org_id.as_deref() == caller.org_id.as_deref()
}

#[utoipa::path(
    post,
    path = "/api/mcp/tools/call",
    tag = "MCP",
    summary = "Call an MCP tool",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn call_mcp_tool(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::Extension(resolved): axum::Extension<ResolvedAuthorization>,
    Json(body): Json<CallToolBody>,
) -> axum::response::Response {
    call_mcp_tool_inner(state, caller, resolved.bindings.agent_id, body).await
}

pub(in crate::server) fn signed_agent_binding_allows(
    bound_agent_id: Option<&str>,
    requested_agent_id: &str,
) -> bool {
    bound_agent_id.map_or(true, |bound| bound == requested_agent_id)
}
