//! Self-healing HTTP surface (`/api/healing/*`).
//!
//! Thin handlers over [`crate::healing`]: read/write the `healing.*` config
//! (master switch + auto-decide + caps), inspect the in-memory attempt map, and a
//! debug hook to synthesize a failed run so the loop can be exercised end-to-end
//! without waiting for a real failure.

use axum::{
    extract::State,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use crate::healing::{
    self, HEALING_AUTO_DECIDE_PREF, HEALING_COOLDOWN_SECS_PREF, HEALING_DIAGNOSE_EFFORT_PREF,
    HEALING_DIAGNOSE_MODEL_PREF, HEALING_ENABLED_PREF, HEALING_MAX_ATTEMPTS_PREF,
};

use super::ServerState;

/// `GET /api/healing/config` — resolved healing config (switches + caps + model).
pub async fn config(State(state): State<ServerState>) -> impl IntoResponse {
    Json(healing::resolve_config(&state).await)
}

/// `POST /api/healing/config` — set any provided `healing.*` prefs. Body accepts
/// any of: `enabled`, `auto_decide` (bool), `max_attempts`, `cooldown_secs`
/// (number), `diagnose_model`, `diagnose_effort` (string).
pub async fn set_config(State(state): State<ServerState>, Json(body): Json<Value>) -> Response {
    async fn set_bool(state: &ServerState, key: &str, v: Option<bool>) {
        if let Some(b) = v {
            let _ = state.preferences.set(key, if b { "true" } else { "false" }).await;
        }
    }
    async fn set_str(state: &ServerState, key: &str, v: Option<&str>) {
        if let Some(s) = v {
            let _ = state.preferences.set(key, s).await;
        }
    }
    set_bool(&state, HEALING_ENABLED_PREF, body.get("enabled").and_then(Value::as_bool)).await;
    set_bool(
        &state,
        HEALING_AUTO_DECIDE_PREF,
        body.get("auto_decide").and_then(Value::as_bool),
    )
    .await;
    if let Some(n) = body.get("max_attempts").and_then(Value::as_u64) {
        let _ = state
            .preferences
            .set(HEALING_MAX_ATTEMPTS_PREF, &n.to_string())
            .await;
    }
    if let Some(n) = body.get("cooldown_secs").and_then(Value::as_i64) {
        let _ = state
            .preferences
            .set(HEALING_COOLDOWN_SECS_PREF, &n.to_string())
            .await;
    }
    set_str(
        &state,
        HEALING_DIAGNOSE_MODEL_PREF,
        body.get("diagnose_model").and_then(Value::as_str),
    )
    .await;
    set_str(
        &state,
        HEALING_DIAGNOSE_EFFORT_PREF,
        body.get("diagnose_effort").and_then(Value::as_str),
    )
    .await;
    Json(healing::resolve_config(&state).await).into_response()
}

/// `GET /api/healing/status` — the in-memory per-source attempt map.
pub async fn status(State(_state): State<ServerState>) -> Response {
    let attempts = match healing::global_engine() {
        Some(engine) => engine.attempt_snapshot().await,
        None => Default::default(),
    };
    Json(json!({ "attempts": attempts })).into_response()
}

/// `POST /api/healing/simulate-failure` — DEBUG: create a throwaway conversation
/// with a stored user instruction and flip it to `run_status = failed`, firing the
/// real run-status event so the heal loop runs exactly as it would for a genuine
/// failure. Body: `{ "prompt"?: string, "agent_id"?: string }`.
pub async fn simulate_failure(
    State(state): State<ServerState>,
    Json(body): Json<Value>,
) -> Response {
    let prompt = body
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("Summarize the attached report.");
    let agent_id = body.get("agent_id").and_then(Value::as_str);
    let conv_id = format!("simfail_{}", uuid::Uuid::new_v4().simple());

    if let Err(e) = state
        .conversations
        .ensure_conversation(&conv_id, agent_id, Some("Simulated failed run"))
        .await
    {
        return err(e);
    }
    if let Err(e) = state
        .conversations
        .append_message(&conv_id, "user", prompt, agent_id, None, None)
        .await
    {
        return err(e);
    }
    // Optional stored failure output so the diagnosis has something to read.
    let _ = state
        .conversations
        .append_message(
            &conv_id,
            "assistant",
            "Error: tool `read_file` failed — file not found.",
            agent_id,
            None,
            None,
        )
        .await;
    if let Err(e) = state.conversations.set_run_status(&conv_id, "failed").await {
        return err(e);
    }
    Json(json!({ "conversation_id": conv_id, "status": "failed" })).into_response()
}

fn err(e: anyhow::Error) -> Response {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": format!("{e:#}") })),
    )
        .into_response()
}
