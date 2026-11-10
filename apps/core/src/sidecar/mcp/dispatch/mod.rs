//! The no-gate dispatch core every tool-call plane reaches, and its arms.

mod app_tool;
mod builders;
mod builtins;
mod capability;
mod composio;
mod conversation;
mod external;
mod loopback;
mod router;

use crate::sidecar::mcp::*;

/// Everything the dispatch core resolved before it picks the arm that runs a call.
struct Dispatch<'a> {
    agent_id: Option<&'a str>,
    tool_id: &'a str,
    arguments: Value,
    allowlist: Option<&'a [String]>,
    user_id: Option<&'a str>,
    profile_ids: &'a [String],
    session_id: Option<String>,
    host_conversation_id: Option<&'a str>,
    composio_connection_scope: Option<&'a [crate::sidecar::adapters::ComposioConnectionBinding]>,
    conversation_scope: Option<&'a [String]>,
    configure_approved: bool,
    account_policy: Option<crate::agent_access::AgentAccountPolicy>,
    connection_action: crate::identity::ConnectionAction,
    injected_credential: Option<crate::identity::SecretState>,
}

impl McpRegistry {
    #[allow(clippy::too_many_arguments)]
    pub(in crate::sidecar::mcp) async fn call_tool_with_identity_no_gate_scoped_inner(
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
        // Cloud-task conversations run only their cloud tools, plus `computer.*`
        // and `browser.*` when they are routed to their Box; a conversation on
        // a Box never drives the node's display, through Shadow computer use or a
        // node display provider's own tools. A facade dispatch the Box router
        // left on the node (the owner's `node` preference) is not refused here.
        if let Some(conversation_id) = host_conversation_id {
            let drives_node_display =
                !is_capability_provider_dispatch && self.drives_node_display(tool_id).await;
            if let Some(refusal) = box_desktop::conversation_gate(
                self.conversations.as_ref(),
                conversation_id,
                tool_id,
                drives_node_display,
            )
            .await
            {
                bail!("{refusal}");
            }
        }
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
        // Control-plane source grants are checked at this final dispatch
        // boundary too: capability facades, app aliases, approval replays and
        // workflow callers reach it without the gated entry, and a facade's
        // resolved provider target is only visible here. Unlike the direct
        // web-provider check, capability-provider dispatch is not exempt.
        self.enforce_control_plane_source_grants(tool_id)?;
        // Every dispatch (approved re-runs, workflows, adapters) reaches this
        // core, so the org tool policy is enforced here as well as before the
        // approval gate. The rules are re-resolved for this call's principal
        // (cached per caller for a short TTL).
        self.enforce_org_tool_policy(tool_id, host_conversation_id)
            .await?;
        let normalized_allowlist = allowlist.map(|list| {
            list.iter()
                .map(|entry| self.canonical_tool_id_for_registry(entry))
                .collect::<Vec<_>>()
        });
        let allowlist = normalized_allowlist.as_deref();
        // The calling agent's account policy. An agent with its own identity
        // never acts with the user's Identity Vault profiles, so they are
        // dropped here, before effect metadata, Passport, the vault consult and
        // MCP OAuth can read them. Composio is narrowed in its branch below.
        let account_policy = self.agent_account_policy(agent_id).await?;
        let profile_ids: &[String] = match &account_policy {
            Some(policy) if !policy.allows_user_accounts() => &[],
            _ => profile_ids,
        };
        let (tool_annotations, tool_http_method, connection_action) = self
            .tool_effect_metadata_scoped(tool_id, agent_id, profile_ids, host_conversation_id)
            .await?;

        // A filesystem-shaped delete tool is a second way for an agent to
        // remove a path without producing a shell command. Keep this check in
        // the no-gate dispatch core so an approved re-dispatch, an app alias,
        // and an agent-less internal caller cannot bypass the default-deny
        // safety policy. A normal approval or `approval-mode=off` is not enough
        // to authorize permanent filesystem deletion; this policy has no opt-out.
        if ryu_deletion_guard::is_filesystem_delete_tool(tool_id) {
            return Err(anyhow!(
                "permanent filesystem deletion blocked by Ryu; use the host Trash or Recycle Bin command instead"
            ));
        }

        // A capability adapter or other agent-less caller has no persisted card
        // from which to prove these privileges. Require a calling agent before
        // any privileged built-in reaches its dispatch arm.
        let orchestration_tool =
            self.split_registered_tool_id(tool_id)
                .is_some_and(|(server, _)| {
                    server == delegate::SERVER_NAME || server == orchestrator::SERVER_NAME
                });
        let creation_tool = tool_id == CREATE_AGENT_TOOL_ID || tool_id == CREATE_AGENT_TEAM_TOOL_ID;
        let configuration_tool = tool_id == "agent_builder.configure_agent";
        if agent_id.is_none() && (orchestration_tool || creation_tool || configuration_tool) {
            return Err(anyhow!(
                "tool '{tool_id}' requires a verified calling agent"
            ));
        }

        // Approved agent calls retain the lifecycle/read-only gate here so an
        // internal caller cannot bypass it by selecting the ungated entry
        // point. Missing identity is only valid for genuinely agent-less
        // callers and legacy approvals; an identified call must fail closed if
        // the store or record is unavailable.
        if let Some(agent_id) = agent_id {
            let store = self
                .agent_store
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("agent store unavailable for governed tool call"))?;
            let record = store.get(agent_id).await?.ok_or_else(|| {
                anyhow::anyhow!("calling agent '{agent_id}' is no longer installed")
            })?;
            if record.safety_profile == crate::agents::AgentSafetyProfile::VerifiedPlanOnly
                && !tool_id.starts_with("plans.")
            {
                crate::safe_actions::authorize_verified_dispatch(agent_id, tool_id, &arguments)
                    .await?;
            }
            crate::agent_execution::ensure_tool_allowed_for_record_with_metadata(
                &record,
                tool_id,
                tool_annotations.as_ref(),
                tool_http_method.as_deref(),
            )?;
            if orchestration_tool && !record.orchestrator_enabled() {
                return Err(anyhow!(
                    "tool '{tool_id}' requires the orchestrator capability, which is disabled for this agent"
                ));
            }
            if creation_tool && !record.can_create_agents_enabled() {
                return Err(anyhow!(
                    "tool '{tool_id}' requires the agent-creation capability, which is disabled for this agent"
                ));
            }
            if configuration_tool {
                if crate::sidecar::control_plane::is_managed_node() {
                    return Err(anyhow!(
                        "agent-builder configuration is disabled on managed nodes until agent ownership is bound to the verified caller"
                    ));
                }
                if !configure_approved {
                    return Err(anyhow!(
                        "agent_builder.configure_agent requires interactive permission"
                    ));
                }
            }
        }

