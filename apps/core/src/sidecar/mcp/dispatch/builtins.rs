//! Arms for Core's in-process built-in providers.

use super::Dispatch;
use crate::sidecar::mcp::*;

impl McpRegistry {
    pub(super) async fn dispatch_cloud(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            tool_id,
            arguments,
            allowlist,
            user_id,
            host_conversation_id,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                bail!("tool '{tool_id}' is not in this agent's allowlist");
            }
        }
        let conversation_id = host_conversation_id
            .filter(|id| !id.is_empty())
            .ok_or_else(|| anyhow!("Cloud tools require a verified host conversation"))?;
        let store = self
            .conversations
            .as_ref()
            .ok_or_else(|| anyhow!("Conversation ownership is unavailable"))?;
        let meta = store
            .get_access_meta(conversation_id)
            .await?
            .ok_or_else(|| anyhow!("Cloud conversation does not exist"))?;
        let principal = ToolPrincipal::resolve_optional(Some(store), Some(conversation_id)).await;
        let owner = match (principal, meta.owner_user_id) {
            (ToolPrincipal::Owned { user_id, .. }, Some(owner)) if user_id == owner => {
                format!("user:{owner}")
            }
            (ToolPrincipal::Unrestricted, Some(owner)) => format!("user:{owner}"),
            (ToolPrincipal::Unrestricted, None) => "node-owner".to_owned(),
            _ => bail!("Cloud conversation ownership does not match the verified caller"),
        };
        crate::server::cloud_tasks::execute_bound_tool(&owner, conversation_id, tool, arguments)
            .await
    }

    // Built-in wasmtime sandbox provider (M6 / issue #190).
    pub(super) async fn dispatch_sandbox(
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
            session_id,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        sandbox::dispatch_with_context(tool, arguments, agent_id, session_id).await
    }

    // Built-in desktop-notification provider (#456): dispatched in-process,
    // publishing to the events channel the desktop subscribes to.
    pub(super) async fn dispatch_notify_tool(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
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
        notify_tool::dispatch(tool, arguments).await
    }

    // Built-in device capability provider: invokes a capability on a paired,
    // securely-connected Ryu device. Personal nodes only; an org-bound call
    // without a resolvable principal is refused before the device is reached.
    pub(super) async fn dispatch_device_tool(
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
        // Paired Ryu devices are the user's own hardware, so they count as
        // control of the user's machine: an agent with only its own identity
        // never gets them, and a limited agent needs `platform:desktop`.
        crate::agent_access::require_desktop_access(account_policy.as_ref())?;
        let principal =
            ToolPrincipal::resolve_optional(self.conversations.as_ref(), host_conversation_id)
                .await;
        if principal.is_unresolved() {
            bail!("device tools require a verified caller");
        }
        device_tool::dispatch(tool, arguments, agent_id).await
    }

    // Built-in artifact provider: saves a generated file into a Space (default
    // Artifacts). Dispatched in-process against the wired SpaceStore.
    pub(super) async fn dispatch_artifact_tool(
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
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        let principal =
            ToolPrincipal::resolve_optional(self.conversations.as_ref(), host_conversation_id)
                .await;
        artifact_tool::dispatch(tool, arguments, self.spaces.as_ref(), &principal).await
    }

    // Built-in Spaces provider. Reads and mutations share the same server-derived
    // tenancy principal as conversation search; mutating calls are additionally
    // held by the normal approval gate before they reach this branch.
    pub(super) async fn dispatch_spaces_tool(
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
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        let principal =
            ToolPrincipal::resolve_optional(self.conversations.as_ref(), host_conversation_id)
                .await;
        spaces_tool::dispatch(
            tool,
            arguments,
            self.spaces.as_ref(),
            self.agent_store.as_ref(),
            &principal,
            agent_id,
        )
        .await
    }

    // Built-in working memory: the owner, document id, and mode are all
    // server-derived; the model supplies only the new content / patch.
    pub(super) async fn dispatch_working_memory_tool(
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
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        let principal =
            ToolPrincipal::resolve_optional(self.conversations.as_ref(), host_conversation_id)
                .await;
        working_memory_tool::dispatch(
            tool,
            arguments,
            self.memory.as_ref(),
            self.agent_store.as_ref(),
            &principal,
            agent_id,
            host_conversation_id,
        )
        .await
    }

    // Built-in generative-UI provider: client-rendered (no-op in Core). The
    // desktop renders the spec from the tool input; dispatch only sanity-checks.
    pub(super) async fn dispatch_ui_tool(
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
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        ui_tool::dispatch(
            tool,
            arguments,
            self.conversations.as_ref(),
            host_conversation_id,
        )
        .await
    }

    // Built-in consent requests: client-rendered cards (no-op in Core). The
    // user's click drives the existing connection / install routes.
    pub(super) async fn dispatch_consent_tool(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
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
        consent_tool::dispatch(tool, arguments).await
    }

    // Built-in suggested next task: a client-rendered card (no-op in Core).
    // The task only runs when the user clicks Start, as an ordinary new chat.
    pub(super) async fn dispatch_tasks_tool(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
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
        tasks_tool::dispatch(tool, arguments).await
    }

    // Built-in workspace shell actions. They publish a server-derived,
    // user-scoped navigation request; the connected Desktop consumes it and
    // applies the same page-key allowlist as the workspace dock.
    pub(super) async fn dispatch_workspace_tool(
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
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        let principal =
            ToolPrincipal::resolve_optional(self.conversations.as_ref(), host_conversation_id)
                .await;
        workspace_tool::dispatch(tool, arguments, &principal).await
    }

    // Built-in routine CRUD. The routine tool receives the same
    // server-derived principal and host conversation scope as Spaces and
    // conversation tools; model-supplied user ids never become authority.
    pub(super) async fn dispatch_routines_tool(
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
            user_id,
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
        // A routine runs its agent with that agent's account access, so a
        // restricted agent may only schedule or run agents within its own.
        let targets = routines_tool::routine_target_agents(tool, &arguments, agent_id)?;
        self.require_delegation_within_policy(account_policy.as_ref(), agent_id, targets.clone())
            .await?;
        let principal =
            ToolPrincipal::resolve_optional(self.conversations.as_ref(), host_conversation_id)
                .await;
        // The routine runs for this member, so they need `agent.run` on it.
        if let ToolPrincipal::Owned { user_id, .. } = &principal {
            crate::scheduler::agent_run_access::require_owner_may_run_agents(
                Some(user_id),
                &targets,
            )
            .await
            .map_err(|error| anyhow!(error))?;
        }
        routines_tool::dispatch(
            tool,
            arguments,
            &principal,
            self.agent_store.as_ref(),
            self.conversations.as_ref(),
            agent_id,
            host_conversation_id,
            account_policy.as_ref(),
        )
        .await
    }

    // Built-in send-to-channel provider (#456): posts to a Slack/Discord
    // incoming-webhook URL over HTTP.
    pub(super) async fn dispatch_channel_tool(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
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
        channel_tool::dispatch(&self.http, tool, arguments).await
    }

    // Built-in Agent Inbox provider: the calling agent's hosted address. The
    // agent identity comes from this dispatch context, never the arguments.
    pub(super) async fn dispatch_agent_inbox_tool(
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
        agent_inbox_tool::dispatch(
            &self.http,
            tool,
            arguments,
            agent_id,
            self.agent_store.as_ref(),
        )
        .await
    }
}

#[cfg(test)]
#[path = "../tests/dispatch_builtins.rs"]
mod tests;
