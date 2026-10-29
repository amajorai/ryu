//! `POST /api/plugins/:plugin_id/host` — the app host-capability bridge over HTTP.
//!
//! Exposes the SAME [`PluginHookBridge`] capabilities the JS turn-hook sandbox
//! uses (`host.sideModel` / `host.runAgent` / `host.storage_*`) to a full-page
//! **Companion** app's sandboxed iframe. The desktop host (the trusted webview)
//! holds the node token and is the sole caller; the null-origin iframe reaches
//! here only through the capability-gated `MessagePort` RPC — its CSP is
//! `connect-src 'none'`, so it cannot fetch this route directly. An agent's
//! node-token loopback (the CoreApi self-API) is kept out by the
//! `self_api::is_denied` rule for `/api/plugins/*/host`, so the verified user
//! here is always the desktop's signed-in user, never a stand-in.
//!
//! Security model (locked design — `docs/ryu-apps-extensibility.md`):
//! - **Auth**: inherits `require_auth` (mounted on the protected router). No inline
//!   token check; Core's `enforce_remote_auth` guarantees a remote node is token-gated.
//! - **Enabled gate**: a live, per-request `app_store` lookup; 404 unless `rec.enabled`
//!   (copied from `plugin_ui_bundle`). A just-disabled plugin stops working at once.
//! - **Grants**: built from `rec.approved_grants` (the Gateway-validated subset), NEVER
//!   the manifest `permission_grants` claim. Disabled ⇒ `approved_grants == []` ⇒
//!   deny-all even absent the enabled gate.
//! - **`plugin_id` from the PATH only**: it is both the grant-lookup key AND the storage
//!   namespace owner inside the bridge, so a body-supplied id could never let app A run
//!   under app B's grants/storage. Pinning both to the path id IS the cross-plugin
//!   isolation guarantee.
//! - **Closed method set**: the desktop method is allowlisted and reassembled as
//!   `host.<...>`; the caller cannot inject a different `host.*` namespace.
//!   Core-owned operations (`server::app_*`) are matched by name. The user-aware
//!   ones — `safeActions.request` (plan review) and `webhooks.secretGet` /
//!   `webhooks.secretSet` — are bridge-only: they need the app's grant AND the
//!   verified caller's own permission, run under that caller (never an identity
//!   from the args), and record that caller as the reviewer.
//! - **`agent.run` spawn-concurrency** is bounded per-plugin by a semaphore (a compute/
//!   process DoS guard); each sub-agent's model egress is separately Gateway-governed.
//!
//! Placement (AGENTS.md §1): this decides *what runs* for an app (a completion, a
//! sub-agent, its own KV) — Core. The grant/budget/audit of each model call it makes
//! is the Gateway's, reached through the same bridge the sandbox uses.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use axum::{
    extract::{Extension, Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use super::kernel_op::KernelOpError;
use super::ServerState;
use crate::plugin_host::PluginHookBridge;
use crate::tool_exec::{InvokeOutcome, SandboxBridge};

/// Max concurrent agent/fan-out spawns per plugin (a spawn-DoS guard; each
/// delegate's model egress is separately Gateway-governed by budgets).
const MAX_CONCURRENT_RUN_AGENT_PER_PLUGIN: usize = 2;

/// Map a desktop-facing method to the closed `host.<path>` string the bridge matches
/// (`handle_inner` strips the `host.` prefix). A method absent here is rejected — the
/// caller can never forward a verbatim path into a different capability namespace.
fn bridge_path_for(method: &str) -> Option<&'static str> {
    match method {
        "catalog.snapshot" => Some("host.catalogSnapshot"),
        "catalog.models" => Some("host.catalogModels"),
        "model.complete" => Some("host.sideModel"),
        "agent.run" => Some("host.runAgent"),
        "agent.runFanout" => Some("host.runFanout"),
        "storage.get" => Some("host.storage_get"),
        "backups.destinations"
        | "backups.create"
        | "backups.list"
        | "backups.get"
        | "backups.restore" => crate::plugin_host::dispatch_path_for(method),
        "storage.set" => Some("host.storage_set"),
        "storage.delete" => Some("host.storage_delete"),
        "storage.keys" => Some("host.storage_keys"),
        "storage.compareAndSet" => Some("host.storage_compare_and_set"),
        "crypto.seal" => Some("host.crypto_seal"),
        "crypto.open" => Some("host.crypto_open"),
        "crypto.status" => Some("host.crypto_status"),
        "spaces.ensureSpace" => Some("host.spaces_ensure_space"),
        "spaces.search" => crate::plugin_host::dispatch_path_for(method),
        "spaces.createDoc" => Some("host.spaces_create_doc"),
        "spaces.getDoc" => Some("host.spaces_get_doc"),
        "spaces.updateDoc" => Some("host.spaces_update_doc"),
        "spaces.listDocs" => Some("host.spaces_list_docs"),
        "spaces.deleteDoc" => Some("host.spaces_delete_doc"),
        "spaces.createDatabase" => Some("host.spaces_create_database"),
        "spaces.listDatabases" => Some("host.spaces_list_databases"),
        "spaces.getDatabase" => Some("host.spaces_get_database"),
        "spaces.updateDatabase" => Some("host.spaces_update_database"),
        "spaces.queryDatabase" => Some("host.spaces_query_database"),
        "spaces.deleteDatabase" => Some("host.spaces_delete_database"),
        "conversation.setTitle" => Some("host.setConversationTitle"),
        "conversation.addReaction" => Some("host.addMessageReaction"),
        "preferences.get" => Some("host.getPreference"),
        "background.list" => Some("host.background_list"),
        "background.stop" => Some("host.background_stop"),
        "execution.pause" | "execution.resume" | "execution.status" => {
            crate::plugin_host::dispatch_path_for(method)
        }
        "gateway.budgetSpend" => crate::plugin_host::dispatch_path_for(method),
        "gateway.audit" => crate::plugin_host::dispatch_path_for(method),
        "subscriptions.list" | "subscriptions.usage" => {
            crate::plugin_host::dispatch_path_for(method)
        }
        "learning.recordFeedback" => Some("host.recordFeedback"),
        "learning.synthesizeSkill" => Some("host.synthesizeSkill"),
        "hooks.run" => Some("host.runHook"),
        _ => None,
    }
}

