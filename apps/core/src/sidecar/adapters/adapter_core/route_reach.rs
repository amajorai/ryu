use super::*;

/// Resolve a chat request into a concrete [`AgentRoute`].
///
/// `agent_id` is the client-selected agent; `engine`/`model` are the agent's
/// persisted binding from the [`AgentStore`] (U6), when known. Resolution order:
///   1. The built-in "ryu" flagship agent (and the bots that share its engine,
///      Jay Jr. and Patrol) → Pi ACP with gateway env-injection (U042).
///   2. The plain default agent (no/empty/`default` agent_id) → registry-configured
///      OpenAI-compat route, forwarded via the gateway (U18).
///   3. A local-engine binding (`ollama`/`llamacpp`/`vllm`) → `LocalEngine`, which
///      triggers a managed swap (U4) before streaming.
///   4. A registry id (built-in or cloud agent) → its transport.
///
/// `engine` falls back to `agent_id` so clients that send a registry id directly
/// (the legacy prefix path) keep working even before any store row exists.
///
/// `provider_reg` is the unified [`ProviderRegistry`] that supplies the default
/// base_url and model (env > file > literal). Passing it explicitly keeps the
/// function pure and unit-testable.
pub(crate) fn agent_route(
    agent_id: Option<&str>,
    engine: Option<&str>,
    model: Option<&str>,
    acp_registry: &AcpAgentRegistry,
    provider_reg: &ProviderRegistry,
) -> Option<AgentRoute> {
    agent_route_with_user_jwt(
        agent_id,
        engine,
        model,
        acp_registry,
        provider_reg,
        None,
        None,
        None,
        None,
        None,
    )
}

/// What a route would launch for an agent, as [`route_provider_reach`] sees it.
#[derive(Debug, Clone, Copy)]
pub(crate) enum LaunchedEngine<'a> {
    /// A BYO `acp-exec:<command>` agent.
    AcpExec(&'a str),
    /// A Core-managed SDK app: one shared process on an unscoped Gateway token.
    SdkApp,
    /// A registry entry. `acp` is false for an OpenAI-compatible entry, which
    /// Core itself sends through Gateway.
    Registry {
        id: &'a str,
        acp: bool,
        gateway_bypass: bool,
    },
}

/// The routing switches that decide where a launched engine's model calls go:
/// Claude Code's and Codex's subscription passthroughs, and the agent's generic
/// Gateway routing.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RouteSwitches {
    pub(crate) claude: bool,
    pub(crate) codex: bool,
    pub(crate) agent: bool,
}

/// How `engine` would reach its model provider under `switches`. Pure, so the
/// table is testable without the process-global switches; keep it in step with
/// the branches of [`agent_route_with_user_jwt`] and with the clients'
/// `engineModelProvider` in `packages/core-client/src/agent-account-access.ts`.
pub(crate) fn route_provider_reach(
    engine: LaunchedEngine<'_>,
    switches: RouteSwitches,
) -> crate::agent_access::ProviderReach {
    use crate::acp_agent_settings::AcpAgentKind;
    use crate::agent_access::ProviderReach;
    match engine {
        // Claude Code and Codex are recognised by their command, so a BYO
        // command cannot pass for a Gateway-routed client: Claude Code speaks
        // Anthropic format, and Codex keeps whatever sign-in its own home holds.
        // Gemini CLI and Kiro CLI ignore the injected base URL and sign in
        // themselves; the sandbox keeps Gemini's home visible on the same match.
        LaunchedEngine::AcpExec(cmd) => match AcpAgentKind::of_spawn(cmd) {
            AcpAgentKind::ClaudeCode => ProviderReach::Vendor("anthropic"),
            AcpAgentKind::Codex => ProviderReach::Vendor("openai"),
            AcpAgentKind::Other if crate::acp_agent_settings::spawn_launches_gemini_cli(cmd) => {
                ProviderReach::Vendor("genai")
            }
            AcpAgentKind::Other if crate::acp_agent_settings::spawn_launches_kiro_cli(cmd) => {
                ProviderReach::Vendor("kiro")
            }
            AcpAgentKind::Other if switches.agent => ProviderReach::Gateway,
            AcpAgentKind::Other => ProviderReach::SelfCalled { routable: true },
        },
        LaunchedEngine::SdkApp => ProviderReach::SelfCalled { routable: false },
        LaunchedEngine::Registry { acp: false, .. } => ProviderReach::Gateway,
        // Claude Code uses the user's own Anthropic sign-in, through the
        // passthrough or directly; the passthrough carries no agent.
        LaunchedEngine::Registry {
            id: "acp:claude", ..
        } => ProviderReach::Vendor("anthropic"),
        // Codex on its subscription passthrough uses the user's ChatGPT sign-in.
        // Otherwise it runs from the sign-in-free safety home on a scoped
        // Gateway bearer (the both-off case is re-signed for a limited agent).
        LaunchedEngine::Registry {
            id: "acp:codex", ..
        } if switches.codex => ProviderReach::Vendor("openai"),
        LaunchedEngine::Registry {
            id: "acp:codex", ..
        } => ProviderReach::Gateway,
        LaunchedEngine::Registry {
            id: "acp:gemini", ..
        } => ProviderReach::Vendor("genai"),
        // Kiro signs in with the native provider accounts Ryu holds for it.
        LaunchedEngine::Registry { id: "acp:kiro", .. } => ProviderReach::Vendor("kiro"),
        // The user's own Pi runs with its own config and keys, which an OpenAI
        // base URL does not redirect.
        LaunchedEngine::Registry { id: "acp:pi", .. } => {
            ProviderReach::SelfCalled { routable: false }
        }
        LaunchedEngine::Registry {
            gateway_bypass: true,
            ..
        } => ProviderReach::SelfCalled { routable: false },
        LaunchedEngine::Registry { .. } if switches.agent => ProviderReach::Gateway,
        LaunchedEngine::Registry { .. } => ProviderReach::SelfCalled { routable: true },
    }
}

