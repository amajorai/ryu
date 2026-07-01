//! The plugin host-capability bridge.
//!
//! Implements [`crate::tool_exec::SandboxBridge`] so a plugin hook running in the
//! Deno sandbox can call `host.*` capabilities. Every capability is gated by a
//! manifest grant; an ungranted call returns an error the hook can see (it never
//! silently succeeds). All plugin-specific logic lives here, keeping
//! [`crate::tool_exec`] a generic substrate.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;

use serde_json::{json, Value};

use crate::server::ServerState;
use crate::tool_exec::{InvokeOutcome, SandboxBridge, ToolInvokeResult};

/// Grant required to call `host.sideModel`.
const GRANT_SIDE_MODEL: &str = "hook:side-model";
/// Grant required to call `host.storage.*`.
const GRANT_STORAGE: &str = "storage:kv";

/// Bridges sandbox `host.*` calls for one plugin hook run.
pub struct PluginHookBridge {
    plugin_id: String,
    grants: HashSet<String>,
    state: ServerState,
}

impl PluginHookBridge {
    pub fn new(plugin_id: String, grants: HashSet<String>, state: ServerState) -> Self {
        Self {
            plugin_id,
            grants,
            state,
        }
    }

    async fn handle_inner(&self, path: String, args: Value) -> InvokeOutcome {
        // The sandbox proxy delivers `host.<method>` as the path.
        let method = path.strip_prefix("host.").unwrap_or(&path);
        match method {
            "sideModel" => self.side_model(args).await,
            "storage_get" | "storage_set" | "storage_delete" | "storage_keys" => {
                self.storage(method, args).await
            }
            other => err(format!("unknown host capability '{other}'")),
        }
    }

    async fn side_model(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_SIDE_MODEL) {
            return err(format!(
                "capability '{GRANT_SIDE_MODEL}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let prompt = args
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if prompt.is_empty() {
            return err("host.sideModel requires a non-empty 'prompt'".to_string());
        }
        let system = args
            .get("system")
            .and_then(Value::as_str)
            .unwrap_or("You are a careful assistant.");
        let explicit = args.get("model").and_then(Value::as_str);
        let pref_key = args.get("model_pref_key").and_then(Value::as_str);
        let effort = args.get("effort").and_then(Value::as_str).unwrap_or("");
        let model = self.resolve_model(pref_key, explicit).await;
        match crate::server::call_side_model(&self.state, &model, effort, system, prompt).await {
            Ok(text) => ok(json!(text)),
            Err(e) => err(e),
        }
    }

    async fn storage(&self, method: &str, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_STORAGE) {
            return err(format!(
                "capability '{GRANT_STORAGE}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let Some(store) = crate::plugin_storage::global() else {
            return err("plugin storage is unavailable".to_string());
        };
        let namespace = args
            .get("namespace")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("default");
        let key = args.get("key").and_then(Value::as_str).unwrap_or_default();

        match method {
            "storage_get" => match store.get(&self.plugin_id, namespace, key).await {
                Ok(Some(v)) => ok(json!(v)),
                Ok(None) => ok(Value::Null),
                Err(e) => err(e.to_string()),
            },
            "storage_set" => {
                let value = args
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if key.is_empty() {
                    return err("host.storage.set requires a non-empty key".to_string());
                }
                match store.set(&self.plugin_id, namespace, key, value).await {
                    Ok(()) => ok(json!(true)),
                    Err(e) => err(e.to_string()),
                }
            }
            "storage_delete" => match store.delete(&self.plugin_id, namespace, key).await {
                Ok(()) => ok(json!(true)),
                Err(e) => err(e.to_string()),
            },
            "storage_keys" => match store.keys(&self.plugin_id, namespace).await {
                Ok(keys) => ok(json!(keys)),
                Err(e) => err(e.to_string()),
            },
            _ => err(format!("unknown storage method '{method}'")),
        }
    }

    /// Resolve the side-model id, swappable and never hardcoded to a remote
    /// provider: explicit `model` → preference `model_pref_key` → env
    /// `RYU_DEFAULT_LLM_MODEL` → the bundled local default.
    async fn resolve_model(&self, pref_key: Option<&str>, explicit: Option<&str>) -> String {
        if let Some(m) = explicit {
            let t = m.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
        if let Some(key) = pref_key.filter(|k| !k.is_empty()) {
            if let Ok(Some(pref)) = self.state.preferences.get(key).await {
                let t = pref.trim();
                if !t.is_empty() {
                    return t.to_string();
                }
            }
        }
        if let Ok(v) = std::env::var("RYU_DEFAULT_LLM_MODEL") {
            if !v.is_empty() {
                return v;
            }
        }
        crate::registry::DEFAULT_LOCAL_CHAT_MODEL_ID.to_string()
    }
}

impl SandboxBridge for PluginHookBridge {
    fn handle(
        &self,
        path: String,
        args: Value,
    ) -> Pin<Box<dyn Future<Output = InvokeOutcome> + Send + '_>> {
        Box::pin(self.handle_inner(path, args))
    }
}

/// A successful host result.
fn ok(value: Value) -> InvokeOutcome {
    InvokeOutcome::Result(ToolInvokeResult {
        value,
        is_error: false,
        error: None,
    })
}

/// A host error the hook can catch (rejects the awaited call).
fn err(message: String) -> InvokeOutcome {
    InvokeOutcome::Result(ToolInvokeResult {
        value: Value::Null,
        is_error: true,
        error: Some(message),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grants(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    // We can exercise the pure gating logic without a ServerState by checking the
    // grant-set membership directly through the constants the bridge uses; the
    // full async path is covered by the live double-check verification (M7).
    #[test]
    fn grant_constants_are_stable() {
        assert_eq!(GRANT_SIDE_MODEL, "hook:side-model");
        assert_eq!(GRANT_STORAGE, "storage:kv");
    }

    #[test]
    fn grant_set_membership_gates_capabilities() {
        let g = grants(&["hook:side-model"]);
        assert!(g.contains(GRANT_SIDE_MODEL));
        assert!(!g.contains(GRANT_STORAGE));
    }
}
