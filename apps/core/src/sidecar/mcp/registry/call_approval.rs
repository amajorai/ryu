//! Approved and ungated tool-call entry points.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// Dispatch after an approval decision while preserving every plugin security
    /// boundary around the provider call. Safe Actions and the legacy approval
    /// engine use this entry so they skip only the duplicate human-approval gate;
    /// they still run pre-tool firewalls, result redaction, and post-tool audit
    /// hooks exactly like a direct governed call.
    pub(crate) async fn call_tool_with_identity_after_approval(
        &self,
        agent_id: Option<&str>,
        tool_id: &str,
        arguments: Value,
        allowlist: Option<&[String]>,
        user_id: Option<&str>,
        profile_ids: &[String],
        session_id: Option<String>,
        host_conversation_id: Option<&str>,
    ) -> Result<Value> {
        self.call_tool_with_identity_after_approval_scoped(
            agent_id,
            tool_id,
            arguments,
            allowlist,
            user_id,
            profile_ids,
            session_id,
            host_conversation_id,
            None,
            None,
            false,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn call_tool_with_identity_after_approval_scoped(
        &self,
        agent_id: Option<&str>,
        tool_id: &str,
        arguments: Value,
        allowlist: Option<&[String]>,
        user_id: Option<&str>,
        profile_ids: &[String],
        session_id: Option<String>,
        host_conversation_id: Option<&str>,
        composio_connection_scope: Option<&[crate::sidecar::adapters::ComposioConnectionBinding]>,
        conversation_scope: Option<&[String]>,
        configure_approved: bool,
    ) -> Result<Value> {
        let normalized_tool_id = self.canonical_tool_id_for_registry(tool_id);
        let tool_id = normalized_tool_id.as_str();
        if let Some(agent_id) = agent_id {
            if !crate::fleet::is_agent_available(agent_id) {
                return Err(anyhow!(
                    "agent '{agent_id}' is unavailable under the node's organization policy"
                ));
            }
        }
        if let Some((server, _)) = self.split_registered_tool_id(tool_id) {
            if crate::fleet::is_artifact_blocked(server) {
                return Err(anyhow!(
                    "MCP server '{server}' is blocked under the node's organization policy"
                ));
            }
        }
        let normalized_allowlist = allowlist.map(|list| {
            list.iter()
                .map(|entry| self.canonical_tool_id_for_registry(entry))
                .collect::<Vec<_>>()
        });
        let allowlist = normalized_allowlist.as_deref();

        // PreToolUse hooks (Claude parity): a plugin tool-firewall may block the
        // call. This is a per-agent plugin layer ON TOP of the Gateway's own tool
        // governance, not a replacement for it. Fail-open + bounded timeout +
        // reentrancy-guarded, so installing a hook plugin can never wedge or break
        // tool dispatch. Skipped instantly (DB-free) when no tool-hook plugin is
        // loaded (`any_manifest_declares`).
        if let Some(reason) = run_pre_tool_hooks(tool_id, &arguments, session_id.as_deref()).await {
            return Err(anyhow!(
                "tool '{tool_id}' blocked by a plugin hook: {reason}"
            ));
        }
        // Keep a copy for the post-hooks before `arguments` is consumed.
        let tool_input = arguments.clone();
        // `session_id` is moved into the dispatch core below, so keep the id the
        // `tool_result` hooks need for their conversation-scoped storage.
        let hook_session_id = session_id.clone();

        let result = self
            .call_tool_with_identity_no_gate_scoped(
                agent_id,
                tool_id,
                arguments,
                allowlist,
                user_id,
                profile_ids,
                session_id,
                host_conversation_id,
                composio_connection_scope,
                conversation_scope,
                configure_approved,
            )
            .await;

        match result {
            Ok(output) => {
                // `tool_result` hooks: AWAITED, and may rewrite the result before the
                // model ever sees it (redaction / narrowing). Fail-open — on timeout,
                // error, or no subscriber the original output is used unchanged.
                let output = run_tool_result_hooks(
                    tool_id,
                    &tool_input,
                    &output,
                    hook_session_id.as_deref(),
                )
                .await
                .unwrap_or(output);
                // PostToolUse hooks: observe-only, fired detached so they add no
                // latency and cannot fail the call. They observe the FINAL output —
                // the same bytes the model got. Deliberate: a `tool_result` hook that
                // redacts a secret is a security boundary, and handing the raw value
                // to every other installed plugin afterwards would defeat it.
                fire_post_tool_hooks(tool_id.to_string(), tool_input, output.clone());
                Ok(output)
            }
            Err(e) => Err(e),
        }
    }

    /// The ungated tool-dispatch core: identity consult + provider dispatch, with
    /// **no** approval gate. Called by [`call_tool_with_identity`] after the gate
    /// permits the call, and directly by the approval engine to run an approved
    /// tool call exactly once (without re-raising an approval).
    ///
    /// `agent_id` is the CALLING agent, threaded from [`call_tool_with_identity`]
    /// (it is first, mirroring that entry's shape, so the three `Option<&str>`
    /// arguments cannot be transposed unnoticed). It is what per-agent *record*
    /// state is resolved from at dispatch — today the skill allowlist for the
    /// `skills` provider. `None` for the agent-less callers (workflows, monitors,
    /// recipes, capability adapters, the approval engine), which degrade to the
    /// unscoped behaviour they had before.
    pub(crate) async fn call_tool_with_identity_no_gate(
        &self,
        agent_id: Option<&str>,
        tool_id: &str,
        arguments: Value,
        allowlist: Option<&[String]>,
        user_id: Option<&str>,
        profile_ids: &[String],
        session_id: Option<String>,
        host_conversation_id: Option<&str>,
    ) -> Result<Value> {
        self.call_tool_with_identity_no_gate_scoped(
            agent_id,
            tool_id,
            arguments,
            allowlist,
            user_id,
            profile_ids,
            session_id,
            host_conversation_id,
            None,
            None,
            false,
        )
        .await
    }

    // The dispatcher can re-enter through a capability facade or app alias.
    // Keeping its full async state inline duplicates it through each approval
    // and identity wrapper; debug builds then exhaust ordinary 2 MiB workers.
    // Allocate this production boundary once, before constructing those wrappers.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn call_tool_with_identity_no_gate_scoped<'a>(
        &'a self,
        agent_id: Option<&'a str>,
        tool_id: &'a str,
        arguments: Value,
        allowlist: Option<&'a [String]>,
        user_id: Option<&'a str>,
        profile_ids: &'a [String],
        session_id: Option<String>,
        host_conversation_id: Option<&'a str>,
        composio_connection_scope: Option<
            &'a [crate::sidecar::adapters::ComposioConnectionBinding],
        >,
        conversation_scope: Option<&'a [String]>,
        configure_approved: bool,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + 'a>> {
        let dispatch = self.call_tool_with_identity_no_gate_scoped_inner(
            agent_id,
            tool_id,
            arguments,
            allowlist,
            user_id,
            profile_ids,
            session_id,
            host_conversation_id,
            composio_connection_scope,
            conversation_scope,
            configure_approved,
        );
        // Every plane reaches this core, so a sub-turn a tool starts (delegate,
        // coordinator worker, app or workflow run) inherits the profile-activity
        // attribution of the turn that called it, also when the call arrives over
        // the ACP bridge or the Gateway exec plane outside that turn's task.
        let dispatch = crate::profile_activity::with_attribution(
            crate::profile_activity::dispatch_attribution(host_conversation_id),
            dispatch,
        );
        // Every plane reaches this core, so it owns the `tools/call {tool}` span;
        // MCP requests issued inside it carry its traceparent. Without export
        // consent the span is disabled and the dispatch is boxed unchanged.
        let span = crate::sidecar::gen_ai_spans::mcp_tools_call_span(tool_id);
        if span.is_none() {
            return Box::pin(dispatch);
        }
        Box::pin(async move {
            use tracing::Instrument as _;
            let result = dispatch.instrument(span.clone()).await;
            crate::sidecar::gen_ai_spans::record_dispatch_result(&span, result.as_ref().ok());
            result
        })
    }

    /// Refuse a tool whose control-plane-managed source (an external MCP
    /// server or a `composio.<slug>` toolkit) is not granted. Where grants are
    /// not enforced (unbound and local-first nodes) this always passes.
    pub(in crate::sidecar::mcp) fn enforce_control_plane_source_grants(
        &self,
        tool_id: &str,
    ) -> Result<()> {
        if let Some((server, _)) = self.split_registered_tool_id(tool_id) {
            let is_external_mcp = self
                .servers
                .read()
                .ok()
                .is_some_and(|servers| servers.contains_key(server));
            if is_external_mcp
                && !crate::sidecar::control_plane::resolved_source_granted("mcp", server)
            {
                return Err(anyhow!(
                    "MCP server '{server}' is not granted by the control plane"
                ));
            }
        }
        if let Some(toolkit) = composio_grant_slug(tool_id) {
            if !crate::sidecar::control_plane::resolved_source_granted("composio", &toolkit) {
                return Err(anyhow!(
                    "Composio toolkit '{toolkit}' for '{tool_id}' is not granted by the control plane"
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "../tests/call_entries.rs"]
mod tests;