/// The grant a method requires. Checked at the endpoint (a clean 403 before dispatch)
/// AND again inside the bridge (defense in depth) — the two never trust each other.
///
/// Single-sourced: reads the `method → grant` table from `ryu-kernel-contracts`
/// ([`ryu_kernel_contracts::grant_for`]), the SAME table the TS app host derives its
/// `METHOD_CAPABILITY` / `GRANT_CAPABILITY` from, so the two vocabularies can never
/// drift. The table also carries grants for methods this bridge does NOT dispatch
/// (monitors/workflows/… are TS-host-direct), but `plugin_bridge_dispatch` still
/// double-gates on [`bridge_path_for`], so a grant here without a bridge path is
/// rejected as `unknown host method` exactly as before — see the dispatch match.
/// `view.action` (grant `views:actions`) is the one bridge-gated method with no unary
/// bridge path; it is handled by its own dispatch branch.
fn required_grant_for(method: &str) -> Option<&'static str> {
    ryu_kernel_contracts::host_api::grant_for(method)
}

fn requires_agent_run_permission(method: &str) -> bool {
    matches!(method, "agent.run" | "agent.runFanout")
}

/// One in-flight `agent.run` limiter per plugin id.
fn run_agent_gate(plugin_id: &str) -> Arc<Semaphore> {
    static GATES: OnceLock<Mutex<HashMap<String, Arc<Semaphore>>>> = OnceLock::new();
    let map = GATES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().expect("run_agent_gate mutex poisoned");
    guard
        .entry(plugin_id.to_string())
        .or_insert_with(|| Arc::new(Semaphore::new(MAX_CONCURRENT_RUN_AGENT_PER_PLUGIN)))
        .clone()
}

/// Refusal for a host-bridge call the web tier forwarded for a browser (it carries
/// [`crate::sidecar::ext_proxy::HDR_WEB_DELEGATION`]) whose caller is not a verified
/// member of a bound node. The web tier holds the node token for many users, which
/// an unbound node would otherwise read as its owner; this is the same candidacy
/// rule as `/api/ext` (`server::web_delegated_candidate`). The marker only ever
/// narrows: a call without it is handled exactly as before.
fn refuse_unadmitted_web_delegation(
    headers: &HeaderMap,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> Option<axum::response::Response> {
    if !headers.contains_key(crate::sidecar::ext_proxy::HDR_WEB_DELEGATION) {
        return None;
    }
    let status = super::web_delegated_candidate(caller).err()?;
    Some(err_response(
        status,
        "denied",
        "a web request needs a signed-in member of a node bound to an organization".to_owned(),
    ))
}

/// Request body: `{ method, args }`. `args` is forwarded to the bridge VERBATIM —
/// every bridge method narrows its own fields defensively (`as_str`/`as_u64`/clamp).
#[derive(Deserialize)]
pub struct HostDispatchBody {
    pub method: String,
    #[serde(default)]
    pub args: Value,
}

/// `POST /api/plugins/:plugin_id/host` — dispatch one host-capability call for an
/// enabled app, gated by that app's Gateway-approved grants.
#[utoipa::path(
    post,
    path = "/api/plugins/{id}/host",
    tag = "Plugins",
    summary = "dispatch one host-capability call for an",
    params(("plugin_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn plugin_bridge_dispatch(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(plugin_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<HostDispatchBody>,
) -> axum::response::Response {
    if let Some(refusal) = refuse_unadmitted_web_delegation(&headers, &caller) {
        return refusal;
    }
    // Allowlist the method → closed `host.*` path (no verbatim path injection).
    // `view.action` is the one grant-gated method with NO unary bridge path: the
    // shell relays a declarative-view intent to the owning app. It is dispatched
    // by its own branch below (after the enabled + grant gates), never the bridge.
    let is_view_action = body.method == "view.action";
    // Core-owned kernel operations a Companion reaches through this bridge (the
    // same in-process implementation as the matching `KERNEL_CAPABILITIES` row),
    // gated by the host-API table's grant for the method.
    let webhook_op = crate::server::app_webhooks::WebhookOp::from_name(&body.method);
    let warmup_op = crate::server::app_warmup::WarmupOp::from_name(&body.method);
    // User-aware operations: bridge-only (no kernel row), run under the verified
    // caller, which their handlers check for its own permission.
    let webhook_secret_op = crate::server::app_webhooks::WebhookSecretOp::from_name(&body.method);
    let safe_actions_op = crate::server::app_safe_actions::SafeActionsOp::from_name(&body.method);
    let (bridge_path, required_grant) = if is_view_action {
        (None, "views:actions")
    } else if webhook_op.is_some()
        || warmup_op.is_some()
        || webhook_secret_op.is_some()
        || safe_actions_op.is_some()
    {
        match required_grant_for(&body.method) {
            Some(grant) => (None, grant),
            None => {
                return err_response(
                    StatusCode::BAD_REQUEST,
                    "invalid_args",
                    format!("unknown host method '{}'", body.method),
                );
            }
        }
    } else {
        match (
            bridge_path_for(&body.method),
            required_grant_for(&body.method),
        ) {
            (Some(path), Some(grant)) => (Some(path), grant),
            _ => {
                return err_response(
                    StatusCode::BAD_REQUEST,
                    "invalid_args",
                    format!("unknown host method '{}'", body.method),
                );
            }
        }
    };

    // Live enabled gate + approved-grant load (never the unvalidated manifest claim).
    let record = match state.app_store.get(&plugin_id).await {
        Ok(Some(rec)) if rec.enabled => rec,
        Ok(_) => {
            return err_response(
                StatusCode::NOT_FOUND,
                "not_found",
                "plugin not enabled".to_owned(),
            );
        }
        Err(e) => {
            return err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                e.to_string(),
            );
        }
    };
    let grants =
        crate::plugin_host::current_approved_grants(&state, &plugin_id, &record.approved_grants)
            .await;

    // Endpoint-level grant gate: a clean `denied` before we spin anything up.
    if !grants.contains(required_grant) {
        return err_response(
            StatusCode::FORBIDDEN,
            "denied",
            format!("capability '{required_grant}' not granted to this app"),
        );
    }

    if requires_agent_run_permission(&body.method)
        && crate::server::enforce_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_RUN,
        )
        .await
        .is_err()
    {
        return err_response(
            StatusCode::FORBIDDEN,
            "denied",
            "insufficient permissions: agent.run".to_owned(),
        );
    }

    // Manual hooks read a caller-selected transcript. Bind that selection to a
    // verified caller and the exact conversation ACL before any hook code is
    // spawned; the bridge repeats the binding as defense in depth.
    let authorized_conversation_id = if body.method == "hooks.run" {
        let Some(conversation_id) = body
            .args
            .get("conversation_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            return err_response(
                StatusCode::BAD_REQUEST,
                "invalid_args",
                "hooks.run requires a non-empty conversation_id".to_owned(),
            );
        };
        if let Err(response) =
            crate::server::require_conversation_read_by_id(&state, &caller, conversation_id).await
        {
            return response;
        }
        Some(conversation_id.to_owned())
    } else {
        None
    };

    // `view.action`: the shell relays an app-backed declarative-view intent (an
    // action with no declarative `http` handler). It is grant-gated (above) and
    // audited (the tracing line below), then routed to the owning plugin's OWN
    // `view_action` hooks — `plugin_id` is the path id, so an app can never reach
    // another app's handler. A plugin with no such hook gets an explicit 404 that
    // names the missing hook phase instead of a silent drop.
    if is_view_action {
        tracing::info!(
            plugin = %plugin_id,
            args = %body.args,
            "plugin view.action intent received"
        );
        let outcome = crate::plugin_host::dispatch_view_action(
            &state, &plugin_id, &grants, caller, &body.args,
        )
        .await;
        return view_action_response(&plugin_id, &body.args, outcome);
    }
    if let Some(op) = webhook_op {
        return Json(json!({ "result": op.run(&state).await })).into_response();
    }
    if let Some(op) = warmup_op {
        // The path id is the owner every job is scoped to; the verified user is
        // still checked for `agent.view` / `agent.edit` by the scheduler handlers.
        let outcome = op.run(&state, &plugin_id, &caller, &body.args).await;
        return kernel_op_reply(&body.method, outcome);
    }
    // Neither args nor results of these two are ever logged: secretGet/Set carry
    // signing secrets.
    if let Some(op) = webhook_secret_op {
        let outcome = op.run(&state, &caller, &body.args).await;
        return kernel_op_reply(&body.method, outcome);
    }
    if let Some(op) = safe_actions_op {
        let outcome = op.run(&state, &caller, &body.args).await;
        return kernel_op_reply(&body.method, outcome);
    }
    // Every non-view.action method resolved a concrete bridge path above.
    let Some(bridge_path) = bridge_path else {
        return err_response(
            StatusCode::BAD_REQUEST,
            "invalid_args",
            format!("unknown host method '{}'", body.method),
        );
    };

    // Bound the heavy sub-agent paths per plugin. Held for the whole call.
    let _permit = if matches!(body.method.as_str(), "agent.run" | "agent.runFanout") {
        match run_agent_gate(&plugin_id).try_acquire_owned() {
            Ok(permit) => Some(permit),
            Err(_) => {
                return err_response(
                    StatusCode::TOO_MANY_REQUESTS,
                    "over_budget",
                    "too many concurrent agent runs for this app".to_owned(),
                );
            }
        }
    } else {
        None
    };

    // Reuse the exact bridge the JS sandbox uses — one implementation, one grant
    // vocabulary. `plugin_id` moves in as both the grant subject and the storage owner.
    let bridge = PluginHookBridge::new_for_request(
        plugin_id,
        grants,
        state,
        caller,
        authorized_conversation_id,
    );
    match bridge.handle(bridge_path.to_owned(), body.args).await {
        InvokeOutcome::Result(r) if r.is_error => {
            let message = r
                .error
                .unwrap_or_else(|| "capability call failed".to_owned());
            let (status, code) = classify_bridge_error(&message);
            err_response(status, code, message)
        }
        InvokeOutcome::Result(r) => Json(json!({ "result": r.value })).into_response(),
        // A one-shot HTTP call cannot drive an interactive elicitation (the three
        // exposed methods never suspend, but stay defensive against future ones).
        InvokeOutcome::Suspend(_) => err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            "capability requires interactive elicitation".to_owned(),
        ),
    }
}

