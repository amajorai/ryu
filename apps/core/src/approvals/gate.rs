//! The Layer-B approval gate at the tool-dispatch chokepoint.

use super::*;

/// Layer-B approval gate at the tool-dispatch chokepoint. If the global approval
/// mode gates `tool_id`, mint a `ToolCall` approval capturing the full
/// re-dispatch context and return `Some(err)` — the caller returns that error
/// **instead of dispatching** the tool. Returning an error (not a plain
/// "pending" value) is deliberate: every plane treats a tool error as
/// not-done, so a gated call can never masquerade as a completed side effect
/// (a sandbox program's `await tool()` throws rather than silently continuing;
/// the chat/ACP model sees "approval required"). The engine runs the tool for
/// real on approve.
///
/// Returns `None` when nothing gates the call (e.g. a non-risky tool under the
/// default `smart` mode, or an explicit operator `approval-mode=off`).
///
/// **Fail-closed:** if the approval cannot be persisted, this still returns
/// `Some(err)` so the risky action is NOT run when its required approval could
/// not be recorded.
///
/// `agent_approval_tools` is Layer A — the calling agent's configured
/// `approval_tools` list (pass `&[]` for agent-less callers). Composio tools are
/// NOT exempt: the connection flow is authentication, not approval, so a risky
/// `composio.*` action (send/delete/pay across 250+ SaaS apps) gates like any
/// other tool; only its connect/consent elicitation runs ungated (that path
/// returns an `__ryu_elicitation__` envelope instead of executing).
#[allow(clippy::too_many_arguments)]
/// Run an app-requested turn, persisted into a conversation the user can open.
///
/// A free function, and the ONE implementation of an app send: both the
/// approval-gated path (via [`ApprovalEngine::execute_action`]) and the
/// gate-off path in `server::host_chat` call exactly this, so an approved send and
/// an unattended one cannot drift into behaving differently.
///
/// `run_worker` rather than `run` because it is the `persist = true` primitive —
/// both the user instruction and the reply are written to history. `isolate =
/// false` and no `cwd`: a message the user asked to be sent belongs in an ordinary
/// conversation, not in a coordinator's throwaway git worktree.
pub async fn execute_app_send_turn(action: &PendingAction) -> anyhow::Result<()> {
    let PendingAction::AppSendTurn {
        agent_id,
        conversation_id,
        cwd,
        text,
        ..
    } = action
    else {
        return Err(anyhow::anyhow!("not an app send"));
    };
    let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() else {
        // No runner ⇒ nothing can answer. Reported rather than swallowed: the
        // caller marked a queued message as dispatched on the strength of this.
        return Err(anyhow::anyhow!(
            "no agent runner is published on this node; the message was not sent"
        ));
    };
    runner
        .run_worker(
            agent_id.clone(),
            conversation_id.clone(),
            text.clone(),
            cwd.clone(),
            false,
        )
        .await
        .map(|_reply| ())
}

pub async fn gate_tool_call(
    policy_tool_id: &str,
    dispatch_tool_id: &str,
    arguments: &serde_json::Value,
    agent_id: Option<&str>,
    agent_approval_tools: &[String],
    allowlist: Option<&[String]>,
    user_id: Option<&str>,
    profile_ids: &[String],
    session_id: Option<String>,
    host_conversation_id: Option<&str>,
    composio_connection_scope: Option<&[crate::sidecar::adapters::ComposioConnectionBinding]>,
    conversation_scope: Option<&[String]>,
    configure_approved: bool,
    chat_grants_honored: bool,
) -> Option<anyhow::Error> {
    let engine = global_engine()?;
    gate_tool_call_with_engine(
        engine,
        policy_tool_id,
        dispatch_tool_id,
        arguments,
        agent_id,
        agent_approval_tools,
        allowlist,
        user_id,
        profile_ids,
        session_id,
        host_conversation_id,
        composio_connection_scope,
        conversation_scope,
        configure_approved,
        chat_grants_honored,
    )
    .await
}

/// `chat_grants_honored` is `false` for a call the exfiltration guard holds
/// ([`exfiltration_guard`]): an in-chat "Allow" was given for the tool, not for
/// sending out data a program read, so such a call always goes to the inbox.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn gate_tool_call_with_engine(
    engine: &ApprovalEngine,
    policy_tool_id: &str,
    dispatch_tool_id: &str,
    arguments: &serde_json::Value,
    agent_id: Option<&str>,
    agent_approval_tools: &[String],
    allowlist: Option<&[String]>,
    user_id: Option<&str>,
    profile_ids: &[String],
    session_id: Option<String>,
    host_conversation_id: Option<&str>,
    composio_connection_scope: Option<&[crate::sidecar::adapters::ComposioConnectionBinding]>,
    conversation_scope: Option<&[String]>,
    configure_approved: bool,
    chat_grants_honored: bool,
) -> Option<anyhow::Error> {
    // Layer C: the organization's tool policy is consulted first. A denial is
    // final and is never queued, so approving cannot override the admin.
    let org_policy = crate::org_policy::current();
    if let Some(reason) = policy::org_policy_denial(
        org_policy.as_deref().map(|snapshot| &snapshot.rules),
        policy_tool_id,
    ) {
        crate::org_policy::record_denial("org_policy.tool_denied", dispatch_tool_id, &reason);
        return Some(anyhow::anyhow!(
            "This action (`{dispatch_tool_id}`) was not run: {reason}. It cannot be approved locally; ask an organization admin to change the tool policy."
        ));
    }
    let raw_pref = engine.approval_mode_pref().await;
    let mode = policy::ApprovalMode::from_pref(raw_pref.as_deref().unwrap_or_default());
    let tags = policy::should_require_approval_local(
        agent_approval_tools,
        policy_tool_id,
        mode,
        raw_pref.as_deref(),
    )?;
    // The user already allowed this exact call (or this tool for the whole
    // conversation) in the chat that raised it. See `chat_grants`.
    if chat_grants_honored
        && host_conversation_id.is_some_and(|conversation_id| {
            chat_grants::take(conversation_id, policy_tool_id, arguments)
        })
    {
        return None;
    }

    let action = PendingAction::ToolCall {
        tool_id: dispatch_tool_id.to_owned(),
        arguments: arguments.clone(),
        agent_id: agent_id.map(str::to_owned),
        allowlist: allowlist.map(<[String]>::to_vec),
        user_id: user_id.map(str::to_owned),
        profile_ids: profile_ids.to_vec(),
        session_id,
        host_conversation_id: host_conversation_id.map(str::to_owned),
        composio_connection_scope: composio_connection_scope
            .map(<[crate::sidecar::adapters::ComposioConnectionBinding]>::to_vec),
        conversation_scope: conversation_scope.map(<[String]>::to_vec),
        configure_approved,
    };
    let mut req = ApprovalRequest::for_tool_call(dispatch_tool_id, tags, action);
    if let Some(intent) = tool_intent::resolve(policy_tool_id, arguments, agent_id).await {
        req.apply_tool_intent(intent);
    }
    match engine.request(req).await {
        Ok(created) => Some(anyhow::anyhow!(
            "This action (`{dispatch_tool_id}`) requires your approval before it runs. It has been queued in your Approvals inbox (id {}) and will run once you approve it.",
            created.id
        )),
        // Fail CLOSED: could not queue the approval ⇒ do NOT run the tool.
        Err(e) => Some(anyhow::anyhow!(
            "This action (`{dispatch_tool_id}`) requires approval, but the approval could not be queued ({e}); it was not run."
        )),
    }
}
