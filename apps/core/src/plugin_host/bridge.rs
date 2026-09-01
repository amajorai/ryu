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
use crate::workflow::delegation::{
    run_fanout, DelegateSpec, DelegationCaps, PermissionPreset, MAX_DELEGATION_TOKENS,
};

/// Grant required to call `host.sideModel`.
const GRANT_SIDE_MODEL: &str = "hook:side-model";
/// Grant required to read the secret-free runtime catalog. This deliberately
/// shares the existing read-only agent-catalog grant; the projection below
/// never contains credentials, hook code, or provider endpoints.
const GRANT_CATALOG: &str = "core:list_agents";
/// Grant required to call `host.storage.*`.
const GRANT_STORAGE: &str = "storage:kv";
/// Grant required to call `host.crypto_*` (seal/open the plugin's own data under a
/// per-plugin subkey it never holds). See [`PluginHookBridge::crypto`].
const GRANT_CRYPTO: &str = "crypto:seal";
/// Grant required to call `host.runAgent` (spawn a full tool-using sub-agent).
const GRANT_RUN_AGENT: &str = "hook:run-agent";
/// Grant required to call `host.spaces_*` (own Space documents).
const GRANT_SPACES: &str = "spaces:docs";
/// Grant required to call `host.finetune_*` (drive fine-tune runs). Owned by the
/// `@ryu/finetune` app; Core still owns the orchestration + job store, the app
/// reaches it through this governed bridge.
const GRANT_FINETUNE: &str = "finetune:runs";
/// Grant required to call `host.navigate` (ask the host shell to navigate/deep-link).
const GRANT_NAVIGATE: &str = "shell:navigate";
/// Grant required to call `host.setConversationTitle`.
const GRANT_SET_TITLE: &str = "conversation:set-title";
/// Grant required to call `host.getPreference`.
const GRANT_PREFERENCES_READ: &str = "preferences:read";
/// Grant required to list and request stops for Core-visible background processes.
const GRANT_BACKGROUND_CONTROL: &str = "background:control";
/// Grant required to read an agent's normalized subscription usage snapshot.
const GRANT_USAGE_READ: &str = "usage:read";
/// Grant required to call `host.recordFeedback` (the Learning message-action seam).
const GRANT_LEARNING_FEEDBACK: &str = "learning:crud";
/// Grant required to call `host.synthesizeSkill` (the Learning context-menu seam).
const GRANT_LEARNING_SYNTHESIZE: &str = "learning:crud";
/// Grant required to call `host.runHook` — run one of the CALLING plugin's own
/// declared turn hooks on demand. Its own grant, not a reuse of `hook:side-model`
/// or similar: this is the one capability whose effect is "everything that hook is
/// allowed to do", so it has to be approved as its own line in the install dialog.
const GRANT_RUN_SELF_HOOK: &str = "hook:run-self";
/// Grant required to raise one bounded notification for the active user.
const GRANT_NOTIFY: &str = "notifications:send";
/// Grant required to raise one bounded notification for an explicitly selected
/// member. Kept separate from the active-user-only hook notification grant.
const GRANT_NOTIFY_TARGET: &str = "notifications:send-to-user";

const MAX_NOTIFICATION_TITLE_CHARS: usize = 120;
const MAX_NOTIFICATION_BODY_CHARS: usize = 2000;
const MAX_NOTIFICATION_TARGET_CHARS: usize = 256;

fn project_catalog_provider(provider: &Value) -> Value {
    json!({
        "id": provider.get("id").cloned().unwrap_or(Value::Null),
        "label": provider.get("label").cloned().unwrap_or(Value::Null),
        "api": provider.get("api").cloned().unwrap_or(Value::Null),
        "authKind": provider.get("authKind").cloned().unwrap_or(Value::Null),
        "routing": provider.get("routing").cloned().unwrap_or(Value::Null),
        "routingLocked": provider.get("routingLocked").cloned().unwrap_or(Value::Bool(false)),
        "managed": provider.get("managed").cloned().unwrap_or(Value::Bool(false)),
        "configured": provider.get("configured").cloned().unwrap_or(Value::Bool(false)),
        "active": provider.get("active").cloned().unwrap_or(Value::Bool(false)),
        "custom": provider.get("custom").cloned().unwrap_or(Value::Bool(false)),
        "suggestedModels": provider.get("suggestedModels").cloned().unwrap_or_else(|| json!([])),
        "supportsDiscovery": provider.get("supportsDiscovery").cloned().unwrap_or(Value::Bool(false)),
        "modelOverrides": provider.get("modelOverrides").cloned().unwrap_or_else(|| json!({})),
    })
}

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
        "catalog.snapshot" => "host.catalogSnapshot",
        "catalog.models" => "host.catalogModels",
        "model.complete" => "host.sideModel",
        "agent.run" => "host.runAgent",
        "agent.runFanout" => "host.runFanout",
        "storage.get" => "host.storage_get",
        "storage.set" => "host.storage_set",
        "storage.delete" => "host.storage_delete",
        "storage.keys" => "host.storage_keys",
        "storage.compareAndSet" => "host.storage_compare_and_set",
        "crypto.seal" => "host.crypto_seal",
        "crypto.open" => "host.crypto_open",
        "crypto.status" => "host.crypto_status",
        "spaces.ensureSpace" => "host.spaces_ensure_space",
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
        "conversation.setTitle" => "host.setConversationTitle",
        "preferences.get" => "host.getPreference",
        "background.list" => "host.background_list",
        "background.stop" => "host.background_stop",
        "usage.snapshot" => "host.usageSnapshot",
        "learning.recordFeedback" => "host.recordFeedback",
        "learning.synthesizeSkill" => "host.synthesizeSkill",
        "hooks.run" => "host.runHook",
        "notifications.send" => "host.notifications_send",
        _ => return None,
    })
}

