//! MCP entries and tool calls from sidecars, ACP agents and host conversations: `call_mcp_tool_inner` through `call_action`.

use crate::server::*;

/// A conversationless call from a verified caller runs with that caller in the
/// tool scope, so secret resolution and the org tool policy apply the caller's
/// own `user:`/`role:`/`team:` rules. A call naming a host conversation keeps
/// its conversation-owner resolution.
pub(in crate::server) async fn call_mcp_tool_inner(
    state: ServerState,
    caller: Option<crate::identity_verify::VerifiedCaller>,
    bound_agent_id: Option<String>,
    body: CallToolBody,
) -> axum::response::Response {
    let scoped = conversationless_caller(caller.as_ref(), &body);
    let turn_sender = relayed_turn_sender(caller.as_ref(), &body);
    let dispatch = Box::pin(dispatch_mcp_tool_call(state, caller, bound_agent_id, body));
    match (scoped, turn_sender) {
        (Some(caller), _) => {
            crate::sidecar::mcp::with_verified_tool_caller(&caller, dispatch).await
        }
        (None, Some(sender)) => {
            crate::sidecar::mcp::search_conversations::with_turn_sender(&sender, dispatch).await
        }
        (None, None) => dispatch.await,
    }
}

/// The live turn's verified sender for an anonymous Gateway relay whose proof
/// carries that turn's token for this same host conversation. A call with a
/// verified caller never uses it.
fn relayed_turn_sender(
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    body: &CallToolBody,
) -> Option<std::sync::Arc<crate::identity_verify::VerifiedCaller>> {
    if caller.is_some() {
        return None;
    }
    gateway_turn_sender(
        body.host_conversation_id.as_deref()?,
        body.host_conversation_proof.as_deref()?,
    )
}

/// The verified caller to bind as the tool principal: only when the body names
/// no host conversation, whose owner otherwise stays the principal.
fn conversationless_caller(
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    body: &CallToolBody,
) -> Option<crate::identity_verify::VerifiedCaller> {
    caller
        .filter(|_| body.host_conversation_id.is_none())
        .cloned()
}

