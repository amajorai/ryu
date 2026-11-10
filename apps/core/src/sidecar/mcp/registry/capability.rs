//! Capability layer defaults, adapters and verb resolution.
// test-exempt: moved verbatim out of sidecar/mcp/mod.rs; covered by the McpRegistry tests under sidecar/mcp/tests/.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// The user's stored defaults for one verb's canonical arguments, coerced to the
    /// types its schema declares.
    ///
    /// Empty when preferences are not wired (test/CLI contexts) — a layer default is
    /// a convenience, never a precondition, so its absence must never fail a call.
    pub(in crate::sidecar::mcp) async fn layer_defaults(
        &self,
        verb: &capability_tools::Verb,
    ) -> serde_json::Map<String, Value> {
        let mut out = serde_json::Map::new();
        let Some(prefs) = self.preferences.as_ref() else {
            return out;
        };
        for arg in capability_tools::canonical_args(verb) {
            let key = capability_tools::layer_default_key(verb.capability, &arg);
            let Ok(Some(raw)) = prefs.get(&key).await else {
                continue;
            };
            if let Some(value) = capability_tools::coerce_to_schema_type(verb, &arg, &raw) {
                out.insert(arg, value);
            }
        }
        out
    }

    /// A binding's `arg_defaults` with its `pref:` tokens substituted from the
    /// preferences store.
    ///
    /// Falls back to the raw defaults when preferences are not wired (test/CLI): the
    /// token then resolves to nothing and its argument is dropped, which surfaces as
    /// the provider complaining about a missing field rather than as a literal
    /// `"pref:..."` being sent upstream and treated as a real value.
    pub(in crate::sidecar::mcp) async fn resolve_provider_defaults(
        &self,
        binding: &crate::plugin_manifest::CapabilityToolBinding,
    ) -> serde_json::Map<String, Value> {
        let keys = capability_tools::referenced_pref_keys(binding);
        if keys.is_empty() {
            return binding.arg_defaults.clone();
        }
        let mut resolved = std::collections::BTreeMap::new();
        if let Some(prefs) = self.preferences.as_ref() {
            for key in keys {
                if let Ok(Some(value)) = prefs.get(&key).await {
                    resolved.insert(key, value);
                }
            }
        }
        capability_tools::resolve_arg_defaults(binding, &resolved)
    }

    /// Run a provider's capability ADAPTER for one verb: the code path that exists
    /// so a provider whose shape no JSON can express (an async job API that must be
    /// polled, a token vocabulary needing normalization, a body that must read a
    /// resolved `pref:`) stays bindable without growing the shared grammar.
    ///
    /// The adapter is handed the canonical arguments and returns the canonical
    /// result, so the declarative arg/response mapping is deliberately NOT applied
    /// around it — running both would apply the same transformation twice.
    pub(in crate::sidecar::mcp) async fn run_capability_adapter(
        &self,
        tool_id: &str,
        resolved: &capability_tools::ResolvedVerb,
        adapter: &crate::plugin_manifest::CapabilityAdapter,
        provider_defaults: serde_json::Map<String, Value>,
        arguments: Value,
        agent_id: Option<&str>,
        user_id: Option<&str>,
        profile_ids: &[String],
        session_id: Option<String>,
        host_conversation_id: Option<&str>,
    ) -> Result<Value> {
        // Shipping code is a visible, approvable act: the providing plugin must hold
        // `tool:execute`, the same grant an `inline_js` tool is gated on. For a
        // Community-tier provider this reads the Gateway-APPROVED set, not the
        // manifest's self-declaration, so a third party cannot self-authorize.
        let grants = self.provider_grants(&resolved.provider_id).await;
        if !grants.contains(crate::tool_exec::GRANT_TOOL_EXECUTE) {
            return Err(anyhow!(
                "provider '{}' maps '{tool_id}' through an adapter but does not hold the \
                 '{}' grant",
                resolved.provider_id,
                crate::tool_exec::GRANT_TOOL_EXECUTE
            ));
        }
        let Some(registry) = global_registry() else {
            return Err(anyhow!(
                "adapter for '{tool_id}' unavailable: tool registry not initialized"
            ));
        };
        let bridge = std::sync::Arc::new(CapabilityAdapterBridge {
            registry,
            target: resolved.binding.tool.clone(),
            allowed: adapter.tools.iter().cloned().collect(),
            provider_id: resolved.provider_id.clone(),
            agent_id: agent_id.map(str::to_owned),
            user_id: user_id.map(str::to_owned),
            profile_ids: profile_ids.to_vec(),
            session_id,
            host_conversation_id: host_conversation_id.map(str::to_owned),
        });
        let invoker = std::sync::Arc::new(crate::tool_exec::SandboxToolInvoker::bridge(bridge));
        let program = crate::tool_exec::build_capability_adapter_program(
            &arguments,
            &Value::Object(provider_defaults),
            &adapter.code,
        );
        // Deny-all sandbox: an adapter reshapes JSON and calls one tool, so it needs
        // no FS, network or subprocess of its own. Its provider's HTTP egress still
        // happens inside the bound tool, where the Gateway grant governs it — an
        // adapter cannot reach the network directly to route around that.
        //
        // Boxed for the same reason the `inline_js` arm is: the bridge re-enters
        // tool dispatch, so this edge would otherwise make the future infinite-sized.
        let outcome = Box::pin(crate::tool_exec::run_sandboxed(
            program,
            invoker,
            &resolved.provider_id,
        ))
        .await;
        match outcome {
            crate::tool_exec::ExecOutcome::Completed {
                result,
                is_error,
                error,
                ..
            } => {
                if is_error {
                    Err(anyhow!(
                        "adapter for '{tool_id}' (provider '{}') failed: {}",
                        resolved.provider_id,
                        error.unwrap_or_default()
                    ))
                } else {
                    // Stamp the envelope's `provider` exactly as `map_response`
                    // does, so an adapter-backed verb is indistinguishable from a
                    // declaratively-bound one. Leaving it to each adapter to
                    // remember would make the swap observable in the one field that
                    // reports which provider answered.
                    Ok(stamp_provider(
                        result.unwrap_or(Value::Null),
                        &resolved.provider_id,
                    ))
                }
            }
            // An adapter maps one verb; it has no user to elicit from mid-call.
            crate::tool_exec::ExecOutcome::Paused { .. } => Err(anyhow!(
                "adapter for '{tool_id}' paused, which capability verbs do not support"
            )),
        }
    }

    /// The effective grant set of an ENABLED plugin, by id. Mirrors
    /// [`Self::resolve_app_tool_backend`]'s source of truth exactly: the store
    /// record's Gateway-approved grants for a Community-tier plugin, the manifest's
    /// own declaration for a Core-tier one. An unknown or disabled plugin has no
    /// grants, so every grant check over it fails closed.
    async fn provider_grants(&self, plugin_id: &str) -> std::collections::HashSet<String> {
        let empty = std::collections::HashSet::new();
        let (Some(manifests), Some(store)) = (
            self.self_build_manifests.as_ref(),
            self.self_build_app_store.as_ref(),
        ) else {
            return empty;
        };
        let Ok(records) = store.list().await else {
            return empty;
        };
        let Some(record) = records.into_iter().find(|r| r.enabled && r.id == plugin_id) else {
            return empty;
        };
        let guard = manifests.read().await;
        guard
            .iter()
            .find(|m| m.id == plugin_id)
            .map(|m| effective_tool_grants(m, &record.approved_grants))
            .unwrap_or(empty)
    }

    /// Resolve one capability verb id to its bound provider tool, or `None` when no
    /// provider is selected for that capability or the selected one omits the verb.
    pub(in crate::sidecar::mcp) async fn resolve_capability_verb(
        &self,
        tool_id: &str,
    ) -> Option<capability_tools::ResolvedVerb> {
        let tool_id = canonical_tool_id(tool_id);
        self.capability_verbs()
            .await
            .into_iter()
            .find(|r| r.verb.id == tool_id)
    }
}
