use super::*;

/// Gate `agent_builder.configure_agent` — an agent rewriting its OWN
/// configuration — behind an interactive user prompt raised over `permission_tx`.
///
/// **No channel ⇒ DENY.** `permission_tx` is the ACP stream back-channel the
/// prompt travels on; its absence does not mean "unattended, proceed", it means
/// there is nobody to ask. A permission check that cannot ask must not assume
/// yes. In-process ACP callers always supply the channel (`acp.rs` builds the
/// bridge with `Some(instance_tx)` and keeps a relay alive for the whole
/// instance), so for years this branch was unreachable — it was the transport
/// contract, written down before a transport that trips it existed.
///
/// **That transport now exists: `POST /mcp/:agent_id`** ([`serve_http_jsonrpc`]).
/// A network MCP client can never hold an `AcpEvent` sender, so it lands in this
/// branch on every call, and returning `Ok` here would hand a remote caller agent
/// self-reconfiguration with no prompt and no inbox item. The branch is live;
/// `configure_agent_is_denied_without_a_permission_channel` is what holds it.
///
/// This was the one governance layer in the `call_tool` path that read the
/// transport at all. Every other layer decides the same way for every caller:
/// [`crate::approvals::gate_tool_call`] routes an approval through the inbox
/// engine without ever looking at whether a stream is attached, and the allowlist
/// recheck inside `McpRegistry::call_tool` refuses an un-granted tool id no matter
/// who is asking. Only this one treated "nobody is listening" as consent.
///
/// The channel check deliberately runs BEFORE the one-time session-approval
/// cache. The cache records a decision a human made through an interactive
/// prompt, keyed by a caller-supplied scope id this function does not
/// authenticate; replaying it for a transport that could never have raised that
/// prompt would let a network client inherit somebody else's "Allow" just by
/// naming their conversation. "No channel is never allowed" holds unconditionally.
pub(super) async fn require_agent_builder_configure_permission(
    permission_tx: &Option<tokio::sync::mpsc::UnboundedSender<AcpEvent>>,
    permission_scope_id: Option<&str>,
    args: &Value,
) -> Result<(), McpError> {
    let Some(tx) = permission_tx else {
        return Err(McpError::new(
            rmcp::model::ErrorCode::INVALID_REQUEST,
            "'agent_builder.configure_agent' requires an interactive permission channel \
             to ask the user for approval, and this transport has none; call it from an \
             interactive session"
                .to_owned(),
            None,
        ));
    };
    if let Some(scope_id) = permission_scope_id {
        if AGENT_BUILDER_CONFIGURE_APPROVALS
            .lock()
            .map(|approvals| approvals.contains(scope_id))
            .unwrap_or(false)
        {
            return Ok(());
        }
    }
    let agent_id = args
        .get("agent_id")
        .and_then(Value::as_str)
        .unwrap_or("this agent");
    let chosen = crate::sidecar::adapters::acp::request_user_permission(
        tx,
        json!({
            "title": "configure itself",
            "kind": "agent_builder.configure",
            "agent_id": agent_id,
            "fields": {
                "title": "configure itself"
            }
        }),
        json!([
            {
                "optionId": "allow_once",
                "name": "Allow once",
                "kind": "allow_once"
            },
            {
                "optionId": "allow_session",
                "name": "Allow for session",
                "kind": "allow_always"
            },
            {
                "optionId": "reject_once",
                "name": "Deny",
                "kind": "reject_once"
            }
        ]),
        // The host conversation, so `POST /api/chat/permission` can gate the decision
        // on the thread that raised it.
        permission_scope_id.map(str::to_owned),
    )
    .await;
    match chosen.as_deref() {
        Some("allow_once") => Ok(()),
        Some("allow_session") => {
            if let Some(scope_id) = permission_scope_id {
                if let Ok(mut approvals) = AGENT_BUILDER_CONFIGURE_APPROVALS.lock() {
                    approvals.insert(scope_id.to_owned());
                }
            }
            Ok(())
        }
        _ => Err(McpError::new(
            rmcp::model::ErrorCode::INVALID_REQUEST,
            "user denied permission to configure the agent".to_owned(),
            None,
        )),
    }
}

/// Whether `gate_id` changes Gateway or routing settings. Those are approved one
/// call at a time: "Allow for this chat" covers every later call to the tool
/// whatever its arguments, so one approved budget edit would let a later,
/// injected edit of a different section run without asking.
pub(super) fn is_gateway_settings_change(gate_id: &str) -> bool {
    crate::self_api::is_mutating(gate_id)
        && crate::self_api::route_for(gate_id).is_some_and(|route| {
            route.path_template.starts_with("/api/gateway/")
                || route.path_template.starts_with("/api/routing/")
        })
}

/// The in-chat permission card's choices for `gate_id`: no "Allow for this
/// chat" for a Gateway or routing change (see [`is_gateway_settings_change`]).
pub(super) fn consent_options(gate_id: &str) -> Value {
    if is_gateway_settings_change(gate_id) {
        return json!([
            { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" },
            { "optionId": "reject_once", "name": "Deny", "kind": "reject_once" }
        ]);
    }
    json!([
        { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" },
        { "optionId": "allow_session", "name": "Allow for this chat", "kind": "allow_always" },
        { "optionId": "reject_once", "name": "Deny", "kind": "reject_once" }
    ])
}

/// What an in-chat permission prompt says the agent wants to do.
pub(super) fn in_chat_consent_title(tool_id: &str, args: &Value) -> String {
    if tool_id == crate::approvals::chat_grants::SWITCH_INTERFACE_TOOL_ID {
        let interface = args
            .get("interface")
            .and_then(Value::as_str)
            .unwrap_or("another interface");
        return format!("switch your interface to {interface}");
    }
    if let Some(route) = crate::self_api::route_for(tool_id) {
        let summary = route.summary.trim().trim_end_matches('.');
        let endpoint = format!("{} {}", route.method, route.path_template);
        return if summary.is_empty() {
            format!("change Ryu settings ({endpoint})")
        } else {
            format!("{} ({endpoint})", summary.to_lowercase())
        };
    }
    format!("run {tool_id}")
}