/// Map a relayed view intent's outcome onto the host-bridge HTTP contract.
fn view_action_response(
    plugin_id: &str,
    args: &Value,
    outcome: crate::plugin_host::ViewActionOutcome,
) -> axum::response::Response {
    use crate::plugin_host::{ViewActionOutcome, ON_VIEW_ACTION};
    let action_id = args
        .get("action_id")
        .and_then(Value::as_str)
        .unwrap_or("(unnamed)");
    match outcome {
        ViewActionOutcome::NoHandler => err_response(
            StatusCode::NOT_FOUND,
            "not_found",
            format!(
                "plugin '{plugin_id}' declares no enabled `{ON_VIEW_ACTION}` hook to handle view action '{action_id}'; add a `contributes.turn_hooks` entry with `on: \"{ON_VIEW_ACTION}\"` or a declarative `http` handler on the action"
            ),
        ),
        ViewActionOutcome::Unavailable => err_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "server_error",
            "the sandbox that runs plugin hooks is not available on this node".to_owned(),
        ),
        ViewActionOutcome::Declined { hook_ids } => err_response(
            StatusCode::CONFLICT,
            "invalid_args",
            format!(
                "view action '{action_id}' was not handled: hook(s) {} declined it (unrecognized intent, or the hook's work failed)",
                hook_ids.join(", ")
            ),
        ),
        ViewActionOutcome::Handled { hook_ids, messages } => Json(json!({
            "result": {
                "handled": true,
                "hooks": hook_ids,
                "message": messages.join("\n"),
            }
        }))
        .into_response(),
    }
}

/// Classify a bridge `is_error` message into a status + closed error code. The grant
/// case is already handled at the endpoint, so remaining errors are bad-args (empty
/// prompt/task/key) or an upstream model/storage failure.
fn classify_bridge_error(message: &str) -> (StatusCode, &'static str) {
    let lower = message.to_ascii_lowercase();
    if lower.contains("not granted") {
        (StatusCode::FORBIDDEN, "denied")
    } else if lower.contains("revision conflict") {
        (StatusCode::CONFLICT, "conflict")
    } else if lower.contains("requires") || lower.contains("non-empty") || lower.contains("empty") {
        (StatusCode::BAD_REQUEST, "invalid_args")
    } else {
        (StatusCode::INTERNAL_SERVER_ERROR, "server_error")
    }
}

