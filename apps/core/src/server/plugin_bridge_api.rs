//! `POST /api/plugins/:plugin_id/host` — the app host-capability bridge over HTTP.
//!
//! Exposes the SAME [`PluginHookBridge`] capabilities the Deno turn-hook sandbox
//! uses (`host.sideModel` / `host.runAgent` / `host.storage_*`) to a full-page
//! **Companion** app's sandboxed iframe. The desktop host (the trusted webview)
//! holds the node token and is the sole caller; the null-origin iframe reaches
//! here only through the capability-gated `MessagePort` RPC — its CSP is
//! `connect-src 'none'`, so it cannot fetch this route directly.
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
//! - **`agent.run` spawn-concurrency** is bounded per-plugin by a semaphore (a compute/
//!   process DoS guard); each sub-agent's model egress is separately Gateway-governed.
//!
//! Placement (AGENTS.md §1): this decides *what runs* for an app (a completion, a
//! sub-agent, its own KV) — Core. The grant/budget/audit of each model call it makes
//! is the Gateway's, reached through the same bridge the sandbox uses.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use super::ServerState;
use crate::plugin_host::PluginHookBridge;
use crate::tool_exec::{InvokeOutcome, SandboxBridge};

/// Max concurrent `agent.run` spawns per plugin (a spawn-DoS guard; the sub-agent's
/// model egress is separately Gateway-governed by budgets).
const MAX_CONCURRENT_RUN_AGENT_PER_PLUGIN: usize = 2;

/// Map a desktop-facing method to the closed `host.<path>` string the bridge matches
/// (`handle_inner` strips the `host.` prefix). A method absent here is rejected — the
/// caller can never forward a verbatim path into a different capability namespace.
fn bridge_path_for(method: &str) -> Option<&'static str> {
    match method {
        "model.complete" => Some("host.sideModel"),
        "agent.run" => Some("host.runAgent"),
        "storage.get" => Some("host.storage_get"),
        "storage.set" => Some("host.storage_set"),
        "storage.delete" => Some("host.storage_delete"),
        "storage.keys" => Some("host.storage_keys"),
        "spaces.createDoc" => Some("host.spaces_create_doc"),
        "spaces.getDoc" => Some("host.spaces_get_doc"),
        "spaces.updateDoc" => Some("host.spaces_update_doc"),
        "spaces.listDocs" => Some("host.spaces_list_docs"),
        "spaces.deleteDoc" => Some("host.spaces_delete_doc"),
        "finetune.capability" => Some("host.finetune_capability"),
        "finetune.start" => Some("host.finetune_start"),
        "finetune.list" => Some("host.finetune_list"),
        "finetune.get" => Some("host.finetune_get"),
        "finetune.cancel" => Some("host.finetune_cancel"),
        "finetune.adapters" => Some("host.finetune_adapters"),
        "finetune.merge" => Some("host.finetune_merge"),
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
    Path(plugin_id): Path<String>,
    Json(body): Json<HostDispatchBody>,
) -> axum::response::Response {
    // Allowlist the method → closed `host.*` path (no verbatim path injection).
    // `view.action` is the one grant-gated method with NO unary bridge path: the
    // shell relays a declarative-view intent to the owning app. It is dispatched
    // by its own branch below (after the enabled + grant gates), never the bridge.
    let is_view_action = body.method == "view.action";
    let (bridge_path, required_grant) = if is_view_action {
        (None, "views:actions")
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
                )
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
            )
        }
        Err(e) => {
            return err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                e.to_string(),
            )
        }
    };
    let grants: HashSet<String> = record.approved_grants.into_iter().collect();

    // Endpoint-level grant gate: a clean `denied` before we spin anything up.
    if !grants.contains(required_grant) {
        return err_response(
            StatusCode::FORBIDDEN,
            "denied",
            format!("capability '{required_grant}' not granted to this app"),
        );
    }

    // `view.action` v1: the method EXISTS, is grant-gated (above), and is audited
    // (the tracing line below feeds the standard log/audit pipeline), but no app
    // turn-hook runtime consumes view intents yet — the declarative `http` tier is
    // the primary CRUD path. Apps relaying intents get an honest 501 rather than a
    // silent drop; wiring a hook phase upgrades this branch without a wire change.
    if is_view_action {
        tracing::info!(
            plugin = %plugin_id,
            args = %body.args,
            "plugin view.action intent received (no app hook runtime wired; declarative http actions are the primary path)"
        );
        return err_response(
            StatusCode::NOT_IMPLEMENTED,
            "server_error",
            "view.action intents are not consumed by an app hook runtime yet; declare a declarative `http` handler on the action instead".to_owned(),
        );
    }
    // Every non-view.action method resolved a concrete bridge path above.
    let Some(bridge_path) = bridge_path else {
        return err_response(
            StatusCode::BAD_REQUEST,
            "invalid_args",
            format!("unknown host method '{}'", body.method),
        );
    };

    // Bound the heavy sub-agent path per plugin. Held for the whole call.
    let _permit = if body.method == "agent.run" {
        match run_agent_gate(&plugin_id).try_acquire_owned() {
            Ok(permit) => Some(permit),
            Err(_) => {
                return err_response(
                    StatusCode::TOO_MANY_REQUESTS,
                    "over_budget",
                    "too many concurrent agent runs for this app".to_owned(),
                )
            }
        }
    } else {
        None
    };

    // Reuse the exact bridge the Deno sandbox uses — one implementation, one grant
    // vocabulary. `plugin_id` moves in as both the grant subject and the storage owner.
    let bridge = PluginHookBridge::new(plugin_id, grants, state);
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

