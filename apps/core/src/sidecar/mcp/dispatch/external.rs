//! The configured external MCP server arm.

use super::Dispatch;
use crate::sidecar::mcp::*;

impl McpRegistry {
    // A configured external MCP server: stdio, HTTP or OAuth-backed remote.
    pub(super) async fn dispatch_external_mcp(
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
            profile_ids,
            session_id,
            host_conversation_id,
            account_policy,
            connection_action,
            ..
        } = call;
        // Extract owned values under the read lock; drop the guard before .await.
        let cfg = {
            let servers = self.servers.read().expect("mcp servers RwLock poisoned");
            let cfg = servers
                .get(server)
                .ok_or_else(|| anyhow!("unknown MCP server: {server}"))?;
            if !cfg.enabled {
                return Err(anyhow!("MCP server '{server}' is disabled"));
            }
            cfg.clone()
        };

        let (cfg, _plugin_lease) = self.active_server_config(server, cfg).await?;

        // Enforce the per-agent allowlist before spawning anything.
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }

        // Ghost controls the user's desktop, and a server whose config names
        // one of the user's saved keys acts with it, so both are the user's
        // accounts. Decide on the stored config, before any reference resolves.
        if is_ghost_server(server, &cfg) {
            crate::agent_access::require_desktop_access(account_policy.as_ref())?;
        }
        if config_references_user_secret(&cfg) {
            crate::agent_access::require_saved_key_access(
                account_policy.as_ref(),
                saved_key_account_id(server, &cfg),
            )?;
        }
        // An app's keyless stdio server forwards to the app's lazy sidecar, which
        // may be stopped: wake it (and keep it alive for this call) before the spawn.
        let _sidecar_activity = self.wake_owner_sidecars(&cfg).await?;

        let mut mcp_ids = vec![server.to_owned()];
        if let Some(plugin_id) = cfg.owner_plugin_id.clone() {
            mcp_ids.push(plugin_id);
        }
        let secret_context = self
            .secret_resolution_context(host_conversation_id, mcp_ids)
            .await;
        let cfg = self
            .resolve_mcp_secret_config(&cfg, &secret_context)
            .await?;

        if cfg.auth.is_none() {
            let target = cfg.to_target()?;
            let mut metadata = serde_json::Map::new();
            if is_ghost_cursor_action(server, tool, &cfg) {
                if let Some(identity) = self
                    .ghost_cursor_identity(agent_id, host_conversation_id)
                    .await
                {
                    metadata.insert("ryu/ghostCursor".to_owned(), identity);
                }
            }
            if carries_plugin_caller_scope(&cfg) {
                let principal = ToolPrincipal::resolve_optional(
                    self.conversations.as_ref(),
                    host_conversation_id,
                )
                .await;
                metadata.insert(
                    PLUGIN_CALLER_META_KEY.to_owned(),
                    plugin_caller_scope_meta(&principal),
                );
            }
            let call = forms::call_tool(&target, server, tool, arguments, host_conversation_id);
            let result = if metadata.is_empty() {
                call.await
            } else {
                client::with_tool_metadata(Value::Object(metadata), call).await
            };
            return match result {
                Ok(result) => Ok(normalize_mpp_result(result, server, tool)),
                Err(error) => match mpp_payment_required(&error, server, tool) {
                    Some(envelope) => Ok(envelope),
                    None => Err(error),
                },
            };
        }

        let (owner_user_id, profile_id) = self
            .oauth_dispatch_identity(&cfg, agent_id, profile_ids, host_conversation_id)
            .await?;
        let cmd = match oauth_target(
            &cfg,
            &owner_user_id,
            &profile_id,
            connection_action,
            agent_id.is_some(),
            false,
            session_id.clone(),
            agent_id,
        )
        .await
        {
            Ok(target) => target,
            Err(error) if oauth_requires_connect(&error) => {
                return oauth_elicitation(&cfg, &owner_user_id, &profile_id, None).await;
            }
            Err(error) => return Err(error),
        };
        match forms::call_tool(&cmd, server, tool, arguments.clone(), host_conversation_id).await {
            Ok(result) => Ok(normalize_mpp_result(result, server, tool)),
            Err(error) if mpp_payment_required(&error, server, tool).is_some() => {
                Ok(mpp_payment_required(&error, server, tool).expect("checked above"))
            }
            Err(error) if oauth_http_failure(&error, reqwest::StatusCode::UNAUTHORIZED) => {
                let refreshed = match oauth_target(
                    &cfg,
                    &owner_user_id,
                    &profile_id,
                    connection_action,
                    agent_id.is_some(),
                    true,
                    session_id.clone(),
                    agent_id,
                )
                .await
                {
                    Ok(target) => target,
                    Err(refresh_error) if oauth_requires_connect(&refresh_error) => {
                        return oauth_elicitation(&cfg, &owner_user_id, &profile_id, None).await;
                    }
                    Err(refresh_error) => return Err(refresh_error),
                };
                match forms::call_tool(&refreshed, server, tool, arguments, host_conversation_id)
                    .await
                {
                    Ok(result) => Ok(normalize_mpp_result(result, server, tool)),
                    Err(retry_error)
                        if mpp_payment_required(&retry_error, server, tool).is_some() =>
                    {
                        Ok(
                            mpp_payment_required(&retry_error, server, tool)
                                .expect("checked above"),
                        )
                    }
                    Err(retry_error)
                        if oauth_http_failure(&retry_error, reqwest::StatusCode::UNAUTHORIZED) =>
                    {
                        oauth_elicitation(&cfg, &owner_user_id, &profile_id, None).await
                    }
                    Err(retry_error) => Err(retry_error),
                }
            }
            Err(error) if oauth_http_failure(&error, reqwest::StatusCode::FORBIDDEN) => {
                let challenge = oauth_challenge_header(&error);
                let is_step_up = challenge.as_deref().is_some_and(|value| {
                    value.contains("insufficient_scope") || value.contains("scope=")
                });
                if !is_step_up {
                    return Err(error);
                }
                oauth_elicitation(&cfg, &owner_user_id, &profile_id, challenge).await
            }
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
#[path = "../tests/dispatch_external.rs"]
mod tests;
