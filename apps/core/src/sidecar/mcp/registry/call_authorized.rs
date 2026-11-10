//! The gated, authorized tool-call entry point.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// Only the interactive bridge calls this after its dedicated configuration
    /// permission prompt succeeds. Other ingress paths retain `false`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn call_tool_with_identity_scoped_authorized(
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
        let is_capability_provider_dispatch = CAPABILITY_PROVIDER_DISPATCH
            .try_with(|in_dispatch| *in_dispatch)
            .unwrap_or(false);
        if !is_capability_provider_dispatch && self.is_direct_web_provider_tool(tool_id).await {
            bail!("call web or browser providers through their canonical layer tools");
        }
        if !is_capability_provider_dispatch
            && self
                .web_access_restricted_provider_tools(self.web_search_access_mode().await)
                .await
                .contains(tool_id)
        {
            bail!("tool '{tool_id}' is disabled by the node's web search access mode");
        }
        if self
            .selected_only_tool_refused(tool_id, is_capability_provider_dispatch)
            .await
        {
            bail!("{SELECTED_ONLY_TOOL_REFUSAL}");
        }
        if web_search_access::is_web_access_tool_id(tool_id)
            && !self.web_search_access_mode().await.allows_tool_id(tool_id)
        {
            bail!("tool '{tool_id}' is disabled by the node's web search access mode");
        }
        // Early refusal so an ungranted source is never queued for approval;
        // the no-gate dispatch core re-checks the resolved target.
        self.enforce_control_plane_source_grants(tool_id)?;
        // Org tool policy runs before the approval gate so a denied tool is
        // refused outright instead of being queued for a human to approve.
        self.enforce_org_tool_policy(tool_id, host_conversation_id)
            .await?;
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
        // Profile bootstrap is a scoped read job, not a general agent turn. Keep
        // its source ceiling at the registry chokepoint so prompt injection cannot
        // switch to another MCP server, PTC, delegation, or a Core API tool that
        // would bypass the selected Composio accounts/imported chats.
        if !profile_scope_allows_registry_tool(
            tool_id,
            composio_connection_scope.is_some(),
            conversation_scope.is_some(),
        ) {
            return Err(anyhow!(
                "profile bootstrap may access only selected connected sources and imported conversations"
            ));
        }
        let normalized_allowlist = allowlist.map(|list| {
            list.iter()
                .map(|entry| self.canonical_tool_id_for_registry(entry))
                .collect::<Vec<_>>()
        });
        let allowlist = normalized_allowlist.as_deref();

        // Layer A input: the calling agent's configured approval_tools. Missing
        // store / unknown id degrade to an empty list (Layers B/B′ still apply).
        let agent_record = match (agent_id, &self.agent_store) {
            (Some(id), Some(store)) => store.get(id).await.ok().flatten(),
            _ => None,
        };
        if agent_record.as_ref().is_some_and(|record| {
            record.safety_profile == crate::agents::AgentSafetyProfile::VerifiedPlanOnly
        }) && !tool_id.starts_with("plans.")
        {
            return Err(anyhow!(
                "verified agent direct tool call denied; submit a typed plan with plans.submit"
            ));
        }
        let mut agent_approval_tools = agent_record
            .as_ref()
            .map(|record| record.approval_tools.clone())
            .unwrap_or_default();
        // An app id's action segment is plugin-chosen and can look benign while
        // its manifest-fixed alias target is risky (`gmail.send_email`), so the
        // gate must classify the RESOLVED target — plugin naming must not launder
        // a risky call past `smart`. Native app-tool ids must use the same path:
        // their manifest metadata is just as authoritative as an `app.` id's.
        let (gate_id, action_needs_approval) = self.approval_target_for_tool(tool_id).await;
        let configures_agent =
            crate::runnable::agent_configuration_policy::requires_operator_approval(
                &self.canonical_tool_id_for_registry(&gate_id),
            );
        if configures_agent {
            require_agent_configuration_node()?;
            if crate::approvals::global_engine().is_none() {
                return Err(anyhow!(
                    "agent configuration requires the operator approval engine"
                ));
            }
        }
        let (annotations, http_method, connection_action) = self
            .tool_effect_metadata_scoped(&gate_id, agent_id, profile_ids, host_conversation_id)
            .await?;
        let effect = agent_record
            .as_ref()
            .map(|record| {
                crate::agent_execution::ensure_tool_allowed_for_record_with_metadata(
                    record,
                    &gate_id,
                    annotations.as_ref(),
                    http_method.as_deref(),
                )
            })
            .transpose()?;
        if action_needs_approval && !agent_approval_tools.iter().any(|id| id == &gate_id) {
            // An Action's explicit `needsApproval` is stronger than the global
            // smart-mode name heuristic: its author declared the side effect
            // consequential even if the slug is innocuous (for example,
            // `crm.save`). Reuse Layer A so the existing approval queue,
            // persistence, and no-gate re-dispatch remain the single path.
            agent_approval_tools.push(gate_id.clone());
        }
        if agent_record.as_ref().is_some_and(|record| {
            record.safety_profile == crate::agents::AgentSafetyProfile::ApprovalRequired
        }) && effect.is_some_and(|effect| !effect.is_read_only())
            && !agent_approval_tools.iter().any(|id| id == &gate_id)
        {
            // Reuse Layer A's existing approval queue for the agent-scoped
            // posture. This composes with global smart/manual policy rather than
            // replacing it, and approval re-dispatch still enters no_gate below.
            agent_approval_tools.push(gate_id.clone());
        }
        // A connection's default RiskBased level must use the same human review
        // path as every other consequential action. Force Layer A for known
        // connected-account writes/deletes so an innocuous provider verb such as
        // `update` cannot slip past the global name heuristic. The connection
        // ceiling still decides whether the approved call is allowed at dispatch.
        if self.is_connection_backed_tool(&gate_id)
            && !matches!(connection_action, crate::identity::ConnectionAction::Read)
            && !matches!(
                connection_action,
                crate::identity::ConnectionAction::Unknown
            )
            && !agent_approval_tools.iter().any(|id| id == &gate_id)
        {
            agent_approval_tools.push(gate_id.clone());
        }
        // Exfiltration guard (lethal trifecta): inside one PTC program run, once a
        // private-data source has returned, an egress-capable call could carry
        // what was read off the machine with no tool name looking risky. Force
        // Layer A for it, in every approval mode, and fail closed without an
        // engine. Nested provider dispatch and tool-hook calls are not the
        // program's own calls, so they are neither held nor counted.
        // It classifies the registry-canonical gate id, so a legacy `__` alias
        // target (`web__extract`) is held and counted like `web.extract`.
        let sandbox_run = crate::approvals::exfiltration_guard::current_sandbox_run()
            .filter(|_| !is_capability_provider_dispatch && !in_tool_hook());
        let flow_id = self.canonical_tool_id_for_registry(&gate_id);
        let data_flow = match &sandbox_run {
            Some(_) => {
                self.data_flow_for_tool(tool_id, &flow_id, annotations.as_ref(), connection_action)
                    .await
            }
            None => crate::approvals::exfiltration_guard::DataFlow::default(),
        };
        let held_after_private_read = sandbox_run
            .as_deref()
            .and_then(|run| crate::approvals::exfiltration_guard::held_by(run, data_flow));
        if let Some(source) = &held_after_private_read {
            if crate::approvals::global_engine().is_none() {
                return Err(crate::approvals::exfiltration_guard::held_without_engine(
                    &flow_id, source,
                ));
            }
            if !agent_approval_tools.iter().any(|id| id == &gate_id) {
                agent_approval_tools.push(gate_id.clone());
            }
        }
        if gate_id == "research.run" && crate::approvals::global_engine().is_none() {
            return Err(anyhow!(
                "research.run is disabled because the operator approval engine is unavailable"
            ));
        }
        // A challenge submission is always confirmed by the user (see
        // `approvals::policy`). Without an approval engine the gate below would
        // be skipped, so fail closed instead of submitting unconfirmed.
        if gate_id == challenges_tool::SUBMIT_TOOL_ID && crate::approvals::global_engine().is_none()
        {
            return Err(anyhow!(
                "challenges.submit is unavailable because the approval engine is not running; \
                 it never submits without the user's confirmation"
            ));
        }
        // An approval is a promise that approving makes the action happen. A
        // `skills.<slug>` CATALOG id cannot keep that promise: it is a discovery
        // row merged into `tool_search`, never a function, and every path to it
        // ends in `skills_tool::dispatch`'s fallthrough refusal — including the
        // approval engine's own re-run through `call_tool_with_identity_no_gate`.
        // So gating one queues a pending item in the user's inbox whose only
        // possible outcome is the same error the model would have received
        // immediately.
        //
        // It is reachable with ordinary skill names, not adversarial ones:
        // `approvals::policy::classify_risk` substring-matches the action segment
        // (the part after the last `.` — for `skills.deploy-to-staging` that is
        // the whole slug) against RISKY_PATTERNS, so `deploy-to-staging`,
        // `send-weekly-digest` and `delete-stale-branches` all classify risky under
        // the default `smart` mode; under `manual` every slug queues. Newly
        // reachable because skill rows only recently started appearing in front of
        // models as `skills.<slug>` ids.
        //
        // Skipping the gate here is not a privilege grant: it removes the approval
        // for a call that had no privilege to begin with, and the refusal below is
        // unchanged. Everything after this block — plugin PreToolUse hooks, the
        // identity consult, the TOOL-allowlist check inside `no_gate`, the
        // skills-unavailable envelope — still runs in the same order for these ids,
        // so an agent whose tool allowlist excludes the `skills` server still gets
        // "not in this agent's allowlist" rather than the refusal, exactly as before.
        //
        // Items already sitting in an inbox for a `skills.<slug>` id are untouched:
        // approving one still lands in the dispatch fallthrough and still returns
        // the refusal. This stops new ones being created; it does not migrate old.
        //
        // (Independent of the `?agent=` skill scoping on the SEARCH path — that is
        // which skill rows a plane may see; this is what happens when a model calls
        // one. Same ids, different mechanisms.)
        if approval_gate_applies(&gate_id) {
            if let Some(err) = crate::approvals::gate_tool_call(
                &gate_id,
                if configures_agent { tool_id } else { &gate_id },
                &arguments,
                agent_id,
                &agent_approval_tools,
                allowlist,
                user_id,
                profile_ids,
                session_id.clone(),
                host_conversation_id,
                composio_connection_scope,
                conversation_scope,
                configure_approved,
                // A held egress call is never satisfied by an earlier in-chat
                // "Allow": that grant was given for the tool, not for sending data
                // this program read.
                held_after_private_read.is_none(),
            )
            .await
            {
                // Gated: return the "approval required" error instead of dispatching.
                // Every plane treats a tool error as not-done, so the call cannot be
                // mistaken for a completed side effect; the engine runs it on approve.
                return Err(match &held_after_private_read {
                    Some(source) => {
                        crate::approvals::exfiltration_guard::held_for_approval(&err, source)
                    }
                    None => err,
                });
            }
        }

        let result = self
            .call_tool_with_identity_after_approval_scoped(
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
        // Mark the run only once the private data is actually on its way back to
        // the program (before the reply reaches it), so a refused or gated read
        // does not taint the run but every data-dependent call after it is held.
        if result.is_ok() && data_flow.private_source {
            if let Some(run) = &sandbox_run {
                run.mark_private_read(&flow_id);
            }
        }
        result
    }
}

#[cfg(test)]
#[path = "../tests/gated_entry.rs"]
mod tests;