async fn dispatch_mcp_tool_call(
    state: ServerState,
    caller: Option<crate::identity_verify::VerifiedCaller>,
    bound_agent_id: Option<String>,
    body: CallToolBody,
) -> axum::response::Response {
    let host_conversation_id = match authorize_tool_host_conversation(
        &state,
        caller.as_ref(),
        body.host_conversation_id.as_deref(),
        body.host_conversation_proof.as_deref(),
    )
    .await
    {
        Ok(value) => value,
        Err((status, message)) => return json_error(status, message),
    };
    // Core is the execution and charge authority for every Composio action that
    // reaches this dispatcher. A client-controlled `budget_already_metered`
    // flag used to let any node-token caller suppress the charge notification.
    // Gateway callers now rely on this Core-side event and do not debit the same
    // unified-tool execution a second time.
    let should_record_tool_charge = is_billable_composio_tool(&body.tool);
    let charge_agent_id = body.agent_id.clone();
    // `body.user_id` is client-supplied and, from the Gateway tool loop, a
    // Composio entity selector. The charge goes to the verified owner the
    // dispatch resolves, else to that id with an agent's own entity mapped to
    // its owner, so the charge never names an agent entity as the user.
    let charge_user_id = if should_record_tool_charge {
        let verified_owner = match crate::sidecar::mcp::ToolPrincipal::resolve_optional(
            Some(&state.conversations),
            host_conversation_id.as_deref(),
        )
        .await
        {
            crate::sidecar::mcp::ToolPrincipal::Owned { user_id, .. } => Some(user_id),
            crate::sidecar::mcp::ToolPrincipal::Unrestricted
            | crate::sidecar::mcp::ToolPrincipal::Unresolved => None,
        };
        crate::sidecar::mcp::composio::charge_user_id(
            verified_owner.as_deref(),
            body.user_id.as_deref(),
        )
    } else {
        None
    };
    let charge_session_id = host_conversation_id.clone();
    // The allowlist must be tied to a *known* agent. A `None` allowlist means
    // "allow every tool" (see `McpRegistry::call_tool`), so we must not let a
    // client reach that path by omitting or faking `agent_id` — that would be a
    // fail-open bypass of the per-agent allowlist. Require a non-empty agent id
    // that resolves to a registered agent; otherwise deny.
    let Some(agent_id) = body.agent_id.as_deref().filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "agent_id is required to call a tool" })),
        )
            .into_response();
    };
    if !signed_agent_binding_allows(bound_agent_id.as_deref(), agent_id) {
        return json_error(
            StatusCode::FORBIDDEN,
            "agent differs from signed binding".to_owned(),
        );
    }
    if let Err(response) = enforce_agent_resource_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_RUN,
        agent_id,
    )
    .await
    {
        return response;
    }
    if !crate::fleet::is_agent_available(agent_id) {
        return json_error(
            StatusCode::FORBIDDEN,
            format!("agent '{agent_id}' is unavailable under organization policy"),
        );
    }
    // User-created agents live in AgentStore, not necessarily the ACP registry.
    // Use the same exact-id rule as /mcp/:agent_id and reuse this record for the
    // identity binding below. A failed lookup must not erase a stored binding.
    let agent_record = match state.agent_store.get(agent_id).await {
        Ok(record) => record,
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "agent lookup unavailable".to_owned(),
            );
        }
    };
    if !mcp_principal_resolves(
        agent_id,
        agent_record.is_some(),
        state.agents.entries.iter().map(|entry| entry.id.as_str()),
    ) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": format!("unknown agent '{agent_id}'") })),
        )
            .into_response();
    }
    if state.mcp.command_tool_requires_files_read(&body.tool).await
        && enforce_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::SPACE_READ,
        )
        .await
        .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: space.read (required for workspace file search)".to_owned(),
        );
    }
    // Per-agent restriction comes from the agent's configured allowlist. (A
    // deny-by-default global policy for unconfigured agents is Gateway /
    // control-plane scope, U28/U30, out of scope here.)
    if let Err(response) =
        authorize_agent_configuration_tool(&state.mcp, &body.tool, &body.arguments, |target| {
            enforce_agent_resource_permission(
                &state,
                &caller,
                crate::identity_verify::permissions::AGENT_EDIT,
                target,
            )
        })
        .await
    {
        return response;
    }
    let allowlist = if body.mcp_policy_snapshot {
        body.mcp_allowlist.clone()
    } else {
        resolved_agent_tool_allowlist(&state, agent_id).await
    };
    // A call forwarded for an unverified caller's turn keeps only the
    // untrusted-caller profile's tools, the same narrowing the turn itself got.
    let allowlist = crate::sidecar::adapters::caller_scoped_tool_allowlist(
        body.untrusted_caller,
        &state.mcp,
        allowlist,
    );
    // Per-agent Identity Vault binding (epic #517): a tool call targeting a
    // NEEDS_AUTH bound domain elicits; an AUTHENTICATED one reads the credential
    // under the gateway grant. Resolved from the AgentStore record (empty when the
    // agent has no row / no binding, which is the common case).
    let identity_profile_ids = body.identity_profile_ids.clone().unwrap_or_else(|| {
        agent_record
            .as_ref()
            .map(|rec| rec.identity_profile_ids.clone())
            .unwrap_or_default()
    });
    let dispatch = state.mcp.call_tool_with_identity_scoped(
        // The calling agent, so its configured `approval_tools` (policy
        // Layer A) feed the approval gate.
        Some(agent_id),
        &body.tool,
        body.arguments,
        allowlist.as_deref(),
        // `body.user_id` is CLIENT-SUPPLIED. It selects a Composio entity and
        // tags the audit line — it is NOT an authorization principal and must
        // never be used as one (any node-token holder could name themselves
        // anyone). See `ToolPrincipal`.
        body.user_id.as_deref(),
        &identity_profile_ids,
        None,
        // The SERVER-DERIVED host conversation the openai-compat tool loop runs
        // on behalf of, forwarded by the Gateway exec plane (`POST /v1/exec/tool`
        // → `host_conversation_id`). It is lowered to a `ToolPrincipal` at
        // dispatch: present + org-bound ⇒ `Owned` (the conversation-reading tools
        // `threads.*` / `search_conversations.*` resolve the owner instead of
        // refusing); absent ⇒ fail-closed `Unresolved` on a bound node (e.g. a
        // direct/legacy caller). Unbound (personal) nodes resolve `Unrestricted`
        // regardless. This is NEVER `user_id` (client-supplied, spoofable).
        host_conversation_id.as_deref(),
        body.profile_composio_connection_scope.as_deref(),
        body.profile_conversation_scope.as_deref(),
    );
    // This handler records the charge for its own direct `composio.*` call, so
    // that dispatch is marked to keep the Composio arm from charging it again.
    // An approval queued here is replayed later without the marker and is
    // charged by the arm; an alias (`app.x` -> `composio.*`) is not stripped
    // here, so it is never marked.
    let mut result = if should_record_tool_charge {
        crate::sidecar::mcp::with_caller_recorded_composio_charge(dispatch).await
    } else {
        dispatch.await
    };
    // A connection prompt is not charged. A failure Composio logged is charged
    // under its receipt and still answered as the same failure below.
    let charge = if should_record_tool_charge {
        crate::sidecar::mcp::composio::take_tool_charge(&mut result)
    } else {
        None
    };
    if let Some(charge) = charge {
        let client = state.client.clone();
        tokio::spawn(async move {
            if let Err(error) = crate::sidecar::gateway::record_tool_charge(
                &client,
                charge_agent_id.as_deref(),
                charge_user_id.as_deref(),
                charge_session_id.as_deref(),
                1,
                charge.receipt.as_ref(),
                charge.accounting_unavailable,
            )
            .await
            {
                tracing::warn!(error = %error, "Core MCP tool charge notification failed");
            }
        });
    }
    match result {
        Ok(output) => Json(json!({ "ok": true, "output": output })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Every HTTP/ACP configuration call authorizes the exact model-selected target
/// after resolving the registry alias. The checker stays server-owned.
pub(in crate::server) async fn authorize_agent_configuration_tool<'a, P>(
    registry: &crate::sidecar::mcp::McpRegistry,
    tool_id: &str,
    arguments: &'a serde_json::Value,
    permission: impl FnOnce(&'a str) -> P,
) -> Result<(), axum::response::Response>
where
    P: std::future::Future<Output = Result<(), axum::response::Response>>,
{
    let canonical_tool = registry.canonical_tool_id_for_registry(tool_id);
    let (configuration_tool, _) = registry.approval_target_for_tool(&canonical_tool).await;
    let target = crate::runnable::agent_configuration_policy::edit_target(
        &registry.canonical_tool_id_for_registry(&configuration_tool),
        arguments
            .get("agent_id")
            .and_then(serde_json::Value::as_str),
    )
    .map_err(|message| json_error(StatusCode::BAD_REQUEST, message.to_owned()))?;
    if let Some(target) = target {
        permission(target).await?;
    }
    Ok(())
}

/// Network MCP uses the same target ACL as the REST tool endpoint. Invalid or
/// unrelated messages remain the protocol dispatcher's responsibility.
pub(in crate::server) async fn authorize_network_agent_configuration_tool<'a, P>(
    registry: &crate::sidecar::mcp::McpRegistry,
    message: &'a serde_json::Value,
    permission: impl FnOnce(&'a str) -> P,
) -> Result<(), axum::response::Response>
where
    P: std::future::Future<Output = Result<(), axum::response::Response>>,
{
    if message.get("method").and_then(serde_json::Value::as_str) != Some("tools/call") {
        return Ok(());
    }
    let Some(tool) = message
        .pointer("/params/name")
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.is_empty())
    else {
        return Ok(());
    };
    // Missing/non-object arguments cannot authorize a configuration target. The
    // dispatcher still handles ordinary malformed tool requests as before.
    let arguments = message.pointer("/params/arguments").unwrap_or(message);
    authorize_agent_configuration_tool(registry, tool, arguments, permission).await
}

/// `POST /api/actions/{action_id}` — invoke one SDK Action by its semantic id.
/// Resolution is action-marker-only, then the request re-enters
/// `call_mcp_tool`, so schema/backend/allowlist/identity/approval/audit behavior
/// cannot drift between the HTTP Action and MCP projections.
#[utoipa::path(
    post,
    path = "/api/actions/{action_id}",
    tag = "Actions",
    summary = "Call a canonical Action",
    params(("action_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn call_action(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::Extension(resolved): axum::Extension<ResolvedAuthorization>,
    Path(action_id): Path<String>,
    Json(body): Json<CallActionBody>,
) -> axum::response::Response {
    let Some(tool_id) = state.mcp.resolve_action_tool_id(&action_id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": format!("unknown action '{action_id}'") })),
        )
            .into_response();
    };
    call_mcp_tool_inner(
        state,
        caller,
        resolved.bindings.agent_id,
        CallToolBody {
            tool: tool_id,
            arguments: body.arguments,
            agent_id: body.agent_id,
            user_id: body.user_id,
            host_conversation_id: None,
            host_conversation_proof: None,
            profile_composio_connection_scope: None,
            profile_conversation_scope: None,
            mcp_allowlist: None,
            identity_profile_ids: None,
            mcp_policy_snapshot: false,
            untrusted_caller: false,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(host_conversation_id: Option<&str>) -> CallToolBody {
        serde_json::from_value(json!({
            "tool": "srv.call",
            "agent_id": "agent",
            "host_conversation_id": host_conversation_id,
        }))
        .unwrap()
    }

    fn bob() -> crate::identity_verify::VerifiedCaller {
        crate::identity_verify::VerifiedCaller {
            user_id: "bob".to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org-1".to_owned()),
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        }
    }

    /// Regression: a REST tool call without a host conversation used to run
    /// with no verified principal, so vault resolution saw no subjects and the
    /// caller's own `user:`/`role:` denies never applied.
    #[test]
    fn a_conversationless_call_binds_the_verified_caller() {
        let caller = bob();
        let bound = conversationless_caller(Some(&caller), &body(None));
        assert_eq!(bound.map(|caller| caller.user_id).as_deref(), Some("bob"));
    }

    #[test]
    fn a_conversation_call_or_owner_token_binds_no_caller() {
        let caller = bob();
        assert!(conversationless_caller(Some(&caller), &body(Some("conv-1"))).is_none());
        assert!(conversationless_caller(None, &body(None)).is_none());
    }

    #[test]
    fn only_an_anonymous_relay_of_the_live_turn_token_binds_its_sender() {
        let turn = register_gateway_turn_sender("mtc-conv-1", std::sync::Arc::new(bob()));
        let relay = |conversation: &str, proof: String| {
            let mut call = body(Some(conversation));
            call.host_conversation_proof = Some(proof);
            call
        };
        let live = relay("mtc-conv-1", turn.host_conversation_proof());
        let sender = relayed_turn_sender(None, &live).map(|sender| sender.user_id.clone());
        assert_eq!(sender.as_deref(), Some("bob"));

        // A verified caller, the bare proof, or no proof binds nothing.
        assert!(relayed_turn_sender(Some(&bob()), &live).is_none());
        let bare = relay("mtc-conv-1", host_conversation_proof("mtc-conv-1"));
        assert!(relayed_turn_sender(None, &bare).is_none());
        assert!(relayed_turn_sender(None, &body(Some("mtc-conv-1"))).is_none());

        drop(turn);
        assert!(relayed_turn_sender(None, &live).is_none());
    }
}
