//! Web search access modes, capability verbs and node display tools.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// The ENABLED plugin manifests — the candidate set every capability binding is
    /// resolved over. Enabled rather than merely installed because that is the set
    /// the binding registry's invariants (deterministic pick, disable safety) are
    /// stated over, and the set the broker actually sees at call time.
    ///
    /// `None` when the manifest store / app store is not wired (test + CLI contexts),
    /// which callers treat as "no capabilities available" rather than an error.
    pub(in crate::sidecar::mcp) async fn enabled_manifests(&self) -> Option<Vec<PluginManifest>> {
        let manifests = self.self_build_manifests.as_ref()?;
        let store = self.self_build_app_store.as_ref()?;
        let enabled: std::collections::HashSet<String> = store
            .list()
            .await
            .ok()?
            .into_iter()
            .filter(|r| r.enabled)
            .map(|r| r.id)
            .collect();
        let guard = manifests.read().await;
        Some(
            guard
                .iter()
                .filter(|m| enabled.contains(&m.id))
                .cloned()
                .collect(),
        )
    }

    pub(in crate::sidecar::mcp) async fn web_search_access_mode(
        &self,
    ) -> web_search_access::WebSearchAccessMode {
        let Some(preferences) = self.preferences.as_ref() else {
            return web_search_access::WebSearchAccessMode::default();
        };

        match preferences
            .get(web_search_access::WEB_SEARCH_ACCESS_MODE_PREF_KEY)
            .await
        {
            Ok(None) => web_search_access::WebSearchAccessMode::default(),
            Ok(Some(value)) => web_search_access::WebSearchAccessMode::parse(&value)
                .unwrap_or_else(|| {
                    tracing::warn!("invalid stored web search access mode; denying web access");
                    web_search_access::WebSearchAccessMode::Disabled
                }),
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    "failed to read web search access mode; denying web access"
                );
                web_search_access::WebSearchAccessMode::Disabled
            }
        }
    }

    /// Provider tools (of every enabled provider, selected or not) bound to a web
    /// or browser verb `mode` denies. Empty in `Live` without reading manifests.
    ///
    /// Fails closed like [`Self::web_search_access_mode`]: when manifests are loaded
    /// but the enabled set cannot be read (a plugin-store listing error), every
    /// loaded provider's web/browser tools are restricted. Over-restricting during a
    /// transient store error is preferable to letting an unselected provider's tools
    /// through a mode that denies them.
    pub(in crate::sidecar::mcp) async fn web_access_restricted_provider_tools(
        &self,
        mode: web_search_access::WebSearchAccessMode,
    ) -> std::collections::BTreeSet<String> {
        if mode == web_search_access::WebSearchAccessMode::Live {
            return std::collections::BTreeSet::new();
        }
        if let Some(enabled) = self.enabled_manifests().await {
            return web_search_access::restricted_provider_tool_ids(&enabled, mode);
        }
        // `enabled_manifests` is `None` either because nothing is wired (no
        // manifests: no provider to restrict) or because the store listing failed.
        let Some(manifests) = self.self_build_manifests.as_ref() else {
            return std::collections::BTreeSet::new();
        };
        tracing::warn!(
            "failed to list enabled plugins; restricting web access tools of every loaded provider"
        );
        let loaded = manifests.read().await;
        web_search_access::restricted_provider_tool_ids(&loaded, mode)
    }

    /// Whether a call to a selected-only provider's tool must be refused. Such a
    /// tool (Ryu Cloud Search's `cloudsearch.search`) runs only through the layer
    /// facade, and only while a resolved verb binds it. Neither a direct call nor
    /// another provider's adapter can reach it and spend organization credits.
    pub(in crate::sidecar::mcp) async fn selected_only_tool_refused(
        &self,
        tool_id: &str,
        via_capability: bool,
    ) -> bool {
        if !web_search_access::builtin_selected_only_tool_ids().contains(tool_id) {
            return false;
        }
        if !via_capability {
            return true;
        }
        !web_search_access::selected_only_tool_bound(&self.capability_verbs().await, tool_id)
    }

    pub(in crate::sidecar::mcp) async fn is_direct_web_provider_tool(&self, tool_id: &str) -> bool {
        let direct_server = self
            .split_registered_tool_id(tool_id)
            .map(|(server, _)| server)
            .or_else(|| tool_id.split_once('.').map(|(server, _)| server));
        let Some(direct_server) = direct_server else {
            return false;
        };

        self.capability_verbs().await.iter().any(|resolved| {
            web_search_access::is_web_access_tool_id(resolved.verb.id)
                && (resolved.binding.tool == tool_id
                    || resolved
                        .binding
                        .tool
                        .split_once('.')
                        .is_some_and(|(server, _)| server == direct_server))
        })
    }

    /// Every capability verb the facade can currently serve, given the enabled
    /// providers and the user's binding overrides. Drives both tool listing and the
    /// `GET /api/capabilities` read model.
    pub async fn capability_verbs(&self) -> Vec<capability_tools::ResolvedVerb> {
        // Served from cache unless the provider selection or the enabled plugin set
        // has changed. Without this the enabled-set join (a plugin-store read plus a
        // clone of every enabled manifest) would run on every facade tool call AND
        // inside every `list_all_tools`, which is itself called per agent listing,
        // per catalog search, and per describe.
        let generation = capability_tools::generation();
        if let Ok(cache) = self.capability_cache.lock() {
            if let Some((cached_generation, verbs)) = cache.as_ref() {
                if *cached_generation == generation {
                    return verbs.clone();
                }
            }
        }
        let Some(enabled) = self.enabled_manifests().await else {
            return Vec::new();
        };
        let verbs =
            capability_tools::resolve_verbs(&enabled, &crate::plugins::binding::active_config());
        if let Ok(mut cache) = self.capability_cache.lock() {
            // Store the generation read BEFORE resolving: if an invalidation landed
            // mid-resolve, the stored value is already stale and the next read
            // recomputes rather than serving a torn snapshot.
            *cache = Some((generation, verbs.clone()));
        }
        verbs
    }

    /// The MCP servers whose tools drive this node's own display: the servers
    /// every enabled `local-machine` computer or browser provider binds its
    /// verbs to (`box_desktop::node_display_servers`).
    async fn node_display_servers(&self) -> std::collections::BTreeSet<String> {
        let generation = capability_tools::generation();
        if let Ok(cache) = self.node_display_cache.lock() {
            if let Some((cached_generation, servers)) = cache.as_ref() {
                if *cached_generation == generation {
                    return servers.clone();
                }
            }
        }
        let servers = match self.enabled_manifests().await {
            Some(enabled) => box_desktop::node_display_servers(&enabled),
            // A failed store listing withholds every loaded provider's tools,
            // the conservative reading for a conversation on a Box.
            None => match self.self_build_manifests.as_ref() {
                Some(manifests) => box_desktop::node_display_servers(&manifests.read().await),
                None => std::collections::BTreeSet::new(),
            },
        };
        if let Ok(mut cache) = self.node_display_cache.lock() {
            *cache = Some((generation, servers.clone()));
        }
        servers
    }

    /// Whether `tool_id` drives this node's own display: Shadow computer use,
    /// or a tool of a node display provider's server (Ghost, Codex computer
    /// use, the Chromium sidecar, …). The capability facade verbs are not:
    /// they are routed per conversation by `box_desktop::route`.
    pub(crate) async fn drives_node_display(&self, tool_id: &str) -> bool {
        if box_desktop::NODE_COMPUTER_USE_TOOLS.contains(&tool_id) {
            return true;
        }
        if capability_tools::verb_by_id(tool_id).is_some() {
            return false;
        }
        let server = self
            .split_registered_tool_id(tool_id)
            .map(|(server, _)| server)
            .or_else(|| tool_id.split_once('.').map(|(server, _)| server));
        let servers = self.node_display_servers().await;
        servers.contains(tool_id) || server.is_some_and(|server| servers.contains(server))
    }

    /// `tools` without the ones that drive this node's display when the
    /// machine verbs of `host_conversation_id` run on its session Box, so the
    /// model is never offered a way around its Box (the dispatch gate refuses
    /// them too).
    pub(crate) async fn without_node_display_tools(
        &self,
        tools: Vec<RegistryTool>,
        host_conversation_id: Option<&str>,
    ) -> Vec<RegistryTool> {
        if !box_desktop::withholds_node_display(self.conversations.as_ref(), host_conversation_id)
            .await
        {
            return tools;
        }
        let mut kept = Vec::with_capacity(tools.len());
        for tool in tools {
            if !self.drives_node_display(&tool.id).await {
                kept.push(tool);
            }
        }
        kept
    }
}

#[cfg(test)]
#[path = "../tests/web_access.rs"]
mod tests;