/// Hooks currently running through `host.runHook`, keyed `"<plugin>:<hook>"`.
///
/// The re-entrancy guard for [`PluginHookBridge::run_own_hook`]: a hook body that
/// calls `host.runHook` on itself would otherwise spawn sandboxes until the
/// machine gave out, and nothing else in the chain bounds that (the turn loop's
/// own bound is that it fires each hook once per turn).
fn manual_hook_runs() -> &'static std::sync::Mutex<HashSet<String>> {
    static RUNS: std::sync::OnceLock<std::sync::Mutex<HashSet<String>>> =
        std::sync::OnceLock::new();
    RUNS.get_or_init(|| std::sync::Mutex::new(HashSet::new()))
}

/// Claim a manual run slot. `false` when one is already in flight for this key.
/// A poisoned lock resolves to "refuse": failing closed here costs one menu click,
/// while failing open costs the recursion bound this exists to hold.
fn manual_run_begin(key: &str) -> bool {
    manual_hook_runs()
        .lock()
        .map(|mut set| set.insert(key.to_string()))
        .unwrap_or(false)
}

fn manual_run_end(key: &str) {
    if let Ok(mut set) = manual_hook_runs().lock() {
        set.remove(key);
    }
}

/// Bridges sandbox `host.*` calls for one plugin hook run.
pub struct PluginHookBridge {
    plugin_id: String,
    grants: HashSet<String>,
    state: ServerState,
    verified_caller: Option<crate::identity_verify::VerifiedCaller>,
    authorized_conversation_id: Option<String>,
    storage_tenant: Option<String>,
}

impl PluginHookBridge {
    pub fn new(plugin_id: String, grants: HashSet<String>, state: ServerState) -> Self {
        Self::new_for_request(plugin_id, grants, state, None, None)
    }

    pub fn new_for_request(
        plugin_id: String,
        grants: HashSet<String>,
        state: ServerState,
        verified_caller: Option<crate::identity_verify::VerifiedCaller>,
        authorized_conversation_id: Option<String>,
    ) -> Self {
        Self {
            plugin_id,
            grants,
            state,
            verified_caller,
            authorized_conversation_id,
            storage_tenant: None,
        }
    }

    /// Construct a bridge for an authenticated tool dispatch that has a
    /// verified user id but no full JWT caller object. The tenant is used only
    /// to partition plugin KV; it never grants resource access.
    pub fn new_with_tenant(
        plugin_id: String,
        grants: HashSet<String>,
        state: ServerState,
        tenant: Option<String>,
    ) -> Self {
        let mut bridge = Self::new(plugin_id, grants, state);
        bridge.storage_tenant = tenant;
        bridge
    }

    async fn handle_inner(&self, path: String, args: Value) -> InvokeOutcome {
        // The sandbox proxy delivers `host.<method>` as the path.
        let method = path.strip_prefix("host.").unwrap_or(&path);
        match method {
            "catalogSnapshot" => self.catalog_snapshot(args).await,
            "catalogModels" => self.catalog_models(args).await,
            "sideModel" => self.side_model(args).await,
            "runAgent" => self.run_agent(args).await,
            "runFanout" => self.run_fanout(args).await,
            "storage_get"
            | "storage_set"
            | "storage_delete"
            | "storage_keys"
            | "storage_compare_and_set" => self.storage(method, args).await,
            "crypto_seal" | "crypto_open" | "crypto_status" => self.crypto(method, args).await,
            "spaces_ensure_space"
            | "spaces_create_doc"
            | "spaces_get_doc"
            | "spaces_update_doc"
            | "spaces_list_docs"
            | "spaces_delete_doc" => self.spaces(method, args).await,
            "finetune_capability"
            | "finetune_start"
            | "finetune_list"
            | "finetune_get"
            | "finetune_cancel"
            | "finetune_adapters"
            | "finetune_merge" => self.finetune(method, args).await,
            "setConversationTitle" => self.set_conversation_title(args).await,
            "getPreference" => self.get_preference(args).await,
            "background_list" => self.background_list(args).await,
            "background_stop" => self.background_stop(args).await,
            "usageSnapshot" => self.usage_snapshot(args).await,
            "recordFeedback" => self.record_feedback(args).await,
            "synthesizeSkill" => self.synthesize_skill(args).await,
            "runHook" => self.run_own_hook(args).await,
            "notify" => self.notify(args).await,
            "notifications_send" => self.notifications_send(args).await,
            "navigate" => self.navigate(args),
            other => err(format!("unknown host capability '{other}'")),
        }
    }

