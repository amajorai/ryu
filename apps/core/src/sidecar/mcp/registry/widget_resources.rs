//! Widget resources, prewarming and widget-accessible tools.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// Resolve (and cache) a widget HTML resource for `server` by its `uri`.
    ///
    /// The in-process apps provider serves its bundled HTML directly; a config
    /// MCP server is asked over `resources/read`. Never holds the cache lock
    /// across an `.await`.
    pub async fn widget_resource(&self, server: &str, uri: &str) -> Option<WidgetResource> {
        let configured = self.servers.read().ok()?.get(server).cloned();
        let external = match configured {
            Some(cfg) => Some(self.active_server_config(server, cfg).await.ok()?),
            None => None,
        };
        // Cache hit?
        let now = std::time::Instant::now();
        let cached = if let Ok(mut cache) = self.resource_cache.lock() {
            if let Some(server_cache) = cache.get_mut(server) {
                let expired = server_cache
                    .get(uri)
                    .is_some_and(|entry| !entry.is_fresh_at(now));
                if expired {
                    server_cache.remove(uri);
                }
                server_cache.get(uri).map(|entry| entry.value.clone())
            } else {
                None
            }
        } else {
            None
        };
        if let Some(resource) = cached {
            return Some(resource);
        }

        // SDK-authored widgets are stored as the installed plugin's bundled
        // `ui_code`, not behind an MCP process. Resolve that carriage through the
        // same enabled-plugin store used by the lifecycle gate and keep the
        // result in the normal per-server cache.
        if let (Some(manifests), Some(store)) = (
            self.self_build_manifests.as_ref(),
            self.self_build_app_store.as_ref(),
        ) {
            let identity = {
                let manifests = manifests.read().await;
                self_build_widget_identity(&manifests, server, uri)
            };
            if let Some((plugin_id, mime_type)) = identity {
                let enabled = store
                    .get(&plugin_id)
                    .await
                    .ok()
                    .flatten()
                    .is_some_and(|record| record.enabled);
                if !enabled {
                    return None;
                }
                if let Ok(Some(html)) = store.get_ui_code(&plugin_id).await {
                    let resource = WidgetResource {
                        uri: uri.to_owned(),
                        mime_type,
                        html,
                        meta: None,
                    };
                    if let Ok(mut cache) = self.resource_cache.lock() {
                        cache.entry(server.to_owned()).or_default().insert(
                            uri.to_owned(),
                            CachedMcpValue {
                                value: resource.clone(),
                                expires_at: None,
                            },
                        );
                    }
                    return Some(resource);
                }
            }
        }

        let (cfg, _plugin_lease) = external.as_ref()?;
        let (cmd, cache_allowed) = (cfg.to_target().ok()?, cfg.auth.is_none());
        let read = client::read_resource_with_cache_hints(&cmd, uri)
            .await
            .ok()?;
        if read.result_type != "complete" {
            return None;
        }
        let cache_expiry = mcp_result_cache_expiry(read.cache_hints, std::time::Instant::now());
        let first = read.contents.into_iter().find(|c| c.text.is_some())?;
        let resource = WidgetResource {
            uri: uri.to_owned(),
            mime_type: first
                .mime_type
                .unwrap_or_else(|| "text/html+skybridge".to_owned()),
            html: first.text.unwrap_or_default(),
            meta: first.meta,
        };
        if cache_allowed {
            if let Some(expires_at) = cache_expiry {
                if let Ok(mut cache) = self.resource_cache.lock() {
                    cache.entry(server.to_owned()).or_default().insert(
                        uri.to_owned(),
                        CachedMcpValue {
                            value: resource.clone(),
                            expires_at,
                        },
                    );
                }
            }
        }
        Some(resource)
    }

    /// Prewarm every widget resource a server advertises so the emit path can
    /// resolve HTML without a round-trip. In-process apps are already warm.
    pub async fn prewarm_widgets(&self, server: &str) -> Result<()> {
        let cfg = {
            let servers = self.servers.read().expect("mcp servers RwLock poisoned");
            let Some(cfg) = servers.get(server) else {
                return Ok(());
            };
            if !cfg.enabled {
                return Ok(());
            }
            cfg.clone()
        };
        let (cfg, plugin_lease) = self.active_server_config(server, cfg).await?;
        let cmd = cfg.to_target();
        let Ok(cmd) = cmd else {
            // A malformed entry lists no widgets rather than failing the prewarm;
            // `tools_for_server` is where the user sees the real error.
            return Ok(());
        };
        let resources = client::list_resources(&cmd).await.unwrap_or_default();
        // Nested resource reads acquire their own lease. Do not retain this one
        // behind a queued disable writer while reacquiring another read lock.
        drop(plugin_lease);
        for r in resources {
            if r.uri.starts_with("ui://widget/") {
                let _ = self.widget_resource(server, &r.uri).await;
            }
        }
        Ok(())
    }

    /// The fully-qualified ids of the widget-accessible (companion) tools on
    /// `server` — used to bound which tools a mounted widget may `callTool`.
    pub async fn widget_accessible_tool_ids(&self, server: &str) -> Vec<String> {
        let mut ids: Vec<String> = self
            .tools_for_server(server)
            .await
            .map(|tools| {
                tools
                    .into_iter()
                    .filter(|t| t.widget_accessible)
                    .map(|t| t.id)
                    .collect()
            })
            .unwrap_or_default();

        // Self-built Ryu Apps do not have an MCP process under `server`. Their
        // tool rows live in `app_tools`, while the widget-accessible flags live
        // in the app manifest. Include those rows here so `callTool` receives
        // the same server-scoped allowlist as an MCP widget.
        if let Some(manifests) = self.self_build_manifests.as_ref() {
            let manifests = manifests.read().await;
            let prefix = format!("{server}.");
            for manifest in manifests.iter() {
                for entry in &manifest.runnables {
                    if entry.kind != crate::runnable::RunnableKind::Tool {
                        continue;
                    }
                    let Some(config) = entry.config.as_ref() else {
                        continue;
                    };
                    if config.get("widget").and_then(Value::as_bool) == Some(true) {
                        continue;
                    }
                    if config.get("widget_accessible").and_then(Value::as_bool) != Some(true) {
                        continue;
                    }
                    let Ok(tool_config) = serde_json::from_value::<
                        crate::plugin_manifest::schema::ToolConfig,
                    >(config.clone()) else {
                        continue;
                    };
                    let id = app_tool_registered_id(&tool_config);
                    if id.starts_with(&prefix) && !ids.iter().any(|candidate| candidate == &id) {
                        ids.push(id);
                    }
                }
            }
        }

        ids
    }
}

#[cfg(test)]
#[path = "../tests/self_build_widgets.rs"]
mod tests;
