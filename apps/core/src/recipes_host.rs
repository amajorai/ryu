//! The live-ghost recorder Core holds on behalf of the out-of-process Recipes app.
//!
//! The `ryu-recipes` sidecar owns the recipe store surface, the replay/record
//! *logic*, the `/api/recipes/*` handlers, and the deterministic draft synthesis.
//! What it cannot own — because it is kernel machinery that must stay in Core — is
//! the **dedicated recording subprocess** ([`McpSession`]) held across
//! `record_start`..`record_stop`: the in-process input tap is a shared OS resource
//! that must survive between calls, so the session lives in a process-global slot
//! here rather than in any single request or in the sidecar.
//!
//! These are plain inherent methods, not a trait impl. Core used to implement the
//! app crate's `RecipesHost` trait, which is what made `apps/core` link the app —
//! the dependency arrow pointed Core → app purely to satisfy the plug. The sidecar
//! reaches these through the generic `ghost.*` kernel capabilities (the handlers
//! at the bottom of this file), which speak JSON, so no shared Rust type is needed and Core
//! links zero app code. The JSON bodies the three recorder methods return are the
//! wire contract: `{started_at, info}`, `{task, started_at, status}`, and
//! `{task, started_at, payload}` — the shapes the sidecar deserializes into its own
//! `Recorder*` structs. Changing a key here breaks the sidecar; the key-set tests
//! below pin them.
//!
//! Stateless replay needs none of this: `ghost.ghost_run` goes straight through
//! the shared MCP registry, which both the workflow executor's `Recipe` node and
//! the `ghost.replay` capability do directly.
//!
//! The recording session is a process-global single slot: only one recording can
//! be active at a time. A `tokio` mutex because the guard is held across the
//! `.await` of a ghost `tools/call`.

use anyhow::{anyhow, Result};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use std::sync::OnceLock;
use tokio::sync::Mutex;

use crate::plugins::builtins::RECIPES_PLUGIN_ID;
use crate::server::ServerState;
use crate::sidecar::ext_proxy::authenticate_sidecar;
use crate::sidecar::mcp::client::{extract_mcp_json, McpSession, McpStdioCommand, McpTarget};

/// A live recording session: the ghost subprocess (holding the input tap) plus
/// the metadata the desktop shows while recording.
struct Recording {
    session: McpSession,
    task: String,
    started_at: String,
}

/// Process-global single-slot recording session. Only one recording can be
/// active at a time (the input tap is a shared OS resource).
fn recording() -> &'static Mutex<Option<Recording>> {
    static R: OnceLock<Mutex<Option<Recording>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

/// The command that launches the ghost MCP server (`<bin> mcp`). Mirrors the
/// built-in registered in [`crate::sidecar::mcp`].
/// Ghost is always a local stdio child (an `~/.ryu/bin` binary), so this is the
/// one construction site that names [`McpTarget::Stdio`] directly rather than
/// going through the registry's config lowering.
fn ghost_command() -> McpTarget {
    McpTarget::Stdio(McpStdioCommand {
        command: crate::sidecar::tools::ghost::ghost_bin_path()
            .to_string_lossy()
            .into_owned(),
        args: vec!["mcp".to_string()],
        env: Vec::new(),
        cwd: None,
    })
}

// ── Wire bodies ───────────────────────────────────────────────────────────────
//
// The three recorder responses are a WIRE CONTRACT with the `ryu-recipes` sidecar,
// which deserializes them into its own `RecorderStarted`/`RecorderStatus`/
// `RecorderStopped` (bare serde derives, no rename/default). Core no longer links
// those structs, so these constructors are the single definition of each shape —
// built here rather than inline at the call site precisely so the tests below can
// assert the real production bytes instead of a copy of them.

/// `ghost.recordStart` response body.
fn started_body(started_at: &str, info: Value) -> Value {
    json!({ "started_at": started_at, "info": info })
}

/// `ghost.recordStatus` response body (the active-session arm).
fn status_body(task: &str, started_at: &str, status: Value) -> Value {
    json!({ "task": task, "started_at": started_at, "status": status })
}

/// `ghost.recordStop` response body.
fn stopped_body(task: &str, started_at: &str, payload: Value) -> Value {
    json!({ "task": task, "started_at": started_at, "payload": payload })
}

/// Core's kernel side of the recipes seam: stateless replay plus the singleton
/// recorder subprocess.
pub struct CoreRecipesHost;