    /// Return the Ryu-owned runtime catalog used by Companion pickers.
    ///
    /// This is intentionally a projection rather than a serialization of Core's
    /// config. Provider rows keep auth kind, routing, and configuration state,
    /// but drop auth environment names and every
    /// credential. Agent rows drop prompts and persona payloads. Hook rows expose
    /// declarations only — never code or grants — so an app can discover the
    /// shared ecosystem without becoming a privileged plugin host.
    async fn catalog_snapshot(&self, _args: Value) -> InvokeOutcome {
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
    async fn catalog_models(&self, args: Value) -> InvokeOutcome {
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

    /// `host.background.list({ running_only?, producer? })` — return the shared
    /// Core registry projection. The process owner remains responsible for
    /// honoring stop requests; this read is safe for both hooks and apps.
    async fn background_list(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_BACKGROUND_CONTROL) {
            return err(format!(
                "capability '{GRANT_BACKGROUND_CONTROL}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let running_only = args
            .get("running_only")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let producer = args
            .get("producer")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let owner =
            match crate::background_processes::owner_for_caller(self.verified_caller.as_ref()) {
                Ok(owner) => owner,
                Err(error) => return err(error),
            };
        match serde_json::to_value(crate::background_processes::list(
            &owner,
            running_only,
            producer,
        )) {
            Ok(value) => ok(value),
            Err(error) => err(format!("could not list background processes: {error}")),
        }
    }

    /// `host.background.stop({ process_id })` — enqueue a cooperative stop for
    /// the process owner. Core never sends a signal to an arbitrary PID.
    async fn background_stop(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_BACKGROUND_CONTROL) {
            return err(format!(
                "capability '{GRANT_BACKGROUND_CONTROL}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let process_id = args
            .get("process_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if process_id.is_empty() {
            return err("host.background.stop requires a non-empty 'process_id'".to_string());
        }
        let owner =
            match crate::background_processes::owner_for_caller(self.verified_caller.as_ref()) {
                Ok(owner) => owner,
                Err(error) => return err(error),
            };
        match crate::background_processes::request_stop(&owner, process_id) {
            Ok(()) => ok(json!({
                "ok": true,
                "requested": true,
                "process_id": process_id,
            })),
            Err(error) => err(error),
        }
    }

    /// `host.setConversationTitle({ id, title, mode? })` — rename a conversation.
    /// `mode` defaults to `"auto"` (skips when `title_custom`); `"custom"` locks
    /// the title like a manual rename. Titles are sanitized with the same rules
    /// as Core's built-in titler.
    async fn set_conversation_title(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_SET_TITLE) {
            return err(format!(
                "capability '{GRANT_SET_TITLE}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let id = args
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if id.is_empty() {
            return err("host.setConversationTitle requires a non-empty 'id'".to_string());
        }
        let raw = args
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let title = crate::server::auto_title::sanitize_title(raw);
        if title.is_empty() {
            return err("host.setConversationTitle requires a usable 'title'".to_string());
        }
        let mode = args
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .trim();
        match mode {
            "custom" => match self.state.conversations.set_title(id, &title).await {
                Ok(()) => ok(json!({ "ok": true, "title": title, "applied": true })),
                Err(e) => err(e.to_string()),
            },
            "auto" => match self.state.conversations.auto_set_title(id, &title).await {
                Ok(applied) => ok(json!({ "ok": true, "title": title, "applied": applied })),
                Err(e) => err(e.to_string()),
            },
            other => err(format!(
                "host.setConversationTitle mode must be 'auto' or 'custom', got '{other}'"
            )),
        }
    }

    /// `host.getPreference({ key })` — read one preference as a string (or null).
    async fn get_preference(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_PREFERENCES_READ) {
            return err(format!(
                "capability '{GRANT_PREFERENCES_READ}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let key = args
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if key.is_empty() {
            return err("host.getPreference requires a non-empty 'key'".to_string());
        }
        match self.state.preferences.get(key).await {
            Ok(Some(v)) => ok(json!(v)),
            Ok(None) => ok(Value::Null),
            Err(e) => err(e.to_string()),
        }
    }

    /// `host.usageSnapshot({ agent_id })` — read the same normalized, read-only
    /// subscription windows shown in the composer. The credential reader never
    /// refreshes tokens and the snapshot contains no credential material.
    async fn usage_snapshot(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_USAGE_READ) {
            return err(format!(
                "capability '{GRANT_USAGE_READ}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let agent_id = args
            .get("agent_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if agent_id.is_empty() {
            return err("host.usageSnapshot requires a non-empty 'agent_id'".to_string());
        }
        match serde_json::to_value(ryu_usage::fetch_usage(agent_id).await) {
            Ok(snapshot) => ok(snapshot),
            Err(e) => err(e.to_string()),
        }
    }

    /// `host.recordFeedback({ conversation_id, message_id, rating })` — record a
    /// thumbs vote on an assistant turn. `rating` is `"up"` / `"down"` or `null`
    /// (clear). Persists the durable message state, then wraps Core's shared
    /// `crate::learning::apply_message_feedback` fan-out (learning reward +
    /// RAG-memory sinks), the same sink used by the HTTP feedback route.
    async fn record_feedback(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_LEARNING_FEEDBACK) {
            return err(format!(
                "capability '{GRANT_LEARNING_FEEDBACK}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let conversation_id = args
            .get("conversation_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if conversation_id.is_empty() {
            return err("host.recordFeedback requires a non-empty 'conversation_id'".to_string());
        }
        let message_id = args
            .get("message_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if message_id.is_empty() {
            return err("host.recordFeedback requires a non-empty 'message_id'".to_string());
        }
        let rating = match args.get("rating") {
            Some(Value::Null) | None => None,
            Some(v) => v.as_str(),
        };
        match rating {
            Some("up") | Some("down") | None => {}
            Some(other) => {
                return err(format!(
                    "host.recordFeedback rating must be 'up', 'down' or null, got '{other}'"
                ))
            }
        }
        let updated = match self
            .state
            .conversations
            .set_message_feedback(conversation_id, message_id, rating)
            .await
        {
            Ok(updated) => updated,
            Err(error) => {
                return err(format!(
                    "host.recordFeedback could not persist vote: {error}"
                ))
            }
        };
        if !updated {
            return err(format!(
                "host.recordFeedback message '{message_id}' was not found in conversation '{conversation_id}'"
            ));
        }
        let outcome = crate::learning::apply_message_feedback(
            &self.state,
            conversation_id,
            message_id,
            rating,
            None,
        )
        .await;
        ok(json!(outcome))
    }

    /// `host.synthesizeSkill({ conversation_id, force? })` — distill a skill from a
    /// conversation and propose it in the approval inbox. The "make a skill from
    /// this chat" context-menu row dispatches through this verb; it wraps
    /// `ryu_learning::synthesize_skill`, the same logic as the `/api/learn/synthesize`
    /// route. No caller identity travels on the host bridge (the shell holds the
    /// node token), so `requested_by` is `None`; the force/consent semantics are
    /// identical to the HTTP route.
    async fn synthesize_skill(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_LEARNING_SYNTHESIZE) {
            return err(format!(
                "capability '{GRANT_LEARNING_SYNTHESIZE}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let cid = args
            .get("conversation_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if cid.is_empty() {
            return err("host.synthesizeSkill requires a non-empty 'conversation_id'".to_string());
        }
        let force = args.get("force").and_then(Value::as_bool).unwrap_or(false);
        match ryu_learning::synthesize_skill(
            &crate::learning::learning_ctx(&self.state),
            cid,
            force,
            None,
        )
        .await
        {
            Ok(outcome) => ok(json!(outcome)),
            Err(e) => err(e.to_string()),
        }
    }

    /// `host.runHook({ hook_id, conversation_id, event? })` — run ONE of the
    /// calling plugin's own declared turn hooks, now, outside the turn loop.
    ///
    /// This is what lets an app whose entire behaviour is a hook be triggered by
    /// the user. A contributed context-menu row can only dispatch a HOST
    /// capability, so before this a plugin like `@ryu/chat-title` — which renames
    /// chats from a `post_assistant_turn` hook — had no way to offer "rename this
    /// one now": the shell would have had to hardcode the feature, which is the
    /// arrangement the contribution system exists to remove.
    ///
    /// Three properties make it safe to expose:
    ///
    /// * **Own hooks only.** `self.plugin_id` comes from the bridge (the HTTP relay
    ///   takes it from the PATH, never the body), and the lookup filters on it, so
    ///   a plugin cannot run another plugin's hook or borrow its grants.
    /// * **No privilege gain.** The hook runs with the grants it already has —
    ///   `run_hook` builds its bridge from `hook.grants`. The capability adds a
    ///   TRIGGER, not an authority.
    /// * **No recursion.** A hook that calls `host.runHook` on itself would spawn
    ///   sandboxes without bound, so a re-entrancy set refuses a manual run of a
    ///   hook already running manually.
    ///
    /// `event` is merged into `ctx.event` as `{ source: "manual", ... }`, which is
    /// how a hook tells a user-forced run from its scheduled one (e.g. skipping its
    /// own "only every N turns" gate).
    async fn run_own_hook(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_RUN_SELF_HOOK) {
            return err(format!(
                "capability '{GRANT_RUN_SELF_HOOK}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let hook_id = args
            .get("hook_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if hook_id.is_empty() {
            return err("host.runHook requires a non-empty 'hook_id'".to_string());
        }
        let conversation_id = args
            .get("conversation_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if conversation_id.is_empty() {
            return err("host.runHook requires a non-empty 'conversation_id'".to_string());
        }
        let Some(caller) = self.verified_caller.as_ref() else {
            return err(
                "host.runHook requires a verified user caller; node-token-only requests are denied"
                    .to_string(),
            );
        };
        if self.authorized_conversation_id.as_deref() != Some(conversation_id.as_str()) {
            return err(
                "host.runHook conversation_id is not the conversation authorized for this request"
                    .to_string(),
            );
        }
        if let Err(response) = crate::server::require_conversation_read_by_id(
            &self.state,
            &Some(caller.clone()),
            &conversation_id,
        )
        .await
        {
            return err(format!(
                "host.runHook conversation is not authorized (HTTP {})",
                response.status()
            ));
        }

        let hooks = crate::plugin_host::collect_enabled_hooks(&self.state).await;
        let Some(hook) = hooks
            .into_iter()
            .find(|h| h.plugin_id == self.plugin_id && h.hook_id == hook_id)
        else {
            // Also the disabled case: `collect_enabled_hooks` only returns hooks of
            // enabled plugins, so "not found" and "not enabled" are one message.
            return err(format!(
                "plugin '{}' declares no enabled hook '{hook_id}'",
                self.plugin_id
            ));
        };

        let key = format!("{}:{hook_id}", self.plugin_id);
        if !manual_run_begin(&key) {
            return err(format!("hook '{hook_id}' is already running"));
        }

        // Build the same shape the turn loop passes, from the persisted transcript.
        const MAX_TRANSCRIPT: usize = 20;
        let transcript = match self
            .state
            .conversations
            .get_active_messages(&conversation_id)
            .await
        {
            Ok(msgs) => {
                let skip = msgs.len().saturating_sub(MAX_TRANSCRIPT);
                msgs.into_iter()
                    .skip(skip)
                    .map(|m| crate::plugin_host::HookMessage {
                        role: m.role,
                        content: m.content,
                    })
                    .collect()
            }
            Err(e) => {
                manual_run_end(&key);
                return err(format!("host.runHook could not load the transcript: {e}"));
            }
        };
        let mut event = match args.get("event") {
            Some(Value::Object(map)) => map.clone(),
            _ => serde_json::Map::new(),
        };
        event.insert("source".to_string(), json!("manual"));
        let ctx = crate::plugin_host::HookContext {
            conversation_id: Some(conversation_id),
            transcript,
            event: Some(Value::Object(event)),
            ..Default::default()
        };
        let directive = crate::plugin_host::run_hook(&self.state, &hook, &ctx).await;
        manual_run_end(&key);
        // A hook that returns `None` decided to do nothing — its gate did not
        // match, its model returned nothing, its write failed. Reporting that as
        // success is how a menu row ends up toasting "Renamed" over a chat whose
        // title never changed, so the no-op is an error here and the caller's
        // `error` copy is what the user sees. A hook that wants to report success
        // returns a `Note`, whose text becomes the result.
        match directive {
            crate::plugin_host::HookDirective::None => err(format!(
                "hook '{hook_id}' made no change (it declined to act, or its work failed)"
            )),
            other => ok(json!({
                "ran": true,
                "message": match &other {
                    crate::plugin_host::HookDirective::Note { text }
                    | crate::plugin_host::HookDirective::Continue { text } => text.clone(),
                    _ => String::new(),
                },
            })),
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
            kind: crate::events::NavigationKind::Tab,
            force_new: false,
            // A personal node has one trusted operator, so preserve the original
            // broadcast behavior. Shared nodes must address the verified caller;
            // otherwise one app click would navigate every connected teammate.
            target_user_id: crate::server::node_org_id()
                .is_some()
                .then(|| {
                    self.verified_caller
                        .as_ref()
                        .map(|caller| caller.user_id.clone())
                })
                .flatten(),
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
            caps.max_tokens = mt.min(u64::from(MAX_DELEGATION_TOKENS)) as u32;
        }

        let spec = DelegateSpec {
            id: "proof".to_string(),
            task: task.to_string(),
            agent_id,
            preset,
            inline: None,
        };
        // depth = 1: a top-level delegation launched from the chat path.
        let result = if preset.allows_mutation() {
            run_fanout(vec![spec], caps, 1, None).await
        } else {
            crate::workflow::delegation::run_read_only_fanout(vec![spec], caps, 1, None).await
        };
        match result {
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

    /// `host.runFanout({ delegates, caps? })` — run a bounded set of independent
    /// clean-context delegates concurrently through Core's workflow engine. This
    /// is deliberately generic: plugins submit data, while delegation policy and
    /// Gateway routing remain owned by Core.
    async fn run_fanout(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_RUN_AGENT) {
            return err(format!(
                "capability '{GRANT_RUN_AGENT}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let raw_delegates = match args.get("delegates") {
            Some(Value::Array(items)) if !items.is_empty() => items,
            _ => return err("host.runFanout requires a non-empty 'delegates' array".to_string()),
        };
        if raw_delegates.len() > 20 {
            return err("host.runFanout accepts at most 20 delegates".to_string());
        }
        let delegates: Vec<DelegateSpec> = match raw_delegates
            .iter()
            .cloned()
            .map(serde_json::from_value)
            .collect::<Result<_, _>>()
        {
            Ok(value) => value,
            Err(e) => return err(format!("host.runFanout has an invalid delegate: {e}")),
        };
        let mut ids = HashSet::new();
        for delegate in &delegates {
            if delegate.id.trim().is_empty() || delegate.task.trim().is_empty() {
                return err(
                    "host.runFanout delegates require non-empty 'id' and 'task'".to_string()
                );
            }
            if !ids.insert(delegate.id.clone()) {
                return err(format!(
                    "host.runFanout duplicate delegate id '{}'",
                    delegate.id
                ));
            }
            if let Some(inline) = &delegate.inline {
                if inline.system_prompt.trim().is_empty() {
                    return err("host.runFanout inline system_prompt must be non-empty".to_string());
                }
            }
        }
        let mut caps = match args.get("caps").cloned() {
            Some(value) => match serde_json::from_value::<DelegationCaps>(value) {
                Ok(caps) => caps,
                Err(e) => return err(format!("host.runFanout has invalid caps: {e}")),
            },
            None => DelegationCaps::default(),
        };
        caps.max_concurrent = caps.effective_concurrency();
        caps.wall_time_secs = caps.wall_time_secs.clamp(5, 600);
        caps.max_tokens = caps.effective_max_tokens();
        let read_only = delegates
            .iter()
            .all(|delegate| !delegate.preset.allows_mutation());
        let result = if read_only {
            crate::workflow::delegation::run_read_only_fanout(delegates, caps, 1, None).await
        } else {
            run_fanout(delegates, caps, 1, None).await
        };
        match result {
            Ok(results) => ok(json!({
                "ok": true,
                "count": results.len(),
                "results": results,
            })),
            Err(e) => err(e.to_string()),
        }
    }

    /// `host.notify({ title, body })` — deliver one bounded, informational
    /// notification for the active user through Core's shared inbox/toast/push
    /// fan-out. This is intentionally not an app-host RPC or an external-target
    /// alert primitive: a plugin cannot choose a recipient, channel, or level.
    async fn notify(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_NOTIFY) {
            return err(format!(
                "capability '{GRANT_NOTIFY}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let title = bounded_notification_text(
            args.get("title").and_then(Value::as_str),
            MAX_NOTIFICATION_TITLE_CHARS,
        );
        if title.is_empty() {
            return err("host.notify requires a usable 'title'".to_string());
        }
        let body = bounded_notification_text(
            args.get("body").and_then(Value::as_str),
            MAX_NOTIFICATION_BODY_CHARS,
        );
        let Some(store) = crate::notify::global_store() else {
            return err("host.notify unavailable: notification store is not ready".to_string());
        };
        let active_user_id = crate::auth::load_accounts().active_user_id;
        let user_id = self
            .verified_caller
            .as_ref()
            .map(|caller| caller.user_id.clone())
            .or_else(|| self.storage_tenant.clone())
            .or(active_user_id);
        let Some(user_id) = user_id else {
            return err("host.notify unavailable: no active user".to_string());
        };
        match crate::notify::deliver_app_notification(
            &store,
            &self.plugin_id,
            &user_id,
            &title,
            &body,
            "info",
        )
        .await
        {
            Ok(notification_id) => {
                ok(json!({ "queued": true, "notification_id": notification_id }))
            }
            Err(error) => err(format!("host.notify failed: {error}")),
        }
    }

    /// `host.notifications_send({ target_user_id, title, body })` — deliver one
    /// bounded informational notification to a member in the node's resolved
    /// organization/team scope. This is the Inbox app's explicit-recipient
    /// bridge; the older `host.notify` path remains active-user-only.
    async fn notifications_send(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_NOTIFY_TARGET) {
            return err(format!(
                "capability '{GRANT_NOTIFY_TARGET}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        if self
            .verified_caller
            .as_ref()
            .and_then(|caller| caller.org_id.as_ref())
            .is_none()
        {
            return err(
                "targeted notifications require a verified organization caller".to_string(),
            );
        }
        let target_user_id = bounded_notification_text(
            args.get("target_user_id").and_then(Value::as_str),
            MAX_NOTIFICATION_TARGET_CHARS,
        );
        if target_user_id.is_empty() {
            return err("host.notifications_send requires a usable 'target_user_id'".to_string());
        }
        let title = bounded_notification_text(
            args.get("title").and_then(Value::as_str),
            MAX_NOTIFICATION_TITLE_CHARS,
        );
        if title.is_empty() {
            return err("host.notifications_send requires a usable 'title'".to_string());
        }
        let body = bounded_notification_text(
            args.get("body").and_then(Value::as_str),
            MAX_NOTIFICATION_BODY_CHARS,
        );
        let members =
            match crate::sidecar::control_plane::resolve_notify_targets(&self.state.client, None)
                .await
            {
                Ok(members) => members,
                Err(error) => {
                    return err(format!(
                        "host.notifications_send could not resolve the recipient roster: {error}"
                    ));
                }
            };
        if !members
            .iter()
            .any(|member| member.user_id == target_user_id)
        {
            return err(
                "notification recipient is not in the resolved organization/team".to_string(),
            );
        }
        let Some(store) = crate::notify::global_store() else {
            return err(
                "host.notifications_send unavailable: notification store is not ready".to_string(),
            );
        };
        match crate::notify::deliver_app_notification(
            &store,
            &self.plugin_id,
            &target_user_id,
            &title,
            &body,
            "info",
        )
        .await
        {
            Ok(notification_id) => ok(json!({
                "notification_id": notification_id,
                "target_user_id": target_user_id,
            })),
            Err(error) => err(format!("host.notifications_send failed: {error}")),
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
        let provider = args
            .get("provider")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let pref_key = args.get("model_pref_key").and_then(Value::as_str);
        let effort = args.get("effort").and_then(Value::as_str).unwrap_or("");
        let (model, selection_effort) = self.resolve_model(pref_key, explicit).await;
        // The plugin's per-call `effort` is its own considered choice (the
        // advisor asks for "high", auto-expand for "low"), so it wins; the
        // configured selection's effort fills in only when the plugin passed none.
        let effort = if effort.trim().is_empty() {
            selection_effort.as_str()
        } else {
            effort
        };
        match crate::server::call_side_model_with_provider(
            &self.state,
            &model,
            provider,
            effort,
            system,
            prompt,
        )
        .await
        {
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
        let namespace = self.storage_namespace(namespace);
        let key = args.get("key").and_then(Value::as_str).unwrap_or_default();

        match method {
            "storage_get" => match store.get(&self.plugin_id, &namespace, key).await {
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
                match store.set(&self.plugin_id, &namespace, key, value).await {
                    Ok(()) => ok(json!(true)),
                    Err(e) => err(e.to_string()),
                }
            }
            "storage_delete" => match store.delete(&self.plugin_id, &namespace, key).await {
                Ok(()) => ok(json!(true)),
                Err(e) => err(e.to_string()),
            },
            "storage_keys" => match store.keys(&self.plugin_id, &namespace).await {
                Ok(keys) => ok(json!(keys)),
                Err(e) => err(e.to_string()),
            },
            "storage_compare_and_set" => {
                let expected = args.get("expected").and_then(Value::as_str);
                let value = args.get("value").and_then(Value::as_str);
                match store
                    .compare_and_set(&self.plugin_id, &namespace, key, expected, value)
                    .await
                {
                    Ok(changed) => ok(json!(changed)),
                    Err(e) => err(e.to_string()),
                }
            }
            _ => err(format!("unknown storage method '{method}'")),
        }
    }

    fn storage_namespace(&self, namespace: &str) -> String {
        let tenant = self.storage_tenant.as_deref().or_else(|| {
            self.verified_caller
                .as_ref()
                .map(|caller| caller.user_id.as_str())
        });
        super::storage_namespace_for_tenant(tenant, namespace)
    }

    /// `host.crypto_*` — the **sealing primitive**. A plugin encrypts and decrypts
    /// its own data without ever holding, seeing, or naming a key.
    ///
    /// The key is a per-plugin subkey derived from Core's at-rest master key
    /// (`ryu_crypto::plugin_cipher`, HKDF-SHA256 with the plugin id as `info`).
    /// Two properties follow, and both are structural rather than checked:
    ///
    /// * **The key never crosses the sandbox boundary.** Only ciphertext does.
    ///   There is deliberately no `host.crypto_getKey` — a plugin that could read
    ///   the subkey could exfiltrate it, and the whole point is that it cannot.
    /// * **One app cannot open another's ciphertext.** Different id, different
    ///   subkey, so a cross-app open is an AEAD tag failure. `plugin_id` here is
    ///   the bridge's path-bound owner id (the same property `spaces` relies on),
    ///   so a frame cannot spoof its way into another app's data.
    ///
    /// The id is canonicalized before derivation: ids were rescoped to
    /// `@scope/name` with legacy aliases still accepted at the outside edge, and
    /// deriving from a legacy id here would silently produce a *different* subkey,
    /// making everything the app had already sealed unopenable.
    ///
    /// **Guarantee, stated honestly:** this is at-rest sealing. Custody is
    /// env → OS keychain → file fallback, which defends against a stolen disk or a
    /// copied `~/.ryu`, NOT against a compromised running Core (which must hold the
    /// key to function). `crypto_status` exists so an app can surface which custody
    /// is actually live before it stores anything. Note also that there is no rekey
    /// path anywhere in the crate: rotating the master key orphans sealed data.
    async fn crypto(&self, method: &str, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_CRYPTO) {
            return err(format!(
                "capability '{GRANT_CRYPTO}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        // Canonicalize at the ONE derivation site. See the doc comment above: a
        // legacy id here yields a different subkey and orphans existing ciphertext.
        let canonical = crate::plugin_manifest::canonical_plugin_id(&self.plugin_id);
        let cipher = match ryu_crypto::plugin_cipher(canonical) {
            Ok(c) => c,
            Err(e) => return err(format!("crypto is unavailable: {e}")),
        };

        match method {
            "crypto_seal" => {
                let Some(plaintext) = args.get("value").and_then(Value::as_str) else {
                    return err("host.crypto.seal requires a string { value }".to_string());
                };
                match cipher.seal(plaintext) {
                    Ok(sealed) => ok(json!(sealed)),
                    Err(e) => err(e.to_string()),
                }
            }
            "crypto_open" => {
                let Some(stored) = args.get("value").and_then(Value::as_str) else {
                    return err("host.crypto.open requires a string { value }".to_string());
                };
                match cipher.open(stored) {
                    Ok(plain) => ok(json!(plain)),
                    // The message deliberately does NOT echo the input: a failed
                    // open is usually another app's ciphertext, and reflecting it
                    // back would leak across the boundary the subkey exists to hold.
                    Err(e) => err(format!("could not open sealed value: {e}")),
                }
            }
            // Non-secret custody description, so an app can tell the user which
            // guarantee is live. `KeyCustody` is built to carry no key material —
            // not the key, not a prefix, not a hash — so it is safe to hand to a
            // sandboxed frame verbatim. `key_custody` itself gates `key_file` to
            // the `File` source (it is `None` for env/keychain), so the path is
            // disclosed only in the case where the key sits next to the data it
            // protects and the user genuinely needs to know.
            "crypto_status" => match ryu_crypto::key_custody() {
                Ok(c) => ok(json!({
                    "source": c.source.as_str(),
                    "keychain_service": c.keychain_service,
                    "keychain_account": c.keychain_account,
                    "key_file": c.key_file.map(|p| p.display().to_string()),
                    // The weaker-than-keychain case, named plainly so a UI does not
                    // have to re-derive the judgement from `source`.
                    "key_beside_data": matches!(c.source, ryu_crypto::MasterKeySource::File),
                })),
                Err(e) => err(format!("crypto status unavailable: {e}")),
            },
            _ => err(format!("unknown crypto method '{method}'")),
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
        let owner = self.verified_caller.as_ref().map_or_else(
            crate::server::spaces::background_owner,
            |_| {
                crate::server::spaces::owner_of(&crate::server::caller_tenancy(
                    &self.verified_caller,
                ))
            },
        );
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
            // `host.spaces.ensureSpace({ name, description? })` — resolve a Space by
            // NAME, creating it if absent, and return its id.
            //
            // Without this the rest of this facade is unreachable from a turn hook:
            // every other method needs a `space_id`, ids are uuids, and a sandboxed
            // hook has no route parameter to read one from. The name is the caller's
            // argument (never a constant in Core) so this stays a generic seam rather
            // than one plugin's Space wired into the kernel.
            "spaces_ensure_space" => {
                let name = args
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim();
                if name.is_empty() {
                    return err("host.spaces.ensureSpace requires a non-empty 'name'".to_string());
                }
                let description = args
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                match store.ensure_named_space(name, description, &owner).await {
                    Ok(id) => ok(json!(id)),
                    Err(e) => err(e.to_string()),
                }
            }
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
                    .app_create_doc(&self.plugin_id, space_id, title, &owner)
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

    /// `host.finetune_*` — the `@ryu/finetune` app drives fine-tune runs. The
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
    async fn resolve_model(
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
        (
            crate::registry::DEFAULT_LOCAL_CHAT_MODEL_ID.to_string(),
            String::new(),
        )
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

fn bounded_notification_text(value: Option<&str>, max_chars: usize) -> String {
    value
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_string()
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
        assert_eq!(GRANT_CATALOG, "core:list_agents");
        assert_eq!(GRANT_SIDE_MODEL, "hook:side-model");
        assert_eq!(GRANT_STORAGE, "storage:kv");
        assert_eq!(GRANT_RUN_AGENT, "hook:run-agent");
        assert_eq!(GRANT_SPACES, "spaces:docs");
        assert_eq!(GRANT_FINETUNE, "finetune:runs");
        assert_eq!(GRANT_SET_TITLE, "conversation:set-title");
        assert_eq!(GRANT_PREFERENCES_READ, "preferences:read");
        assert_eq!(GRANT_BACKGROUND_CONTROL, "background:control");
        assert_eq!(GRANT_NOTIFY, "notifications:send");
        assert_eq!(GRANT_NOTIFY_TARGET, "notifications:send-to-user");
    }

    #[test]
    fn catalog_provider_projection_never_exposes_account_identity() {
        let projected = project_catalog_provider(&json!({
            "id": "openai",
            "label": "OpenAI",
            "accounts": [{
                "accountId": "personal",
                "label": "person@example.com",
                "kind": "oauth",
                "active": true,
                "updatedAt": 123,
            }],
        }));
        assert_eq!(projected.get("id").and_then(Value::as_str), Some("openai"));
        assert!(projected.get("accounts").is_none());
        assert!(!projected.to_string().contains("person@example.com"));
    }

    #[test]
    fn fanout_token_cap_is_hard_bounded() {
        let caps = DelegationCaps {
            max_tokens: u32::MAX,
            ..Default::default()
        };
        assert_eq!(caps.effective_max_tokens(), MAX_DELEGATION_TOKENS);
        assert_eq!(DelegationCaps::default().effective_max_tokens(), 4096);
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
        assert_eq!(grant_for("catalog.snapshot"), Some(GRANT_CATALOG));
        assert_eq!(grant_for("catalog.models"), Some(GRANT_CATALOG));
        assert_eq!(grant_for("model.complete"), Some(GRANT_SIDE_MODEL));
        assert_eq!(grant_for("agent.run"), Some(GRANT_RUN_AGENT));
        assert_eq!(grant_for("storage.get"), Some(GRANT_STORAGE));
        assert_eq!(grant_for("spaces.createDoc"), Some(GRANT_SPACES));
        assert_eq!(grant_for("finetune.start"), Some(GRANT_FINETUNE));
        assert_eq!(grant_for("conversation.setTitle"), Some(GRANT_SET_TITLE));
        assert_eq!(grant_for("preferences.get"), Some(GRANT_PREFERENCES_READ));
        assert_eq!(grant_for("background.list"), Some(GRANT_BACKGROUND_CONTROL));
        assert_eq!(grant_for("notifications.send"), Some(GRANT_NOTIFY_TARGET));
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
            "catalog.snapshot",
            "catalog.models",
            "model.complete",
            "agent.run",
            "agent.runFanout",
            "storage.get",
            "spaces.createDoc",
            "finetune.start",
            "conversation.setTitle",
            "preferences.get",
            "background.list",
            "background.stop",
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
            "catalogSnapshot"
                | "catalogModels"
                | "sideModel"
                | "runAgent"
                | "runFanout"
                | "storage_get"
                | "storage_set"
                | "storage_delete"
                | "storage_keys"
                | "storage_compare_and_set"
                | "crypto_seal"
                | "crypto_open"
                | "crypto_status"
                | "spaces_ensure_space"
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
                | "setConversationTitle"
                | "getPreference"
                | "usageSnapshot"
                | "background_list"
                | "background_stop"
                | "recordFeedback"
                | "synthesizeSkill"
                | "runHook"
                | "notify"
                | "notifications_send"
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

    #[test]
    fn notification_text_is_control_free_and_bounded() {
        assert_eq!(
            bounded_notification_text(Some(" \u{0000}ready\n "), 20),
            "ready"
        );
        assert_eq!(bounded_notification_text(Some("abcdef"), 3), "abc");
        assert_eq!(bounded_notification_text(Some("\u{0001}\u{0002}"), 20), "");
    }

    #[test]
    fn notification_grants_keep_active_and_targeted_paths_separate() {
        let g = grants(&["hook:run-agent"]);
        assert!(!g.contains(GRANT_NOTIFY));
        let g = grants(&[GRANT_NOTIFY]);
        assert!(g.contains(GRANT_NOTIFY));
        assert!(!g.contains(GRANT_NOTIFY_TARGET));
        let g = grants(&[GRANT_NOTIFY_TARGET]);
        assert!(g.contains(GRANT_NOTIFY_TARGET));
        assert!(!g.contains(GRANT_NOTIFY));
        assert_eq!(
            dispatch_path_for("notifications.send"),
            Some("host.notifications_send")
        );
    }

    #[test]
    fn targeted_notification_has_a_dedicated_dispatch_path() {
        assert_eq!(
            dispatch_path_for("notifications.send"),
            Some("host.notifications_send")
        );
    }

    /// The sealing key is derived from the CANONICAL plugin id, so canonicalization
    /// must be total and idempotent. If it ever stopped being either, the subkey
    /// would change and every value the plugin had already sealed would become
    /// permanently unopenable — with no error louder than an AEAD tag failure.
    /// This pins the exact composition `crypto()` performs.
    #[test]
    fn crypto_derives_from_a_stable_canonical_id() {
        use crate::plugin_manifest::canonical_plugin_id;

        // Idempotent: canonicalizing an already-canonical id is a no-op, so a
        // double-canonicalized call site cannot drift from a single one.
        for id in ["@ryu/goal", "@acme/thing", "unscoped-third-party"] {
            assert_eq!(
                canonical_plugin_id(canonical_plugin_id(id)),
                canonical_plugin_id(id)
            );
        }

        // A legacy (pre-scoping) id and its canonical form must land on the SAME
        // key, or upgrading a built-in orphans its sealed data.
        let legacy = canonical_plugin_id("goal");
        let scoped = canonical_plugin_id("@ryu/goal");
        assert_eq!(
            legacy, scoped,
            "legacy id must canonicalize onto the scoped id"
        );
    }

    /// End-to-end through the real primitive with the real canonicalization: seal
    /// round-trips, a DIFFERENT plugin cannot open it, and a master-key envelope is
    /// refused rather than decrypted (no decryption oracle behind the grant).
    #[test]
    fn crypto_seals_round_trips_and_isolates_by_plugin() {
        use crate::plugin_manifest::canonical_plugin_id;

        // A unit test has no booted Core, so the crypto host seam is empty and every
        // key lookup fails. Install a throwaway one and pin the key via the env
        // rung of the custody ladder, so the test never touches the real keychain
        // or `~/.ryu`. Both installs are idempotent `OnceLock`s: if the full-suite
        // run already initialised them, the existing key is used instead — which is
        // fine, because nothing below asserts on the key's VALUE, only on the
        // seal/open algebra.
        struct TestCryptoHost(std::path::PathBuf);
        impl ryu_crypto::CryptoHost for TestCryptoHost {
            fn keyring_account_suffix(&self) -> String {
                "-bridge-test".to_string()
            }
            fn ryu_dir(&self) -> std::path::PathBuf {
                self.0.clone()
            }
        }
        // BASE64 of 32 zero bytes. It must be base64, not hex: a value that fails
        // to decode is WARNED AND IGNORED, and the ladder falls through to the real
        // OS keychain — which is both a slow test and one that touches the
        // developer's actual keychain. (This test did exactly that until the key
        // was fixed; the tell was a 46-second unit test.)
        std::env::set_var(
            "RYU_MASTER_KEY",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        );
        ryu_crypto::set_global_host(std::sync::Arc::new(TestCryptoHost(
            std::env::temp_dir().join("ryu-bridge-crypto-test"),
        )));

        // No skip branch: an error here is a real failure, not an environment
        // quirk. An earlier version returned early and the test passed while
        // asserting nothing.
        let mine = ryu_crypto::plugin_cipher(canonical_plugin_id("@ryu/goal"))
            .expect("plugin cipher for @ryu/goal");
        let sealed = mine.seal("hunter2").expect("seal");
        assert!(
            sealed.starts_with("encp:v1:"),
            "own envelope, not the master one"
        );
        assert_eq!(mine.open(&sealed).expect("open"), "hunter2");

        let theirs = ryu_crypto::plugin_cipher(canonical_plugin_id("@acme/other")).expect("cipher");
        assert!(
            theirs.open(&sealed).is_err(),
            "another app must not open it"
        );

        // Master-key ciphertext is REFUSED, not decrypted. This is what keeps the
        // grant from being a general decryption oracle over anything the app can read.
        assert!(
            mine.open("enc:v1:AAAA").is_err(),
            "master envelope must be refused"
        );

        // Never-sealed values pass through so a store can migrate in place.
        assert_eq!(mine.open("plain").expect("legacy passthrough"), "plain");
    }
}
