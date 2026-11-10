//! App tool backends, approval targets and action descriptors.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// Resolve the dispatch backend + grants for an `app.<slug>` tool id by
    /// scanning the LIVE enabled-plugin manifests (the same source
    /// `plugin_host::collect_enabled_hooks` reads). Returns `None` when the
    /// registry has no self-build wiring (bare/test registries) or no enabled
    /// plugin owns this id — the dispatcher then falls back to the legacy alias
    /// behavior, so this is purely additive.
    ///
    /// Never holds the `app_tools` mutex (or any std lock) across the `.await`s.
    pub(in crate::sidecar::mcp) async fn resolve_app_tool_backend(
        &self,
        tool_id: &str,
    ) -> Option<ResolvedAppTool> {
        let manifests = self.self_build_manifests.as_ref()?;
        let store = self.self_build_app_store.as_ref()?;

        // Only enabled plugins may own a live tool (matches the hook collector).
        // The record's GATEWAY-APPROVED grants ride along: they, not the manifest's
        // self-declaration, are what gates a Community-tier tool below.
        let enabled: std::collections::HashMap<String, Vec<String>> = store
            .list()
            .await
            .ok()?
            .into_iter()
            .filter(|r| r.enabled)
            .map(|r| (r.id, r.approved_grants))
            .collect();
        if enabled.is_empty() {
            return None;
        }

        let guard = manifests.read().await;
        let namespace = Self::split_tool_id(tool_id).map_or("", |(server, _)| server);
        // Two enabled plugins may declare the same id; the namespace owner wins.
        let mut fallback = None;
        for manifest in guard.iter() {
            let Some(approved_grants) = enabled.get(&manifest.id) else {
                continue;
            };
            for entry in &manifest.runnables {
                if entry.kind != crate::runnable::RunnableKind::Tool {
                    continue;
                }
                let Some(cfg) = entry.config.as_ref().and_then(|v| {
                    serde_json::from_value::<crate::plugin_manifest::schema::ToolConfig>(v.clone())
                        .ok()
                }) else {
                    continue;
                };
                // Match the SAME id registration mints (native id for a namespaced
                // non-Alias tool, else `app.<slug>`) so resolution never diverges.
                if app_tool_registered_id(&cfg) != tool_id {
                    continue;
                }
                // A malformed backend was already rejected at manifest validation;
                // if it somehow fails here, skip (dispatcher falls back to alias).
                let mut backend = cfg.resolve_backend().ok()?;
                crate::tool_exec::restrict_backend_env_sources(manifest, &mut backend);
                let grants = effective_tool_grants(manifest, approved_grants);
                let owns_namespace = self.plugin_owns_tool_namespace(manifest, namespace);
                let resolved = ResolvedAppTool {
                    backend,
                    grants,
                    plugin_id: manifest.id.clone(),
                    permissions: manifest.permissions.clone(),
                    timeout_secs: cfg.timeout_secs,
                    needs_approval: cfg.needs_approval.unwrap_or(false),
                    owns_namespace,
                };
                if owns_namespace {
                    return Some(resolved);
                }
                fallback.get_or_insert(resolved);
            }
        }
        fallback
    }

    /// Resolve the approval target and explicit manifest gate for a registered
    /// app tool. Native dotted ids (for example `crm.save`) do not carry the
    /// `app.` prefix, so checking only [`is_app_tool_id`] would bypass an
    /// explicit `needs_approval: true` declaration. Restrict the extra lookup
    /// to ids already registered by the app-tool loader; ordinary native MCP
    /// ids remain on their existing path.
    pub(crate) async fn approval_target_for_tool(&self, tool_id: &str) -> (String, bool) {
        // A native id that yields to a configured server it does not own is gated
        // as that server's tool, not by the yielding plugin's manifest.
        if !is_app_tool_id(tool_id) && !self.app_tool_serves_call(tool_id).await {
            return (tool_id.to_owned(), false);
        }

        match self.resolve_app_tool_backend(tool_id).await {
            Some(resolved) => {
                let gate_id = match resolved.backend {
                    crate::plugin_manifest::schema::ToolBackend::Alias { target } => target,
                    _ => tool_id.to_owned(),
                };
                (gate_id, resolved.needs_approval)
            }
            // Legacy alias re-enter: the target is the id after the prefix.
            None => (
                tool_id
                    .strip_prefix(APP_TOOL_PREFIX)
                    .unwrap_or(tool_id)
                    .to_owned(),
                false,
            ),
        }
    }

    /// List enabled, registered SDK Actions without exposing ordinary tools.
    /// The manifest marker is authoritative for semantics, while `app_tools`
    /// confirms the runnable was actually activated before it becomes reachable
    /// through a protocol projection.
    pub(crate) async fn action_descriptors(&self) -> Vec<ActionDescriptor> {
        let Some(manifests) = self.self_build_manifests.as_ref() else {
            return Vec::new();
        };
        let Some(store) = self.self_build_app_store.as_ref() else {
            return Vec::new();
        };
        let enabled: std::collections::HashSet<String> = match store.list().await {
            Ok(records) => records
                .into_iter()
                .filter(|record| record.enabled)
                .map(|record| record.id)
                .collect(),
            Err(_) => return Vec::new(),
        };
        if enabled.is_empty() {
            return Vec::new();
        }
        let registered: std::collections::HashSet<String> = self
            .app_tools
            .lock()
            .map(|tools| tools.iter().map(|tool| tool.id.clone()).collect())
            .unwrap_or_default();
        let guard = manifests.read().await;
        let mut actions = Vec::new();
        for manifest in guard.iter() {
            if !enabled.contains(&manifest.id) {
                continue;
            }
            for entry in &manifest.runnables {
                if entry.kind != crate::runnable::RunnableKind::Tool {
                    continue;
                }
                let Some(config) = entry.config.as_ref() else {
                    continue;
                };
                let Ok(tool_config) = serde_json::from_value::<
                    crate::plugin_manifest::schema::ToolConfig,
                >(config.clone()) else {
                    continue;
                };
                if tool_config.action != Some(true) {
                    continue;
                }
                let registered_id = app_tool_registered_id(&tool_config);
                if !registered.contains(&registered_id) {
                    continue;
                }
                let effect = if tool_config
                    .annotations
                    .as_ref()
                    .and_then(|annotations| annotations.get("readOnlyHint"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    "read"
                } else {
                    "mutate"
                };
                actions.push(ActionDescriptor {
                    action_id: tool_config.slug,
                    description: tool_config
                        .description
                        .unwrap_or_else(|| format!("{} action", entry.name)),
                    effect,
                    name: entry.name.clone(),
                    plugin_id: manifest.id.clone(),
                    registered_id,
                });
            }
        }
        actions.sort_by(|left, right| left.registered_id.cmp(&right.registered_id));
        actions
    }

    /// Resolve an external Action id to the activated tool id used by Core
    /// dispatch. Raw slugs are accepted only when unambiguous; the registered
    /// id (`app.<slug>`) or `<plugin-id>/<slug>` can always identify the action.
    pub(crate) async fn resolve_action_tool_id(&self, action_id: &str) -> Option<String> {
        let requested = action_id.trim();
        if requested.is_empty() {
            return None;
        }
        let matches: Vec<String> = self
            .action_descriptors()
            .await
            .into_iter()
            .filter(|action| {
                requested == action.registered_id
                    || requested == action.action_id
                    || requested == format!("{}/{}", action.plugin_id, action.action_id)
            })
            .map(|action| action.registered_id)
            .collect();
        (matches.len() == 1).then(|| matches[0].clone())
    }

    /// The effective grant set of the plugin that OWNS a derived ext-API route, or
    /// `None` when it is not a currently-enabled manifest.
    ///
    /// Resolved live from the manifest store + app-store record on every call rather
    /// than snapshotted into [`crate::ext_api::ExtApiRoute`] at lowering time. That
    /// costs a lookup per dispatch and buys the only property that matters here: a
    /// grant REVOKED after the sidecar went healthy takes effect on the next call.
    /// A snapshot would keep serving the grants the app held at boot, which is
    /// precisely the window an operator revokes a grant to close.
    ///
    /// `None` is the fail-closed answer for three different situations that all mean
    /// "no owner right now": the plugin was disabled (its rows should already have
    /// been cleared — this is the belt to that braces), the manifest is gone, or the
    /// stores are unwired (CLI/test). The caller refuses on `None`; it must never
    /// substitute an empty set, because an empty set is not "no grants" to
    /// [`crate::ext_api::call_plan`] — the loopback egress union would still make the
    /// call go through.
    /// Whether `plugin_id`'s loaded manifest reaches the user's desktop (see
    /// [`manifest_reaches_user_desktop`]). With no manifest store wired there is
    /// nothing to dispatch to, so this answers `false` and the caller's own
    /// manifest lookup refuses the call.
    pub(in crate::sidecar::mcp) async fn plugin_reaches_user_desktop(
        &self,
        plugin_id: &str,
    ) -> bool {
        let Some(manifests) = self.self_build_manifests.as_ref() else {
            return false;
        };
        manifests
            .read()
            .await
            .iter()
            .find(|manifest| manifest.id == plugin_id)
            .is_some_and(manifest_reaches_user_desktop)
    }

    pub(in crate::sidecar::mcp) async fn ext_api_effective_grants(
        &self,
        plugin_id: &str,
    ) -> Option<std::collections::HashSet<String>> {
        let manifests = self.self_build_manifests.as_ref()?;
        let store = self.self_build_app_store.as_ref()?;

        // Enabled-only, matching `resolve_app_tool_backend` and the hook collector:
        // an installed-but-disabled plugin owns nothing at dispatch.
        let record = store
            .list()
            .await
            .ok()?
            .into_iter()
            .find(|r| r.id == plugin_id && r.enabled)?;

        let guard = manifests.read().await;
        let manifest = guard.iter().find(|m| m.id == plugin_id)?;
        Some(effective_tool_grants(manifest, &record.approved_grants))
    }
}

#[cfg(test)]
#[path = "../tests/app_tool_grants.rs"]
mod tests;

#[cfg(test)]
#[path = "../tests/app_tool_resolution.rs"]
mod resolution_tests;