impl CoreRecipesHost {
    /// Replay a recipe by calling `ghost.ghost_run` through the shared MCP
    /// registry. Returns the RAW MCP `tools/call` envelope — the sidecar's `run()`
    /// wrapper unwraps it with its own `extract_mcp_json`, so do not unwrap here.
    pub async fn call_ghost_run(&self, recipe: &str, params: Value) -> Result<Value> {
        let registry = crate::sidecar::mcp::global_registry()
            .ok_or_else(|| anyhow!("MCP registry not initialized"))?;
        registry
            .call_tool(
                crate::sidecar::mcp::GHOST_RUN_TOOL,
                json!({ "recipe": recipe, "params": params }),
                None,
            )
            .await
            .map_err(|e| anyhow!("recipe replay failed: {e}"))
    }

    /// Spawn a dedicated ghost recorder for `task` into the process-global slot.
    /// Wire shape: `{ started_at, info }`.
    pub async fn recorder_start(&self, task: &str) -> Result<Value> {
        let mut guard = recording().lock().await;
        if guard.is_some() {
            return Err(anyhow!(
                "a recording session is already active — stop it before starting another"
            ));
        }
        let mut session = McpSession::connect(&ghost_command()).await.map_err(|e| {
            anyhow!("could not start the ghost recorder: {e}. Install the ghost sidecar to record recipes.")
        })?;
        let info = session
            .call_tool("ghost_learn_start", json!({ "task": task }))
            .await
            .and_then(|r| extract_mcp_json(&r));
        let info = match info {
            Ok(v) => v,
            Err(e) => {
                // learn_start failed — don't leak the child.
                session.shutdown().await;
                return Err(anyhow!("ghost_learn_start failed: {e}"));
            }
        };
        let started_at = chrono::Utc::now().to_rfc3339();
        *guard = Some(Recording {
            session,
            task: task.to_string(),
            started_at: started_at.clone(),
        });
        Ok(started_body(&started_at, info))
    }

    /// Poll the held recorder. `Ok(None)` when idle (the caller serialises that as
    /// JSON `null`). Wire shape: `{ task, started_at, status }`.
    pub async fn recorder_status(&self) -> Result<Option<Value>> {
        let mut guard = recording().lock().await;
        match guard.as_mut() {
            None => Ok(None),
            Some(rec) => {
                let status = rec
                    .session
                    .call_tool("ghost_learn_status", json!({}))
                    .await
                    .and_then(|r| extract_mcp_json(&r))
                    .unwrap_or(Value::Null);
                Ok(Some(status_body(&rec.task, &rec.started_at, status)))
            }
        }
    }

    /// Stop and tear down the held recorder. Wire shape:
    /// `{ task, started_at, payload }`.
    pub async fn recorder_stop(&self) -> Result<Value> {
        let mut guard = recording().lock().await;
        let mut rec = guard
            .take()
            .ok_or_else(|| anyhow!("no active recording session to stop"))?;
        let payload = rec
            .session
            .call_tool("ghost_learn_stop", json!({}))
            .await
            .and_then(|r| extract_mcp_json(&r));
        rec.session.shutdown().await;
        let payload = payload?;
        Ok(stopped_body(&rec.task, &rec.started_at, payload))
    }
}

// ── `ghost.*` kernel capabilities (sidecar → Core) ───────────────────────────
//
// The `ryu-recipes` sidecar reaches the recorder above, and live replay through
// Core's shared MCP registry, via the generic capability broker
// (`POST /api/host/capability/ghost.{replay,recordStart,recordStatus,recordStop}`,
// rows in `sidecar::ext_proxy::KERNEL_CAPABILITIES`). Each handler mirrors ONE
// [`CoreRecipesHost`] method and returns its RAW result; the sidecar shapes it.
// These used to live in a separate `recipes_client.rs` "client" file even though
// Core never called the app — they are kernel capability handlers, so they live
// beside the kernel machinery they expose. Auth: [`authenticate_sidecar`] (minted
// `RYU_EXT_TOKEN` bearer + enabled check) plus the Recipes app pin.

