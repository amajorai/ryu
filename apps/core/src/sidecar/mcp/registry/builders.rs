//! `McpRegistry` constructors and `with_*` wiring.
// test-exempt: moved verbatim out of sidecar/mcp/mod.rs; covered by the McpRegistry tests under sidecar/mcp/tests/.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// Build an empty registry (no servers configured).
    pub fn empty() -> Self {
        Self {
            servers: RwLock::new(BTreeMap::new()),
            plugin_servers: RwLock::new(BTreeMap::new()),
            plugin_runtime: RwLock::new(None),
            sidecar_wake: RwLock::new(SidecarWake::default()),
            tool_cache: Mutex::new(BTreeMap::new()),
            discovery_backoff: DiscoveryBackoff::default(),
            resource_cache: Mutex::new(HashMap::new()),
            app_tools: Mutex::new(Vec::new()),
            ext_api: Mutex::new(BTreeMap::new()),
            capability_cache: Mutex::new(None),
            node_display_cache: Mutex::new(None),
            http: reqwest::Client::new(),
            self_build_manifests: None,
            self_build_app_store: None,
            agent_store: None,
            conversations: None,
            skills: None,
            preferences: None,
            capabilities: None,
            spaces: None,
            memory: None,
        }
    }

    /// Build a registry from a server map (used by config loading and tests).
    pub fn from_servers(servers: BTreeMap<String, McpServerConfig>) -> Self {
        Self {
            servers: RwLock::new(servers),
            plugin_servers: RwLock::new(BTreeMap::new()),
            plugin_runtime: RwLock::new(None),
            sidecar_wake: RwLock::new(SidecarWake::default()),
            tool_cache: Mutex::new(BTreeMap::new()),
            discovery_backoff: DiscoveryBackoff::default(),
            resource_cache: Mutex::new(HashMap::new()),
            app_tools: Mutex::new(Vec::new()),
            ext_api: Mutex::new(BTreeMap::new()),
            capability_cache: Mutex::new(None),
            node_display_cache: Mutex::new(None),
            http: reqwest::Client::new(),
            self_build_manifests: None,
            self_build_app_store: None,
            agent_store: None,
            conversations: None,
            skills: None,
            preferences: None,
            capabilities: None,
            spaces: None,
            memory: None,
        }
    }

    /// Wire the self-build context (manifests + app store) into the registry.
    /// Must be called after construction to enable the `ryu_self_build` tools.
    pub fn with_self_build(
        mut self,
        manifests: std::sync::Arc<TokioRwLock<Vec<PluginManifest>>>,
        app_store: std::sync::Arc<crate::plugins::PluginStore>,
    ) -> Self {
        self.self_build_manifests = Some(manifests);
        self.self_build_app_store = Some(app_store);
        self
    }

    /// Wire the agent config store into the registry. Must be called after
    /// construction to enable the `agent_builder` tools (chat-driven agent edits).
    pub fn with_agent_store(mut self, store: crate::agents::AgentStore) -> Self {
        self.agent_store = Some(store);
        self
    }

    /// Resolve the server-owned display context for the local Ghost cursor.
    /// Metadata travels through MCP `_meta`, outside the tool arguments, so a
    /// model cannot spoof another agent or session title.
    pub(in crate::sidecar::mcp) async fn ghost_cursor_identity(
        &self,
        agent_id: Option<&str>,
        host_conversation_id: Option<&str>,
    ) -> Option<Value> {
        let agent = match (agent_id, self.agent_store.as_ref()) {
            (Some(id), Some(store)) => store.get(id).await.ok().flatten(),
            _ => None,
        };
        let conversation = match (host_conversation_id, self.conversations.as_ref()) {
            (Some(id), Some(store)) => store.get_run_summary(id).await.ok().flatten(),
            _ => None,
        };

        let mut identity = serde_json::Map::new();
        if let Some(record) = agent.as_ref() {
            if let Some(agent_id) = cursor_identity_text(Some(record.id.as_str()), 96) {
                identity.insert("agentId".into(), Value::String(agent_id));
            }
            let display_name = record
                .persona
                .as_ref()
                .and_then(|persona| persona.display_name.as_deref())
                .or(Some(record.name.as_str()));
            if let Some(name) = cursor_identity_text(display_name, 80) {
                identity.insert("agentName".into(), Value::String(name));
            }
            if let Some(title) = cursor_identity_text(Some(&record.title), 80) {
                identity.insert("agentTitle".into(), Value::String(title));
            }
            if let Some(avatar_url) = record
                .persona
                .as_ref()
                .and_then(|persona| persona.avatar_url.as_deref())
                .filter(|url| url.len() <= 20_000)
                .filter(|url| !url.trim().is_empty())
            {
                identity.insert("avatarUrl".into(), Value::String(avatar_url.to_owned()));
            }
            if let Some(emoji) = record
                .persona
                .as_ref()
                .and_then(|persona| persona.emoji.as_deref())
            {
                if let Some(emoji) = cursor_identity_text(Some(emoji), 8) {
                    identity.insert("avatarEmoji".into(), Value::String(emoji));
                }
            }
        }
        if let Some(title) = conversation
            .as_ref()
            .and_then(|summary| summary.title.as_deref())
            .and_then(|title| cursor_identity_text(Some(title), 160))
        {
            identity.insert("sessionTitle".into(), Value::String(title));
        }

        (!identity.is_empty()).then_some(Value::Object(identity))
    }

    /// Wire the Core-as-consumer capability helper into the registry. Must be
    /// called after construction to enable `agent_builder.create_agent_team` (mint
    /// a roster of agents + persist them through the `teams.create` capability) and
    /// the `dashboard_builder` tools (the `dashboards.*` capabilities).
    pub fn with_capabilities(
        mut self,
        consumer: crate::sidecar::capability_consumer::CapabilityConsumer,
    ) -> Self {
        self.capabilities = Some(consumer);
        self
    }

    /// Wire the conversation store into the registry. Must be called after
    /// construction to enable the `search_conversations` built-in tool (semantic
    /// search over past chat messages).
    pub fn with_conversations(
        mut self,
        store: crate::server::conversations::ConversationStore,
    ) -> Self {
        self.conversations = Some(store);
        self
    }

    /// Wire the Spaces store into the registry. Must be called after construction
    /// to enable the built-in Spaces tools, `artifact.create`, and the ACP artifact
    /// auto-file hook to persist files into a Space.
    pub fn with_spaces(mut self, spaces: crate::server::spaces::SpaceStore) -> Self {
        self.spaces = Some(spaces);
        self
    }

    /// Wire the memory store into the registry. Must be called after construction
    /// to enable the built-in `working_memory.update_working_memory` tool.
    pub fn with_memory(mut self, memory: crate::server::memory::MemoryStore) -> Self {
        self.memory = Some(memory);
        self
    }

    /// Wire the skill registry into the registry. Must be called after
    /// construction to enable the `skills` built-in tools (`skills.search` /
    /// `skills.load`, progressive disclosure of Agent Skills).
    pub fn with_skills(mut self, skills: ryu_skills::SkillRegistry) -> Self {
        self.skills = Some(skills);
        self
    }

    /// Wire the preferences store into the registry for per-layer defaults and
    /// the web search access policy.
    pub fn with_preferences(
        mut self,
        preferences: crate::server::preferences::PreferencesStore,
    ) -> Self {
        self.preferences = Some(preferences);
        self
    }
}
