//! Plugin runtime wiring, lazy sidecar wake and active server leases.

use crate::sidecar::mcp::*;

impl McpRegistry {
    pub fn set_plugin_runtime(&self, runtime: crate::plugins::runtime::PluginRuntime) {
        *self
            .plugin_runtime
            .write()
            .expect("plugin runtime lock poisoned") = Some(runtime);
    }

    /// Install the sidecar manager that wakes an app's lazy sidecar before a tool
    /// call on its stdio MCP server (see [`SidecarWake`]).
    pub fn set_sidecar_manager(
        &self,
        manager: std::sync::Arc<crate::sidecar::manager::SidecarManager>,
    ) {
        self.sidecar_wake
            .write()
            .expect("sidecar wake lock poisoned")
            .manager = Some(manager);
    }

    /// Record the lazy / idle-stopped sidecars of `plugin_id` that its MCP servers
    /// forward to; an empty list forgets the plugin.
    pub(in crate::sidecar::mcp) fn set_wake_sidecars(
        &self,
        plugin_id: &str,
        sidecars: Vec<String>,
    ) {
        let mut wake = self
            .sidecar_wake
            .write()
            .expect("sidecar wake lock poisoned");
        if sidecars.is_empty() {
            wake.sidecars.remove(plugin_id);
        } else {
            wake.sidecars.insert(plugin_id.to_owned(), sidecars);
        }
    }

    /// Wake the lazy sidecars behind `cfg`'s owning app so a tool call on its stdio
    /// MCP server reaches a running sidecar. The returned guards pin them alive for
    /// the call (the idle clock restarts when they drop). A server with no such
    /// sidecar, or one already running, costs nothing. A start that is still in
    /// progress after [`SIDECAR_WAKE_TIMEOUT`] is a retryable error, and a failed
    /// start is reported as such, so the keyless process's own refusal is never
    /// what the caller sees.
    pub(in crate::sidecar::mcp) async fn wake_owner_sidecars(
        &self,
        cfg: &McpServerConfig,
    ) -> Result<Vec<crate::sidecar::manager::ActivityGuard>> {
        let Some(owner) = cfg.owner_plugin_id.as_deref() else {
            return Ok(Vec::new());
        };
        let (manager, sidecars) = {
            let wake = self
                .sidecar_wake
                .read()
                .expect("sidecar wake lock poisoned");
            let Some(manager) = wake.manager.clone() else {
                return Ok(Vec::new());
            };
            (
                manager,
                wake.sidecars.get(owner).cloned().unwrap_or_default(),
            )
        };
        let mut guards = Vec::with_capacity(sidecars.len());
        for name in sidecars {
            if !manager.is_wake_eligible(&name) {
                continue;
            }
            if let Err(error) = manager
                .wake_and_await_healthy(&name, SIDECAR_WAKE_TIMEOUT)
                .await
            {
                tracing::warn!("mcp: waking sidecar '{name}' for '{owner}' failed: {error:#}");
                if crate::sidecar::manager::is_still_starting(&error) {
                    bail!("the app's sidecar is still starting; retry shortly");
                }
                bail!("the app's sidecar failed to start");
            }
            guards.push(manager.enter_request(&name));
        }
        Ok(guards)
    }

    /// Gate every external MCP operation, including discovery and resource reads.
    /// Keep the returned lease until that operation and cache publication finish.
    pub(in crate::sidecar::mcp) async fn active_server_config(
        &self,
        server: &str,
        cfg: McpServerConfig,
    ) -> Result<(
        McpServerConfig,
        Option<crate::plugins::runtime::PluginWorkLease>,
    )> {
        if !cfg.enabled {
            bail!("MCP server '{server}' is disabled");
        }
        // Catalog installs are synthetic lifecycle records backed by mcp.json;
        // their wire config intentionally carries no owner metadata.
        let owner = match cfg.owner_plugin_id.clone() {
            Some(owner) => Some(owner),
            None => match self.self_build_manifests.as_ref() {
                Some(manifests) => manifests
                    .read()
                    .await
                    .iter()
                    .find(|manifest| {
                        manifest.id == server
                            && manifest.category.as_deref() == Some(MCP_SERVER_CATEGORY)
                    })
                    .map(|manifest| manifest.id.clone()),
                None => None,
            },
        };
        let Some(owner) = owner else {
            return Ok((cfg, None));
        };
        if let Some(store) = self.self_build_app_store.as_ref() {
            if !store
                .get(&owner)
                .await?
                .is_some_and(|record| record.enabled)
            {
                bail!("MCP server '{server}' owning plugin is inactive");
            }
        }
        let runtime = self
            .plugin_runtime
            .read()
            .expect("plugin runtime lock poisoned")
            .clone()
            .ok_or_else(|| anyhow!("MCP plugin lifecycle is unavailable"))?;
        let lease = runtime
            .try_acquire(&owner)
            .ok_or_else(|| anyhow!("MCP server '{server}' owning plugin is inactive"))?;
        // Re-read the registration protected by this active lifecycle lease.
        let mut current = self
            .servers
            .read()
            .expect("mcp servers RwLock poisoned")
            .get(server)
            .filter(|current| current.enabled && current.owner_plugin_id == cfg.owner_plugin_id)
            .cloned()
            .ok_or_else(|| anyhow!("MCP server '{server}' registration changed"))?;
        // Every spawn path lowers this config, so the owner's host callback env is
        // layered here, on the call-time copy, never on the stored registration.
        if let Some(manifests) = self.self_build_manifests.as_ref() {
            owner_host_env::apply(&mut current, &manifests.read().await);
        }
        Ok((current, Some(lease)))
    }
}

#[cfg(test)]
#[path = "../tests/registry_lifecycle.rs"]
mod tests;
