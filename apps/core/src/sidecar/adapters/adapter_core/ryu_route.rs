use super::*;

/// `agent_id` is the agent the route runs as: `ryu` itself, or a built-in that
/// borrows Ryu's engine under its own identity (see
/// [`crate::agents::runs_on_ryu_engine`]). It keys the Gateway bearer and URL,
/// so spend and budgets land on that agent rather than on Ryu.
pub(crate) fn ryu_agent_route_with_user_jwt(
    agent_id: &str,
    acp_registry: &AcpAgentRegistry,
    provider_reg: &ProviderRegistry,
    user_jwt: Option<&str>,
    composio_connection_scope: Option<&[crate::sidecar::adapters::ComposioConnectionBinding]>,
    conversation_scope: Option<&[String]>,
    host_conversation_id: Option<&str>,
    // The agent's model provider access (`None` = unrestricted), signed into
    // its Gateway bearer.
    provider_access: Option<&[String]>,
) -> Option<AgentRoute> {
    if host_conversation_id.is_some_and(|id| !acp::is_safe_host_conversation_id(id)) {
        tracing::warn!("ryu agent route refused an invalid host conversation id");
        return None;
    }
    // Prefer Core's own managed Pi binary (~/.ryu/bin/pi). This is a separate
    // install from any Pi the user has on PATH — same relationship as OpenClaw to Pi.
    if let Some(cmd) = acp::ryu_pi_acp_cmd_for_agent(
        user_jwt,
        Some(agent_id),
        composio_connection_scope,
        conversation_scope,
        host_conversation_id,
        provider_access,
    ) {
        return Some(AgentRoute::Acp { spawn_cmd: cmd });
    }

    // Managed binary not installed yet (first run / setup pending). Fall back to
    // the user's Pi on PATH, but still pointed at Ryu's OWN isolated config dir
    // (`PI_CODING_AGENT_DIR`) so it reads Ryu's model/provider config, never the
    // user's `~/.pi/agent`. Gateway env injection is applied only in Gateway-routed
    // mode (the default), matching `acp::ryu_pi_acp_cmd`.
    if let Some(pi_entry) = acp_registry.find_by_prefix("acp:pi") {
        if let acp::AgentTransport::Acp { ref spawn_cmd } = pi_entry.transport {
            // Same config invariants the managed-binary path enforces (valid
            // zero-key defaultModel + Pi-side skills off + gateway models.json
            // pin) — this fallback Pi reads the same isolated config dir.
            if let Err(e) = crate::pi_config::ensure_managed_defaults() {
                tracing::error!(error = %e, "ryu fallback: refusing stale managed Pi configuration");
                return None;
            }
            let gateway = crate::pi_config::is_gateway_routing();
            if !gateway && provider_access.is_some() {
                tracing::warn!("ryu fallback: refusing Pi without Gateway routing for an agent with limited model provider access");
                return None;
            }
            // A limited agent reads a config dir with no user provider credential.
            let config_dir = match crate::pi_config::agent_config_dir_str(
                Some(agent_id),
                provider_access,
            ) {
                Ok(dir) => dir,
                Err(e) => {
                    tracing::error!(error = %e, "ryu fallback: refusing Pi without a credential-free config dir for an agent with limited model provider access");
                    return None;
                }
            };
            let gateway_v1 = if gateway {
                match acp::openai_gateway_v1(Some(agent_id)) {
                    Ok(url) => url,
                    Err(error) => {
                        tracing::error!(error = %error, "ryu fallback: refusing an unproved remote agent route");
                        return None;
                    }
                }
            } else {
                String::new()
            };
            // Fail closed on a remote data plane (WS1): a hosted multi-tenant gateway
            // must reject the shared "ryu-local" literal, so refuse to route this
            // fallback Pi rather than present it. Only resolved when gateway routing
            // is on (otherwise the token is unused and Pi talks straight to provider).
            let token = if gateway {
                match crate::sidecar::gateway::gateway_bearer_for_agent(
                    Some(agent_id),
                    None,
                    host_conversation_id,
                    provider_access,
                ) {
                    Ok(t) => t,
                    Err(e) => {
                        tracing::error!(error = %e, "ryu fallback: no gateway bearer, refusing to route fallback Pi through the gateway");
                        return None;
                    }
                }
            } else {
                String::new()
            };
            // Pi cannot take the in-process MCP bridge (`pi-acp` advertises
            // `mcpCapabilities {http:false, sse:false}` and drops `session/new`'s
            // `mcpServers` on the floor), so its ONLY road to Ryu's tools is the
            // `ryu-mcp` extension in the isolated config dir, which dials Core over
            // HTTP. Add every value through ACP's structured environment field so
            // the fallback has the same scope without interpolating user data into
            // a shell command.
            let mut env = Vec::new();
            if gateway {
                env.push(("OPENAI_BASE_URL".to_owned(), gateway_v1));
                env.push(("OPENAI_API_KEY".to_owned(), token));
            }
            env.push(("PI_CODING_AGENT_DIR".to_owned(), config_dir));
            env.extend(acp::pi_mcp_extension_env(
                user_jwt,
                composio_connection_scope,
                conversation_scope,
                host_conversation_id,
            ));
            let gated_cmd = match acp::acp_spawn_with_env(spawn_cmd, env) {
                Ok(command) => command,
                Err(error) => {
                    tracing::warn!(error = %error, "ryu fallback: invalid ACP spawn declaration");
                    return None;
                }
            };
            return Some(AgentRoute::Acp {
                spawn_cmd: gated_cmd,
            });
        }
    }

    // No Pi available at all — fall back to the plain-LLM default.
    Some(default_agent_route(provider_reg))
}
