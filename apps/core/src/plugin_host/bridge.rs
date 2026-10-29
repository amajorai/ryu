//! The plugin host-capability bridge.
//!
//! Implements [`crate::tool_exec::SandboxBridge`] so a plugin hook running in the
//! JS sandbox can call `host.*` capabilities. Every capability is gated by a
//! manifest grant; an ungranted call returns an error the hook can see (it never
//! silently succeeds). All plugin-specific logic lives here, keeping
//! [`crate::tool_exec`] a generic substrate.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde_json::{json, Value};

use crate::server::ServerState;
use crate::tool_exec::{InvokeOutcome, SandboxBridge, ToolInvokeResult};
use crate::workflow::delegation::{
    run_fanout, DelegateSpec, DelegationCaps, PermissionPreset, MAX_DELEGATION_TOKENS,
};

/// Grant required to call `host.sideModel`.
const GRANT_SIDE_MODEL: &str = "hook:side-model";
/// At most this many images may accompany one `host.sideModel` call.
pub(crate) const MAX_SIDE_MODEL_IMAGES: usize = 8;
/// Combined length of a call's image data URIs. Leaves room under the Gateway's
/// 2 MiB chat body limit for the prompt and system text; the encoded request as
/// a whole is checked against that limit before it is sent
/// ([`crate::server::encode_side_model_request`]).
pub(crate) const MAX_SIDE_MODEL_IMAGE_BYTES: usize = 1536 * 1024;
/// Raster formats every vision-capable provider behind the Gateway accepts.
const SIDE_MODEL_IMAGE_PREFIXES: [&str; 3] = [
    "data:image/png;base64,",
    "data:image/jpeg;base64,",
    "data:image/webp;base64,",
];

/// Validate `host.sideModel`'s optional `images`: at most
/// [`MAX_SIDE_MODEL_IMAGES`] inline `data:image/{png,jpeg,webp};base64` URIs
/// totalling at most [`MAX_SIDE_MODEL_IMAGE_BYTES`]. Inline only, so the
/// Gateway never fetches a plugin-chosen URL on the plugin's behalf.
pub(crate) fn validate_side_model_images(args: &Value) -> Result<Vec<String>, String> {
    use base64::Engine as _;
    let items = match args.get("images") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return Err("host.sideModel 'images' must be an array".to_owned()),
    };
    if items.len() > MAX_SIDE_MODEL_IMAGES {
        return Err(format!(
            "host.sideModel accepts at most {MAX_SIDE_MODEL_IMAGES} images"
        ));
    }
    let mut total = 0usize;
    let mut images = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let Some(url) = item.as_str() else {
            return Err(format!("host.sideModel images[{index}] must be a string"));
        };
        let Some(payload) = SIDE_MODEL_IMAGE_PREFIXES
            .iter()
            .find_map(|prefix| url.strip_prefix(prefix))
        else {
            return Err(format!(
                "host.sideModel images[{index}] must be a data:image/png, jpeg or webp base64 URI"
            ));
        };
        total = total.saturating_add(url.len());
        if total > MAX_SIDE_MODEL_IMAGE_BYTES {
            return Err("host.sideModel images exceed the 1.5 MiB total limit".to_owned());
        }
        if base64::engine::general_purpose::STANDARD
            .decode(payload)
            .map_or(true, |bytes| bytes.is_empty())
        {
            return Err(format!(
                "host.sideModel images[{index}] has an empty or invalid base64 payload"
            ));
        }
        images.push(url.to_owned());
    }
    Ok(images)
}
/// Grant required to read the secret-free runtime catalog. This deliberately
/// shares the existing read-only agent-catalog grant; the projection below
/// never contains credentials, hook code, or provider endpoints.
const GRANT_CATALOG: &str = "core:list_agents";
/// Grant required to call `host.storage.*`.
const GRANT_STORAGE: &str = "storage:kv";
/// Grant required to call `host.crypto_*` (seal/open the plugin's own data under a
/// per-plugin subkey it never holds). See [`PluginHookBridge::crypto`].
const GRANT_CRYPTO: &str = "crypto:seal";
#[path = "backup_bridge.rs"]
mod backup_bridge;
#[path = "workflow_script_bridge.rs"]
mod workflow_script_bridge;

/// Grant required to call `host.runAgent` (spawn a full tool-using sub-agent).
/// On its own it admits only READ-ONLY presets (`code_read`, `research`,
/// `summarise`); see [`GRANT_RUN_AGENT_WRITE`].
const GRANT_RUN_AGENT: &str = "hook:run-agent";
/// Additional explicit grant required before `host.runAgent` / `host.runFanout`
/// may launch a MUTATING preset (`code_write`: write files, apply patches, run
/// commands). Deliberately NOT on the Gateway's default allowlist — only reviewed
/// first-party owners (or an operator allowlist override) can hold it, so a
/// marketplace plugin holding plain `hook:run-agent` cannot escalate to a
/// write-capable sub-agent by passing `preset: "code_write"`.
const GRANT_RUN_AGENT_WRITE: &str = "hook:run-agent:write";
/// Grant required to call `host.spaces_*` (own Space documents).
const GRANT_SPACES: &str = "spaces:docs";
/// Grant required to create, inspect, update, or query native Space databases.
const GRANT_SPACES_DATABASE: &str = "spaces:database";
/// Grant required to call `host.navigate` (ask the host shell to navigate/deep-link).
const GRANT_NAVIGATE: &str = "shell:navigate";
/// Grant required to call `host.setConversationTitle`.
const GRANT_SET_TITLE: &str = "conversation:set-title";
/// Grant required for an agent to add a reaction to a message in its current
/// conversation.
const GRANT_CONVERSATION_REACTIONS: &str = "conversation:reactions";
/// Grant required to call `host.getPreference`.
const GRANT_PREFERENCES_READ: &str = "preferences:read";
/// Grant required to list and request stops for Core-visible background processes.
const GRANT_BACKGROUND_CONTROL: &str = "background:control";
/// Grant required to read an agent's normalized subscription usage snapshot.
const GRANT_USAGE_READ: &str = "usage:read";
/// Separate approval for cross-caller administrative Gateway audit records.
const GRANT_USAGE_AUDIT: &str = "usage:audit";
/// Grant required to call `host.subscriptions_*`: owner-tier subscription
/// accounts with their labels (often email addresses) and cached usage.
/// `subscriptions:pin` is a reserved name for future account pinning only.
const GRANT_SUBSCRIPTIONS_READ: &str = "subscriptions:read";
/// One live vendor read per (plugin, provider, account) per interval; later
/// calls inside the interval are served cache-only.
const SUBSCRIPTION_LIVE_READ_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);
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

/// Shared no-redirect client for `security.check`. Plugin hooks can call it on
/// every turn, so building a client per call reloaded the TLS config and opened
/// a new Gateway connection each time. Redirects stay off so the bearer token
/// never follows a 3xx, and the timeout is set per request.
fn security_check_client() -> Option<&'static reqwest::Client> {
    static CLIENT: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .ok()
        })
        .as_ref()
}

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
        "security.check" => "host.security_check",
        "identity.current" => "host.identity_current",
        "authorization.issue" => "host.authorization_issue",
        "authorization.check" => "host.authorization_check",
        "catalog.snapshot" => "host.catalogSnapshot",
        "catalog.models" => "host.catalogModels",
        "model.complete" => "host.sideModel",
        "agent.run" => "host.runAgent",
        "agent.runFanout" => "host.runFanout",
        "storage.get" => "host.storage_get",
        "backups.destinations" => "host.backups_destinations",
        "backups.create" => "host.backups_create",
        "backups.list" => "host.backups_list",
        "backups.get" => "host.backups_get",
        "backups.restore" => "host.backups_restore",
        "storage.set" => "host.storage_set",
        "storage.delete" => "host.storage_delete",
        "storage.keys" => "host.storage_keys",
        "storage.compareAndSet" => "host.storage_compare_and_set",
        "crypto.seal" => "host.crypto_seal",
        "crypto.open" => "host.crypto_open",
        "crypto.status" => "host.crypto_status",
        "spaces.search" => "host.spaces_search",
        "spaces.ensureSpace" => "host.spaces_ensure_space",
        "spaces.createDoc" => "host.spaces_create_doc",
        "spaces.getDoc" => "host.spaces_get_doc",
        "spaces.updateDoc" => "host.spaces_update_doc",
        "spaces.listDocs" => "host.spaces_list_docs",
        "spaces.deleteDoc" => "host.spaces_delete_doc",
        "spaces.createDatabase" => "host.spaces_create_database",
        "spaces.listDatabases" => "host.spaces_list_databases",
        "spaces.getDatabase" => "host.spaces_get_database",
        "spaces.updateDatabase" => "host.spaces_update_database",
        "spaces.queryDatabase" => "host.spaces_query_database",
        "spaces.deleteDatabase" => "host.spaces_delete_database",
        "conversation.setTitle" => "host.setConversationTitle",
        "conversation.addReaction" => "host.addMessageReaction",
        "preferences.get" => "host.getPreference",
        "background.list" => "host.background_list",
        "background.stop" => "host.background_stop",
        "execution.pause" => "host.execution_pause",
        "execution.resume" => "host.execution_resume",
        "execution.status" => "host.execution_status",
        "usage.snapshot" => "host.usageSnapshot",
        "subscriptions.list" => "host.subscriptions_list",
        "subscriptions.usage" => "host.subscriptions_usage",
        "gateway.budgetSpend" => "host.gatewayBudgetSpend",
        "gateway.audit" => "host.gatewayAudit",
        "learning.recordFeedback" => "host.recordFeedback",
        "learning.synthesizeSkill" => "host.synthesizeSkill",
        "hooks.run" => "host.runHook",
        "notifications.send" => "host.notifications_send",
        _ => return None,
    })
}

/// Hooks currently running through `host.runHook`, keyed
/// `"<plugin>:<user>:<conversation>"`.
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

/// One claimed slot in [`manual_hook_runs`], released on drop, so a cancelled
/// request (a client disconnect drops the handler future mid-run) or a panicking
/// hook cannot leave the hook blocked for that conversation until Core restarts.
struct ManualRunGuard {
    key: String,
}

impl ManualRunGuard {
    /// Claim a manual run slot. `None` when one is already in flight for `key`.
    /// A poisoned lock resolves to "refuse": failing closed here costs one menu
    /// click, while failing open costs the recursion bound this exists to hold.
    fn claim(key: &str) -> Option<Self> {
        let inserted = manual_hook_runs()
            .lock()
            .map(|mut set| set.insert(key.to_owned()))
            .unwrap_or(false);
        inserted.then(|| Self {
            key: key.to_owned(),
        })
    }
}

impl Drop for ManualRunGuard {
    fn drop(&mut self) {
        // Release even through poison, so a slot never outlives its run.
        manual_hook_runs()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.key);
    }
}

