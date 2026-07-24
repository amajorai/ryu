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
use crate::workflow::delegation::{run_fanout, DelegateSpec, DelegationCaps, PermissionPreset};

/// Grant required to call `host.sideModel`.
const GRANT_SIDE_MODEL: &str = "hook:side-model";
/// Grant required to call `host.storage.*`.
const GRANT_STORAGE: &str = "storage:kv";
/// Grant required to call `host.runAgent` (spawn a full tool-using sub-agent).
const GRANT_RUN_AGENT: &str = "hook:run-agent";
/// Grant required to call `host.spaces_*` (own Space documents).
const GRANT_SPACES: &str = "spaces:docs";
/// Grant required to call `host.finetune_*` (drive fine-tune runs). Owned by the
/// `com.ryu.finetune` app; Core still owns the orchestration + job store, the app
/// reaches it through this governed bridge.
const GRANT_FINETUNE: &str = "finetune:runs";
/// Grant required to call `host.navigate` (ask the host shell to navigate/deep-link).
const GRANT_NAVIGATE: &str = "shell:navigate";

/// Map a kernel-contracts host-API method name (dotted, e.g. `"model.complete"`,
/// `"storage.get"`, `"spaces.createDoc"`) to the closed `host.<...>` path
/// [`PluginHookBridge::handle`] matches (`handle_inner` strips the `host.` prefix).
/// A method absent here is NOT bridge-dispatchable — the caller can never forward a
/// verbatim path into a different capability namespace.
///
/// This is the SAME set the HTTP app-host relay (`server::plugin_bridge_api`) maps;
/// the extension-host `/api/host/rpc` route reuses THIS one so the node runtime and
/// the iframe host share one dotted→bridge vocabulary. A unit test pins it to the
/// kernel-contracts `grant_for` table so a new bridge method can't silently omit a
/// path here.
pub fn dispatch_path_for(method: &str) -> Option<&'static str> {
    Some(match method {
        "model.complete" => "host.sideModel",
        "agent.run" => "host.runAgent",
        "storage.get" => "host.storage_get",
        "storage.set" => "host.storage_set",
        "storage.delete" => "host.storage_delete",
        "storage.keys" => "host.storage_keys",
        "spaces.createDoc" => "host.spaces_create_doc",
        "spaces.getDoc" => "host.spaces_get_doc",
        "spaces.updateDoc" => "host.spaces_update_doc",
        "spaces.listDocs" => "host.spaces_list_docs",
        "spaces.deleteDoc" => "host.spaces_delete_doc",
        "finetune.capability" => "host.finetune_capability",
        "finetune.start" => "host.finetune_start",
        "finetune.list" => "host.finetune_list",
        "finetune.get" => "host.finetune_get",
        "finetune.cancel" => "host.finetune_cancel",
        "finetune.adapters" => "host.finetune_adapters",
        "finetune.merge" => "host.finetune_merge",
        _ => return None,
    })
}

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
            "runAgent" => self.run_agent(args).await,
            "storage_get" | "storage_set" | "storage_delete" | "storage_keys" => {
                self.storage(method, args).await
            }
            "spaces_create_doc" | "spaces_get_doc" | "spaces_update_doc" | "spaces_list_docs"
            | "spaces_delete_doc" => self.spaces(method, args).await,
            "finetune_capability"
            | "finetune_start"
            | "finetune_list"
            | "finetune_get"
            | "finetune_cancel"
            | "finetune_adapters"
            | "finetune_merge" => self.finetune(method, args).await,
            "navigate" => self.navigate(args),
            other => err(format!("unknown host capability '{other}'")),
        }
    }

    /// `host.runAgent({ task, agent_id?, preset?, wall_time_secs?, max_tokens? })`
    /// — spawn ONE full sub-agent with a clean context (it sees only `task`, never
    /// the parent transcript) and return its final text. Unlike `sideModel` (a
    /// single toolless completion), this routes through the delegation engine
    /// ([`crate::workflow::delegation::run_fanout`]): when `agent_id` names a
    /// configured agent and the agent runner is live, the sub-agent runs the real
    /// chat path — its own engine, tools, MCP, and Gateway routing — so it can
    /// gather actual evidence (read files, run tests, hit endpoints) rather than
    /// guess from the conversation. This is the "proof of work" primitive: an
    /// independent agent that must *prove* a goal was done, not merely judge it.
    /// `host.navigate({ target, params? })` — ask the host shell to navigate or
    /// deep-link on the app's behalf. A sandboxed app UI can't drive the shell
    /// router directly; this grant-gated primitive publishes a [`NavigationRequest`]
    /// that the connected surface consumes over SSE and acts on. Fire-and-forget:
    /// success means "queued", not "the shell navigated" (no surface may be live).
    fn navigate(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_NAVIGATE) {
            return err(format!(
                "capability '{GRANT_NAVIGATE}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let target = args
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if target.is_empty() {
            return err("host.navigate requires a non-empty 'target'".to_string());
        }
        crate::events::publish_navigation(crate::events::NavigationRequest {
            plugin_id: self.plugin_id.clone(),
            target: target.to_string(),
            params: args.get("params").cloned(),
        });
        ok(serde_json::json!({ "queued": true, "target": target }))
    }

    async fn run_agent(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_RUN_AGENT) {
            return err(format!(
                "capability '{GRANT_RUN_AGENT}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let task = args
            .get("task")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if task.is_empty() {
            return err("host.runAgent requires a non-empty 'task'".to_string());
        }
        let agent_id = args
            .get("agent_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let preset = parse_preset(args.get("preset").and_then(Value::as_str));

        // Bound the verifier: clamp the wall time to a sane range so a stuck
        // sub-agent can never wedge the post-turn hook indefinitely.
        let mut caps = DelegationCaps {
            max_concurrent: 1,
            ..DelegationCaps::default()
        };
        if let Some(w) = args.get("wall_time_secs").and_then(Value::as_u64) {
            caps.wall_time_secs = w.clamp(5, 600);
        }
        if let Some(mt) = args.get("max_tokens").and_then(Value::as_u64) {
            caps.max_tokens = mt.min(u64::from(u32::MAX)) as u32;
        }

        let spec = DelegateSpec {
            id: "proof".to_string(),
            task: task.to_string(),
            agent_id,
            preset,
            inline: None,
        };
        // depth = 1: a top-level delegation launched from the chat path.
        match run_fanout(vec![spec], caps, 1, None).await {
            Ok(mut results) => match results.pop() {
                Some(res) => match res.output {
                    Some(out) => ok(json!(out)),
                    None => err(res
                        .error
                        .unwrap_or_else(|| "verifier agent produced no output".to_string())),
                },
                None => err("verifier agent returned no result".to_string()),
            },
            Err(e) => err(e.to_string()),
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

    /// `host.spaces_*` — a full-page Companion app OWNS Space documents: created in
    /// the `documents` table, search-embedded, `[[backlinked]]`, versioned, and
    /// Space-routed, exactly like a built-in page/database/whiteboard. Every doc an
    /// app touches carries `kind = "app:<plugin_id>"`, and the store enforces that
    /// isolation on every read/update/delete, so one app can never reach another's
    /// docs or a built-in doc. `plugin_id` is the bridge's path-bound owner id, so
    /// it cannot be spoofed by the frame.
    async fn spaces(&self, method: &str, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_SPACES) {
            return err(format!(
                "capability '{GRANT_SPACES}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let store = &self.state.spaces;
        let space_id = args
            .get("space_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let doc_id = args
            .get("doc_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();

        match method {
            "spaces_create_doc" => {
                if space_id.is_empty() {
                    return err("host.spaces.createDoc requires a non-empty 'space_id'".to_string());
                }
                let title = args
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Untitled");
                match store
                    .app_create_doc(
                        &self.plugin_id,
                        space_id,
                        title,
                        &crate::server::spaces::background_owner(),
                    )
                    .await
                {
                    Ok(id) => ok(json!(id)),
                    Err(e) => err(e.to_string()),
                }
            }
            "spaces_get_doc" => {
                if doc_id.is_empty() {
                    return err("host.spaces.getDoc requires a non-empty 'doc_id'".to_string());
                }
                match store.app_get_doc(&self.plugin_id, doc_id).await {
                    Ok(Some(doc)) => match serde_json::to_value(doc) {
                        Ok(v) => ok(v),
                        Err(e) => err(e.to_string()),
                    },
                    Ok(None) => ok(Value::Null),
                    Err(e) => err(e.to_string()),
                }
            }
            "spaces_update_doc" => {
                if doc_id.is_empty() {
                    return err("host.spaces.updateDoc requires a non-empty 'doc_id'".to_string());
                }
                let title = args
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let source = args
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match store
                    .app_update_doc(&self.plugin_id, doc_id, title.as_deref(), source)
                    .await
                {
                    Ok(()) => ok(json!(true)),
                    Err(e) => err(e.to_string()),
                }
            }
            "spaces_list_docs" => {
                if space_id.is_empty() {
                    return err("host.spaces.listDocs requires a non-empty 'space_id'".to_string());
                }
                match store.app_list_docs(&self.plugin_id, space_id).await {
                    Ok(docs) => match serde_json::to_value(docs) {
                        Ok(v) => ok(v),
                        Err(e) => err(e.to_string()),
                    },
                    Err(e) => err(e.to_string()),
                }
            }
            "spaces_delete_doc" => {
                if doc_id.is_empty() {
                    return err("host.spaces.deleteDoc requires a non-empty 'doc_id'".to_string());
                }
                match store.app_delete_doc(&self.plugin_id, doc_id).await {
                    Ok(()) => ok(json!(true)),
                    Err(e) => err(e.to_string()),
                }
            }
            _ => err(format!("unknown spaces method '{method}'")),
        }
    }

    /// `host.finetune_*` — the `com.ryu.finetune` app drives fine-tune runs. The
    /// orchestration, GPU gate, durable job store, adapter→GGUF merge, and Python
    /// `unsloth` worker now live OUT-OF-PROCESS in the `ryu-finetune` sidecar; the
    /// app reaches them through this governed bridge (host holds the node token; the
    /// frame never does), which forwards each call to the sidecar over loopback via
    /// [`crate::finetune_client::FinetuneClient`] — the SAME `/api/finetune/*` surface
    /// the sidecar serves publicly, so the two never drift. Live progress is streamed
    /// separately over the plugin-host streaming endpoint (`finetune.stream`), not here.
    async fn finetune(&self, method: &str, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_FINETUNE) {
            return err(format!(
                "capability '{GRANT_FINETUNE}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let ft = &self.state.finetune;
        let id = args
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let result = match method {
            "finetune_capability" => ft.capability().await,
            "finetune_adapters" => ft.adapters().await,
            "finetune_list" => ft.list().await,
            "finetune_start" => ft.start(args).await,
            "finetune_merge" => ft.merge(args).await,
            "finetune_get" => {
                if id.is_empty() {
                    return err("host.finetune.get requires a non-empty 'id'".to_string());
                }
                ft.get(&id).await
            }
            "finetune_cancel" => {
                if id.is_empty() {
                    return err("host.finetune.cancel requires a non-empty 'id'".to_string());
                }
                ft.cancel(&id).await
            }
            _ => return err(format!("unknown finetune method '{method}'")),
        };
        match result {
            Ok(v) => ok(v),
            Err(e) => err(e),
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

/// Map a permission-preset string to the closed [`PermissionPreset`] set. An
/// unknown/absent value falls back to the safest non-trivial preset (read but
/// never mutate) — the right default for an independent verifier.
fn parse_preset(s: Option<&str>) -> PermissionPreset {
    match s.map(str::trim).unwrap_or_default() {
        "research" => PermissionPreset::Research,
        "code_write" => PermissionPreset::CodeWrite,
        "summarise" | "summarize" => PermissionPreset::Summarise,
        _ => PermissionPreset::CodeRead,
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

/// Flatten a `(StatusCode, Value)` error body from a shared finetune value fn into
/// a single message string for the bridge's `err` outcome. Prefers the `error`
/// field the handlers set; falls back to the whole JSON.
fn status_error(body: &Value) -> String {
    body.get("error")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| body.to_string())
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
        assert_eq!(GRANT_RUN_AGENT, "hook:run-agent");
        assert_eq!(GRANT_SPACES, "spaces:docs");
        assert_eq!(GRANT_FINETUNE, "finetune:runs");
    }

    /// The bridge's local grant consts MUST equal the single-sourced grant the
    /// `ryu-kernel-contracts` host-API table assigns to the corresponding method,
    /// so this gate and the TS app host / `required_grant_for` never drift. Each
    /// const family maps to one representative method in the table. (`GRANT_NAVIGATE`
    /// is intentionally absent: `host.navigate` is a broker verb, not an
    /// `/api/plugins/:id/host` RPC method, so it has no row in the table.)
    #[test]
    fn grant_constants_match_kernel_contracts_table() {
        use ryu_kernel_contracts::host_api::grant_for;
        assert_eq!(grant_for("model.complete"), Some(GRANT_SIDE_MODEL));
        assert_eq!(grant_for("agent.run"), Some(GRANT_RUN_AGENT));
        assert_eq!(grant_for("storage.get"), Some(GRANT_STORAGE));
        assert_eq!(grant_for("spaces.createDoc"), Some(GRANT_SPACES));
        assert_eq!(grant_for("finetune.start"), Some(GRANT_FINETUNE));
    }

    /// Every method `dispatch_path_for` maps MUST (a) carry a grant in the
    /// single-sourced kernel-contracts table (so `/api/host/rpc` can always grant-gate
    /// it) and (b) resolve to a `host.*` path the bridge's `handle_inner` actually
    /// matches. The bridge deliberately dispatches a SUBSET of the grant families
    /// (e.g. `agent.cancel` / `*.stream` are not unary-bridged), so we assert the
    /// forward direction — a mapped method is always grantable + handled — rather than
    /// requiring every grant-family method to have a path.
    #[test]
    fn dispatch_paths_are_grantable_and_handled() {
        use ryu_kernel_contracts::host_api::{grant_for, HOST_API_METHODS};
        for m in HOST_API_METHODS {
            let Some(path) = dispatch_path_for(m.method) else {
                continue;
            };
            assert!(
                grant_for(m.method).is_some(),
                "dispatch path for '{}' but no grant in the kernel-contracts table",
                m.method
            );
            let internal = path
                .strip_prefix("host.")
                .expect("dispatch path is host.<...>");
            assert!(
                handled_method(internal),
                "dispatch path '{path}' for '{}' is not matched by the bridge",
                m.method
            );
        }
    }

    /// Positive coverage: every bridge capability family has at least one representative
    /// method that maps, so a family accidentally dropped from `dispatch_path_for` is
    /// caught.
    #[test]
    fn dispatch_path_covers_every_bridge_family() {
        for method in [
            "model.complete",
            "agent.run",
            "storage.get",
            "spaces.createDoc",
            "finetune.start",
        ] {
            assert!(
                dispatch_path_for(method).is_some(),
                "missing dispatch path for representative method '{method}'"
            );
        }
    }

    /// The set of `host.<method>` names `handle_inner` matches (kept in sync with the
    /// `match` in that fn). Used to prove every `dispatch_path_for` target is real.
    fn handled_method(m: &str) -> bool {
        matches!(
            m,
            "sideModel"
                | "runAgent"
                | "storage_get"
                | "storage_set"
                | "storage_delete"
                | "storage_keys"
                | "spaces_create_doc"
                | "spaces_get_doc"
                | "spaces_update_doc"
                | "spaces_list_docs"
                | "spaces_delete_doc"
                | "finetune_capability"
                | "finetune_start"
                | "finetune_list"
                | "finetune_get"
                | "finetune_cancel"
                | "finetune_adapters"
                | "finetune_merge"
                | "navigate"
        )
    }

    #[test]
    fn dispatch_path_rejects_unknown_method() {
        assert_eq!(dispatch_path_for("widget.setState"), None);
        assert_eq!(dispatch_path_for("nonsense.method"), None);
        assert_eq!(dispatch_path_for("model.complete"), Some("host.sideModel"));
    }

    #[test]
    fn finetune_gate_requires_grant() {
        let g = grants(&["spaces:docs"]);
        assert!(!g.contains(GRANT_FINETUNE));
        let g = grants(&["finetune:runs"]);
        assert!(g.contains(GRANT_FINETUNE));
    }

    #[test]
    fn parse_preset_defaults_to_code_read() {
        assert_eq!(parse_preset(None), PermissionPreset::CodeRead);
        assert_eq!(parse_preset(Some("")), PermissionPreset::CodeRead);
        assert_eq!(parse_preset(Some("nonsense")), PermissionPreset::CodeRead);
        assert_eq!(parse_preset(Some("research")), PermissionPreset::Research);
        assert_eq!(
            parse_preset(Some("code_write")),
            PermissionPreset::CodeWrite
        );
        assert_eq!(parse_preset(Some("summarize")), PermissionPreset::Summarise);
    }

    #[test]
    fn run_agent_gate_requires_grant() {
        let g = grants(&["hook:side-model"]);
        assert!(!g.contains(GRANT_RUN_AGENT));
        let g = grants(&["hook:run-agent"]);
        assert!(g.contains(GRANT_RUN_AGENT));
    }

    #[test]
    fn grant_set_membership_gates_capabilities() {
        let g = grants(&["hook:side-model"]);
        assert!(g.contains(GRANT_SIDE_MODEL));
        assert!(!g.contains(GRANT_STORAGE));
    }
}
