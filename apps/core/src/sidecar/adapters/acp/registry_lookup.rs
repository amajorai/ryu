use super::*;

impl AcpAgentRegistry {
    /// Real tools available for `agent_id`: the tools the agent has actually
    /// invoked this process run. ACP agents publish no static tool catalog, so
    /// an agent reports an empty list until it uses a tool — see
    /// [`observed_tools`]. Returns an empty list for unknown agents.
    pub fn tools_for(&self, agent_id: &str) -> Vec<ToolInfo> {
        observed_tools_for(agent_id)
    }

    /// The MCP tool allowlist for an agent, if one is configured.
    ///
    /// `None` means "no restriction — every registered MCP tool is allowed";
    /// `Some(list)` restricts the agent to those tools (matched by fully-
    /// qualified id, bare tool name, or server name — see `McpRegistry`).
    ///
    /// Resolution order (first match wins):
    ///   1. `RYU_MCP_ALLOWLIST_<AGENT>` — per-agent, where `<AGENT>` is the
    ///      agent id upper-cased with non-alphanumerics turned into `_`
    ///      (e.g. `acp:claude` → `RYU_MCP_ALLOWLIST_ACP_CLAUDE`).
    ///   2. `RYU_MCP_ALLOWLIST` — a global default applied to every agent.
    /// In both cases the value is a comma-separated list; an empty value means
    /// an explicit empty allowlist (no MCP tools).
    pub fn allowlist_for(&self, agent_id: &str) -> Option<Vec<String>> {
        let key_suffix: String = agent_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect();
        let per_agent = std::env::var(format!("RYU_MCP_ALLOWLIST_{key_suffix}")).ok();
        let raw = per_agent.or_else(|| std::env::var("RYU_MCP_ALLOWLIST").ok())?;
        Some(
            raw.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
        )
    }

    /// Find a registry entry whose `id` is a prefix of (or equal to) `agent_id`.
    pub fn find_by_prefix(&self, agent_id: &str) -> Option<&AcpAgentEntry> {
        self.entries
            .iter()
            .find(|e| agent_id == e.id || agent_id.starts_with(&e.id))
    }

    /// Resolve an agent principal for authorization. Prefix matching is useful
    /// for display/legacy routing, but it must never turn `ryu-forged` into the
    /// registered `ryu` record and inherit its posture.
    pub fn find_exact(&self, agent_id: &str) -> Option<&AcpAgentEntry> {
        self.entries.iter().find(|entry| entry.id == agent_id)
    }

    /// Return the fallback provider chain for the default/"ryu" agent. Called by
    /// `route_chat_stream` when the primary route fails with a transport/provider
    /// error so the stream can recover instead of surfacing a raw error.
    ///
    /// The chain is registry-configured — swappable at runtime via env vars:
    ///   `RYU_FALLBACK_LLM_BASE_URL` — fallback provider base URL
    ///                                  (default: local llamacpp at :8080)
    ///   `RYU_FALLBACK_LLM_MODEL`    — fallback model id
    ///                                  (default: `gemma2`)
    ///   `RYU_FALLBACK_LLM_API_KEY`  — bearer key for the fallback (optional)
    ///
    /// Returns a list with one entry — a single bounded retry, never an infinite
    /// loop. An empty list means no fallback is configured (caller must error out).
    pub fn fallback_chain_for_default(&self) -> Vec<FallbackProvider> {
        let base_url = std::env::var("RYU_FALLBACK_LLM_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            // Default points at the local llamacpp chat engine, whose port is
            // profile-aware (release 8080, dev 9080, …).
            .unwrap_or_else(|| format!("http://127.0.0.1:{}", crate::profile::port(8080)));
        let model = std::env::var("RYU_FALLBACK_LLM_MODEL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "gemma2".to_owned());
        let api_key = std::env::var("RYU_FALLBACK_LLM_API_KEY")
            .ok()
            .filter(|s| !s.is_empty());
        vec![FallbackProvider {
            base_url,
            model,
            api_key,
        }]
    }

    /// List all registry agents as [`AgentInfo`] records.
    ///
    /// `default_agent_id` is the registry-configured id that should be
    /// marked as `enabled: true` in the response (AC2 of U041). Pass the
    /// value from [`crate::registry::ProviderRegistry::default_agent_id`].
    /// The built-in fallback is `"acp:pi"` (see
    /// [`crate::registry::DEFAULT_AGENT_ID`]).
    pub fn list_infos(&self) -> Vec<AgentInfo> {
        let default_agent_id = crate::registry::ProviderRegistry::load().default_agent_id;
        self.list_infos_with_default(&default_agent_id)
    }

    /// Like [`list_infos`] but accepts the default agent id directly (avoids
    /// reading the registry file for each entry; used by the server handler
    /// which already holds a loaded registry).
    pub fn list_infos_with_default(&self, default_agent_id: &str) -> Vec<AgentInfo> {
        self.entries
            .iter()
            .map(|e| {
                let model = match &e.transport {
                    AgentTransport::OpenAiCompat { model, .. } => model.map(str::to_owned),
                    AgentTransport::Acp { .. } => None,
                };
                // Engine binding is decided here in Core, never by the client.
                // ACP agents are their own runtime (strip the "acp:" id prefix);
                // OpenAI-compatible agents are themselves the local engine.
                let (engine, transport) = match &e.transport {
                    AgentTransport::Acp { .. } => (
                        Some(e.id.strip_prefix("acp:").unwrap_or(&e.id).to_owned()),
                        "acp",
                    ),
                    AgentTransport::OpenAiCompat { .. } => (Some(e.id.clone()), "openai_compat"),
                };
                let installed = e.detect_binary.map(binary_in_path);
                // Mark the default agent as `enabled: true` (AC2). Config is
                // authoritative; this is NOT persisted to the agents DB (AC4).
                let enabled = (e.id == default_agent_id).then_some(true);
                // Surface the gateway bypass flag (AC3 of #214) so clients can
                // show a warning for engines that cannot be redirected through the
                // local gateway (Claude Code, Gemini CLI).
                let gateway_bypass = e.gateway_bypass.then_some(true);
                if e.gateway_bypass {
                    tracing::debug!(
                        agent_id = %e.id,
                        "acp: agent does not honour OPENAI_BASE_URL — provider calls \
                         bypass the local gateway (residual egress; set gateway_bypass=true \
                         in metadata). To govern this agent, a translating ingress is needed."
                    );
                }
                AgentInfo {
                    id: e.id.clone(),
                    name: e.name.clone(),
                    title: None,
                    description: Some(e.description.clone()),
                    install_hint: if e.install_hint.is_empty() {
                        None
                    } else {
                        Some(e.install_hint.clone())
                    },
                    recommended: e.recommended.then_some(true),
                    installed,
                    model,
                    system_prompt: None,
                    created_at: None,
                    engine,
                    transport: Some(transport.to_owned()),
                    version: None,
                    latest_version: None,
                    version_status: None,
                    locked: None,
                    enabled,
                    gateway_bypass,
                    avatar_url: None,
                    avatar_glyph: None,
                    lifecycle_status: None,
                    safety_profile: None,
                }
            })
            .collect()
    }
}

impl Default for AcpAgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}