/// The node owner, or an owner/admin of the node's org: who may see saved
/// subscription logins and spend their quota.
pub(crate) fn node_owner_or_admin(
    verified_caller: Option<&crate::identity_verify::VerifiedCaller>,
) -> bool {
    if crate::sidecar::control_plane::is_managed_node()
        && crate::sidecar::control_plane::registered_org().is_none()
    {
        return false;
    }
    let Some(node) = crate::sidecar::control_plane::registered_node() else {
        return match crate::sidecar::control_plane::registered_org() {
            Some(org) => is_org_admin(verified_caller, &org.id),
            None => true,
        };
    };
    let Some(caller) = verified_caller else {
        return false;
    };
    if node.scope == crate::sidecar::control_plane::NodeScope::Personal {
        return node.owner_user_id.as_deref() == Some(caller.user_id.as_str());
    }
    is_org_admin(Some(caller), &node.org.id)
}

fn is_org_admin(caller: Option<&crate::identity_verify::VerifiedCaller>, org_id: &str) -> bool {
    caller.is_some_and(|caller| {
        caller.org_id.as_deref() == Some(org_id)
            && caller
                .role
                .satisfies(crate::identity_verify::OrgRole::Admin)
    })
}

/// Bridges sandbox `host.*` calls for one plugin hook run.
pub struct PluginHookBridge {
    plugin_id: String,
    grants: HashSet<String>,
    state: ServerState,
    verified_caller: Option<crate::identity_verify::VerifiedCaller>,
    authorized_conversation_id: Option<String>,
    /// Server-derived identity for an inline agent tool call. It is never read
    /// from the tool arguments, so a sandboxed body cannot react as another agent.
    calling_agent_id: Option<String>,
    storage_tenant: Option<String>,
    #[cfg(test)]
    test_storage: Option<crate::plugin_storage::PluginStorage>,
    middleware_next: Option<crate::plugin_host::MiddlewareNext>,
    middleware_next_used: Arc<AtomicBool>,
}

fn requires_user_agent_run_permission(has_verified_caller: bool, has_parent_agent: bool) -> bool {
    has_verified_caller || !has_parent_agent
}

