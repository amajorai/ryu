use super::*;

pub(crate) fn agent_route_with_user_jwt(
    agent_id: Option<&str>,
    engine: Option<&str>,
    model: Option<&str>,
    acp_registry: &AcpAgentRegistry,
    provider_reg: &ProviderRegistry,
    user_jwt: Option<&str>,
    composio_connection_scope: Option<&[crate::sidecar::adapters::ComposioConnectionBinding]>,
    conversation_scope: Option<&[String]>,
    host_conversation_id: Option<&str>,
    // The agent's model provider access (`None` = unrestricted), signed into
    // the Gateway bearer of every ACP route that is Gateway-routed.
    provider_access: Option<&[String]>,
) -> Option<AgentRoute> {
    // Ryu flagship: Pi engine with gateway on top. Checked before the generic
    // default so "ryu" never falls through to the plain-LLM path. Bots on Ryu's
    // engine (Jay Jr., Patrol) take the same managed route under their own agent
    // id.
    if let Some(ryu_engine_agent) =
        agent_id.filter(|id| *id == "ryu" || crate::agents::runs_on_ryu_engine(id))
    {
        return ryu_agent_route_with_user_jwt(
            ryu_engine_agent,
            acp_registry,
            provider_reg,
            user_jwt,
            composio_connection_scope,
            conversation_scope,
            host_conversation_id,
            provider_access,
        );
    }
    // A limited custom agent on the "Ryu" engine (`acp:pi`) runs on the same
    // managed Pi under its own id: its own Gateway bearer and provider access,
    // and the credential-free limited Pi config, never the user's own Pi. Only a
    // Pi spawn is accepted, so the plain-LLM fallback never stands in for it.
    if let Some(limited_agent) =
        agent_id.filter(|id| crate::agents::runs_limited_on_managed_pi(id, engine, provider_access))
    {
        return ryu_agent_route_with_user_jwt(
            limited_agent,
            acp_registry,
            provider_reg,
            user_jwt,
            composio_connection_scope,
            conversation_scope,
            host_conversation_id,
            provider_access,
        )
        .filter(|route| matches!(route, AgentRoute::Acp { .. }));
    }
    if is_default_agent(agent_id) {
        return Some(default_agent_route(provider_reg));
    }

    // The binding from the store is the source of truth; fall back to the raw id.
    let engine = engine.or(agent_id)?;

    // The id the generic per-agent gateway-routing toggle is keyed on. It must be
    // the SAME string the desktop writes the toggle under: the client-selected
    // agent id (a custom agent's record id for the `acp-exec:` path), falling back
    // to the engine when no agent id was sent.
    let route_id = agent_id.unwrap_or(engine);

    if let Some(peer_id) = engine.strip_prefix("a2a:") {
        let peer_id = peer_id.trim();
        if !peer_id.is_empty() {
            return Some(AgentRoute::A2a {
                peer_id: peer_id.to_owned(),
            });
        }
    }

    // A limited agent launches only engines whose model calls Gateway can
    // limit, or a vendor's own engine when that vendor is allowed. Checked
    // before any branch below spawns anything.
    if let Some(reason) = limited_route_refusal(route_id, engine, acp_registry, provider_access) {
        tracing::warn!(route_id, engine, %reason, "agent_route: refusing an engine outside the agent's model provider access");
        return None;
    }

    // BYO arbitrary ACP agent (zero-lock-in escape hatch): an engine of the form
    // `acp-exec:<command>` runs that literal command as an ACP subprocess. This
    // makes EVERY ACP-compatible agent usable without being enumerated in the
    // registry — a binary-only registry agent the user already installed (goose,
    // cursor, opencode, …), a private/in-house agent, or a future one. It flows
    // through the same `run_acp_prompt` path, so session modes/models/effort,
    // interactive permissions, and diff rendering all apply uniformly. Like the
    // self-fetching registry agents it makes its own provider calls, with the
    // default gateway env injection applied when the client is routable. Its TOOLS
    // still arrive over the MCP bridge, which is a separate gate
    // (`agent-tool-bridge`, default ON) from the egress decision this
    // branch is making — the two were one preference until they were split, and
    // "tool egress" was the phrase that conflated them. Tools are not egress.
    if let Some(cmd) = engine.strip_prefix("acp-exec:") {
        let cmd = cmd.trim();
        if !cmd.is_empty() {
            // Generic gateway routing is ON by default: swap this BYO agent's
            // OpenAI-compatible endpoint to the local gateway so its egress is
            // governed (the lever this whole feature exists for). An explicit
            // direct-egress opt-out runs the command verbatim.
            let spawn_cmd = if crate::agent_routing::is_gateway_routing(route_id) {
                match acp::openai_gateway_cmd_for_agent(cmd, Some(route_id), provider_access) {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::error!(error = %e, route_id, "agent_route: refusing gateway routing for BYO acp-exec agent without a bearer");
                        return None;
                    }
                }
            } else {
                cmd.to_owned()
            };
            let spawn_cmd = apply_acp_agent_settings(spawn_cmd, &[route_id, engine])?;
            return Some(AgentRoute::Acp { spawn_cmd });
        }
    }

    // 0. SDK app (`sdk:<package>`) — a developer SDK app managed by Core.
    //    Routed direct to the loopback (via_gateway:false); gateway policy is
    //    enforced by env-injection into the SDK subprocess at spawn time.
    if sdk::is_sdk_app(engine) {
        let base_url = sdk::sdk_app_base_url();
        let model = model.unwrap_or("sdk-app").to_owned();
        return Some(AgentRoute::SdkApp { base_url, model });
    }

    // 1. Local inference engine — needs a managed swap before streaming.
    if is_local_engine(engine) {
        let base_url = local_engine_base_url(engine)?;
        return Some(AgentRoute::LocalEngine {
            engine: engine.to_owned(),
            base_url: base_url.to_owned(),
            // Ollama/vLLM/SGLang reject an unknown model id, so an unset model
            // is resolved to the engine's served model once it is resident.
            model: model.map(str::to_owned),
        });
    }

    // 2. Registry agent (cloud-style OpenAI-compat or ACP subprocess).
    //
    // OpenAI-compat registry agents (zeroclaw) route via the gateway so the
    // firewall, budget, and audit pipeline governs their egress. When the gateway
    // is unreachable the existing degraded-mode fallback in route_chat_stream
    // reverts to base_url (direct), so chat keeps working even if the gateway is
    // not running.
    //
    // NOTE: ACP subprocess agents make their own provider calls internally, so
    // Ryu cannot intercept their egress. The ones that honour OPENAI_BASE_URL
    // (Codex, Pi, the Ryu flagship) get the gateway env injected at spawn.
    // Claude Code (Anthropic format) is now governable too via the gateway's
    // transparent passthrough proxy by default (see the match arm below). The rest
    // — Gemini CLI (Google format), OpenClaw (its own WebSocket
    // gateway), Hermes (its own creds), and the self-fetching ACP-registry agents
    // — still carry `gateway_bypass: true` (no base-URL hook we can transparently
    // proxy yet).
    let entry = acp_registry.find_by_prefix(engine)?;
    Some(match &entry.transport {
        acp::AgentTransport::Acp { spawn_cmd } => {
            // Claude Code (`acp:claude`) speaks Anthropic format with the user's
            // own subscription auth. By default, inject ANTHROPIC_BASE_URL so its
            // egress traverses the gateway's transparent passthrough proxy
            // (firewall/DLP/audit) while the subscription bearer is forwarded
            // upstream unchanged. An explicit direct-egress opt-out leaves it
            // direct. Other ACP agents are spawned verbatim.
            // Claude and Codex have their own dedicated, format-specific routing
            // (and always take it regardless of the generic toggle); guard the
            // generic OPENAI_BASE_URL injection off their ids so a stale generic-map
            // entry can never inject the wrong env into an Anthropic/Codex agent.
            let is_special = entry.id == "acp:claude" || entry.id == "acp:codex";
            let resolved = if entry.id == "acp:claude" {
                // A Claude route through the owner's desktop applies in both
                // modes: through the Gateway it still carries Claude Code's own
                // token refresh, which does not use ANTHROPIC_BASE_URL. The
                // proxy env changes the command, so a route change gets a fresh
                // pooled instance on the next turn.
                let gateway = crate::claude_config::is_gateway_routing();
                let mut env = Vec::new();
                let mut bypass = Vec::new();
                if gateway {
                    env.push((
                        "ANTHROPIC_BASE_URL".to_owned(),
                        acp::anthropic_passthrough_url(),
                    ));
                    if let Some(host) =
                        reqwest::Url::parse(&crate::sidecar::gateway::configured_gateway_url())
                            .ok()
                            .and_then(|url| url.host_str().map(str::to_owned))
                    {
                        bypass.push(host);
                    }
                }
                let proxy_env = match crate::local_egress::providers::claude_code_proxy_env(&bypass)
                {
                    Ok(proxy_env) => proxy_env,
                    Err(reason) => {
                        tracing::error!(reason, "agent_route: refusing Claude Code because its desktop route is not running");
                        return None;
                    }
                };
                if proxy_env.is_empty() {
                    if gateway {
                        acp::claude_gateway_cmd(spawn_cmd)
                    } else {
                        spawn_cmd.clone()
                    }
                } else {
                    env.extend(proxy_env);
                    match acp::acp_spawn_with_env(spawn_cmd, env) {
                        Ok(command) => command,
                        Err(error) => {
                            tracing::error!(error = %error, "agent_route: refusing Claude Code because its desktop route could not be applied");
                            return None;
                        }
                    }
                }
            } else if entry.id == "acp:codex" && crate::codex_config::is_gateway_routing() {
                // Codex subscription passthrough (default-on): point Codex at an
                // isolated CODEX_HOME → gateway passthrough so its ChatGPT-login
                // Responses egress is governed while the OAuth subscription
                // credential is forwarded upstream unchanged. Overrides the
                // default API-key OPENAI_BASE_URL injection baked into the entry.
                match acp::codex_acp_gateway_cmd() {
                    Ok(command) => command,
                    Err(error) => {
                        tracing::error!(error = %error, "agent_route: refusing Codex because its safe deletion home could not be prepared");
                        return None;
                    }
                }
            } else if entry.id == "acp:codex" && crate::agent_routing::is_gateway_routing(route_id)
            {
                // API-key Codex remains on the OpenAI-compatible path when the
                // subscription-preserving toggle is off; keep its spend under
                // the selected agent as well.
                if let Err(error) = crate::codex_config::ensure_safety_home() {
                    tracing::error!(error = %error, "agent_route: refusing Codex because its safe deletion home could not be prepared");
                    return None;
                }
                match acp::openai_gateway_cmd_for_agent(spawn_cmd, Some(route_id), provider_access)
                {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::error!(error = %e, route_id, "agent_route: refusing Codex gateway routing without a bearer");
                        return None;
                    }
                }
            } else if !is_special
                && !entry.gateway_bypass
                && crate::agent_routing::is_gateway_routing(route_id)
            {
                // Generic per-agent gateway routing (default-on): point a registry ACP
                // agent at the gateway via the OpenAI base-URL swap. Only meaningful
                // for agents whose client honours OPENAI_BASE_URL. Catalog entries
                // declaring bypass do not receive a Gateway bearer that cannot
                // govern their model calls. An explicit false preference opts out.
                match acp::openai_gateway_cmd_for_agent(spawn_cmd, Some(route_id), provider_access)
                {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::error!(error = %e, route_id, "agent_route: refusing generic gateway routing for registry ACP agent without a bearer");
                        return None;
                    }
                }
            } else if entry.id == "acp:codex" {
                if let Err(error) = crate::codex_config::ensure_safety_home() {
                    tracing::error!(error = %error, "agent_route: refusing direct Codex because its safe deletion home could not be prepared");
                    return None;
                }
                if provider_access.is_some() {
                    // The registry command carries Core's unscoped relay
                    // bearer. Re-sign it for this agent so Gateway applies its
                    // provider access (the structured env replaces both names).
                    match acp::openai_gateway_cmd_for_agent(
                        spawn_cmd,
                        Some(route_id),
                        provider_access,
                    ) {
                        Ok(c) => c,
                        Err(e) => {
                            tracing::error!(error = %e, route_id, "agent_route: refusing Codex for a limited agent without a scoped bearer");
                            return None;
                        }
                    }
                } else {
                    spawn_cmd.clone()
                }
            } else {
                spawn_cmd.clone()
            };
            AgentRoute::Acp {
                spawn_cmd: apply_acp_agent_settings(resolved, &[route_id, engine, &entry.id])?,
            }
        }
        acp::AgentTransport::OpenAiCompat {
            base_url,
            model: reg_model,
        } => {
            AgentRoute::OpenAiCompat {
                base_url: (*base_url).to_owned(),
                model: model.or(*reg_model).unwrap_or("default").to_owned(),
                api_key: None,
                // Route through the gateway so firewall/budget/audit governs
                // the egress call. The gateway falls back to direct base_url
                // when it is unreachable (see route_chat_stream).
                via_gateway: true,
            }
        }
    })
}