/// The engine a non-Ryu route would launch for `engine` and its display name,
/// or `None` when Core launches nothing that calls a provider for it (local
/// engines, A2A peers and unknown engines).
pub(crate) fn launched_engine<'a>(
    engine: &'a str,
    acp_registry: &'a AcpAgentRegistry,
) -> Option<(LaunchedEngine<'a>, String)> {
    if engine.starts_with("a2a:") || is_local_engine(engine) {
        return None;
    }
    if let Some(cmd) = engine.strip_prefix("acp-exec:") {
        let cmd = cmd.trim();
        if !cmd.is_empty() {
            return Some((LaunchedEngine::AcpExec(cmd), "This custom agent".to_owned()));
        }
    }
    if sdk::is_sdk_app(engine) {
        return Some((LaunchedEngine::SdkApp, "This SDK app".to_owned()));
    }
    let entry = acp_registry.find_by_prefix(engine)?;
    Some((
        LaunchedEngine::Registry {
            id: entry.id.as_str(),
            acp: matches!(entry.transport, acp::AgentTransport::Acp { .. }),
            gateway_bypass: entry.gateway_bypass,
        },
        entry.name.clone(),
    ))
}

/// Why a limited agent may not launch `engine` under the current routing
/// switches, as a user-facing reason, or `None` when it may (or when the route
/// is decided elsewhere: Ryu's own engine, local engines, A2A peers).
pub(crate) fn limited_route_refusal(
    route_id: &str,
    engine: &str,
    acp_registry: &AcpAgentRegistry,
    provider_access: Option<&[String]>,
) -> Option<String> {
    provider_access?;
    // Ryu's own engine and the default route are checked by their builders, as
    // is a limited custom agent that runs on Ryu's managed Pi.
    if is_default_agent(Some(route_id))
        || crate::agents::runs_on_ryu_engine(route_id)
        || crate::agents::runs_limited_on_managed_pi(route_id, Some(engine), provider_access)
    {
        return None;
    }
    let (launched, name) = launched_engine(engine, acp_registry)?;
    crate::agent_access::self_called_provider_permitted(
        provider_access,
        current_provider_reach(route_id, launched),
        &name,
    )
    .err()
}

/// [`route_provider_reach`] under the routing switches currently saved for
/// `route_id`.
pub(crate) fn current_provider_reach(
    route_id: &str,
    launched: LaunchedEngine<'_>,
) -> crate::agent_access::ProviderReach {
    let switches = RouteSwitches {
        claude: crate::claude_config::is_gateway_routing(),
        codex: crate::codex_config::is_gateway_routing(),
        agent: crate::agent_routing::is_gateway_routing(route_id),
    };
    route_provider_reach(launched, switches)
}
