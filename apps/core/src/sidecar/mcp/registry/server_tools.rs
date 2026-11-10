//! Per-server tool discovery.
// test-exempt: moved verbatim out of sidecar/mcp/mod.rs; covered by the McpRegistry tests under sidecar/mcp/tests/.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// List tools for one enabled server, using the cache when warm.
    ///
    /// The config is extracted under a short read lock, then the lock is dropped
    /// before any `.await` — never hold an `RwLock` guard across an await point.
    pub(crate) async fn tools_for_server(&self, name: &str) -> Result<Vec<RegistryTool>> {
        self.tools_for_server_bound(name, None).await
    }

    /// Caller identity and profiles must come from Core's verified principal and
    /// installed-agent record. Never feed these parameters from model arguments.
    /// Remote OAuth discovery is deliberately not stored in the node-wide cache.
    pub async fn tools_for_server_for_identity(
        &self,
        name: &str,
        owner_user_id: &str,
        agent_id: &str,
        profile_ids: &[String],
    ) -> Result<Vec<RegistryTool>> {
        self.tools_for_server_bound(name, Some((owner_user_id, agent_id, profile_ids)))
            .await
    }

    async fn tools_for_server_bound(
        &self,
        name: &str,
        identity: Option<(&str, &str, &[String])>,
    ) -> Result<Vec<RegistryTool>> {
        // Extract owned config values under the read lock; drop immediately.
        let cfg = {
            let servers = self.servers.read().expect("mcp servers RwLock poisoned");
            let cfg = servers
                .get(name)
                .ok_or_else(|| anyhow!("unknown MCP server: {name}"))?;
            cfg.clone()
        };
        if !cfg.enabled {
            return Ok(vec![]);
        }
        let (cfg, _plugin_lease) = self.active_server_config(name, cfg).await?;
        // A stdio server may need its configured environment or a remote MCP
        // endpoint may authenticate its `tools/list` request. Resolve the same
        // server-side references used by call dispatch before discovery too.
        // Discovery has no host conversation, so a shared node intentionally
        // offers only node-local references here; user/team/org values are
        // still resolved for the chat call itself when its owner is known.
        let mut mcp_ids = vec![name.to_owned()];
        if let Some(plugin_id) = cfg.owner_plugin_id.clone() {
            mcp_ids.push(plugin_id);
        }
        let secret_context = self.secret_resolution_context(None, mcp_ids).await;
        let cfg = self
            .resolve_mcp_secret_config(&cfg, &secret_context)
            .await?;
        let cmd = if cfg.auth.is_some() {
            if identity.is_none() && crate::sidecar::control_plane::registered_org().is_some() {
                bail!(
                    "MCP server '{name}' needs an explicit user/profile preflight on this shared node"
                );
            }
            let (owner, agent, profiles) = identity
                .map(|(owner, agent, profiles)| (owner, Some(agent), profiles))
                .unwrap_or(("local", None, &[]));
            let policy = self.agent_account_policy(agent).await?;
            let profile = oauth_profile_for(owner, &cfg, profiles, agent, policy.as_ref()).await?;
            oauth_target(
                &cfg,
                owner,
                &profile,
                crate::identity::ConnectionAction::Read,
                false,
                false,
                None,
                agent,
            )
            .await?
        } else {
            cfg.to_target()?
        };

        let remote_oauth = cfg.auth.is_some() && crate::mcp_oauth::remote_configured();
        let cached = (!remote_oauth).then(|| {
            let mut cache = self.tool_cache.lock().ok()?;
            let now = std::time::Instant::now();
            if cache.get(name).is_some_and(|entry| !entry.is_fresh_at(now)) {
                cache.remove(name);
            }
            cache.get(name).map(|entry| entry.value.clone())
        });
        if let Some(Some(cached)) = cached {
            return Ok(cached);
        }

        let listing = client::list_tools_with_cache_hints(&cmd).await?;
        self.discovery_backoff.succeeded(name);
        let cache_expiry = mcp_result_cache_expiry(listing.cache_hints, std::time::Instant::now());
        let cacheable = !remote_oauth && cache_expiry.is_some();
        let mcp_tools = listing.tools;
        let server_capabilities = listing.server_capabilities;
        let standard_app_server = mcp_tools
            .iter()
            .any(|tool| ui_extensions::resource_uri(tool.meta.as_ref()).is_some());
        let tools: Vec<RegistryTool> = mcp_tools
            .into_iter()
            .map(|t| {
                let widget = WidgetBinding::from_meta(t.meta.as_ref());
                let widget_accessible =
                    app_visibility::callable(t.meta.as_ref(), standard_app_server);
                let output_template = widget.as_ref().map(|w| w.template_uri.clone());
                RegistryTool {
                    id: Self::tool_id(name, &t.name),
                    server: name.to_owned(),
                    name: t.name,
                    description: t.description,
                    input_schema: t.input_schema,
                    output_schema: t.output_schema,
                    annotations: t.annotations,
                    meta: {
                        let mut meta = t.meta.unwrap_or_else(|| serde_json::json!({}));
                        if let Some(meta) = meta.as_object_mut() {
                            meta.insert(
                                "ryu/serverExtensions".to_owned(),
                                server_capabilities.clone(),
                            );
                        }
                        Some(meta)
                    },
                    widget,
                    widget_accessible,
                    output_template,
                    app_backend: None,
                }
            })
            .collect();

        if cacheable {
            if let Ok(mut cache) = self.tool_cache.lock() {
                cache.insert(
                    name.to_owned(),
                    CachedMcpValue {
                        value: tools.clone(),
                        expires_at: cache_expiry.flatten(),
                    },
                );
            }
        }
        Ok(tools)
    }

    /// Number of registered servers (for diagnostics/tests).
    pub fn len(&self) -> usize {
        self.servers
            .read()
            .expect("mcp servers RwLock poisoned")
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.servers
            .read()
            .expect("mcp servers RwLock poisoned")
            .is_empty()
    }
}