/// The bridge reply for an in-process kernel operation's outcome.
fn kernel_op_reply(
    method: &str,
    outcome: Result<Value, KernelOpError>,
) -> axum::response::Response {
    match outcome {
        Ok(value) => Json(json!({ "result": value })).into_response(),
        Err(error) => kernel_op_error(method, error),
    }
}

/// What a generic message names for a failed kernel operation.
fn kernel_op_label(method: &str) -> &'static str {
    match method {
        "safeActions.request" => "Safe Actions request",
        "webhooks.secretGet" => "webhook secret read",
        "webhooks.secretSet" => "webhook secret update",
        method if method.starts_with("warmup.") => "warmup request",
        method if method.starts_with("webhooks.") => "webhook request",
        _ => "host request",
    }
}

/// Map a kernel operation's error onto the bridge's closed codes. A 4xx message
/// is the handler's own and user-facing (a Safe Actions reload prompt, a
/// secret-length rule), so it passes through. A 5xx message can carry internal
/// detail (a store path, an upstream address) that must never reach the
/// untrusted frame: it is logged here, without args or results, and replaced
/// with a generic message.
fn kernel_op_error(method: &str, error: KernelOpError) -> axum::response::Response {
    let status = error.status;
    let code = match status {
        StatusCode::FORBIDDEN => "denied",
        StatusCode::NOT_FOUND => "not_found",
        StatusCode::TOO_MANY_REQUESTS => "over_budget",
        StatusCode::BAD_REQUEST
        | StatusCode::METHOD_NOT_ALLOWED
        | StatusCode::CONFLICT
        | StatusCode::UNSUPPORTED_MEDIA_TYPE
        | StatusCode::UNPROCESSABLE_ENTITY => "invalid_args",
        _ => "server_error",
    };
    if !status.is_server_error() {
        return err_response(status, code, error.message);
    }
    tracing::warn!(
        method,
        status = status.as_u16(),
        detail = %error.message,
        "app host-bridge kernel operation failed"
    );
    let label = kernel_op_label(method);
    let message = if status == StatusCode::SERVICE_UNAVAILABLE {
        format!("{label} is unavailable on this node right now")
    } else {
        format!("{label} failed")
    };
    err_response(status, code, message)
}

fn err_response(status: StatusCode, code: &str, message: String) -> axum::response::Response {
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

/// Governance filter for a forwarded agent stream: a frame reaches the untrusted
/// null-origin app frame ONLY if it is user-facing reply text, an error, or the
/// terminal sentinel. Tool-call / reasoning / start / finish / usage frames are
/// dropped so an app never sees the agent's internal activity (it is an untrusted
/// third party). `frame` is one SSE record (the text before the `\n\n` boundary).
fn stream_frame_allowed(frame: &str) -> bool {
    let Some(data) = frame.strip_prefix("data:").map(str::trim) else {
        return false;
    };
    if data == "[DONE]" {
        return true;
    }
    match serde_json::from_str::<Value>(data) {
        Ok(v) => {
            let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
            kind.starts_with("text") || kind == "error"
        }
        Err(_) => false,
    }
}

/// Tool scope an app-started streaming `agent.run` may use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamAgentToolScope {
    /// Plain `hook:run-agent`: only tools annotated read-only, on a Core-governed
    /// route (see `ChatStreamRequest::read_only_tools`).
    ReadOnly,
    /// `hook:run-agent` + `hook:run-agent:write`: the agent's full tool set.
    Full,
}

/// Decide the streaming `agent.run` tool scope from the app's approved grants,
/// mirroring the unary bridge's preset rule. No `hook:run-agent` refuses; an
/// explicit mutating preset (`code_write`) without the write grant refuses; plain
/// `hook:run-agent` is read-only; the write grant unlocks the full tool set.
fn stream_agent_tool_scope(
    grants: &std::collections::HashSet<String>,
    preset: Option<&str>,
) -> Result<StreamAgentToolScope, String> {
    if !grants.contains("hook:run-agent") {
        return Err("capability 'hook:run-agent' not granted to this app".to_owned());
    }
    if grants.contains("hook:run-agent:write") {
        return Ok(StreamAgentToolScope::Full);
    }
    if preset.map(str::trim) == Some("code_write") {
        return Err("capability 'hook:run-agent:write' not granted to this app".to_owned());
    }
    Ok(StreamAgentToolScope::ReadOnly)
}

