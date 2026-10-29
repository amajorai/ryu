use super::*;

/// Apply the user's per-agent ACP launch settings ([`crate::acp_agent_settings`])
/// to a resolved spawn. `keys` run most specific first (selected agent, engine,
/// registry entry). Settings that cannot be applied refuse the route rather than
/// silently launching something other than what the user configured.
pub(crate) fn apply_acp_agent_settings(spawn_cmd: String, keys: &[&str]) -> Option<String> {
    use crate::acp_agent_settings::{launch_overrides, lookup, AcpAgentKind};
    let Some(settings) = lookup(keys.iter().copied()) else {
        return Some(spawn_cmd);
    };
    let kind = AcpAgentKind::of_spawn(&spawn_cmd);
    let launch = match launch_overrides(&settings, kind) {
        Ok(launch) => launch,
        Err(error) => {
            tracing::error!(error = %error, ?keys, "agent_route: invalid ACP agent settings");
            return None;
        }
    };
    if launch.is_empty() {
        return Some(spawn_cmd);
    }
    // Keep the adapter's identity in the declaration so Claude-specific session
    // metadata and kind detection still recognize a custom command.
    let stable_name = match kind {
        AcpAgentKind::ClaudeCode => Some("claude-agent-acp"),
        AcpAgentKind::Codex => Some("codex-acp"),
        AcpAgentKind::Other => None,
    };
    match acp::acp_spawn_with_overrides(&spawn_cmd, &launch, stable_name) {
        Ok(spawn_cmd) => Some(spawn_cmd),
        Err(error) => {
            tracing::error!(error = %error, ?keys, "agent_route: could not apply ACP agent settings");
            None
        }
    }
}

/// The per-agent ACP settings for `agent_id`, looked up the same way the route
/// applies them: the agent itself, then its bound engine, then the registry id.
pub async fn resolve_acp_agent_settings(
    agent_id: &str,
    registry: &AcpAgentRegistry,
    agent_store: &AgentStore,
) -> Option<crate::acp_agent_settings::AcpAgentSettings> {
    resolve_acp_agent_settings_with_source(agent_id, registry, agent_store)
        .await
        .map(|(_, settings)| settings)
}

/// [`resolve_acp_agent_settings`], also naming the key the effective settings
/// were stored under (the agent itself, its engine, or its registry entry).
pub async fn resolve_acp_agent_settings_with_source(
    agent_id: &str,
    registry: &AcpAgentRegistry,
    agent_store: &AgentStore,
) -> Option<(String, crate::acp_agent_settings::AcpAgentSettings)> {
    let (engine, ..) = resolve_binding(agent_id, agent_store).await;
    let provider_access =
        crate::agent_access::provider_access_for_agent(agent_store, agent_id).await;
    acp_agent_settings_with_source(
        agent_id,
        engine.as_deref(),
        registry,
        provider_access.as_deref(),
    )
}

/// Which agent-specific knob mapping applies to `agent_id`, classified from the
/// spawn its route resolves to BEFORE any user override (the same declaration
/// [`apply_acp_agent_settings`] classifies). `None` when it is not an external
/// ACP agent, so it has no launch settings at all.
pub async fn resolve_acp_agent_kind(
    agent_id: &str,
    registry: &AcpAgentRegistry,
    agent_store: &AgentStore,
) -> Option<crate::acp_agent_settings::AcpAgentKind> {
    let (engine, ..) = resolve_binding(agent_id, agent_store).await;
    let provider_access =
        crate::agent_access::provider_access_for_agent(agent_store, agent_id).await;
    acp_agent_kind_for(
        agent_id,
        engine.as_deref(),
        registry,
        provider_access.as_deref(),
    )
}

pub(crate) fn acp_agent_kind_for(
    agent_id: &str,
    engine: Option<&str>,
    registry: &AcpAgentRegistry,
    provider_access: Option<&[String]>,
) -> Option<crate::acp_agent_settings::AcpAgentKind> {
    use crate::acp_agent_settings::AcpAgentKind;
    if agent_id == "ryu"
        || is_default_agent(Some(agent_id))
        || crate::agents::runs_on_ryu_engine(agent_id)
        || crate::agents::runs_limited_on_managed_pi(agent_id, engine, provider_access)
    {
        return None;
    }
    let engine = engine.unwrap_or(agent_id);
    if let Some(cmd) = engine.strip_prefix("acp-exec:") {
        let cmd = cmd.trim();
        return (!cmd.is_empty()).then(|| AcpAgentKind::of_spawn(cmd));
    }
    match &registry.find_by_prefix(engine)?.transport {
        acp::AgentTransport::Acp { spawn_cmd } => Some(AcpAgentKind::of_spawn(spawn_cmd)),
        _ => None,
    }
}

pub(crate) fn acp_agent_settings_for(
    agent_id: &str,
    engine: Option<&str>,
    registry: &AcpAgentRegistry,
    provider_access: Option<&[String]>,
) -> Option<crate::acp_agent_settings::AcpAgentSettings> {
    acp_agent_settings_with_source(agent_id, engine, registry, provider_access)
        .map(|(_, settings)| settings)
}

pub(crate) fn acp_agent_settings_with_source(
    agent_id: &str,
    engine: Option<&str>,
    registry: &AcpAgentRegistry,
    provider_access: Option<&[String]>,
) -> Option<(String, crate::acp_agent_settings::AcpAgentSettings)> {
    // Agents on Ryu's managed engine take no external ACP launch settings; the
    // user's own Pi settings (keyed on `acp:pi`) must not leak into them.
    if agent_id == "ryu" || crate::agents::runs_on_ryu_engine(agent_id) {
        return None;
    }
    // A limited custom agent on the "Ryu" engine keeps the settings saved under
    // its own id (its model allowlist and session defaults), never the user's
    // own Pi settings. Its managed route applies no launch override.
    if crate::agents::runs_limited_on_managed_pi(agent_id, engine, provider_access) {
        return crate::acp_agent_settings::lookup_with_source([agent_id]);
    }
    let engine = engine.unwrap_or(agent_id);
    let entry_id = registry
        .find_by_prefix(engine)
        .map(|entry| entry.id.clone());
    crate::acp_agent_settings::lookup_with_source(
        [Some(agent_id), Some(engine), entry_id.as_deref()]
            .into_iter()
            .flatten(),
    )
}

/// Resolve `agent_id` to its ACP spawn command, or `None` when the agent is not
/// an ACP subprocess agent (only ACP agents advertise session/new modes/models/
/// config options to probe). Reuses the same binding + route resolution the chat
/// path uses, so the probed agent is exactly the one a turn would spawn.
pub async fn resolve_acp_spawn_cmd(
    agent_id: &str,
    registry: &AcpAgentRegistry,
    agent_store: &AgentStore,
) -> Option<String> {
    let provider_reg = ProviderRegistry::load();
    let (engine, model, _slots, _persona, _composio, _skills, _identity_profile_ids) =
        resolve_binding(agent_id, agent_store).await;
    let provider_access =
        crate::agent_access::provider_access_for_agent(agent_store, agent_id).await;
    match agent_route_with_user_jwt(
        Some(agent_id),
        engine.as_deref(),
        model.as_deref(),
        registry,
        &provider_reg,
        None,
        None,
        None,
        None,
        provider_access.as_deref(),
    )? {
        AgentRoute::Acp { spawn_cmd } => Some(spawn_cmd),
        _ => None,
    }
}
