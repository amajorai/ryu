//! Continual-learning HTTP surface (`/api/learn/*`, `/api/experience/*`).
//!
//! Thin handlers over [`crate::learning`]: config read, experience-buffer
//! inspection, PRM scoring, skill synthesis, and the reward-filtered retrain
//! cycle. All capture/scoring is gated on the global opt-in inside the learning
//! layer (default OFF). See `docs/continual-learning-metaclaw-spec.md`.

use axum::{
    extract::State,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use crate::learning;

use super::ServerState;

/// `GET /api/learn/config` — resolved, secret-free learning config.
pub async fn config(State(state): State<ServerState>) -> impl IntoResponse {
    Json(learning::resolve_config(&state).await)
}

/// `GET /api/experience/list` — most-recent captured turns (cap 200).
pub async fn list(State(state): State<ServerState>) -> Response {
    match state.experience.list(200).await {
        Ok(rows) => {
            let min_reward = learning::resolve_min_reward(&state).await;
            let counts = state.experience.counts(min_reward).await.unwrap_or((0, 0, 0));
            (
                axum::http::StatusCode::OK,
                Json(json!({
                    "experiences": rows,
                    "total": counts.0,
                    "scored": counts.1,
                    "trainable": counts.2,
                    "min_reward": min_reward,
                })),
            )
                .into_response()
        }
        Err(e) => err(e),
    }
}

/// `POST /api/learn/sweep` — capture new turns from the conversation store.
pub async fn sweep(State(state): State<ServerState>) -> Response {
    match learning::sweep_into_buffer(&state).await {
        Ok(added) => Json(json!({ "captured": added })).into_response(),
        Err(e) => err(e),
    }
}

/// `POST /api/learn/score` — PRM-score unscored samples (cap 256/call).
pub async fn score(State(state): State<ServerState>) -> Response {
    match learning::score_buffer(&state, 256).await {
        Ok(scored) => Json(json!({ "scored": scored })).into_response(),
        Err(e) => err(e),
    }
}

/// `POST /api/learn/synthesize` — distill + activate a skill from a conversation.
/// Body: `{ "conversation_id": "...", "force": false }`. `force` is set only by a
/// deliberate per-conversation user action; without it the call is a no-op when
/// the global learning opt-in is off (consent gate).
pub async fn synthesize(State(state): State<ServerState>, Json(body): Json<Value>) -> Response {
    let Some(cid) = body.get("conversation_id").and_then(Value::as_str) else {
        return bad_request("missing `conversation_id`");
    };
    let force = body.get("force").and_then(Value::as_bool).unwrap_or(false);
    match learning::synthesize_skill(&state, cid, force).await {
        Ok(outcome) => Json(outcome).into_response(),
        Err(e) => err(e),
    }
}

/// `POST /api/learn/cycle` — sweep + score + assemble the reward-filtered SFT
/// dataset. Dry run by default; `{ "execute": true }` is reserved for dispatching
/// the fine-tune (not wired in the scaffold; needs a GPU + the original base).
pub async fn cycle(State(state): State<ServerState>, Json(body): Json<Value>) -> Response {
    let execute = body.get("execute").and_then(Value::as_bool).unwrap_or(false);
    match learning::run_cycle(&state, execute).await {
        Ok(plan) => Json(plan).into_response(),
        Err(e) => err(e),
    }
}

/// `POST /api/learn/exclude` — per-conversation opt-out. Body:
/// `{ "conversation_id": "...", "excluded": true }`. Sets the pref AND flips any
/// already-buffered rows so an excluded chat is dropped from training retroactively.
pub async fn exclude(State(state): State<ServerState>, Json(body): Json<Value>) -> Response {
    let Some(cid) = body.get("conversation_id").and_then(Value::as_str) else {
        return bad_request("missing `conversation_id`");
    };
    let excluded = body.get("excluded").and_then(Value::as_bool).unwrap_or(true);
    // Flip already-buffered rows FIRST and surface any failure — the retroactive
    // training-exclusion guarantee depends on this UPDATE, so a swallowed error
    // (e.g. a busy WAL) must not be reported as success. Only persist the pref
    // once the rows are consistent.
    let flipped = match state.experience.exclude_conversation(cid, excluded).await {
        Ok(n) => n,
        Err(e) => return err(e),
    };
    let key = format!("{}{cid}", learning::LEARNING_EXCLUDE_PREFIX);
    if let Err(e) = state.preferences.set(&key, &excluded.to_string()).await {
        return err(e);
    }
    Json(json!({ "conversation_id": cid, "excluded": excluded, "rows_updated": flipped }))
        .into_response()
}

fn err(e: anyhow::Error) -> Response {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": format!("{e:#}") })),
    )
        .into_response()
}

fn bad_request(msg: &str) -> Response {
    (
        axum::http::StatusCode::BAD_REQUEST,
        Json(json!({ "error": msg })),
    )
        .into_response()
}