/// `POST /api/plugins/:plugin_id/host/stream` — stream a tool-using `agent.run` to a
/// full-page Companion app token-by-token. Reuses the full chat engine
/// (`route_chat_stream` via `run_text_turn_stream`) and forwards a GOVERNANCE-FILTERED
/// view of the SSE (text/error/done only). Cancel = the frame aborts its fetch
/// (drops the SSE); the detached turn then finishes server-side, exactly like a
/// normal chat client disconnect. Only `agent.run` streams in v1.
#[utoipa::path(
    post,
    path = "/api/plugins/{id}/host/stream",
    tag = "Plugins",
    summary = "stream a tool-using `agent.run` to a",
    params(("plugin_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn plugin_bridge_stream(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(plugin_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<HostDispatchBody>,
) -> axum::response::Response {
    if let Some(refusal) = refuse_unadmitted_web_delegation(&headers, &caller) {
        return refusal;
    }
    if body.method != "agent.run" {
        return err_response(
            StatusCode::BAD_REQUEST,
            "invalid_args",
            "only agent.run supports streaming".to_owned(),
        );
    }

    // Same live enabled gate + approved-grant load as the unary endpoint.
    let record = match state.app_store.get(&plugin_id).await {
        Ok(Some(rec)) if rec.enabled => rec,
        Ok(_) => {
            return err_response(
                StatusCode::NOT_FOUND,
                "not_found",
                "plugin not enabled".to_owned(),
            );
        }
        Err(e) => {
            return err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                e.to_string(),
            );
        }
    };
    let grants =
        crate::plugin_host::current_approved_grants(&state, &plugin_id, &record.approved_grants)
            .await;

    // Same grant rule as the unary bridge (`plugin_host::bridge::check_preset_grant`):
    // plain `hook:run-agent` may only start a READ-ONLY agent; tools that can
    // write need the explicit `hook:run-agent:write` grant on top.
    let read_only_tools =
        match stream_agent_tool_scope(&grants, body.args.get("preset").and_then(Value::as_str)) {
            Ok(scope) => scope == StreamAgentToolScope::ReadOnly,
            Err(message) => return err_response(StatusCode::FORBIDDEN, "denied", message),
        };

    if crate::server::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_RUN,
    )
    .await
    .is_err()
    {
        return err_response(
            StatusCode::FORBIDDEN,
            "denied",
            "insufficient permissions: agent.run".to_owned(),
        );
    }

    let task = body
        .args
        .get("task")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();
    if task.is_empty() {
        return err_response(
            StatusCode::BAD_REQUEST,
            "invalid_args",
            "agent.run requires a non-empty 'task'".to_owned(),
        );
    }
    let agent_id = body
        .args
        .get("agent_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    if let Some(agent_id) = agent_id.as_deref() {
        if !crate::fleet::is_agent_available(agent_id) {
            return err_response(
                StatusCode::FORBIDDEN,
                "denied",
                "agent is unavailable under organization policy".to_owned(),
            );
        }
        if let Err(status) = crate::server::enforce_agent_resource_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_RUN,
            agent_id,
        )
        .await
        {
            return status;
        }
    }

    // Hold the per-plugin spawn permit for the WHOLE stream lifetime.
    let permit = match run_agent_gate(&plugin_id).try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return err_response(
                StatusCode::TOO_MANY_REQUESTS,
                "over_budget",
                "too many concurrent agent runs for this app".to_owned(),
            );
        }
    };

    // Ephemeral, unique conversation id (not persisted): correlation only.
    let conversation_id = format!("app-{plugin_id}-{}", uuid::Uuid::new_v4());
    let agent_resource_authorization = caller.clone().map(|caller| {
        std::sync::Arc::new(crate::sidecar::adapters::AgentResourceAuthorization {
            state: state.clone(),
            caller: Some(caller),
        })
    });
    let response = crate::sidecar::adapters::run_text_turn_stream(
        conversation_id,
        agent_id,
        task,
        false, // do not persist an app-driven turn into chat history
        state.agents.clone(),
        state.conversations.clone(),
        state.agent_store.clone(),
        state.manager.clone(),
        state.memory.clone(),
        state.worktree_diffs.clone(),
        state.mcp.clone(),
        state.skills.clone(),
        state.traces.clone(),
        agent_resource_authorization,
        read_only_tools,
    )
    .await;

    // A SUPERVISOR task owns the permit and drains the turn to REAL completion, so
    // the per-plugin concurrency guard bounds actually-running turns, NOT the client
    // connection. The agent turn is detached and runs to completion regardless of the
    // client (adapters `route_acp_stream`); if the permit tracked only the client SSE
    // forwarder, an app could connect-and-drop in a loop to spawn unbounded concurrent
    // turns and defeat the semaphore. Here the permit drops only when the drain sees
    // the turn finish. Governance-filtered frames are tee'd to the client over a
    // bounded channel — a slow/disconnected client only drops frames, never stalls the
    // drain (byte-buffered so a multibyte char split across chunks is never corrupted).
    let (client_tx, client_rx) = tokio::sync::mpsc::channel::<axum::body::Bytes>(256);
    let mut inner = response.into_body().into_data_stream();
    tokio::spawn(async move {
        let _permit = permit; // released only at real turn completion
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = inner.next().await {
            let Ok(bytes) = chunk else { break };
            buf.extend_from_slice(&bytes);
            while let Some(pos) = find_frame_boundary(&buf) {
                let frame_bytes: Vec<u8> = buf.drain(..pos + 2).collect();
                let frame = String::from_utf8_lossy(&frame_bytes[..pos]);
                if let Some(out) = forward_frame(&frame) {
                    // Best-effort: a gone client closes the receiver; keep draining.
                    if client_tx.send(axum::body::Bytes::from(out)).await.is_err() {
                        // Client disconnected — stop teeing but KEEP draining `inner`
                        // (permit still held) so the turn is bounded, not the socket.
                    }
                }
            }
        }
    });
    let forwarded = async_stream::stream! {
        let mut rx = client_rx;
        while let Some(out) = rx.recv().await {
            yield Ok::<_, std::convert::Infallible>(out);
        }
    };
    crate::sidecar::adapters::sse_response(axum::body::Body::from_stream(forwarded))
}

/// Decide what to forward for one SSE frame. Text frames and the terminal sentinel
/// pass through verbatim; an `error` frame is REPLACED with a generic, info-leak-free
/// message (the raw error Display can embed the internal gateway base URL / host:port,
/// which must never reach the untrusted null-origin app); every other frame type is
/// dropped by {@link stream_frame_allowed}.
fn forward_frame(frame: &str) -> Option<Vec<u8>> {
    if !stream_frame_allowed(frame) {
        return None;
    }
    let data = frame.strip_prefix("data:").map(str::trim).unwrap_or("");
    let is_error = serde_json::from_str::<Value>(data)
        .ok()
        .and_then(|v| v.get("type").and_then(Value::as_str).map(|t| t == "error"))
        .unwrap_or(false);
    if is_error {
        return Some(b"data: {\"type\":\"error\",\"errorText\":\"agent run failed\"}\n\n".to_vec());
    }
    let mut out = frame.as_bytes().to_vec();
    out.extend_from_slice(b"\n\n");
    Some(out)
}