        // Passport consumes the bound identity in its own process. This branch
        // precedes local vault consultation so remote mode never decrypts a
        // second local copy or silently falls back after a service failure.
        if tool_id == web_fetch::GET_TOOL_ID && !profile_ids.is_empty() {
            if let Ok(base) = std::env::var("RYU_PASSPORT_URL") {
                if let Some(list) = allowlist {
                    let candidate = RegistryTool::candidate(tool_id, web_fetch::SERVER_NAME, "get");
                    if !tool_allowed(&candidate, list) {
                        return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                    }
                }
                let agent = agent_id.ok_or_else(|| anyhow!("Passport requires a calling agent"))?;
                let fetched = crate::identity::passport::fetch(
                    &base,
                    agent,
                    profile_ids,
                    &arguments,
                    session_id.clone(),
                )
                .await;
                // Passport fetches with the bound identity, so the page is the
                // user's connected-account data.
                if fetched.is_ok() {
                    note_authenticated_read(tool_id);
                }
                return fetched;
            }
        }

        // Identity Vault consult (epic #517): for a bound agent, a tool call
        // targeting a NEEDS_AUTH domain returns the elicitation envelope as its
        // result (no dispatch); an AUTHENTICATED domain reads the credential under
        // the gateway grant + audit at this boundary. No-op when the agent has no
        // bound profiles. Skipped internally for `composio.…` (it owns its own
        // connection-required path).
        // An AUTHENTICATED bound domain for a credential-consuming tool (web_fetch)
        // returns the decrypted credential here so the tool can act AS the user;
        // it is threaded out-of-band to the tool (never into `arguments`, never to
        // the model). For every other tool this is `None`.
        let injected_credential = match crate::identity::consult_for_tool_call_with_agent(
            profile_ids,
            tool_id,
            &arguments,
            session_id.clone(),
            agent_id,
        )
        .await
        {
            crate::identity::ConsultOutcome::Elicit(envelope) => return Ok(envelope),
            crate::identity::ConsultOutcome::Proceed => None,
            crate::identity::ConsultOutcome::ProceedWithCredential(secret) => Some(secret),
        };
        let call = Dispatch {
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
            account_policy,
            connection_action,
            injected_credential,
        };

        // Built-in Composio provider (#474): searchable-not-listed, executed by
        // id prefix. Detected before split because the allowlist guard is
        // id-only (no bare name/server fallback).
        if tool_id.starts_with("composio.") {
            return self.dispatch_composio(call).await;
        }

        let (server, tool) = self
            .split_registered_tool_id(tool_id)
            .ok_or_else(|| anyhow!("malformed tool id '{tool_id}' (expected server.tool)"))?;
        self.dispatch_registered(call, server, tool).await
    }
}

#[cfg(test)]
#[path = "../tests/dispatch_agent_config.rs"]
mod tests;