impl PluginHookBridge {
    #[cfg(test)]
    pub(super) fn with_test_storage(mut self, store: crate::plugin_storage::PluginStorage) -> Self {
        self.test_storage = Some(store);
        self
    }

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
            calling_agent_id: None,
            storage_tenant: None,
            #[cfg(test)]
            test_storage: None,
            middleware_next: None,
            middleware_next_used: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Construct a bridge for an inline tool invoked by an identified agent. The
    /// conversation id and agent id were already resolved by the registry call
    /// path; binding them here gives the tool a narrow current-conversation write
    /// without turning model-controlled arguments into an authorization principal.
    pub fn new_for_agent_tool(
        plugin_id: String,
        grants: HashSet<String>,
        state: ServerState,
        agent_id: Option<&str>,
        conversation_id: Option<&str>,
    ) -> Self {
        let mut bridge = Self::new_for_request(
            plugin_id,
            grants,
            state,
            None,
            conversation_id.map(str::to_owned),
        );
        bridge.calling_agent_id = agent_id.map(str::to_owned);
        bridge
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

    /// Attach the Core-owned continuation for a middleware hook invocation.
    /// This is intentionally not part of the public host-API table: it exists
    /// only inside the sandbox runtime and inherits the current hook's lease.
    pub(crate) fn with_middleware_next(mut self, next: crate::plugin_host::MiddlewareNext) -> Self {
        self.middleware_next = Some(next);
        self
    }

    /// Bind an inline hook/tool bridge to the agent that produced the current
    /// turn. A hook may ask Core to run a specialist, but it must not turn that
    /// argument into a cross-agent privilege selector.
    pub(crate) fn with_calling_agent(mut self, agent_id: Option<String>) -> Self {
        self.calling_agent_id = agent_id;
        self
    }

    async fn require_bound_conversation(&self, requested: &str, write: bool) -> Result<(), String> {
        let requested = requested.trim();
        let Some(bound) = self.authorized_conversation_id.as_deref() else {
            return Err("host operation requires the current authorized conversation".to_owned());
        };
        if bound != requested {
            return Err("host operation cannot target a different conversation".to_owned());
        }
        let meta = self.state.conversations.get_access_meta(requested).await;
        let result = if write {
            crate::server::require_resource_write(
                meta,
                self.verified_caller.as_ref(),
                &format!("conversation '{requested}' not found"),
            )
        } else {
            crate::server::require_resource_read(
                meta,
                self.verified_caller.as_ref(),
                &format!("conversation '{requested}' not found"),
            )
        };
        result.map_err(|response| {
            format!(
                "host operation conversation is not authorized (HTTP {})",
                response.status()
            )
        })
    }

    fn usage_admin_allowed(&self) -> bool {
        node_owner_or_admin(self.verified_caller.as_ref())
    }

    async fn handle_inner(&self, path: String, args: Value) -> InvokeOutcome {
        // The sandbox proxy delivers `host.<method>` as the path.
        let method = path.strip_prefix("host.").unwrap_or(&path);
        match method {
            "authorization_issue" | "authorization_check" => {
                if !self.grants.contains("authorization:defer") {
                    return err("authorization:defer is not granted".to_owned());
                }
                match crate::sidecar::deferred_authorization::invoke(
                    &self.state,
                    &self.plugin_id,
                    method,
                    args,
                )
                .await
                {
                    Ok(value) => ok(value),
                    Err(error) => err(error.to_owned()),
                }
            }
            "execution_pause" | "execution_resume" | "execution_status" => {
                if !self.grants.contains("execution:control") {
                    return err("execution:control is not granted".to_owned());
                }
                if !self.usage_admin_allowed() {
                    return err("execution control is not granted to this caller".to_owned());
                }
                let _control = crate::execution_control::control_lock().await;
                let mut cancelled = 0;
                if method == "execution_pause" {
                    crate::execution_control::pause();
                    cancelled += crate::sidecar::adapters::acp::request_cancel_all();
                    cancelled += crate::a2a::request_cancel_all();
                } else if method == "execution_resume" {
                    crate::execution_control::resume();
                }
                let interrupted_conversations = if method == "execution_pause" {
                    match self
                        .state
                        .conversations
                        .interrupt_running_conversations()
                        .await
                    {
                        Ok(interrupted) => interrupted,
                        Err(error) => {
                            tracing::error!(%error, "execution paused but run statuses could not be updated");
                            return err("execution paused, but run statuses could not be updated"
                                .to_owned());
                        }
                    }
                } else {
                    0
                };
                tracing::info!(plugin = %self.plugin_id, method, cancelled, "execution control");
                ok(
                    json!({ "paused": crate::execution_control::is_paused(), "cancelledTurns": cancelled, "interruptedConversations": interrupted_conversations }),
                )
            }
            "security_check" => {
                if !self.grants.contains("security:check") {
                    return err("security:check is not granted".to_owned());
                }
                let text = match args.get("text").and_then(Value::as_str) {
                    Some(text) if text.len() <= 2_000_000 => text,
                    _ => return err("security.check requires text up to 2 MB".to_owned()),
                };
                let Some(client) = security_check_client() else {
                    return err("Security scanner unavailable".to_owned());
                };
                let endpoint = format!(
                    "{}/v1/firewall/check",
                    crate::sidecar::gateway::gateway_url().trim_end_matches('/')
                );
                let mut request = client
                    .post(endpoint)
                    .timeout(std::time::Duration::from_secs(15))
                    .json(&json!({ "text": text, "checks": ["secret"] }));
                if let Some(token) = crate::sidecar::gateway::gateway_token() {
                    request = request.bearer_auth(token);
                }
                let response = match request.send().await {
                    Ok(response) if response.status().is_success() => response,
                    _ => return err("Security scanner unavailable; operation refused".to_owned()),
                };
                match response.json::<Value>().await {
                    Ok(value) if value.get("allowed").is_some_and(Value::is_boolean) => ok(
                        json!({"allowed": value["allowed"], "reason": value.get("reason").cloned().unwrap_or(Value::Null)}),
                    ),
                    _ => err("Invalid security scanner response".to_owned()),
                }
            }
            "identity_current" => {
                if !self.grants.contains("identity:read") {
                    return err("identity:read is not granted".to_owned());
                }
                // Apps match email-addressed grants against this address, so it
                // carries only an email the identity token marks verified.
                let principal = self.verified_caller.as_ref().map(|caller| {
                    json!({
                        "id": caller.user_id,
                        "email": caller.verified_email().unwrap_or_default(),
                        "workspaceIds": caller.org_id.iter().collect::<Vec<_>>(),
                    })
                });
                ok(
                    json!({ "principal": principal, "requiresIdentity": crate::sidecar::control_plane::registered_org().is_some() }),
                )
            }
            "catalogSnapshot" => self.catalog_snapshot(args).await,
            "catalogModels" => self.catalog_models(args).await,
            "sideModel" => self.side_model(args).await,
            "runAgent" => self.run_agent(args).await,
            "runFanout" => self.run_fanout(args).await,
            "workflowScript" => self.workflow_script(args).await,
            "workflowRunStatus" => self.workflow_run_status(args).await,
            "storage_get"
            | "storage_set"
            | "storage_delete"
            | "storage_keys"
            | "storage_compare_and_set" => self.storage(method, args).await,
            "crypto_seal" | "crypto_open" | "crypto_status" => self.crypto(method, args).await,
            "backups_destinations"
            | "backups_create"
            | "backups_list"
            | "backups_get"
            | "backups_restore" => self.backups(method, args).await,
            "spaces_search"
            | "spaces_ensure_space"
            | "spaces_create_doc"
            | "spaces_get_doc"
            | "spaces_update_doc"
            | "spaces_list_docs"
            | "spaces_delete_doc"
            | "spaces_create_database"
            | "spaces_list_databases"
            | "spaces_get_database"
            | "spaces_update_database"
            | "spaces_query_database"
            | "spaces_delete_database" => self.spaces(method, args).await,
            "setConversationTitle" => self.set_conversation_title(args).await,
            "addMessageReaction" => self.add_message_reaction(args).await,
            "getPreference" => self.get_preference(args).await,
            "background_list" => self.background_list(args).await,
            "background_stop" => self.background_stop(args).await,
            "usageSnapshot" => self.usage_snapshot(args).await,
            "subscriptions_list" | "subscriptions_usage" => self.subscriptions(method, args).await,
            "gatewayBudgetSpend" => self.gateway_budget_spend(args).await,
            "gatewayAudit" => self.gateway_audit(args).await,
            "recordFeedback" => self.record_feedback(args).await,
            "synthesizeSkill" => self.synthesize_skill(args).await,
            "runHook" => self.run_own_hook(args).await,
            "next" => self.next(args).await,
            "notify" => self.notify(args).await,
            "notifications_send" => self.notifications_send(args).await,
            "navigate" => self.navigate(args),
            other => err(format!("unknown host capability '{other}'")),
        }
    }

    /// Continue a middleware hook chain with a serialized `HookContext`.
    /// `next` is one-shot per hook invocation, which prevents accidental
    /// duplicate downstream side effects while retaining normal onion semantics.
    async fn next(&self, args: Value) -> InvokeOutcome {
        let Some(next) = self.middleware_next.as_ref() else {
            return err("host.next is only available to middleware hooks".to_owned());
        };
        if self.middleware_next_used.swap(true, Ordering::AcqRel) {
            return err("middleware hook next() may only be called once".to_owned());
        }
        let Some(context) = args.get("context").cloned() else {
            return err("host.next requires a context object".to_owned());
        };
        let context = match serde_json::from_value::<crate::plugin_host::HookContext>(context) {
            Ok(context) => context,
            Err(error) => return err(format!("host.next received an invalid context: {error}")),
        };
        let directive = next(context).await;
        match serde_json::to_value(directive) {
            Ok(value) => ok(value),
            Err(error) => err(format!("host.next could not serialize its result: {error}")),
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
        if let Err(error) = self.require_bound_conversation(id, true).await {
            return err(error);
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

    /// `host.addMessageReaction({ message_id?, emoji })` — add an agent-authored
    /// reaction to one exact persisted message in the current conversation, or
    /// to its latest user message when `message_id` is omitted.
    ///
    /// The current conversation and actor are bound when the inline tool bridge is
    /// created. This is intentionally not a general conversation-id argument: an
    /// agent can react to a peer's message in the shared transcript, but cannot
    /// turn the tool into a cross-chat write or choose another agent's identity.
    async fn add_message_reaction(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_CONVERSATION_REACTIONS) {
            return err(format!(
                "capability '{GRANT_CONVERSATION_REACTIONS}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let Some(conversation_id) = self
            .authorized_conversation_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        else {
            return err(
                "host.addMessageReaction requires the calling agent's current conversation"
                    .to_owned(),
            );
        };
        let Some(agent_id) = self
            .calling_agent_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= 128)
        else {
            return err("host.addMessageReaction requires a verified calling agent".to_owned());
        };
        if agent_id.chars().any(char::is_control) {
            return err("host.addMessageReaction received an invalid calling agent".to_owned());
        }
        if let Err(error) = self
            .require_bound_conversation(conversation_id, false)
            .await
        {
            return err(error);
        }

        // Keep the agent plane aligned with the existing conversation ACL. On an
        // org-bound node, an unresolved/unterminated host conversation is never a
        // reason to fall back to the node-wide token.
        if crate::sidecar::control_plane::registered_org().is_some()
            && crate::sidecar::mcp::ToolPrincipal::resolve(
                &self.state.conversations,
                Some(conversation_id),
            )
            .await
            .is_unresolved()
        {
            return err(
                "host.addMessageReaction: the current conversation is not authorized".to_owned(),
            );
        }

        // An omitted id means "what the user just said": the agent is never shown
        // persisted message ids, so the acknowledgement case resolves server-side
        // to the latest user message of the bound conversation.
        let named_message_id = args
            .get("message_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let message_id = match named_message_id {
            Some(message_id) => message_id,
            None => match self
                .state
                .conversations
                .latest_user_message_id(conversation_id)
                .await
            {
                Ok(Some(message_id)) => message_id,
                Ok(None) => {
                    return err(
                        "host.addMessageReaction found no user message to react to in the current conversation"
                            .to_owned(),
                    );
                }
                Err(error) => {
                    return err(format!(
                        "host.addMessageReaction could not resolve the latest user message: {error}"
                    ));
                }
            },
        };
        let message_id = message_id.as_str();
        if message_id.len() > 200 {
            return err("host.addMessageReaction 'message_id' exceeds 200 bytes".to_owned());
        }

        let emoji = args
            .get("emoji")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(emoji) = emoji else {
            return err("host.addMessageReaction requires a non-empty 'emoji'".to_owned());
        };
        if emoji.len() > 64 {
            return err("host.addMessageReaction 'emoji' exceeds 64 bytes".to_owned());
        }

        match self
            .state
            .app_store
            .get(crate::plugins::builtins::REACTIONS_PLUGIN_ID)
            .await
        {
            Ok(Some(record)) if record.enabled => {}
            Ok(_) => {
                return err(
                    "host.addMessageReaction requires the Message Reactions plugin to be enabled"
                        .to_owned(),
                );
            }
            Err(error) => {
                return err(format!(
                    "host.addMessageReaction could not verify the Message Reactions plugin: {error}"
                ));
            }
        }

        let actor = format!("agent:{agent_id}");
        match self
            .state
            .conversations
            .add_reaction(conversation_id, message_id, &actor, emoji)
            .await
        {
            Ok(true) => ok(json!({
                "ok": true,
                "conversation_id": conversation_id,
                "message_id": message_id,
                "emoji": emoji,
                "from": agent_id,
            })),
            Ok(false) => err(format!(
                "host.addMessageReaction message '{message_id}' was not found in the current conversation"
            )),
            Err(error) => err(format!(
                "host.addMessageReaction could not persist reaction: {error}"
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
        if crate::server::preferences::is_secret_preference_key(key) {
            return err(
                "host.getPreference cannot return credential-bearing preferences; use the \
                 governed secret-header or vault capability instead"
                    .to_owned(),
            );
        }
        match self.state.preferences.get(key).await {
            Ok(Some(v)) => ok(json!(v)),
            Ok(None) => ok(Value::Null),
            Err(e) => err(e.to_string()),
        }
    }

    /// `host.usageSnapshot(args)` accepts exactly one of two forms:
    ///
    /// - `{ agent_id }`: the same normalized, read-only subscription windows
    ///   shown in the composer. A Ryu subscription provider id reads the vault's
    ///   active account. The credential reader never refreshes tokens and the
    ///   snapshot contains no credential material.
    /// - `{ provider_id, account_id? }`: every saved account of one provider,
    ///   label-free and cache-only (a miss is `pending` and schedules a
    ///   background read), so a turn hook never waits on a vendor. Node
    ///   owner/admin only.
    async fn usage_snapshot(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_USAGE_READ) {
            return err(format!(
                "capability '{GRANT_USAGE_READ}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let agent_id = match parse_usage_args(&args) {
            Ok(UsageArgs::Agent(agent_id)) => agent_id,
            Ok(UsageArgs::Provider {
                provider_id,
                account_id,
            }) => return self.provider_usage(provider_id, account_id).await,
            Err(message) => return err(message),
        };
        if !crate::fleet::is_agent_available(agent_id) {
            return err(
                "host.usageSnapshot agent is unavailable under organization policy".to_owned(),
            );
        }
        // A Ryu subscription provider id reads the owner's active saved
        // account, so it carries the same owner gate as the provider form.
        if crate::subscriptions::provider_kind(agent_id)
            == Some(crate::subscriptions::ProviderKind::Subscription)
            && !self.usage_admin_allowed()
        {
            return err(
                "host.usageSnapshot provider readings are visible to the node owner only"
                    .to_owned(),
            );
        }
        if let Err(response) = crate::server::enforce_agent_resource_permission(
            &self.state,
            &self.verified_caller,
            crate::identity_verify::permissions::AGENT_VIEW,
            agent_id,
        )
        .await
        {
            return err(format!(
                "host.usageSnapshot agent is not authorized (HTTP {})",
                response.status()
            ));
        }
        match serde_json::to_value(crate::subscriptions::reading::agent_reading(agent_id).await) {
            Ok(snapshot) => ok(snapshot),
            Err(e) => err(e.to_string()),
        }
    }

    /// The `{ provider_id, account_id? }` form of `host.usageSnapshot`. Cache
    /// only and label-free: account labels never reach a turn hook.
    async fn provider_usage(&self, provider_id: &str, account_id: Option<&str>) -> InvokeOutcome {
        if !self.usage_admin_allowed() {
            return err(
                "host.usageSnapshot provider readings are visible to the node owner only"
                    .to_owned(),
            );
        }
        // With an account named, only that account is probed on a miss.
        let snapshot = crate::subscriptions::snapshot(crate::subscriptions::SnapshotQuery {
            provider_id: Some(provider_id.to_owned()),
            usage: crate::subscriptions::UsageMode::Cached,
            include_labels: false,
            max_age: crate::subscriptions::DEFAULT_MAX_AGE,
            only_account: account_id.map(str::to_owned),
        })
        .await;
        let provider = snapshot
            .providers
            .into_iter()
            .find(|provider| provider.provider_id == provider_id);
        // The raw cached snapshots need each account's credential revision,
        // which is a vault read: collect them off the async workers.
        let wanted: Vec<String> = provider
            .iter()
            .flat_map(|provider| provider.accounts.iter())
            .filter(|row| account_id.is_none_or(|wanted| row.account_id == wanted))
            .map(|row| row.account_id.clone())
            .collect();
        let owned_provider = provider_id.to_owned();
        let cached: std::collections::HashMap<String, (ryu_usage::UsageSnapshot, String)> =
            crate::subscriptions::blocking(move || {
                wanted
                    .into_iter()
                    .filter_map(|account| {
                        cached_account_snapshot(&owned_provider, &account).map(|hit| (account, hit))
                    })
                    .collect()
            })
            .await;
        ok(provider_usage_projection(
            provider.as_ref(),
            provider_id,
            account_id,
            |_, account| cached.get(account).cloned(),
        ))
    }

    /// `host.subscriptions_list` / `host.subscriptions_usage` — the owner-tier
    /// (T1) subscription inventory with account labels. Fails closed: grant,
    /// then node owner/admin, then argument validation.
    async fn subscriptions(&self, method: &str, args: Value) -> InvokeOutcome {
        if let Err(message) = subscriptions_gate(
            &self.plugin_id,
            self.grants.contains(GRANT_SUBSCRIPTIONS_READ),
            || self.usage_admin_allowed(),
        ) {
            return err(message);
        }
        let args = if args.is_null() { json!({}) } else { args };
        let result = if method == "subscriptions_list" {
            self.subscriptions_list(args).await
        } else {
            self.subscriptions_usage(args).await
        };
        match result {
            Ok(value) => ok(value),
            Err(message) => err(message),
        }
    }

    async fn subscriptions_list(&self, args: Value) -> Result<Value, String> {
        let args: SubscriptionsListArgs = serde_json::from_value(args)
            .map_err(|error| format!("subscriptions.list received invalid arguments: {error}"))?;
        if let Some(provider_id) = args.provider_id.as_deref() {
            validate_subscription_id("providerId", provider_id)?;
        }
        let mut usage = parse_list_usage(args.usage.as_deref())?;
        if usage == crate::subscriptions::UsageMode::Refresh
            && !self.take_live_read(args.provider_id.as_deref().unwrap_or("*"), "*")
        {
            usage = crate::subscriptions::UsageMode::Cached;
        }
        let snapshot = crate::subscriptions::snapshot(crate::subscriptions::SnapshotQuery {
            provider_id: args.provider_id,
            usage,
            include_labels: true,
            max_age: crate::subscriptions::DEFAULT_MAX_AGE,
            only_account: None,
        })
        .await;
        serde_json::to_value(snapshot).map_err(|error| error.to_string())
    }

    async fn subscriptions_usage(&self, args: Value) -> Result<Value, String> {
        let args: SubscriptionsUsageArgs = serde_json::from_value(args)
            .map_err(|error| format!("subscriptions.usage received invalid arguments: {error}"))?;
        validate_subscription_id("providerId", &args.provider_id)?;
        if let Some(account_id) = args.account_id.as_deref() {
            validate_subscription_id("accountId", account_id)?;
        }
        let account = args.account_id.as_deref().map_or(
            crate::subscriptions::AccountSel::Active,
            crate::subscriptions::AccountSel::Exact,
        );
        let mode = if self.take_live_read(
            &args.provider_id,
            args.account_id.as_deref().unwrap_or("@active"),
        ) {
            crate::subscriptions::UsageMode::Refresh
        } else {
            crate::subscriptions::UsageMode::Cached
        };
        let reading = crate::subscriptions::reading::read_with(
            &args.provider_id,
            account,
            crate::subscriptions::reading::ReadOptions {
                mode,
                max_age: crate::subscriptions::DEFAULT_MAX_AGE,
                model: None,
                include_label: true,
            },
        )
        .await;
        serde_json::to_value(reading).map_err(|error| error.to_string())
    }

    /// Claim this plugin's live-read slot for one provider account.
    fn take_live_read(&self, provider_id: &str, account_id: &str) -> bool {
        subscription_live_reads().try_acquire(
            (
                self.plugin_id.clone(),
                provider_id.to_owned(),
                account_id.to_owned(),
            ),
            std::time::Instant::now(),
            SUBSCRIPTION_LIVE_READ_INTERVAL,
        )
    }

    /// `host.gatewayBudgetSpend()` — read the Gateway-owned charged-spend
    /// counters and configured caps without exposing its admin credential.
    async fn gateway_budget_spend(&self, _args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_USAGE_READ) {
            return err(format!(
                "capability '{GRANT_USAGE_READ}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        if !self.usage_admin_allowed() {
            return err("host.gatewayBudgetSpend requires a node administrator".to_owned());
        }
        let url = format!(
            "{}/v1/budget/spend",
            crate::sidecar::gateway::gateway_url().trim_end_matches('/')
        );
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
        {
            Ok(client) => client,
            Err(error) => return err(format!("Gateway budget client unavailable: {error}")),
        };
        let mut request = client.get(url);
        if let Some(token) = crate::sidecar::gateway::gateway_admin_key() {
            request = request.bearer_auth(token);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                return ok(json!({
                    "reachable": false,
                    "error": "Gateway budget is unavailable",
                    "detail": error.to_string(),
                    "users": {},
                    "agents": {},
                    "sessions": {},
                    "limits": {},
                }));
            }
        };
        if !response.status().is_success() {
            return ok(json!({
                "reachable": false,
                "status": response.status().as_u16(),
                "error": "Gateway budget request was refused",
                "users": {},
                "agents": {},
                "sessions": {},
                "limits": {},
            }));
        }
        match response.json::<Value>().await {
            Ok(value) => ok(json!({
                "reachable": true,
                "users": value.get("users").cloned().unwrap_or_else(|| json!({})),
                "agents": value.get("agents").cloned().unwrap_or_else(|| json!({})),
                "sessions": value.get("sessions").cloned().unwrap_or_else(|| json!({})),
                "limits": value.get("limits").cloned().unwrap_or_else(|| json!({})),
                "currency": value.get("currency").cloned().unwrap_or_else(|| json!("USD")),
                "unit": value.get("unit").cloned().unwrap_or_else(|| json!("micro_usd")),
            })),
            Err(error) => ok(json!({
                "reachable": false,
                "error": "Gateway budget response was invalid",
                "detail": error.to_string(),
                "users": {},
                "agents": {},
                "sessions": {},
                "limits": {},
            })),
        }
    }

    /// `host.gatewayAudit({ limit })` — read administrative Gateway audit rows.
    /// A separate audit grant and node administrator authority are both required;
    /// ordinary usage permission never authorizes cross-caller records.
    async fn gateway_audit(&self, args: Value) -> InvokeOutcome {
        let current = match self.state.app_store.get(&self.plugin_id).await {
            Ok(Some(record)) if record.enabled => {
                crate::plugin_host::current_approved_grants(
                    &self.state,
                    &self.plugin_id,
                    &record.approved_grants,
                )
                .await
            }
            _ => HashSet::new(),
        };
        if !self.grants.contains(GRANT_USAGE_AUDIT) || !current.contains(GRANT_USAGE_AUDIT) {
            return err(format!(
                "capability '{GRANT_USAGE_AUDIT}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        if !self.usage_admin_allowed() {
            return err("host.gatewayAudit requires a node administrator".to_owned());
        }
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(100)
            .clamp(1, 100) as u32;
        let url = format!(
            "{}/v1/audit?limit={limit}",
            crate::sidecar::gateway::gateway_url().trim_end_matches('/')
        );
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
        {
            Ok(client) => client,
            Err(error) => return err(format!("Gateway audit client unavailable: {error}")),
        };
        let mut request = client.get(url);
        if let Some(token) = crate::sidecar::gateway::gateway_admin_key() {
            request = request.bearer_auth(token);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(_error) => {
                return ok(json!({
                    "reachable": false,
                    "error": "Gateway audit is unavailable",
                    "entries": [],
                }));
            }
        };
        if !response.status().is_success() {
            return ok(json!({
                "reachable": false,
                "status": response.status().as_u16(),
                "error": "Gateway audit request was refused",
                "entries": [],
            }));
        }
        match response.json::<Value>().await {
            Ok(value) => ok(json!({
                "reachable": true,
                "entries": value.get("entries").cloned().unwrap_or_else(|| json!([])),
                "count": value.get("count").cloned().unwrap_or_else(|| json!(0)),
            })),
            Err(error) => ok(json!({
                "reachable": false,
                "error": format!("Gateway audit response was malformed: {error}"),
                "entries": [],
            })),
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
        if let Err(error) = self
            .require_bound_conversation(conversation_id, false)
            .await
        {
            return err(error);
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
                ));
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
                ));
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
        if let Err(error) = self.require_bound_conversation(cid, false).await {
            return err(error);
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

        let key = format!("{}:{}:{}", self.plugin_id, caller.user_id, conversation_id);
        let Some(manual_run) = ManualRunGuard::claim(&key) else {
            return err(format!("hook '{hook_id}' is already running"));
        };

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
                return err(format!("host.runHook could not load the transcript: {e}"));
            }
        };
        let mut event = match args.get("event") {
            Some(Value::Object(map)) => map.clone(),
            _ => serde_json::Map::new(),
        };
        event.insert("source".to_string(), json!("manual"));
        // Carry the verified caller into the hook, as the turn path does: the
        // inner bridge needs it for conversation/resource ACLs on registered
        // nodes and for the caller's storage tenant.
        let ctx = crate::plugin_host::HookContext {
            conversation_id: Some(conversation_id),
            caller_user_id: Some(caller.user_id.clone()),
            verified_caller: Some(caller.clone()),
            transcript,
            event: Some(Value::Object(event)),
            ..Default::default()
        };
        let directive = crate::plugin_host::run_hook(&self.state, &hook, &ctx).await;
        drop(manual_run);
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

    async fn require_user_agent_run_permission(&self) -> Result<(), String> {
        // A verified user must hold the collection permission in addition to
        // the app's hook grant. Sidecar-only calls without a user are checked
        // against node scope by enforce_permission; only a bridge invoked from
        // an identified agent tool inherits its enclosing turn's authorization.
        if !requires_user_agent_run_permission(
            self.verified_caller.is_some(),
            self.calling_agent_id.is_some(),
        ) {
            return Ok(());
        }
        crate::server::enforce_permission(
            &self.state,
            &self.verified_caller,
            crate::identity_verify::permissions::AGENT_RUN,
        )
        .await
        .map_err(|_| "permission 'agent.run' is not granted to this caller".to_owned())
    }

    /// The `x-ryu-agent-provider-access` value of the agent whose turn invoked
    /// this bridge, or `None` when there is no calling agent or its model
    /// providers are unrestricted. A store error fails closed to `none`.
    pub(super) async fn calling_agent_provider_access(&self) -> Option<String> {
        let agent_id = self.calling_agent_id.as_deref()?;
        crate::agent_access::provider_access_for_agent(&self.state.agent_store, agent_id)
            .await
            .map(|ids| crate::agent_access::provider_access_header_value(&ids))
    }

    /// Sub-agents and fan-out delegates are Gateway completions on the node's
    /// model providers with no provider-access header, so an agent whose model
    /// providers are limited would get them all back through an app's tool.
    pub(super) async fn refuse_limited_provider_access(&self, verb: &str) -> Result<(), String> {
        if self.calling_agent_provider_access().await.is_some() {
            return Err(format!(
                "{verb} runs sub-tasks on all of your model providers, which this agent's account access does not allow"
            ));
        }
        Ok(())
    }

    async fn run_agent(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_RUN_AGENT) {
            return err(format!(
                "capability '{GRANT_RUN_AGENT}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        if let Err(error) = self.require_user_agent_run_permission().await {
            return err(error);
        }
        if let Err(error) = self.refuse_limited_provider_access("host.runAgent").await {
            return err(error);
        }
        let task = args
            .get("task")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if task.is_empty() {
            return err("host.runAgent requires a non-empty 'task'".to_string());
        }
        if task.chars().count() > 64 * 1024 {
            return err("host.runAgent task exceeds the 64 KiB limit".to_owned());
        }
        let agent_id = args
            .get("agent_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        if let Some(agent_id) = agent_id.as_deref() {
            if agent_id.len() > 128 || agent_id.chars().any(char::is_control) {
                return err("host.runAgent received an invalid agent_id".to_owned());
            }
            if let Some(calling_agent) = self.calling_agent_id.as_deref() {
                if calling_agent != agent_id {
                    return err(
                        "host.runAgent cannot target an agent different from the current turn"
                            .to_owned(),
                    );
                }
            }
            if !crate::fleet::is_agent_available(agent_id) {
                return err(
                    "host.runAgent agent is unavailable under organization policy".to_owned(),
                );
            }
            if let Err(response) = crate::server::enforce_agent_resource_permission(
                &self.state,
                &self.verified_caller,
                crate::identity_verify::permissions::AGENT_RUN,
                agent_id,
            )
            .await
            {
                return err(format!(
                    "host.runAgent agent is not authorized (HTTP {})",
                    response.status()
                ));
            }
        }
        let preset = parse_preset(args.get("preset").and_then(Value::as_str));
        if let Err(error) = check_preset_grant(&self.grants, &self.plugin_id, preset) {
            return err(error);
        }

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
        if let Err(error) = self.require_user_agent_run_permission().await {
            return err(error);
        }
        if let Err(error) = self.refuse_limited_provider_access("host.runFanout").await {
            return err(error);
        }
        let raw_delegates = match args.get("delegates") {
            Some(Value::Array(items)) if !items.is_empty() => items,
            _ => return err("host.runFanout requires a non-empty 'delegates' array".to_string()),
        };
        if raw_delegates.len() > 20 {
            return err("host.runFanout accepts at most 20 delegates".to_string());
        }
        let mut delegates: Vec<DelegateSpec> = match raw_delegates
            .iter()
            .cloned()
            .map(serde_json::from_value)
            .collect::<Result<_, _>>()
        {
            Ok(value) => value,
            Err(e) => return err(format!("host.runFanout has an invalid delegate: {e}")),
        };
        let mut ids = HashSet::new();
        for delegate in &mut delegates {
            if delegate.id.trim().is_empty() || delegate.task.trim().is_empty() {
                return err(
                    "host.runFanout delegates require non-empty 'id' and 'task'".to_string()
                );
            }
            if delegate.id.len() > 128
                || delegate.id.chars().any(char::is_control)
                || delegate.task.chars().count() > 64 * 1024
            {
                return err(
                    "host.runFanout delegate id/task exceeds its bounded input limit".to_owned(),
                );
            }
            if !ids.insert(delegate.id.clone()) {
                return err(format!(
                    "host.runFanout duplicate delegate id '{}'",
                    delegate.id
                ));
            }
            if let Some(raw_agent_id) = delegate.agent_id.as_deref() {
                let agent_id = raw_agent_id.trim().to_owned();
                if agent_id.is_empty() {
                    return err("host.runFanout received an empty agent_id".to_owned());
                }
                delegate.agent_id = Some(agent_id.clone());
                if agent_id.len() > 128 || agent_id.chars().any(char::is_control) {
                    return err("host.runFanout received an invalid agent_id".to_owned());
                }
                if let Some(calling_agent) = self.calling_agent_id.as_deref() {
                    if calling_agent != agent_id.as_str() {
                        return err(
                            "host.runFanout cannot target an agent different from the current turn"
                                .to_owned(),
                        );
                    }
                }
                if !crate::fleet::is_agent_available(&agent_id) {
                    return err(
                        "host.runFanout agent is unavailable under organization policy".to_owned(),
                    );
                }
                if let Err(response) = crate::server::enforce_agent_resource_permission(
                    &self.state,
                    &self.verified_caller,
                    crate::identity_verify::permissions::AGENT_RUN,
                    &agent_id,
                )
                .await
                {
                    return err(format!(
                        "host.runFanout agent is not authorized (HTTP {})",
                        response.status()
                    ));
                }
            }
            if let Some(inline) = &delegate.inline {
                if inline.system_prompt.trim().is_empty() {
                    return err("host.runFanout inline system_prompt must be non-empty".to_string());
                }
                if inline.system_prompt.chars().count() > 64 * 1024
                    || inline
                        .model
                        .as_deref()
                        .is_some_and(|model| model.chars().count() > 256)
                {
                    return err(
                        "host.runFanout inline model fields exceed their bounded input limits"
                            .to_owned(),
                    );
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
        for delegate in &delegates {
            if let Err(error) = check_preset_grant(&self.grants, &self.plugin_id, delegate.preset) {
                return err(error);
            }
        }
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
        if prompt.chars().count() > 64 * 1024 {
            return err("host.sideModel prompt exceeds the 64 KiB limit".to_owned());
        }
        if system.chars().count() > 64 * 1024 {
            return err("host.sideModel system prompt exceeds the 64 KiB limit".to_owned());
        }
        let images = match validate_side_model_images(&args) {
            Ok(images) => images,
            Err(message) => return err(message),
        };
        // Character limits do not bound bytes: escaped or multi-byte text plus
        // images can still exceed the Gateway's chat body limit. Refuse here,
        // with the bridge's own name, instead of surfacing a Gateway 413.
        if let Err(message) = crate::server::encode_side_model_request(
            &crate::server::side_model_payload("", "", system, prompt, &images),
        ) {
            return err(format!("host.sideModel refused: {message}"));
        }
        let explicit = args.get("model").and_then(Value::as_str);
        let provider = args
            .get("provider")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let pref_key = args.get("model_pref_key").and_then(Value::as_str);
        let effort = args.get("effort").and_then(Value::as_str).unwrap_or("");
        if explicit.is_some_and(|model| model.chars().count() > 256)
            || provider.is_some_and(|value| value.chars().count() > 256)
            || pref_key.is_some_and(|value| value.chars().count() > 256)
            || effort.chars().count() > 64
        {
            return err("host.sideModel model selection fields exceed their limits".to_owned());
        }
        let (model, selection_effort) = self.resolve_model(pref_key, explicit).await;
        // The plugin's per-call `effort` is its own considered choice (the
        // advisor asks for "high", auto-expand for "low"), so it wins; the
        // configured selection's effort fills in only when the plugin passed none.
        let effort = if effort.trim().is_empty() {
            selection_effort.as_str()
        } else {
            effort
        };
        // The calling agent's provider limit travels with the call, so the
        // Gateway keeps the completion on the providers that agent may use.
        let provider_access = self.calling_agent_provider_access().await;
        match crate::server::call_side_model_with_images(
            &self.state,
            &crate::sidecar::gateway::SidePurpose::Plugin(self.plugin_id.clone()),
            &model,
            provider,
            effort,
            system,
            prompt,
            &images,
            provider_access.as_deref(),
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
        #[cfg(test)]
        let selected_store: Option<&crate::plugin_storage::PluginStorage> =
            match self.test_storage.as_ref() {
                Some(store) => Some(store),
                None => crate::plugin_storage::global(),
            };
        #[cfg(not(test))]
        let selected_store = crate::plugin_storage::global();
        let Some(store) = selected_store else {
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
        let database_method = matches!(
            method,
            "spaces_create_database"
                | "spaces_list_databases"
                | "spaces_get_database"
                | "spaces_update_database"
                | "spaces_query_database"
                | "spaces_delete_database"
        );
        let required_grant = if database_method {
            GRANT_SPACES_DATABASE
        } else {
            GRANT_SPACES
        };
        if !self.grants.contains(required_grant) {
            return err(format!(
                "capability '{required_grant}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        if method == "spaces_search" {
            let space_id = match args.get("space_id").and_then(Value::as_str) {
                Some(id) if !id.is_empty() && id.len() <= 100 => id.to_owned(),
                _ => return err("space_id is required".to_owned()),
            };
            let query = match args.get("query").and_then(Value::as_str) {
                Some(query) if !query.trim().is_empty() && query.len() <= 8_000 => query.to_owned(),
                _ => return err("query must contain 1 to 8000 bytes".to_owned()),
            };
            let response = crate::server::search_space(
                axum::extract::State(self.state.clone()),
                axum::Extension(self.verified_caller.clone()),
                axum::extract::Path(space_id),
                axum::Json(crate::server::SearchBody {
                    query,
                    limit: args
                        .get("limit")
                        .and_then(Value::as_u64)
                        .unwrap_or(8)
                        .clamp(1, 50) as usize,
                    link_expansion: None,
                    ..Default::default()
                }),
            )
            .await;
            let status = response.status();
            if !status.is_success() {
                return err(format!("Space retrieval denied or unavailable ({status})"));
            }
            return match axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024).await {
                Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                    Ok(value) => ok(value),
                    Err(_) => err("Invalid Space retrieval response".to_owned()),
                },
                Err(_) => err("Space retrieval response exceeds limit".to_owned()),
            };
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
        let database_id = args
            .get("database_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();

        // App namespace ownership does not replace the request caller's Space ACL.
        // Apply the same coarse and resource gates used by the public document routes.
        use crate::identity_verify::permissions::{SPACE_READ, SPACE_WRITE};
        let caller = &self.verified_caller;
        if method == "spaces_ensure_space" {
            if crate::server::enforce_permission(&self.state, caller, SPACE_WRITE)
                .await
                .is_err()
            {
                return err("Space creation is not permitted for this caller".to_owned());
            }
        } else if matches!(
            method,
            "spaces_create_doc"
                | "spaces_list_docs"
                | "spaces_create_database"
                | "spaces_list_databases"
        ) && !space_id.is_empty()
        {
            let write = matches!(method, "spaces_create_doc" | "spaces_create_database");
            if crate::server::enforce_permission_on(
                &self.state,
                caller,
                if write { SPACE_WRITE } else { SPACE_READ },
                crate::acl::KIND_SPACE,
                space_id,
            )
            .await
            .is_err()
            {
                return err("Space access is not permitted for this caller".to_owned());
            }
            if write
                && crate::server::require_space_content_write(
                    &self.state,
                    caller,
                    space_id,
                    "space not found",
                )
                .await
                .is_err()
            {
                return err("Space is unavailable or not writable".to_owned());
            }
        } else if matches!(
            method,
            "spaces_get_doc" | "spaces_update_doc" | "spaces_delete_doc"
        ) && !doc_id.is_empty()
        {
            let write = method != "spaces_get_doc";
            let Some(parent) = crate::server::document_parent_space(&self.state, doc_id).await
            else {
                if !write {
                    return ok(Value::Null);
                }
                return err("Document is unavailable".to_owned());
            };
            if crate::server::enforce_permission_on(
                &self.state,
                caller,
                if write { SPACE_WRITE } else { SPACE_READ },
                crate::acl::KIND_SPACE,
                &parent,
            )
            .await
            .is_err()
            {
                return err("Document access is not permitted for this caller".to_owned());
            }
            let meta = crate::server::spaces::doc_access_meta(store, doc_id).await;
            let allowed = if write {
                crate::server::require_resource_write(meta, caller.as_ref(), "document not found")
            } else {
                crate::server::require_resource_read(meta, caller.as_ref(), "document not found")
            };
            if allowed.is_err() {
                return err("Document is unavailable or access was denied".to_owned());
            }
        } else if matches!(
            method,
            "spaces_get_database"
                | "spaces_update_database"
                | "spaces_query_database"
                | "spaces_delete_database"
        ) && !database_id.is_empty()
        {
            let write = matches!(method, "spaces_update_database" | "spaces_delete_database");
            let Some(parent) = crate::server::document_parent_space(&self.state, database_id).await
            else {
                return err("Database is unavailable".to_owned());
            };
            if parent != space_id {
                return err("Database is unavailable".to_owned());
            }
            if crate::server::enforce_permission_on(
                &self.state,
                caller,
                if write { SPACE_WRITE } else { SPACE_READ },
                crate::acl::KIND_SPACE,
                &parent,
            )
            .await
            .is_err()
            {
                return err("Database access is not permitted for this caller".to_owned());
            }
            let meta = crate::server::spaces::doc_access_meta(store, database_id).await;
            let allowed = if write {
                crate::server::require_resource_write(meta, caller.as_ref(), "database not found")
            } else {
                crate::server::require_resource_read(meta, caller.as_ref(), "database not found")
            };
            if allowed.is_err() {
                return err("Database is unavailable or access was denied".to_owned());
            }
        }

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
                match store
                    .list_documents(space_id, crate::server::caller_doc_filter(caller))
                    .await
                {
                    Ok(docs) => {
                        let kind = format!("app:{}", self.plugin_id);
                        let visible: Vec<Value> = docs.into_iter().filter(|doc| doc.kind == kind).map(|doc| json!({"id":doc.id,"title":doc.title,"updated_at":doc.updated_at})).collect();
                        ok(json!(visible))
                    }
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
            "spaces_create_database" => {
                if space_id.is_empty() {
                    return err(
                        "host.spaces.createDatabase requires a non-empty 'space_id'".to_owned()
                    );
                }
                let title = args
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|title| !title.is_empty() && title.len() <= 100)
                    .unwrap_or("Untitled");
                match store.create_database(space_id, title, &owner).await {
                    Ok(id) => ok(json!(id)),
                    Err(error) => err(error.to_string()),
                }
            }
            "spaces_list_databases" => {
                if space_id.is_empty() {
                    return err(
                        "host.spaces.listDatabases requires a non-empty 'space_id'".to_owned()
                    );
                }
                match store
                    .list_documents(space_id, crate::server::caller_doc_filter(caller))
                    .await
                {
                    Ok(documents) => {
                        let databases: Vec<Value> = documents
                            .into_iter()
                            .filter(|document| document.kind == "database")
                            .map(|document| {
                                json!({
                                    "id": document.id,
                                    "title": document.title,
                                    "updated_at": document.updated_at,
                                })
                            })
                            .collect();
                        ok(json!(databases))
                    }
                    Err(error) => err(error.to_string()),
                }
            }
            "spaces_get_database" => {
                if database_id.is_empty() {
                    return err(
                        "host.spaces.getDatabase requires a non-empty 'database_id'".to_owned()
                    );
                }
                match store.get_document(database_id).await {
                    Ok(Some(document))
                        if document.space_id == space_id && document.kind == "database" =>
                    {
                        match serde_json::to_value(document) {
                            Ok(value) => ok(value),
                            Err(error) => err(error.to_string()),
                        }
                    }
                    Ok(_) => ok(Value::Null),
                    Err(error) => err(error.to_string()),
                }
            }
            "spaces_update_database" => {
                if database_id.is_empty() {
                    return err(
                        "host.spaces.updateDatabase requires a non-empty 'database_id'".to_owned(),
                    );
                }
                let Some(expected_revision) = args
                    .get("expected_revision")
                    .and_then(Value::as_i64)
                    .filter(|revision| *revision >= 0)
                else {
                    return err(
                        "host.spaces.updateDatabase requires a non-negative 'expected_revision'"
                            .to_owned(),
                    );
                };
                let source = args
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if source.len() > 1_500_000 {
                    return err("database source exceeds the 1500000 byte limit".to_owned());
                }
                let title = match args.get("title").and_then(Value::as_str) {
                    Some(title) if !title.trim().is_empty() && title.len() <= 100 => {
                        title.trim().to_owned()
                    }
                    Some(_) => return err("database title must contain 1 to 100 bytes".to_owned()),
                    None => match store.get_document(database_id).await {
                        Ok(Some(document))
                            if document.space_id == space_id && document.kind == "database" =>
                        {
                            document.title
                        }
                        _ => return err("Database is unavailable".to_owned()),
                    },
                };
                match store
                    .update_database_document(
                        space_id,
                        database_id,
                        &title,
                        source,
                        expected_revision,
                    )
                    .await
                {
                    Ok(crate::server::spaces::DocumentUpdateOutcome::Applied(result)) => {
                        ok(json!(result))
                    }
                    Ok(crate::server::spaces::DocumentUpdateOutcome::Conflict {
                        current_revision,
                    }) => err(format!("database revision conflict at {current_revision}")),
                    Err(error) => err(error.to_string()),
                }
            }
            "spaces_query_database" => {
                if database_id.is_empty() {
                    return err(
                        "host.spaces.queryDatabase requires a non-empty 'database_id'".to_owned(),
                    );
                }
                let query = args
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let parameters = match args.get("parameters") {
                    Some(Value::Array(parameters)) => parameters.as_slice(),
                    Some(_) => return err("query 'parameters' must be an array".to_owned()),
                    None => &[],
                };
                match store
                    .query_database(space_id, database_id, query, parameters)
                    .await
                {
                    Ok(result) => match serde_json::to_value(result) {
                        Ok(value) => ok(value),
                        Err(error) => err(error.to_string()),
                    },
                    Err(error) => err(error.to_string()),
                }
            }
            "spaces_delete_database" => {
                if database_id.is_empty() {
                    return err(
                        "host.spaces.deleteDatabase requires a non-empty 'database_id'".to_owned(),
                    );
                }
                match store.delete_database_document(space_id, database_id).await {
                    Ok(()) => ok(json!(true)),
                    Err(error) => err(error.to_string()),
                }
            }
            _ => err(format!("unknown spaces method '{method}'")),
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
        (crate::registry::local_chat_model_id(), String::new())
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
/// Plain `hook:run-agent` admits only read-only presets; a mutating preset also
/// needs [`GRANT_RUN_AGENT_WRITE`]. Returns the denial message (classified as a
/// 403 `denied` by the bridge API because it contains "not granted").
fn check_preset_grant(
    grants: &HashSet<String>,
    plugin_id: &str,
    preset: PermissionPreset,
) -> Result<(), String> {
    if preset.allows_mutation() && !grants.contains(GRANT_RUN_AGENT_WRITE) {
        return Err(format!(
            "capability '{GRANT_RUN_AGENT_WRITE}' not granted to plugin '{plugin_id}': \
             '{GRANT_RUN_AGENT}' only allows read-only presets (code_read, research, summarise)"
        ));
    }
    Ok(())
}

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

/// The two mutually exclusive argument forms of `host.usageSnapshot`.
#[derive(Debug, PartialEq, Eq)]
enum UsageArgs<'a> {
    Agent(&'a str),
    Provider {
        provider_id: &'a str,
        account_id: Option<&'a str>,
    },
}

/// An optional trimmed string argument; `null` counts as absent.
fn usage_text_arg<'a>(args: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    match args.get(key).filter(|value| !value.is_null()) {
        None => Ok(None),
        Some(value) => value
            .as_str()
            .map(|value| Some(value.trim()))
            .ok_or_else(|| format!("host.usageSnapshot '{key}' must be a string")),
    }
}

fn parse_usage_args(args: &Value) -> Result<UsageArgs<'_>, String> {
    let agent_id = usage_text_arg(args, "agent_id")?;
    let provider_id = usage_text_arg(args, "provider_id")?;
    let account_id = usage_text_arg(args, "account_id")?;
    match (agent_id, provider_id) {
        (Some(_), Some(_)) => Err(
            "host.usageSnapshot accepts either 'agent_id' or 'provider_id', not both".to_owned(),
        ),
        (_, None) if account_id.is_some() => {
            Err("host.usageSnapshot 'account_id' requires 'provider_id'".to_owned())
        }
        (Some(agent_id), None) if !agent_id.is_empty() => Ok(UsageArgs::Agent(agent_id)),
        (None, Some(provider_id)) => {
            validate_subscription_id("provider_id", provider_id)?;
            if let Some(account_id) = account_id {
                validate_subscription_id("account_id", account_id)?;
            }
            Ok(UsageArgs::Provider {
                provider_id,
                account_id,
            })
        }
        _ => Err("host.usageSnapshot requires a non-empty 'agent_id' or 'provider_id'".to_owned()),
    }
}

/// Validate a caller-supplied provider or account id (1..=256 characters).
fn validate_subscription_id(field: &str, value: &str) -> Result<(), String> {
    let chars = value.chars().count();
    if value.trim().is_empty() || chars > crate::subscriptions::MAX_ID_CHARS {
        return Err(format!(
            "'{field}' must be 1..={} characters",
            crate::subscriptions::MAX_ID_CHARS
        ));
    }
    Ok(())
}

/// Fail-closed gate for the owner-tier subscription calls: the grant first,
/// then a verified node owner/admin caller. The admin check only runs once the
/// grant is held.
fn subscriptions_gate(
    plugin_id: &str,
    granted: bool,
    admin_allowed: impl FnOnce() -> bool,
) -> Result<(), String> {
    if !granted {
        return Err(format!(
            "capability '{GRANT_SUBSCRIPTIONS_READ}' not granted to plugin '{plugin_id}'"
        ));
    }
    if !admin_allowed() {
        return Err("subscriptions are visible to the node owner only".to_owned());
    }
    Ok(())
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubscriptionsListArgs {
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    usage: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubscriptionsUsageArgs {
    provider_id: String,
    #[serde(default)]
    account_id: Option<String>,
}

/// The bridge never forces a vendor read; `force` is owner-HTTP only.
fn parse_list_usage(usage: Option<&str>) -> Result<crate::subscriptions::UsageMode, String> {
    use crate::subscriptions::UsageMode;
    match usage {
        None | Some("cached") => Ok(UsageMode::Cached),
        Some("none") => Ok(UsageMode::None),
        Some("refresh") => Ok(UsageMode::Refresh),
        Some(_) => Err("subscriptions.list 'usage' must be none, cached or refresh".to_owned()),
    }
}

type LiveReadKey = (String, String, String);

/// Per-(plugin, provider, account) live-read limiter for the T1 bridge calls.
#[derive(Default)]
struct LiveReadLimiter {
    last: std::sync::Mutex<std::collections::HashMap<LiveReadKey, std::time::Instant>>,
}

impl LiveReadLimiter {
    /// `true` (and the slot is taken) when `key` had no live read in the last
    /// `interval`; `false` means the caller must stay cache-only.
    fn try_acquire(
        &self,
        key: LiveReadKey,
        now: std::time::Instant,
        interval: std::time::Duration,
    ) -> bool {
        let mut last = self
            .last
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        last.retain(|_, at| now.saturating_duration_since(*at) < interval);
        if last.contains_key(&key) {
            return false;
        }
        last.insert(key, now);
        true
    }
}

fn subscription_live_reads() -> &'static LiveReadLimiter {
    static LIMITER: std::sync::OnceLock<LiveReadLimiter> = std::sync::OnceLock::new();
    LIMITER.get_or_init(LiveReadLimiter::default)
}

/// The cached raw snapshot (and when it was observed) for one saved account
/// under its current credential revision. Never reads the vendor.
fn cached_account_snapshot(
    provider_id: &str,
    account_id: &str,
) -> Option<(ryu_usage::UsageSnapshot, String)> {
    let scope = crate::pi_config::provider_account_scope(provider_id)?;
    let revision = crate::pi_config::accounts::global()?
        .credential_revision(&scope, account_id)
        .ok()
        .flatten()?;
    let hit = crate::subscriptions::cache::global().lookup(
        provider_id,
        account_id,
        &revision,
        crate::subscriptions::cache::Freshness::MaxAge(crate::subscriptions::DEFAULT_MAX_AGE),
    )?;
    Some((hit.snapshot, hit.observed_at.to_rfc3339()))
}

/// Project one provider for the label-free hook form. Account rows carry ids,
/// eligibility and the cached raw snapshot only — never the saved label.
fn provider_usage_projection(
    provider: Option<&crate::subscriptions::SubscriptionProvider>,
    provider_id: &str,
    account_id: Option<&str>,
    cached: impl Fn(&str, &str) -> Option<(ryu_usage::UsageSnapshot, String)>,
) -> Value {
    use crate::subscriptions::AccountState;
    let usage_supported = provider.is_some_and(|provider| provider.capabilities.account_usage);
    let pool_strategy = provider
        .and_then(|provider| provider.policy.as_ref())
        .and_then(|policy| serde_json::to_value(policy.strategy).ok())
        .unwrap_or(Value::Null);
    let rows = provider.map_or(&[][..], |provider| provider.accounts.as_slice());
    let mut accounts = Vec::new();
    for row in rows
        .iter()
        .filter(|row| account_id.is_none_or(|wanted| row.account_id == wanted))
    {
        let mut state = row.state;
        let mut usage = Value::Null;
        let mut observed_at = None;
        if matches!(state, AccountState::Ok | AccountState::Unavailable) {
            match cached(provider_id, &row.account_id) {
                Some((snapshot, observed)) => {
                    usage = serde_json::to_value(snapshot).unwrap_or(Value::Null);
                    observed_at = Some(observed);
                }
                // The reading expired between the listing and this lookup.
                None if state == AccountState::Ok => state = AccountState::Pending,
                None => {}
            }
        }
        let mut entry = json!({
            "account_id": row.account_id,
            "active": row.active,
            "eligible": row.pool_enabled && !row.needs_reauth,
            "needs_reauth": row.needs_reauth,
            "state": serde_json::to_value(state).unwrap_or(Value::Null),
            "usage": usage,
        });
        if let (Some(observed_at), Some(object)) = (observed_at, entry.as_object_mut()) {
            object.insert("observed_at".to_owned(), Value::String(observed_at));
        }
        accounts.push(entry);
    }
    let account_not_found = account_id.is_some() && accounts.is_empty();
    let mut out = json!({
        "provider_id": provider_id,
        "usage_supported": usage_supported,
        "pool_strategy": pool_strategy,
        "accounts": accounts,
    });
    if account_not_found {
        out["error"] = Value::String("account_not_found".to_owned());
    }
    out
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

    #[test]
    fn manual_run_guard_refuses_a_second_claim_and_releases_on_drop() {
        let key = format!("test-plugin:user:conv-{}", uuid::Uuid::new_v4().simple());
        let first = ManualRunGuard::claim(&key).expect("first claim");
        assert!(ManualRunGuard::claim(&key).is_none());
        drop(first);
        assert!(ManualRunGuard::claim(&key).is_some());
    }

    /// A dropped handler future (client disconnect, an outer sandbox timeout)
    /// must release the slot; the old begin/end pair left it claimed forever.
    #[tokio::test]
    async fn manual_run_slot_is_released_when_the_run_is_cancelled() {
        let key = format!("test-plugin:user:conv-{}", uuid::Uuid::new_v4().simple());
        let (claimed_tx, claimed_rx) = tokio::sync::oneshot::channel();
        let run_key = key.clone();
        let run = tokio::spawn(async move {
            let _slot = ManualRunGuard::claim(&run_key).expect("claim");
            let _ = claimed_tx.send(());
            std::future::pending::<()>().await;
        });
        claimed_rx.await.expect("the run holds its slot");
        assert!(ManualRunGuard::claim(&key).is_none());
        run.abort();
        let _ = run.await;
        assert!(
            ManualRunGuard::claim(&key).is_some(),
            "a cancelled run must release its slot"
        );
    }

    #[test]
    fn execution_control_rejects_non_admin_and_cross_org_callers() {
        let mut caller = crate::identity_verify::VerifiedCaller {
            user_id: "user".to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org".to_owned()),
            role: crate::identity_verify::OrgRole::Viewer,
            teams: vec![],
        };
        assert!(!is_org_admin(None, "org"));
        assert!(!is_org_admin(Some(&caller), "org"));
        caller.role = crate::identity_verify::OrgRole::Admin;
        assert!(is_org_admin(Some(&caller), "org"));
        assert!(!is_org_admin(Some(&caller), "other-org"));
        caller.org_id = None;
        assert!(!is_org_admin(Some(&caller), "org"));
    }

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
        assert_eq!(GRANT_SPACES_DATABASE, "spaces:database");
        assert_eq!(GRANT_SET_TITLE, "conversation:set-title");
        assert_eq!(GRANT_PREFERENCES_READ, "preferences:read");
        assert_eq!(GRANT_BACKGROUND_CONTROL, "background:control");
        assert_eq!(GRANT_NOTIFY, "notifications:send");
        assert_eq!(GRANT_NOTIFY_TARGET, "notifications:send-to-user");
    }

    #[test]
    fn preference_host_reads_reject_credential_keys() {
        assert!(crate::server::preferences::is_secret_preference_key(
            "openrouter-api-key"
        ));
        assert!(crate::server::preferences::is_secret_preference_key(
            "node-onboarding-state"
        ));
        assert!(!crate::server::preferences::is_secret_preference_key(
            "theme"
        ));
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
    fn side_model_images_are_bounded_by_count_type_and_size() {
        let png = "data:image/png;base64,aGVsbG8=";
        assert!(validate_side_model_images(&json!({})).unwrap().is_empty());
        assert_eq!(
            validate_side_model_images(&json!({ "images": [png, "data:image/jpeg;base64,aGk=", "data:image/webp;base64,aGk="] }))
                .unwrap()
                .len(),
            3
        );
        let too_many = vec![png; MAX_SIDE_MODEL_IMAGES + 1];
        assert!(validate_side_model_images(&json!({ "images": too_many }))
            .unwrap_err()
            .contains("at most 8"));
        for bad in [
            json!({ "images": "data:image/png;base64,aGk=" }),
            json!({ "images": [42] }),
            json!({ "images": ["https://example.test/a.png"] }),
            json!({ "images": ["data:image/svg+xml;base64,PHN2Zz4="] }),
            json!({ "images": ["data:image/gif;base64,R0lGOA=="] }),
            json!({ "images": ["data:image/png;base64,"] }),
            json!({ "images": ["data:image/png;base64,not base64!"] }),
        ] {
            assert!(validate_side_model_images(&bad).is_err(), "{bad}");
        }
        // Each image under the cap, but together over it.
        let chunk = format!(
            "data:image/png;base64,{}",
            "A".repeat(MAX_SIDE_MODEL_IMAGE_BYTES / 2)
        );
        assert!(validate_side_model_images(&json!({ "images": [chunk.clone()] })).is_ok());
        assert!(
            validate_side_model_images(&json!({ "images": [chunk.clone(), chunk] }))
                .unwrap_err()
                .contains("1.5 MiB")
        );
    }

    #[test]
    fn side_model_request_is_bounded_by_its_encoded_size() {
        // Within every per-field limit, but escaped text plus a full image
        // budget encodes past the Gateway's 2 MiB chat body limit.
        let escaped = "\u{1}".repeat(64 * 1024);
        let image = format!(
            "data:image/png;base64,{}",
            "A".repeat(MAX_SIDE_MODEL_IMAGE_BYTES - 64)
        );
        let images = validate_side_model_images(&json!({ "images": [image] })).unwrap();
        let payload = crate::server::side_model_payload("m", "", &escaped, &escaped, &images);
        let error = crate::server::encode_side_model_request(&payload).unwrap_err();
        assert!(error.contains("2 MiB chat request limit"), "{error}");

        let fits = crate::server::side_model_payload("m", "", "system", "describe", &images);
        let bytes = crate::server::encode_side_model_request(&fits).unwrap();
        assert!(bytes.len() <= crate::server::MAX_SIDE_MODEL_REQUEST_BYTES);
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), fits);
    }

    #[test]
    fn side_model_payload_uses_image_url_parts_only_when_images_are_present() {
        let plain = crate::server::side_model_payload("m", "", "sys", "describe", &[]);
        assert_eq!(plain["messages"][1]["content"], json!("describe"));
        assert!(plain.get("reasoning_effort").is_none());

        let images = vec![
            "data:image/png;base64,aGVsbG8=".to_owned(),
            "data:image/jpeg;base64,aGk=".to_owned(),
        ];
        let vision = crate::server::side_model_payload("m", "low", "sys", "tag these", &images);
        assert_eq!(
            vision["messages"][0],
            json!({ "role": "system", "content": "sys" })
        );
        assert_eq!(
            vision["messages"][1]["content"],
            json!([
                { "type": "text", "text": "tag these" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,aGVsbG8=" } },
                { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,aGk=" } },
            ])
        );
        assert_eq!(vision["reasoning_effort"], json!("low"));
        assert_eq!(vision["stream"], json!(false));
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
        assert_eq!(
            grant_for("spaces.queryDatabase"),
            Some(GRANT_SPACES_DATABASE)
        );
        assert_eq!(
            grant_for("spaces.deleteDatabase"),
            Some(GRANT_SPACES_DATABASE)
        );
        // `finetune.*` keeps its host-API grant row (host API is additive within a
        // major) but has no Core bridge path: hosts forward it to the app's own
        // sidecar through the generic ext-proxy.
        assert_eq!(grant_for("finetune.start"), Some("finetune:runs"));
        assert_eq!(dispatch_path_for("finetune.start"), None);
        assert_eq!(grant_for("conversation.setTitle"), Some(GRANT_SET_TITLE));
        assert_eq!(
            grant_for("conversation.addReaction"),
            Some(GRANT_CONVERSATION_REACTIONS)
        );
        assert_eq!(grant_for("preferences.get"), Some(GRANT_PREFERENCES_READ));
        assert_eq!(grant_for("background.list"), Some(GRANT_BACKGROUND_CONTROL));
        assert_eq!(grant_for("gateway.budgetSpend"), Some(GRANT_USAGE_READ));
        assert_eq!(grant_for("gateway.audit"), Some(GRANT_USAGE_AUDIT));
        assert_ne!(grant_for("gateway.audit"), grant_for("usage.snapshot"));
        assert_eq!(grant_for("usage.snapshot"), Some(GRANT_USAGE_READ));
        assert_eq!(
            grant_for("subscriptions.list"),
            Some(GRANT_SUBSCRIPTIONS_READ)
        );
        assert_eq!(
            grant_for("subscriptions.usage"),
            Some(GRANT_SUBSCRIPTIONS_READ)
        );
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
            "spaces.createDatabase",
            "conversation.setTitle",
            "conversation.addReaction",
            "preferences.get",
            "background.list",
            "background.stop",
            "gateway.budgetSpend",
            "gateway.audit",
            "subscriptions.list",
            "subscriptions.usage",
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
            "security_check"
                | "identity_current"
                | "authorization_issue"
                | "authorization_check"
                | "execution_pause"
                | "execution_resume"
                | "execution_status"
                | "catalogSnapshot"
                | "catalogModels"
                | "sideModel"
                | "runAgent"
                | "runFanout"
                | "backups_destinations"
                | "backups_create"
                | "backups_list"
                | "backups_get"
                | "backups_restore"
                | "storage_get"
                | "storage_set"
                | "storage_delete"
                | "storage_keys"
                | "storage_compare_and_set"
                | "crypto_seal"
                | "crypto_open"
                | "crypto_status"
                | "spaces_search"
                | "spaces_ensure_space"
                | "spaces_create_doc"
                | "spaces_get_doc"
                | "spaces_update_doc"
                | "spaces_list_docs"
                | "spaces_delete_doc"
                | "spaces_create_database"
                | "spaces_list_databases"
                | "spaces_get_database"
                | "spaces_update_database"
                | "spaces_query_database"
                | "spaces_delete_database"
                | "setConversationTitle"
                | "addMessageReaction"
                | "getPreference"
                | "usageSnapshot"
                | "subscriptions_list"
                | "subscriptions_usage"
                | "gatewayBudgetSpend"
                | "gatewayAudit"
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
    fn subscriptions_gate_denies_missing_grant_before_checking_the_caller() {
        let error = subscriptions_gate("com.x.app", false, || {
            panic!("the caller check must not run without the grant")
        })
        .expect_err("ungranted");
        assert!(
            error.starts_with("capability 'subscriptions:read' not granted"),
            "{error}"
        );
    }

    #[test]
    fn subscriptions_gate_denies_a_non_admin_caller() {
        assert_eq!(
            subscriptions_gate("com.x.app", true, || false),
            Err("subscriptions are visible to the node owner only".to_owned())
        );
        assert_eq!(subscriptions_gate("com.x.app", true, || true), Ok(()));
    }

    #[test]
    fn subscriptions_args_reject_unknown_fields_and_force() {
        assert!(serde_json::from_value::<SubscriptionsListArgs>(json!({})).is_ok());
        assert!(
            serde_json::from_value::<SubscriptionsListArgs>(json!({ "provider": "x" })).is_err()
        );
        assert!(serde_json::from_value::<SubscriptionsUsageArgs>(
            json!({ "providerId": "claude-pro-max", "accountId": "acct_1", "label": true })
        )
        .is_err());
        assert!(serde_json::from_value::<SubscriptionsUsageArgs>(json!({})).is_err());
        assert!(parse_list_usage(Some("force")).is_err());
        assert_eq!(
            parse_list_usage(None),
            Ok(crate::subscriptions::UsageMode::Cached)
        );
        assert_eq!(
            parse_list_usage(Some("refresh")),
            Ok(crate::subscriptions::UsageMode::Refresh)
        );
        assert!(validate_subscription_id("providerId", "").is_err());
        assert!(validate_subscription_id("providerId", &"a".repeat(257)).is_err());
        assert!(validate_subscription_id("providerId", &"a".repeat(256)).is_ok());
    }

    #[test]
    fn subscription_live_reads_are_limited_per_plugin_provider_and_account() {
        let limiter = LiveReadLimiter::default();
        let start = std::time::Instant::now();
        let interval = SUBSCRIPTION_LIVE_READ_INTERVAL;
        let key = |plugin: &str, account: &str| {
            (
                plugin.to_owned(),
                "claude-pro-max".to_owned(),
                account.to_owned(),
            )
        };
        assert!(limiter.try_acquire(key("a", "acct_1"), start, interval));
        assert!(!limiter.try_acquire(key("a", "acct_1"), start, interval));
        assert!(limiter.try_acquire(key("a", "acct_2"), start, interval));
        assert!(limiter.try_acquire(key("b", "acct_1"), start, interval));
        assert!(limiter.try_acquire(key("a", "acct_1"), start + interval, interval));
    }

    #[test]
    fn usage_args_accept_exactly_one_form() {
        assert_eq!(
            parse_usage_args(&json!({ "agent_id": " claude " })),
            Ok(UsageArgs::Agent("claude"))
        );
        assert_eq!(
            parse_usage_args(&json!({ "provider_id": "claude-pro-max" })),
            Ok(UsageArgs::Provider {
                provider_id: "claude-pro-max",
                account_id: None
            })
        );
        assert_eq!(
            parse_usage_args(&json!({ "provider_id": "claude-pro-max", "account_id": "acct_1" })),
            Ok(UsageArgs::Provider {
                provider_id: "claude-pro-max",
                account_id: Some("acct_1")
            })
        );
        for invalid in [
            json!({ "agent_id": "claude", "provider_id": "claude-pro-max" }),
            json!({ "agent_id": "claude", "account_id": "acct_1" }),
            json!({ "account_id": "acct_1" }),
            json!({ "agent_id": "" }),
            json!({ "provider_id": "" }),
            json!({ "provider_id": 7 }),
            json!({}),
        ] {
            assert!(
                parse_usage_args(&invalid).is_err(),
                "{invalid} must be rejected"
            );
        }
    }

    fn pool_provider() -> crate::subscriptions::SubscriptionProvider {
        use crate::server::oauth_pool_policy::Strategy;
        use crate::subscriptions::{
            AccountPinning, AccountState, PoolPolicySummary, ProviderCapabilities, ProviderKind,
            SubscriptionAccount, SubscriptionProvider,
        };
        let account =
            |account_id: &str, state: AccountState, needs_reauth: bool| SubscriptionAccount {
                account_id: account_id.to_owned(),
                label: Some(format!("{account_id}@example.test")),
                kind: "oauth".to_owned(),
                active: account_id == "acct_ok",
                gateway_active: false,
                needs_reauth,
                updated_at: 1,
                connection_state: None,
                pool_enabled: state != AccountState::PoolDisabled,
                pool_priority: Some(0),
                state,
                usage: None,
            };
        SubscriptionProvider {
            provider_id: "claude-pro-max".to_owned(),
            label: "Claude Pro/Max".to_owned(),
            kind: ProviderKind::Subscription,
            managed: false,
            capabilities: ProviderCapabilities {
                account_usage: true,
                account_ping: true,
                account_pinning: AccountPinning::None,
                pool_strategies: vec![Strategy::QuotaFirst],
                quota_observations: true,
            },
            policy: Some(PoolPolicySummary {
                strategy: Strategy::QuotaFirst,
                drain_threshold_percent: 80,
            }),
            active_account_id: Some("acct_ok".to_owned()),
            accounts: vec![
                account("acct_ok", AccountState::Ok, false),
                account("acct_expired", AccountState::Ok, false),
                account("acct_reauth", AccountState::NeedsReauth, true),
                account("acct_off", AccountState::PoolDisabled, false),
            ],
        }
    }

    fn cached_ok(
        provider_id: &str,
        account_id: &str,
    ) -> Option<(ryu_usage::UsageSnapshot, String)> {
        (account_id == "acct_ok").then(|| {
            (
                ryu_usage::UsageSnapshot {
                    agent_id: provider_id.to_owned(),
                    engine: "claude".to_owned(),
                    available: true,
                    provider_id: Some(provider_id.to_owned()),
                    account_id: Some(account_id.to_owned()),
                    ..Default::default()
                },
                "2026-10-14T00:00:00+00:00".to_owned(),
            )
        })
    }

    #[test]
    fn provider_usage_form_is_label_free_and_cache_only() {
        let provider = pool_provider();
        let out = provider_usage_projection(Some(&provider), "claude-pro-max", None, cached_ok);
        assert_eq!(out["provider_id"], "claude-pro-max");
        assert_eq!(out["usage_supported"], true);
        assert_eq!(out["pool_strategy"], "quota_first");
        assert!(out.get("error").is_none());
        let accounts = out["accounts"].as_array().expect("accounts");
        assert_eq!(accounts.len(), 4);
        for account in accounts {
            let object = account.as_object().expect("account object");
            assert!(!object.contains_key("label"));
            assert!(!object.contains_key("account_label"));
        }
        assert!(!out.to_string().contains("@example.test"));

        assert_eq!(accounts[0]["state"], "ok");
        assert_eq!(accounts[0]["eligible"], true);
        assert_eq!(accounts[0]["usage"]["account_id"], "acct_ok");
        assert_eq!(accounts[0]["observed_at"], "2026-10-14T00:00:00+00:00");
        // A listed reading that expired before the raw lookup reads as pending.
        assert_eq!(accounts[1]["state"], "pending");
        assert!(accounts[1]["usage"].is_null());
        assert!(accounts[1].get("observed_at").is_none());
        assert_eq!(accounts[2]["state"], "needs_reauth");
        assert_eq!(accounts[2]["eligible"], false);
        assert_eq!(accounts[3]["state"], "pool_disabled");
        assert_eq!(accounts[3]["eligible"], false);
    }

    #[test]
    fn provider_usage_form_reports_unknown_account_and_unknown_provider() {
        let provider = pool_provider();
        let out = provider_usage_projection(
            Some(&provider),
            "claude-pro-max",
            Some("acct_missing"),
            cached_ok,
        );
        assert_eq!(out["accounts"], json!([]));
        assert_eq!(out["error"], "account_not_found");

        let one = provider_usage_projection(
            Some(&provider),
            "claude-pro-max",
            Some("acct_ok"),
            cached_ok,
        );
        assert_eq!(one["accounts"].as_array().map(Vec::len), Some(1));

        let unknown = provider_usage_projection(None, "nope", None, cached_ok);
        assert_eq!(unknown["usage_supported"], false);
        assert!(unknown["pool_strategy"].is_null());
        assert_eq!(unknown["accounts"], json!([]));
        assert!(unknown.get("error").is_none());
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
    fn plain_run_agent_grant_only_allows_read_only_presets() {
        let read = grants(&["hook:run-agent"]);
        for preset in [
            PermissionPreset::CodeRead,
            PermissionPreset::Research,
            PermissionPreset::Summarise,
        ] {
            assert!(check_preset_grant(&read, "p", preset).is_ok());
        }
        let denied = check_preset_grant(&read, "p", PermissionPreset::CodeWrite)
            .expect_err("code_write must need the write grant");
        assert!(denied.contains("hook:run-agent:write"));
        assert!(denied.contains("not granted"));

        let write = grants(&["hook:run-agent", "hook:run-agent:write"]);
        assert!(check_preset_grant(&write, "p", PermissionPreset::CodeWrite).is_ok());
    }

    fn refusal_of(outcome: InvokeOutcome) -> Option<String> {
        match outcome {
            InvokeOutcome::Result(result) if result.is_error => result.error,
            _ => None,
        }
    }

    #[tokio::test]
    async fn a_calling_agent_with_limited_model_providers_cannot_fan_out_on_all_of_them() {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let limited = state
            .agent_store
            .create(crate::agents::CreateAgent {
                name: "Limited".into(),
                ..Default::default()
            })
            .await
            .unwrap()
            .id;
        state
            .agent_store
            .update(
                &limited,
                crate::agents::UpdateAgent {
                    account_access: Some(Some(vec!["provider:openai".into()])),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let open = state
            .agent_store
            .create(crate::agents::CreateAgent {
                name: "Open".into(),
                ..Default::default()
            })
            .await
            .unwrap()
            .id;
        let bridge_for = |agent: &str| {
            PluginHookBridge::new_for_agent_tool(
                "@test/app".to_owned(),
                grants(&["hook:run-agent", "hook:side-model"]),
                state.clone(),
                Some(agent),
                Some("conv-1"),
            )
        };

        let bridge = bridge_for(&limited);
        assert_eq!(
            bridge.calling_agent_provider_access().await.as_deref(),
            Some("openai")
        );
        let delegates = json!({ "delegates": [{ "id": "a", "task": "x" }] });
        for (verb, outcome) in [
            (
                "host.runAgent",
                bridge.run_agent(json!({ "task": "x" })).await,
            ),
            ("host.runFanout", bridge.run_fanout(delegates).await),
        ] {
            let error = refusal_of(outcome).expect("a limited agent is refused");
            assert!(error.starts_with(verb), "{error}");
            assert!(error.contains("model providers"), "{error}");
        }

        // An unrestricted agent, and a bridge with no calling agent, carry no limit.
        assert_eq!(
            bridge_for(&open).calling_agent_provider_access().await,
            None
        );
        let no_agent = PluginHookBridge::new_for_agent_tool(
            "@test/app".to_owned(),
            grants(&["hook:run-agent"]),
            state.clone(),
            None,
            None,
        );
        assert_eq!(no_agent.calling_agent_provider_access().await, None);
    }

    #[test]
    fn run_agent_gate_requires_grant() {
        let g = grants(&["hook:side-model"]);
        assert!(!g.contains(GRANT_RUN_AGENT));
        let g = grants(&["hook:run-agent"]);
        assert!(g.contains(GRANT_RUN_AGENT));
    }

    #[test]
    fn agent_run_permission_is_skipped_only_for_an_identified_parent_agent() {
        assert!(requires_user_agent_run_permission(false, false));
        assert!(!requires_user_agent_run_permission(false, true));
        assert!(requires_user_agent_run_permission(true, false));
        assert!(requires_user_agent_run_permission(true, true));
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