/// Index of the first `\n\n` frame boundary in a byte buffer, if any.
fn find_frame_boundary(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant_set(values: &[&str]) -> std::collections::HashSet<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn streaming_agent_run_without_the_grant_is_refused() {
        let denied = stream_agent_tool_scope(&grant_set(&[]), None).unwrap_err();
        assert!(denied.contains("'hook:run-agent'"));
        let write_only = stream_agent_tool_scope(&grant_set(&["hook:run-agent:write"]), None);
        assert!(
            write_only.is_err(),
            "the write grant alone must not admit a run"
        );
    }

    #[test]
    fn streaming_agent_run_with_the_plain_grant_is_read_only() {
        let plain = grant_set(&["hook:run-agent"]);
        for preset in [None, Some("code_read"), Some("research"), Some("summarise")] {
            assert_eq!(
                stream_agent_tool_scope(&plain, preset),
                Ok(StreamAgentToolScope::ReadOnly)
            );
        }
        let denied = stream_agent_tool_scope(&plain, Some("code_write")).unwrap_err();
        assert!(denied.contains("hook:run-agent:write"));
    }

    #[test]
    fn streaming_agent_run_with_the_write_grant_gets_the_full_tool_set() {
        let write = grant_set(&["hook:run-agent", "hook:run-agent:write"]);
        for preset in [None, Some("code_write")] {
            assert_eq!(
                stream_agent_tool_scope(&write, preset),
                Ok(StreamAgentToolScope::Full)
            );
        }
    }

    #[test]
    fn only_agent_run_bridge_methods_require_the_user_run_permission() {
        assert!(requires_agent_run_permission("agent.run"));
        assert!(requires_agent_run_permission("agent.runFanout"));
        assert!(!requires_agent_run_permission("model.complete"));
        assert!(!requires_agent_run_permission("storage.get"));
    }

    #[test]
    fn view_action_without_a_hook_is_a_404_naming_the_phase() {
        let response = view_action_response(
            "@acme/tasks",
            &json!({ "action_id": "archive" }),
            crate::plugin_host::ViewActionOutcome::NoHandler,
        );
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn view_action_statuses_follow_the_outcome() {
        use crate::plugin_host::ViewActionOutcome;
        let args = json!({ "action_id": "archive" });
        assert_eq!(
            view_action_response("p", &args, ViewActionOutcome::Unavailable).status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            view_action_response(
                "p",
                &args,
                ViewActionOutcome::Declined {
                    hook_ids: vec!["h".to_owned()]
                }
            )
            .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            view_action_response(
                "p",
                &args,
                ViewActionOutcome::Handled {
                    hook_ids: vec!["h".to_owned()],
                    messages: vec!["Archived".to_owned()],
                }
            )
            .status(),
            StatusCode::OK
        );
    }

    #[test]
    fn method_allowlist_is_closed() {
        assert_eq!(
            bridge_path_for("catalog.snapshot"),
            Some("host.catalogSnapshot")
        );
        assert_eq!(
            bridge_path_for("catalog.models"),
            Some("host.catalogModels")
        );
        assert_eq!(bridge_path_for("model.complete"), Some("host.sideModel"));
        assert_eq!(bridge_path_for("agent.run"), Some("host.runAgent"));
        assert_eq!(bridge_path_for("agent.runFanout"), Some("host.runFanout"));
        assert_eq!(bridge_path_for("storage.get"), Some("host.storage_get"));
        assert_eq!(bridge_path_for("storage.set"), Some("host.storage_set"));
        assert_eq!(
            bridge_path_for("storage.delete"),
            Some("host.storage_delete")
        );
        assert_eq!(bridge_path_for("storage.keys"), Some("host.storage_keys"));
        assert_eq!(
            bridge_path_for("spaces.ensureSpace"),
            Some("host.spaces_ensure_space")
        );
        assert_eq!(
            bridge_path_for("spaces.createDoc"),
            Some("host.spaces_create_doc")
        );
        assert_eq!(bridge_path_for("spaces.search"), Some("host.spaces_search"));
        assert_eq!(required_grant_for("spaces.search"), Some("spaces:docs"));
        assert_eq!(
            bridge_path_for("spaces.getDoc"),
            Some("host.spaces_get_doc")
        );
        assert_eq!(
            bridge_path_for("spaces.updateDoc"),
            Some("host.spaces_update_doc")
        );
        assert_eq!(
            bridge_path_for("spaces.listDocs"),
            Some("host.spaces_list_docs")
        );
        assert_eq!(
            bridge_path_for("spaces.deleteDoc"),
            Some("host.spaces_delete_doc")
        );
        assert_eq!(
            bridge_path_for("spaces.createDatabase"),
            Some("host.spaces_create_database")
        );
        assert_eq!(
            bridge_path_for("spaces.listDatabases"),
            Some("host.spaces_list_databases")
        );
        assert_eq!(
            bridge_path_for("spaces.getDatabase"),
            Some("host.spaces_get_database")
        );
        assert_eq!(
            bridge_path_for("spaces.updateDatabase"),
            Some("host.spaces_update_database")
        );
        assert_eq!(
            bridge_path_for("spaces.queryDatabase"),
            Some("host.spaces_query_database")
        );
        assert_eq!(
            bridge_path_for("spaces.deleteDatabase"),
            Some("host.spaces_delete_database")
        );
        // `finetune.*` is no longer Core-bridged: hosts forward it to the app's own
        // sidecar through the generic ext-proxy (`/api/ext/@ryu/finetune/*`).
        assert_eq!(bridge_path_for("finetune.capability"), None);
        assert_eq!(bridge_path_for("finetune.start"), None);
        assert_eq!(bridge_path_for("finetune.merge"), None);
        assert_eq!(
            bridge_path_for("conversation.setTitle"),
            Some("host.setConversationTitle")
        );
        assert_eq!(
            bridge_path_for("conversation.addReaction"),
            Some("host.addMessageReaction")
        );
        assert_eq!(
            bridge_path_for("preferences.get"),
            Some("host.getPreference")
        );
        assert_eq!(
            bridge_path_for("background.list"),
            Some("host.background_list")
        );
        assert_eq!(
            bridge_path_for("background.stop"),
            Some("host.background_stop")
        );
        assert_eq!(
            bridge_path_for("gateway.budgetSpend"),
            Some("host.gatewayBudgetSpend")
        );
        assert_eq!(bridge_path_for("gateway.audit"), Some("host.gatewayAudit"));
        assert_eq!(required_grant_for("gateway.audit"), Some("usage:audit"));
        assert_eq!(
            required_grant_for("gateway.budgetSpend"),
            Some("usage:read")
        );
        assert_eq!(
            bridge_path_for("subscriptions.list"),
            Some("host.subscriptions_list")
        );
        assert_eq!(
            bridge_path_for("subscriptions.usage"),
            Some("host.subscriptions_usage")
        );
        assert_eq!(
            required_grant_for("subscriptions.list"),
            Some("subscriptions:read")
        );
        assert_eq!(
            required_grant_for("subscriptions.usage"),
            Some("subscriptions:read")
        );
        // `finetune.stream` keeps its host-API grant row but no bridge path: hosts
        // read the sidecar's SSE through the ext-proxy.
        assert_eq!(bridge_path_for("finetune.stream"), None);
        assert_eq!(required_grant_for("finetune.stream"), Some("finetune:runs"));
        // Anything else — including a raw host.* path — is rejected.
        assert_eq!(bridge_path_for("host.sideModel"), None);
        assert_eq!(bridge_path_for("host.spaces_create_doc"), None);
        assert_eq!(bridge_path_for("tool.call"), None);
        assert_eq!(bridge_path_for(""), None);
    }

    #[test]
    fn required_grant_matches_bridge_vocabulary() {
        assert_eq!(
            required_grant_for("model.complete"),
            Some("hook:side-model")
        );
        assert_eq!(required_grant_for("agent.run"), Some("hook:run-agent"));
        assert_eq!(required_grant_for("storage.get"), Some("storage:kv"));
        assert_eq!(required_grant_for("storage.keys"), Some("storage:kv"));
        assert_eq!(
            required_grant_for("storage.compareAndSet"),
            Some("storage:kv")
        );
        assert_eq!(required_grant_for("crypto.seal"), Some("crypto:seal"));
        assert_eq!(required_grant_for("crypto.open"), Some("crypto:seal"));
        assert_eq!(required_grant_for("crypto.status"), Some("crypto:seal"));
        assert_eq!(required_grant_for("spaces.createDoc"), Some("spaces:docs"));
        assert_eq!(required_grant_for("spaces.getDoc"), Some("spaces:docs"));
        assert_eq!(required_grant_for("spaces.updateDoc"), Some("spaces:docs"));
        assert_eq!(required_grant_for("spaces.listDocs"), Some("spaces:docs"));
        assert_eq!(required_grant_for("spaces.deleteDoc"), Some("spaces:docs"));
        assert_eq!(
            required_grant_for("spaces.queryDatabase"),
            Some("spaces:database")
        );
        assert_eq!(
            required_grant_for("spaces.deleteDatabase"),
            Some("spaces:database")
        );
        assert_eq!(
            required_grant_for("finetune.capability"),
            Some("finetune:runs")
        );
        assert_eq!(required_grant_for("finetune.start"), Some("finetune:runs"));
        assert_eq!(required_grant_for("finetune.get"), Some("finetune:runs"));
        assert_eq!(
            required_grant_for("conversation.setTitle"),
            Some("conversation:set-title")
        );
        assert_eq!(
            required_grant_for("conversation.addReaction"),
            Some("conversation:reactions")
        );
        assert_eq!(
            required_grant_for("preferences.get"),
            Some("preferences:read")
        );
        assert_eq!(
            required_grant_for("background.list"),
            Some("background:control")
        );
        // `view.action` is grant-gated but has NO unary bridge path — it is
        // dispatched by its own branch to the plugin's `view_action` hooks.
        assert_eq!(required_grant_for("view.action"), Some("views:actions"));
        assert_eq!(bridge_path_for("view.action"), None);
        assert_eq!(required_grant_for("nope"), None);
    }

    #[test]
    fn every_allowlisted_method_has_a_required_grant() {
        for method in [
            "model.complete",
            "agent.run",
            "agent.runFanout",
            "storage.get",
            "storage.set",
            "storage.delete",
            "storage.keys",
            "crypto.seal",
            "crypto.open",
            "crypto.status",
            "spaces.createDoc",
            "spaces.getDoc",
            "spaces.updateDoc",
            "spaces.listDocs",
            "spaces.deleteDoc",
            "conversation.setTitle",
            "preferences.get",
            "background.list",
            "background.stop",
        ] {
            assert!(bridge_path_for(method).is_some());
            assert!(required_grant_for(method).is_some());
        }
    }

    #[test]
    fn stream_filter_forwards_only_text_error_done() {
        // Forwarded: reply text, errors, terminal sentinel.
        assert!(stream_frame_allowed(
            r#"data: {"type":"text-delta","delta":"hi"}"#
        ));
        assert!(stream_frame_allowed(
            r#"data: {"type":"text-start","id":"1"}"#
        ));
        assert!(stream_frame_allowed(
            r#"data: {"type":"error","errorText":"boom"}"#
        ));
        assert!(stream_frame_allowed("data: [DONE]"));
        // Dropped: agent internals never exposed to an untrusted app frame.
        assert!(!stream_frame_allowed(
            r#"data: {"type":"tool-input-start"}"#
        ));
        assert!(!stream_frame_allowed(
            r#"data: {"type":"tool-output-available"}"#
        ));
        assert!(!stream_frame_allowed(r#"data: {"type":"reasoning-delta"}"#));
        assert!(!stream_frame_allowed(r#"data: {"type":"start"}"#));
        assert!(!stream_frame_allowed(r#"data: {"type":"finish"}"#));
        // Non-data / malformed lines dropped.
        assert!(!stream_frame_allowed("event: message"));
        assert!(!stream_frame_allowed("data: not-json"));
    }

    #[test]
    fn frame_boundary_finds_double_newline() {
        assert_eq!(find_frame_boundary(b"data: x\n\nrest"), Some(7));
        assert_eq!(find_frame_boundary(b"no boundary yet"), None);
    }

    #[test]
    fn forward_frame_passes_text_and_sanitizes_errors() {
        // Text passes verbatim.
        let text = forward_frame(r#"data: {"type":"text-delta","delta":"hi"}"#).unwrap();
        let mut expected = br#"data: {"type":"text-delta","delta":"hi"}"#.to_vec();
        expected.extend_from_slice(b"\n\n");
        assert_eq!(text, expected);
        // [DONE] passes.
        assert_eq!(
            forward_frame("data: [DONE]").unwrap(),
            b"data: [DONE]\n\n".to_vec()
        );
        // An error frame is REPLACED — the raw errorText (which may embed an internal
        // url like http://127.0.0.1:7981/...) never reaches the untrusted frame.
        let leaky = r#"data: {"type":"error","errorText":"Agent unreachable: error for url (http://127.0.0.1:7981/v1/chat/completions)"}"#;
        let out = String::from_utf8(forward_frame(leaky).unwrap()).unwrap();
        assert!(!out.contains("127.0.0.1"));
        assert!(!out.contains("7981"));
        assert!(out.contains("agent run failed"));
        // Internal frames still dropped.
        assert!(forward_frame(r#"data: {"type":"tool-input-start"}"#).is_none());
    }

    async fn reply_parts(response: axum::response::Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn kernel_op_error_maps_statuses() {
        for (status, code) in [
            (StatusCode::FORBIDDEN, "denied"),
            (StatusCode::NOT_FOUND, "not_found"),
            (StatusCode::BAD_REQUEST, "invalid_args"),
            (StatusCode::METHOD_NOT_ALLOWED, "invalid_args"),
            (StatusCode::CONFLICT, "invalid_args"),
            (StatusCode::UNSUPPORTED_MEDIA_TYPE, "invalid_args"),
            (StatusCode::UNPROCESSABLE_ENTITY, "invalid_args"),
        ] {
            let (got, body) = reply_parts(kernel_op_error(
                "safeActions.request",
                KernelOpError::new(status, "reload the latest version and retry"),
            ))
            .await;
            assert_eq!(got, status);
            assert_eq!(body["error"]["code"], code, "{status}");
            // 4xx text is the handler's own, user-facing message.
            assert_eq!(
                body["error"]["message"], "reload the latest version and retry",
                "{status}"
            );
        }
    }

    #[tokio::test]
    async fn five_hundred_detail_is_scrubbed() {
        let leaky = "/var/lib/ryu/plans.db: io error at 127.0.0.1:7981";
        for (method, status, expected) in [
            (
                "safeActions.request",
                StatusCode::INTERNAL_SERVER_ERROR,
                "Safe Actions request failed",
            ),
            (
                "safeActions.request",
                StatusCode::BAD_GATEWAY,
                "Safe Actions request failed",
            ),
            (
                "safeActions.request",
                StatusCode::SERVICE_UNAVAILABLE,
                "Safe Actions request is unavailable on this node right now",
            ),
            (
                "webhooks.secretSet",
                StatusCode::INTERNAL_SERVER_ERROR,
                "webhook secret update failed",
            ),
            (
                "webhooks.secretGet",
                StatusCode::INTERNAL_SERVER_ERROR,
                "webhook secret read failed",
            ),
            (
                "warmup.apply",
                StatusCode::INTERNAL_SERVER_ERROR,
                "warmup request failed",
            ),
        ] {
            let (got, body) =
                reply_parts(kernel_op_error(method, KernelOpError::new(status, leaky))).await;
            assert_eq!(got, status);
            assert_eq!(body["error"]["code"], "server_error");
            assert_eq!(body["error"]["message"], expected, "{method} {status}");
            let encoded = body.to_string();
            assert!(!encoded.contains("/var"), "{encoded}");
            assert!(!encoded.contains("7981"), "{encoded}");
        }
    }

    /// The desktop's version-skew fallback keys on this exact reply; keep it
    /// pinned (`withLegacyBridgeFallback` in `apps/desktop/src/lib/api/plugins.ts`).
    #[tokio::test]
    async fn unknown_method_reply_is_pinned() {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let (status, body) = reply_parts(
            plugin_bridge_dispatch(
                State(state),
                Extension(None),
                Path("@example/any".to_owned()),
                HeaderMap::new(),
                Json(HostDispatchBody {
                    method: "safeActions.nope".to_owned(),
                    args: Value::Null,
                }),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "invalid_args");
        assert_eq!(
            body["error"]["message"],
            "unknown host method 'safeActions.nope'"
        );
    }

    /// A call the web tier forwarded for a browser is admitted only for a
    /// verified member of a bound node, on both bridge routes; one without the
    /// marker is handled exactly as before (here: the unknown-method reply).
    #[tokio::test]
    async fn web_delegated_calls_need_a_member_of_a_bound_node() {
        use crate::identity_verify::{OrgRole, VerifiedCaller};
        use crate::sidecar::control_plane::{
            with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
        };

        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let member = VerifiedCaller {
            user_id: "alice".to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org-1".to_owned()),
            role: OrgRole::Member,
            teams: Vec::new(),
        };
        let delegated = || {
            let mut headers = HeaderMap::new();
            headers.insert(
                crate::sidecar::ext_proxy::HDR_WEB_DELEGATION,
                axum::http::HeaderValue::from_static("1"),
            );
            headers
        };
        let call = |caller: Option<VerifiedCaller>, headers: HeaderMap, stream: bool| {
            let state = state.clone();
            async move {
                let path = Path("@example/any".to_owned());
                let body = Json(HostDispatchBody {
                    method: "safeActions.nope".to_owned(),
                    args: Value::Null,
                });
                let response = if stream {
                    plugin_bridge_stream(State(state), Extension(caller), path, headers, body).await
                } else {
                    plugin_bridge_dispatch(State(state), Extension(caller), path, headers, body)
                        .await
                };
                reply_parts(response).await
            }
        };

        // The test process is an unbound node.
        for stream in [false, true] {
            for caller in [None, Some(member.clone())] {
                let (status, body) = call(caller, delegated(), stream).await;
                assert_eq!(status, StatusCode::FORBIDDEN, "stream={stream} {body}");
                assert_eq!(body["error"]["code"], "denied");
            }
        }
        let (status, body) = call(None, HeaderMap::new(), false).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "invalid_args");

        let node = RegisteredNode {
            org: RegisteredOrg {
                id: "org-1".to_owned(),
                name: "org-1".to_owned(),
                slug: None,
            },
            node_id: "node-1".to_owned(),
            scope: NodeScope::Org,
            team_id: None,
            owner_user_id: None,
        };
        with_test_node_binding(true, Some(node), async {
            let (status, _) = call(None, delegated(), false).await;
            assert_eq!(status, StatusCode::FORBIDDEN);
            // A member of the bound org passes the gate and reaches dispatch.
            for stream in [false, true] {
                let (status, body) = call(Some(member.clone()), delegated(), stream).await;
                assert_eq!(status, StatusCode::BAD_REQUEST, "stream={stream} {body}");
                assert_eq!(body["error"]["code"], "invalid_args");
            }
        })
        .await;
    }

    #[test]
    fn error_classification() {
        assert_eq!(
            classify_bridge_error("capability 'storage:kv' not granted to plugin 'x'").1,
            "denied"
        );
        assert_eq!(
            classify_bridge_error("host.sideModel requires a non-empty 'prompt'").1,
            "invalid_args"
        );
        assert_eq!(classify_bridge_error("gateway timeout").1, "server_error");
    }
}