/// Shared front half of every `ghost.*` kernel-capability handler: authenticate the
/// sidecar callback and assert it IS the Recipes app. Returns the error `Response`
/// to short-circuit on failure.
async fn authorize(state: &ServerState, headers: &HeaderMap) -> Result<(), Response> {
    let plugin_id = match authenticate_sidecar(state, headers).await {
        Ok((id, _grants)) => id,
        Err((status, msg)) => {
            return Err((status, Json(json!({ "error": msg }))).into_response());
        }
    };
    if plugin_id != RECIPES_PLUGIN_ID {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not the recipes app" })),
        )
            .into_response());
    }
    Ok(())
}

/// `POST /api/host/capability/ghost.replay` — replay a recipe through the live Ghost MCP
/// registry. Body `{ recipe, params }`; returns the RAW ghost MCP `tools/call`
/// envelope (the sidecar's `run()` wrapper unwraps it with `extract_mcp_json`).
pub(crate) async fn host_recipes_run(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(resp) = authorize(&state, &headers).await {
        return resp;
    }
    let recipe = body.get("recipe").and_then(Value::as_str).unwrap_or("");
    if recipe.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing recipe" })),
        )
            .into_response();
    }
    let params = body.get("params").cloned().unwrap_or(Value::Null);
    match CoreRecipesHost.call_ghost_run(recipe, params).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/host/capability/ghost.recordStart` — spawn the ghost recorder into Core's
/// process-global slot. Body `{ task }`; returns the raw `{ started_at, info }` body.
pub(crate) async fn host_recipes_record_start(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(resp) = authorize(&state, &headers).await {
        return resp;
    }
    let task = body.get("task").and_then(Value::as_str).unwrap_or("");
    match CoreRecipesHost.recorder_start(task).await {
        Ok(started) => Json(started).into_response(),
        Err(e) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/host/capability/ghost.recordStatus` — poll Core's held recorder. Returns the
/// raw `{ task, started_at, status }` body, or JSON `null` when idle.
pub(crate) async fn host_recipes_record_status(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = authorize(&state, &headers).await {
        return resp;
    }
    match CoreRecipesHost.recorder_status().await {
        Ok(status) => Json(status).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/host/capability/ghost.recordStop` — stop and tear down Core's held recorder.
/// Returns the raw `{ task, started_at, payload }` body.
pub(crate) async fn host_recipes_record_stop(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = authorize(&state, &headers).await {
        return resp;
    }
    match CoreRecipesHost.recorder_stop().await {
        Ok(stopped) => Json(stopped).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three recorder bodies are a WIRE CONTRACT: the `ryu-recipes` sidecar
    /// deserializes them into `RecorderStarted`/`RecorderStatus`/`RecorderStopped`
    /// (`serde_json::from_value`, bare derives, no rename/default). Core no longer
    /// links those structs, so nothing but these assertions stops a key rename here
    /// from silently breaking the sidecar. The app-side counterpart lives in
    /// `apps-store/recipes/backend/src/lib.rs` and deserializes these exact shapes.
    fn keys(v: &Value) -> Vec<&str> {
        let mut k: Vec<&str> = v
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        k.sort_unstable();
        k
    }

    #[test]
    fn recorder_started_wire_keys() {
        let body = started_body("2026-01-01T00:00:00Z", json!({ "ok": true }));
        assert_eq!(keys(&body), vec!["info", "started_at"]);
        assert_eq!(body["started_at"], json!("2026-01-01T00:00:00Z"));
        assert_eq!(body["info"], json!({ "ok": true }));
    }

    #[test]
    fn recorder_status_wire_keys() {
        let body = status_body("t", "2026-01-01T00:00:00Z", Value::Null);
        assert_eq!(keys(&body), vec!["started_at", "status", "task"]);
        assert_eq!(body["task"], json!("t"));
        assert_eq!(body["status"], Value::Null);
    }

    #[test]
    fn recorder_stopped_wire_keys() {
        let body = stopped_body("t", "2026-01-01T00:00:00Z", json!({ "event_count": 0 }));
        assert_eq!(keys(&body), vec!["payload", "started_at", "task"]);
        assert_eq!(body["payload"], json!({ "event_count": 0 }));
    }

    /// The idle branch must still serialize as JSON `null`, exactly as
    /// `Option<RecorderStatus>` did — the sidecar's `Option<RecorderStatus>`
    /// deserialize depends on it.
    #[test]
    fn idle_status_serializes_as_null() {
        let idle: Option<Value> = None;
        assert_eq!(serde_json::to_value(idle).unwrap(), Value::Null);
    }
}