/// Classify a bridge `is_error` message into a status + closed error code. The grant
/// case is already handled at the endpoint, so remaining errors are bad-args (empty
/// prompt/task/key) or an upstream model/storage failure.
fn classify_bridge_error(message: &str) -> (StatusCode, &'static str) {
    let lower = message.to_ascii_lowercase();
    if lower.contains("not granted") {
        (StatusCode::FORBIDDEN, "denied")
    } else if lower.contains("requires") || lower.contains("non-empty") || lower.contains("empty") {
        (StatusCode::BAD_REQUEST, "invalid_args")
    } else {
        (StatusCode::INTERNAL_SERVER_ERROR, "server_error")
    }
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
    Path(plugin_id): Path<String>,
    Json(body): Json<HostDispatchBody>,
) -> axum::response::Response {
    if body.method != "agent.run" && body.method != "finetune.stream" {
        return err_response(
            StatusCode::BAD_REQUEST,
            "invalid_args",
            "only agent.run and finetune.stream support streaming".to_owned(),
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
            )
        }
        Err(e) => {
            return err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                e.to_string(),
            )
        }
    };
    let grants: HashSet<String> = record.approved_grants.into_iter().collect();

    // Fine-tune progress stream: the `com.ryu.finetune` app subscribes to a run's
    // live SSE. The `ryu-finetune` sidecar owns the orchestration + the source SSE
    // (local worker or remote node); we proxy that stream verbatim through the
    // loopback finetune client (its frames are the app's OWN run data — step/loss/
    // state — not another agent's internals, so no governance filter is applied).
    // Gated on `finetune:runs`.
    if body.method == "finetune.stream" {
        if !grants.contains("finetune:runs") {
            return err_response(
                StatusCode::FORBIDDEN,
                "denied",
                "capability 'finetune:runs' not granted to this app".to_owned(),
            );
        }
        let id = body
            .args
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_owned();
        if id.is_empty() {
            return err_response(
                StatusCode::BAD_REQUEST,
                "invalid_args",
                "finetune.stream requires a non-empty 'id'".to_owned(),
            );
        }
        return state.finetune.stream(&id).await;
    }

    if !grants.contains("hook:run-agent") {
        return err_response(
            StatusCode::FORBIDDEN,
            "denied",
            "capability 'hook:run-agent' not granted to this app".to_owned(),
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

    // Hold the per-plugin spawn permit for the WHOLE stream lifetime.
    let permit = match run_agent_gate(&plugin_id).try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return err_response(
                StatusCode::TOO_MANY_REQUESTS,
                "over_budget",
                "too many concurrent agent runs for this app".to_owned(),
            )
        }
    };

    // Ephemeral, unique conversation id (not persisted): correlation only.
    let conversation_id = format!("app-{plugin_id}-{}", uuid::Uuid::new_v4());
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

    #[test]
    fn method_allowlist_is_closed() {
        assert_eq!(bridge_path_for("model.complete"), Some("host.sideModel"));
        assert_eq!(bridge_path_for("agent.run"), Some("host.runAgent"));
        assert_eq!(bridge_path_for("storage.get"), Some("host.storage_get"));
        assert_eq!(bridge_path_for("storage.set"), Some("host.storage_set"));
        assert_eq!(
            bridge_path_for("storage.delete"),
            Some("host.storage_delete")
        );
        assert_eq!(bridge_path_for("storage.keys"), Some("host.storage_keys"));
        assert_eq!(
            bridge_path_for("spaces.createDoc"),
            Some("host.spaces_create_doc")
        );
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
            bridge_path_for("finetune.capability"),
            Some("host.finetune_capability")
        );
        assert_eq!(
            bridge_path_for("finetune.start"),
            Some("host.finetune_start")
        );
        assert_eq!(
            bridge_path_for("finetune.merge"),
            Some("host.finetune_merge")
        );
        // `finetune.stream` is a STREAMING method — it has a required grant but no
        // unary bridge path (it's handled by the stream endpoint, not dispatch).
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
        assert_eq!(required_grant_for("spaces.createDoc"), Some("spaces:docs"));
        assert_eq!(required_grant_for("spaces.getDoc"), Some("spaces:docs"));
        assert_eq!(required_grant_for("spaces.updateDoc"), Some("spaces:docs"));
        assert_eq!(required_grant_for("spaces.listDocs"), Some("spaces:docs"));
        assert_eq!(required_grant_for("spaces.deleteDoc"), Some("spaces:docs"));
        assert_eq!(
            required_grant_for("finetune.capability"),
            Some("finetune:runs")
        );
        assert_eq!(required_grant_for("finetune.start"), Some("finetune:runs"));
        assert_eq!(required_grant_for("finetune.get"), Some("finetune:runs"));
        // `view.action` is grant-gated but has NO unary bridge path — it is
        // dispatched by its own branch (501 until an app hook runtime consumes it).
        assert_eq!(required_grant_for("view.action"), Some("views:actions"));
        assert_eq!(bridge_path_for("view.action"), None);
        assert_eq!(required_grant_for("nope"), None);
    }

    #[test]
    fn every_allowlisted_method_has_a_required_grant() {
        for method in [
            "model.complete",
            "agent.run",
            "storage.get",
            "storage.set",
            "storage.delete",
            "storage.keys",
            "spaces.createDoc",
            "spaces.getDoc",
            "spaces.updateDoc",
            "spaces.listDocs",
            "spaces.deleteDoc",
            "finetune.capability",
            "finetune.start",
            "finetune.list",
            "finetune.get",
            "finetune.cancel",
            "finetune.adapters",
            "finetune.merge",
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
