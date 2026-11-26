//! `host.catalog*` reads and the side-model resolver.
// test-exempt: moved verbatim out of plugin_host/bridge.rs; tests in bridge/tests.rs and bridge/runtime_tests.rs.

use super::*;

impl PluginHookBridge {
    /// Return the Ryu-owned runtime catalog used by Companion pickers.
    ///
    /// This is intentionally a projection rather than a serialization of Core's
    /// config. Provider rows keep auth kind, routing, and configuration state,
    /// but drop auth environment names and every
    /// credential. Agent rows drop prompts and persona payloads. Hook rows expose
    /// declarations only — never code or grants — so an app can discover the
    /// shared ecosystem without becoming a privileged plugin host.
    pub(super) async fn catalog_snapshot(&self, _args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_CATALOG) {
            return err(format!(
                "capability '{GRANT_CATALOG}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }

        let raw_catalog = crate::pi_config::catalog();
        let providers = raw_catalog
            .get("providers")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .map(project_catalog_provider)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let current = crate::pi_config::current();
        let current = json!({
            "provider": current.provider,
            "model": current.model,
            "thinkingLevel": current.thinking_level,
            "routing": current.routing,
            "providerRouting": current.provider_routing,
        });

        let registry = crate::registry::ProviderRegistry::load();
        let agents = self
            .state
            .agents
            .list_infos_with_default(&registry.default_agent_id)
            .into_iter()
            .map(|agent| {
                json!({
                    "id": agent.id,
                    "name": agent.name,
                    "title": agent.title,
                    "description": agent.description,
                    "installHint": agent.install_hint,
                    "installed": agent.installed,
                    "model": agent.model,
                    "engine": agent.engine,
                    "transport": agent.transport,
                    "recommended": agent.recommended,
                    "version": agent.version,
                    "latestVersion": agent.latest_version,
                    "versionStatus": agent.version_status,
                    "locked": agent.locked,
                    "enabled": agent.enabled,
                    "gatewayBypass": agent.gateway_bypass,
                    "lifecycleStatus": agent.lifecycle_status,
                    "safetyProfile": agent.safety_profile,
                })
            })
            .collect::<Vec<_>>();

        let records = match self.state.app_store.list().await {
            Ok(records) => records,
            Err(error) => return err(format!("host.catalogSnapshot could not list apps: {error}")),
        };
        let enabled_ids: HashSet<String> = records
            .iter()
            .filter(|record| record.enabled)
            .map(|record| record.id.clone())
            .collect();

        let plugins = {
            let manifests = self.state.app_manifests.read().await;
            manifests
                .iter()
                .map(|manifest| {
                    let contributes = manifest.contributes.as_ref();
                    json!({
                        "id": manifest.id,
                        "name": manifest.name,
                        "version": manifest.version,
                        "enabled": enabled_ids.contains(&manifest.id),
                        "compatible": true,
                        "hasCompanion": manifest.companion.is_some(),
                        "runnableCount": manifest.runnables.len(),
                        "hookCount": contributes.map_or(0, |value| value.turn_hooks.len()),
                        "hookEventCount": contributes.map_or(0, |value| value.hook_events.len()),
                    })
                })
                .collect::<Vec<_>>()
        };

        let plugins = {
            let incompatible = self.state.incompatible_manifests.read().await;
            let mut plugins = plugins;
            plugins.extend(incompatible.iter().map(|entry| {
                let manifest = entry.for_catalog();
                let contributes = manifest.contributes.as_ref();
                json!({
                    "id": manifest.id,
                    "name": manifest.name,
                    "version": manifest.version,
                    "enabled": false,
                    "compatible": false,
                    "compatibility": entry.verdict(),
                    "source": entry.source(),
                    "hasCompanion": manifest.companion.is_some(),
                    "runnableCount": manifest.runnables.len(),
                    "hookCount": contributes.map_or(0, |value| value.turn_hooks.len()),
                    "hookEventCount": contributes.map_or(0, |value| value.hook_events.len()),
                })
            }));
            plugins
        };

        let (hooks, hook_events) = {
            let manifests = self.state.app_manifests.read().await;
            let mut hooks = Vec::new();
            let mut hook_events = Vec::new();
            for manifest in manifests.iter() {
                let enabled = enabled_ids.contains(&manifest.id);
                let Some(contributes) = manifest.contributes.as_ref() else {
                    continue;
                };
                hooks.extend(contributes.turn_hooks.iter().map(|hook| {
                    json!({
                        "pluginId": manifest.id,
                        "hookId": hook.id,
                        "on": hook.on,
                        "priority": hook.priority,
                        "enabled": enabled,
                    })
                }));
                hook_events.extend(contributes.hook_events.iter().map(|event| {
                    json!({
                        "pluginId": manifest.id,
                        "id": event.id,
                        "title": event.title,
                        "description": event.description,
                        "payloadExample": event.payload_example,
                        "enabled": enabled,
                    })
                }));
            }

            let incompatible = self.state.incompatible_manifests.read().await;
            for entry in incompatible.iter() {
                let manifest = entry.for_catalog();
                let Some(contributes) = manifest.contributes.as_ref() else {
                    continue;
                };
                hooks.extend(contributes.turn_hooks.iter().map(|hook| {
                    json!({
                        "pluginId": manifest.id,
                        "hookId": hook.id,
                        "on": hook.on,
                        "priority": hook.priority,
                        "enabled": false,
                    })
                }));
                hook_events.extend(contributes.hook_events.iter().map(|event| {
                    json!({
                        "pluginId": manifest.id,
                        "id": event.id,
                        "title": event.title,
                        "description": event.description,
                        "payloadExample": event.payload_example,
                        "enabled": false,
                    })
                }));
            }
            (hooks, hook_events)
        };

        ok(json!({
            "version": 1,
            "current": current,
            "providers": providers,
            "agents": agents,
            "plugins": plugins,
            "hooks": hooks,
            "hookEvents": hook_events,
            "thinkingLevels": raw_catalog.get("thinkingLevels").cloned().unwrap_or_else(|| json!([])),
            "apiTypes": raw_catalog.get("apiTypes").cloned().unwrap_or_else(|| json!([])),
        }))
    }

    /// Discover models for one provider through Core's existing server-side
    /// resolver. BYOK keys and subscription OAuth material stay in Core; only
    /// model ids/labels cross the app boundary.
    pub(super) async fn catalog_models(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_CATALOG) {
            return err(format!(
                "capability '{GRANT_CATALOG}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let Some(provider_id) = args
            .get("providerId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return err("host.catalogModels requires a non-empty 'providerId'".to_string());
        };

        let result = crate::pi_config::discover_models(crate::pi_config::DiscoverInput {
            provider: Some(provider_id.to_owned()),
            base_url: None,
            api_key: None,
            api: None,
        })
        .await;
        let source = result
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("fallback");
        let models = result
            .get("models")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        let id = row.get("id").and_then(Value::as_str)?.trim();
                        if id.is_empty() {
                            return None;
                        }
                        let name = row
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty());
                        Some(match name {
                            Some(name) => json!({ "id": id, "name": name }),
                            None => json!({ "id": id }),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        ok(json!({
            "providerId": provider_id,
            "models": models,
            "source": source,
        }))
    }

    /// Resolve the side-model id **and effort**, swappable and never hardcoded
    /// to a remote provider: explicit `model` → the plugin's own
    /// `model_pref_key` → the node-wide default selection → env
    /// `RYU_DEFAULT_LLM_MODEL` → the bundled local default.
    ///
    /// This is the single choke point for every plugin that calls
    /// `host.sideModel` with a `model_pref_key` (advisor, goal, double-check,
    /// proof, security-guidance, auto-expand, …), which is why the node-wide
    /// default only has to be threaded here to reach all of them.
    ///
    /// The preference may hold a full [`crate::agent_selection::AgentSelection`]
    /// or a legacy bare model id; both parse. An effort carried by the
    /// selection is returned alongside and beats the plugin's per-call `effort`
    /// argument only when the plugin passed none (the caller applies that).
    pub(super) async fn resolve_model(
        &self,
        pref_key: Option<&str>,
        explicit: Option<&str>,
    ) -> (String, String) {
        if let Some(m) = explicit {
            let t = m.trim();
            if !t.is_empty() {
                return (t.to_string(), String::new());
            }
        }
        if let Some(key) = pref_key.filter(|k| !k.is_empty()) {
            if let Some(resolved) =
                crate::agent_selection::resolve_side_model(&self.state.preferences, key, None).await
            {
                return (resolved.model, resolved.effort);
            }
        } else if let Some(resolved) = crate::agent_selection::resolve_side_model(
            &self.state.preferences,
            crate::agent_selection::LOCAL_SELECTION_PREF,
            None,
        )
        .await
        {
            // No per-plugin key at all — the node-wide default still applies.
            return (resolved.model, resolved.effort);
        }
        if let Ok(v) = std::env::var("RYU_DEFAULT_LLM_MODEL") {
            if !v.is_empty() {
                return (v, String::new());
            }
        }
        (crate::registry::local_chat_model_id(), String::new())
    }
}
