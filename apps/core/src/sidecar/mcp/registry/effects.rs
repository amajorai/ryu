//! Tool effect metadata, account policy and per-agent tool lists.
// test-exempt: moved verbatim out of sidecar/mcp/mod.rs; covered by the McpRegistry tests under sidecar/mcp/tests/.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// Resolve the provider metadata used by the lifecycle gate. App HTTP tools
    /// carry their method in the manifest backend; MCP tools carry annotations in
    /// the cached tools/list descriptor. Missing metadata deliberately falls
    /// through to the conservative name classifier.

    /// The exact owner/profile resolver shared by effect gating and execution.
    pub(in crate::sidecar::mcp) async fn oauth_dispatch_identity(
        &self,
        cfg: &McpServerConfig,
        agent_id: Option<&str>,
        profile_ids: &[String],
        host_conversation_id: Option<&str>,
    ) -> Result<(String, String)> {
        let saved_profiles;
        let profiles = if crate::mcp_oauth::remote_configured() {
            let agent = agent_id.context("Passport MCP requires an explicit calling agent")?;
            let store = self
                .agent_store
                .as_ref()
                .context("agent store unavailable for Passport MCP")?;
            let record = store
                .get(agent)
                .await?
                .context("calling Passport MCP agent is not installed")?;
            saved_profiles = crate::identity::passport::bound_mcp_profiles(
                &record.identity_profile_ids,
                profile_ids,
            )?;
            saved_profiles.as_slice()
        } else {
            profile_ids
        };
        let principal =
            ToolPrincipal::resolve_optional(self.conversations.as_ref(), host_conversation_id)
                .await;
        let owner = oauth_owner_from_principal(&principal)?;
        let policy = self.agent_account_policy(agent_id).await?;
        let profile = oauth_profile_for(&owner, cfg, profiles, agent_id, policy.as_ref()).await?;
        Ok((owner, profile))
    }

    /// The calling agent's account policy (identity mode + account allowlist),
    /// read fresh from its record so a settings change applies to the next call.
    /// `None` when there is no calling agent, no wired store or no record; the
    /// governed dispatch core separately refuses an identified agent in the last
    /// two cases. A store error propagates rather than reading as unrestricted.
    pub(in crate::sidecar::mcp) async fn agent_account_policy(
        &self,
        agent_id: Option<&str>,
    ) -> Result<Option<crate::agent_access::AgentAccountPolicy>> {
        let (Some(agent_id), Some(store)) = (agent_id, self.agent_store.as_ref()) else {
            return Ok(None);
        };
        Ok(store
            .get(agent_id)
            .await?
            .map(|record| crate::agent_access::AgentAccountPolicy::from_record(&record)))
    }

    /// Refuse delegation that would let a restricted agent act through an agent
    /// with wider reach into the user's accounts; see
    /// [`crate::agent_access::require_delegation_within_policy`].
    pub(in crate::sidecar::mcp) async fn require_delegation_within_policy(
        &self,
        caller: Option<&crate::agent_access::AgentAccountPolicy>,
        caller_agent_id: Option<&str>,
        target_agent_ids: Vec<String>,
    ) -> Result<()> {
        crate::agent_access::require_delegation_within_policy(
            self.agent_store.as_ref(),
            caller,
            caller_agent_id,
            target_agent_ids,
        )
        .await
    }

    /// Remote OAuth effects come only from the runtime grant's pinned action.
    /// This path never reads or populates the node-wide tool discovery cache.
    async fn remote_oauth_tool_effect(
        &self,
        tool_id: &str,
        agent_id: Option<&str>,
        profile_ids: &[String],
        host_conversation_id: Option<&str>,
    ) -> Result<Option<crate::identity::passport::McpToolEffect>> {
        if !crate::mcp_oauth::remote_configured() {
            return Ok(None);
        }
        let (lookup, _) = self.approval_target_for_tool(tool_id).await;
        let Some((server, tool)) = self.split_registered_tool_id(&lookup) else {
            return Ok(None);
        };
        let cfg = {
            let servers = self.servers.read().expect("mcp servers RwLock poisoned");
            servers
                .get(server)
                .filter(|cfg| cfg.auth.is_some())
                .cloned()
        };
        let Some(cfg) = cfg else {
            return Ok(None);
        };
        if !cfg.enabled || crate::fleet::is_artifact_blocked(server) {
            bail!("OAuth MCP server is unavailable");
        }
        let mut ids = vec![server.to_owned()];
        if let Some(plugin) = cfg.owner_plugin_id.clone() {
            ids.push(plugin);
        }
        let context = self
            .secret_resolution_context(host_conversation_id, ids)
            .await;
        let cfg = self.resolve_mcp_secret_config(&cfg, &context).await?;
        let (owner, profile) = self
            .oauth_dispatch_identity(&cfg, agent_id, profile_ids, host_conversation_id)
            .await?;
        let binding = ryu_vault::mcp_oauth::McpBinding {
            owner_user_id: owner,
            profile_id: profile,
            plugin_id: cfg
                .owner_plugin_id
                .clone()
                .context("OAuth MCP server has no owning plugin")?,
            server_name: cfg
                .owner_server_name
                .clone()
                .context("OAuth MCP server has no owning manifest key")?,
            resource_url: cfg
                .url
                .clone()
                .context("OAuth MCP server has no resource URL")?,
            client_id: cfg
                .auth
                .as_ref()
                .and_then(crate::plugin_manifest::McpServerAuthDecl::client_id)
                .map(str::to_owned),
        };
        Ok(Some(
            crate::identity::passport::mcp_tool_effect(
                agent_id.context("Passport MCP requires an explicit calling agent")?,
                &binding,
                &oauth_configuration(&cfg)?,
                tool,
            )
            .await?,
        ))
    }

    pub(in crate::sidecar::mcp) async fn tool_effect_metadata_scoped(
        &self,
        tool_id: &str,
        agent_id: Option<&str>,
        profile_ids: &[String],
        host_conversation_id: Option<&str>,
    ) -> Result<(
        Option<Value>,
        Option<String>,
        crate::identity::ConnectionAction,
    )> {
        if let Some(effect) = self
            .remote_oauth_tool_effect(tool_id, agent_id, profile_ids, host_conversation_id)
            .await?
        {
            return Ok((
                Some(effect.annotations),
                Some(effect.http_method),
                effect.action,
            ));
        }
        let (annotations, method) = self.tool_effect_metadata(tool_id).await;
        let action = crate::connection_policy::action_for_tool(
            tool_id,
            annotations.as_ref(),
            method.as_deref(),
        );
        Ok((annotations, method, action))
    }

    pub(crate) async fn tool_effect_metadata(
        &self,
        tool_id: &str,
    ) -> (Option<Value>, Option<String>) {
        let normalized = self.canonical_tool_id_for_registry(tool_id);
        let mut lookup_id = normalized.clone();
        let mut http_method = None;
        if is_app_tool_id(&normalized) {
            if let Some(resolved) = self.resolve_app_tool_backend(&normalized).await {
                match &resolved.backend {
                    crate::plugin_manifest::schema::ToolBackend::Alias { target } => {
                        lookup_id = self.canonical_tool_id_for_registry(target);
                    }
                    crate::plugin_manifest::schema::ToolBackend::Http { method, .. } => {
                        http_method = Some(method.clone());
                    }
                    _ => {}
                }
            }
        }

        let annotations = self
            .list_all_tools()
            .await
            .into_iter()
            .find(|tool| tool.id == lookup_id || tool.id == normalized)
            .and_then(|tool| tool.annotations);
        (annotations, http_method)
    }

    /// Tools visible to an agent, honoring its allowlist.
    ///
    /// `allowlist` semantics:
    ///   - `None`  → no restriction; every registered tool is allowed.
    ///   - `Some([])` → an explicit empty allowlist; no tools allowed.
    ///   - `Some([…])` → only tools whose fully-qualified id OR bare name OR
    ///     owning server appears in the list. Matching on server name lets an
    ///     agent allow a whole server with one entry. The `*` entry is the
    ///     explicit all-tools marker used by newly-created agents.
    pub async fn tools_for_agent(&self, allowlist: Option<&[String]>) -> Vec<RegistryTool> {
        if allowlist.is_some_and(|entries| entries.is_empty()) {
            return Vec::new();
        }
        let all = self.list_all_tools().await;
        match allowlist {
            None => all,
            Some(list) => {
                let normalized: Vec<String> = list
                    .iter()
                    .map(|entry| self.canonical_tool_id_for_registry(entry))
                    .collect();
                all.into_iter()
                    .filter(|t| tool_allowed(t, &normalized))
                    .collect()
            }
        }
    }

    /// Cloud tool metadata is built in; discovering unrelated host MCP servers
    /// must not be a side effect of starting a cloud model turn.
    pub fn cloud_tools_for_agent(&self, allowlist: Option<&[String]>) -> Vec<RegistryTool> {
        if allowlist.is_some_and(|entries| entries.is_empty()) {
            return Vec::new();
        }
        let tools = cloud::tools();
        match allowlist {
            None => tools,
            Some(entries) => {
                let normalized: Vec<String> = entries
                    .iter()
                    .map(|entry| self.canonical_tool_id_for_registry(entry))
                    .collect();
                tools
                    .into_iter()
                    .filter(|tool| tool_allowed(tool, &normalized))
                    .collect()
            }
        }
    }

    /// The `computer.*` and `browser.*` verbs a cloud task turn may run on its
    /// Box's own screen (design §7.4), filtered by the agent's allowlist like
    /// [`Self::cloud_tools_for_agent`]. The conversation gate allows them in a
    /// bound conversation only when they route to its Box.
    pub fn cloud_box_machine_tools_for_agent(
        &self,
        allowlist: Option<&[String]>,
    ) -> Vec<RegistryTool> {
        if allowlist.is_some_and(|entries| entries.is_empty()) {
            return Vec::new();
        }
        let tools = capability_tools::session_box_tools(&[]);
        match allowlist {
            None => tools,
            Some(entries) => {
                let normalized: Vec<String> = entries
                    .iter()
                    .map(|entry| self.canonical_tool_id_for_registry(entry))
                    .collect();
                tools
                    .into_iter()
                    .filter(|tool| tool_allowed(tool, &normalized))
                    .collect()
            }
        }
    }

    /// Resolve an agent's orchestration capabilities from the config store.
    ///
    /// Falls back to the safe defaults ([`AgentCapabilities::default`]:
    /// delegation on, creation off) when the store is unwired (test/CLI
    /// contexts) or the id is unknown (e.g. a bare transport-id caller). Because
    /// the default leaves delegation on, an agent never loses delegation merely
    /// because its config row could not be loaded.
    pub async fn agent_capabilities(&self, agent_id: &str) -> AgentCapabilities {
        if let Some(store) = &self.agent_store {
            if let Ok(Some(record)) = store.get(agent_id).await {
                return AgentCapabilities {
                    orchestrator: record.orchestrator_enabled(),
                    can_create_agents: record.can_create_agents_enabled(),
                };
            }
        }
        AgentCapabilities::default()
    }
}
