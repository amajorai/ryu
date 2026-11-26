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
#[path = "hook_text_bridge.rs"]
mod hook_text_bridge;
#[path = "notify_bridge.rs"]
mod notify_bridge;
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

mod actions;
mod agents;
mod catalog;
mod conversation;
mod dispatch;
mod spaces;
mod spaces_search;
mod storage;
mod support;
mod usage;

use support::*;

#[cfg(test)]
mod runtime_tests;
#[cfg(test)]
mod tests;
