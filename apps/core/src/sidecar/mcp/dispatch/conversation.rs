//! Conversation, coordination and skills arms.

use super::Dispatch;
use crate::sidecar::mcp::*;

impl McpRegistry {
    // Built-in semantic conversation-history search. Allowlist-gated like the
    // other built-ins; reports the index unavailable (not an error) when the
    // conversation store is not wired (test / CLI contexts).
    pub(super) async fn dispatch_search_conversations(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            tool_id,
            arguments,
            allowlist,
            host_conversation_id,
            conversation_scope,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        let Some(store) = self.conversations.as_ref() else {
            return Ok(serde_json::json!({
                "ok": false,
                "available": false,
                "error": "conversation search is not available on this node",
                "results": [],
                "count": 0
            }));
        };
        // The agent plane's authorization principal (see `ToolPrincipal`).
        let principal = ToolPrincipal::resolve(store, host_conversation_id).await;
        if principal.is_unresolved() {
            // BOUND node + no resolvable principal ⇒ fail closed. Agents already
            // degrade gracefully on the `available: false` envelope, so this is
            // not a new failure mode.
            return Ok(serde_json::json!({
                "ok": false,
                "available": false,
                "error": "conversation search is not available: this agent turn has no identifiable owner on a shared node",
                "results": [],
                "count": 0
            }));
        }
        search_conversations::dispatch_scoped(
            tool,
            arguments,
            store,
            &principal,
            conversation_scope,
        )
        .await
    }

    // Built-in agent-level control. The bridge supplies the calling agent and
    // host conversation from server-owned context; neither can be chosen in
    // the tool arguments. The conversation store persists the accepted patch
    // for exactly one later interactive turn.
    pub(super) async fn dispatch_agent_control(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            agent_id,
            tool_id,
            arguments,
            allowlist,
            host_conversation_id,
            account_policy,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        if tool_id != crate::agent_control::SET_ACTIVE_TARGET_TOOL_ID {
            return Err(anyhow!("unknown agent control tool '{tool_id}'"));
        }
        // Switching the conversation to another agent hands it the next
        // turn, so a restricted agent may only switch within its own access.
        if let Some(target) = crate::agent_control::parse_patch(&arguments)?
            .agent_id
            .filter(|target| Some(target.as_str()) != agent_id)
        {
            self.require_delegation_within_policy(account_policy.as_ref(), agent_id, vec![target])
                .await?;
        }
        // agent_control also re-reads the caller's record and refuses a
        // target outside its account policy, since a handoff runs the next
        // turn under the target's own record.
        crate::agent_control::dispatch(
            arguments,
            agent_id,
            host_conversation_id,
            self.agent_store.as_ref(),
            self.conversations.as_ref(),
        )
        .await
    }

    // Built-in coordinator-threads provider (Codex-style cross-thread
    // orchestration). Allowlist-gated like the other built-ins so coordination
    // is opt-in per agent; reports unavailable (not an error) when the
    // conversation store is not wired. `send_message_to_thread` further checks
    // the global agent runner and degrades gracefully when it is absent.
    pub(super) async fn dispatch_threads(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            agent_id,
            tool_id,
            arguments,
            allowlist,
            host_conversation_id,
            account_policy,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        let Some(store) = self.conversations.as_ref() else {
            return Ok(serde_json::json!({
                "ok": false,
                "available": false,
                "error": "coordinator threads are not available on this node"
            }));
        };
        // The agent plane's authorization principal (see `ToolPrincipal`).
        let principal = ToolPrincipal::resolve(store, host_conversation_id).await;
        if principal.is_unresolved() {
            return Ok(serde_json::json!({
                "ok": false,
                "available": false,
                "error": "coordinator threads are not available: this agent turn has no identifiable owner on a shared node"
            }));
        }
        // Sending runs the thread's agent, so a restricted caller may only
        // drive a thread whose agent is within its own account policy. The id
        // is trimmed like the dispatcher trims it (so padding cannot dodge the
        // lookup), and a thread that cannot be found is refused, not waved on.
        // Creating a thread bound to an explicit agent is held to the same
        // policy, so a wider agent never gets a row to run later.
        if account_policy
            .as_ref()
            .is_some_and(|policy| !policy.is_unrestricted())
        {
            if tool == "send_message_to_thread" {
                let thread_id = arguments
                    .get("thread_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| anyhow!("missing required string argument 'thread_id'"))?;
                let (uid, org, bound) = principal.filter_args();
                let Some(summary) = store
                    .get_summary_visible(thread_id, uid, org, bound)
                    .await?
                else {
                    return Err(anyhow!("thread not found"));
                };
                let target = summary
                    .agent_id
                    .unwrap_or_else(|| crate::registry::DEFAULT_AGENT_ID.to_owned());
                self.require_delegation_within_policy(
                    account_policy.as_ref(),
                    agent_id,
                    vec![target],
                )
                .await?;
            } else if tool == "create_thread" {
                if let Some(target) = arguments
                    .get("agent_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                {
                    self.require_delegation_within_policy(
                        account_policy.as_ref(),
                        agent_id,
                        vec![target.to_owned()],
                    )
                    .await?;
                }
            }
        }
        let default_isolate = match self.preferences.as_ref() {
            Some(preferences) => match preferences
                .get(threads::WORKTREE_ISOLATION_DEFAULT_PREF_KEY)
                .await
            {
                Ok(value) => threads::default_worktree_isolation(value.as_deref()),
                Err(error) => {
                    tracing::warn!(
                        error = %error,
                        "could not read the default worker worktree preference; using no worktree"
                    );
                    threads::DEFAULT_WORKTREE_ISOLATION
                }
            },
            None => threads::DEFAULT_WORKTREE_ISOLATION,
        };
        // Workers this coordinator starts get their own child Boxes.
        let box_scope = box_desktop::subagent_scope_for(Some(store), host_conversation_id).await;
        box_desktop::with_subagent_scope(
            box_scope,
            threads::dispatch_with_default_isolation(
                tool,
                arguments,
                store,
                &principal,
                default_isolate,
                host_conversation_id,
            ),
        )
        .await
    }

    // Built-in delegation provider (ephemeral parallel sub-agent fan-out).
    // Allowlist-gated like the other built-ins so it is opt-in when an agent
    // carries an explicit allowlist, and offered by default when it does not.
    // Needs no conversation store; the engine routes each delegate through the
    // global agent runner (or the gateway default LLM when no runner is wired).
    pub(super) async fn dispatch_delegate(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            tool_id,
            arguments,
            allowlist,
            account_policy,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        // Fanout tasks never run the named agent's tools (see the module's
        // "Read-only by construction"), but each one is a Gateway completion
        // on the node's model providers with no provider-access header. An
        // agent whose model providers are limited would get them all back.
        if account_policy
            .as_ref()
            .and_then(|policy| policy.provider_access_header())
            .is_some()
        {
            return Err(anyhow!(
                "tool '{tool_id}' runs sub-tasks on all of your model providers, which this agent's account access does not allow"
            ));
        }
        // Fan-out tasks are read-only completions that never run a registered
        // agent's tool loop, so none of them reaches a Box: they get no child
        // Box (see `threads.*` workers, which do).
        delegate::dispatch(tool, arguments).await
    }

    // Built-in orchestration discovery provider: list peer agents by
    // description so an orchestrator can pick a specialist to delegate to.
    // Allowlist-gated like the other built-ins. Reads the agent config store
    // (wired via `with_agent_store`), so it fails clearly if that is absent.
    pub(super) async fn dispatch_orchestrator(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            agent_id,
            tool_id,
            arguments,
            allowlist,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        let store = self.agent_store.clone().ok_or_else(|| {
            anyhow!(
                "orchestrator tool '{tool_id}' called but agent_store is not wired; \
                 call McpRegistry::with_agent_store at startup"
            )
        })?;
        orchestrator::dispatch(tool, arguments, store, agent_id).await
    }

    // Built-in skills provider (progressive disclosure): discover + load Agent
    // Skills on demand. Allowlist-gated like the other built-ins (offered by
    // default to an unrestricted agent such as the flagship `ryu`). Returns
    // instruction text, never executes it — a skill stays instruction text.
    pub(super) async fn dispatch_skills_tool(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            agent_id,
            tool_id,
            arguments,
            allowlist,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        let Some(skills) = self.skills.as_ref() else {
            return Ok(serde_json::json!({
                "ok": false,
                "available": false,
                "error": "skills are not available on this node"
            }));
        };
        // The calling agent's per-agent SKILL allowlist — a different list from
        // the `allowlist` argument, which is the TOOL allowlist checked above.
        // Without it `skills.load` matched on the globally-enabled set, so an
        // agent could load by id a skill its allowlist kept out of the injected
        // index. Resolved here (lazily, only for a `skills.*` call) from the
        // same store the approval gate reads `approval_tools` from.
        //
        // Fail-open to the empty list — which `enabled_for` defines as "all
        // enabled" — on every degraded path: no agent id (workflows, monitors,
        // the approval engine), no agent store, unknown id, or a store error.
        // A skill is instruction text with no secrets, so this list scopes an
        // agent to its own skills; failing closed would silently strip skills
        // from agent-less callers that legitimately had them, for no gain.
        let skills_allowlist: Vec<String> = match (agent_id, &self.agent_store) {
            (Some(id), Some(store)) => store
                .get(id)
                .await
                .ok()
                .flatten()
                .map(|rec| rec.skills)
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        skills_tool::dispatch(tool, arguments, skills, &skills_allowlist).await
    }
}

#[cfg(test)]
#[path = "../tests/dispatch_delegation.rs"]
mod tests;
