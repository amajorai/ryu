//! Continual-learning HTTP surface (`/api/learn/*`, `/api/experience/*`).
//!
//! Thin, Core-owned handlers over the extracted `ryu-learning` engine
//! ([`ryu_learning`], driven through [`crate::learning::learning_ctx`]): config
//! read, experience-buffer inspection, PRM scoring, skill synthesis, and the
//! reward-filtered retrain cycle. All capture/scoring is gated on the global opt-in
//! inside the engine (default OFF). See `docs/continual-learning-metaclaw-spec.md`.
//!
//! These handlers stay IN CORE (rather than the crate's own `api::routes`) because
//! two checks are kernel-owned: the per-conversation read ACL on
//! `/api/learn/synthesize` (a client-supplied conversation is distilled — a READ)
//! and the Learning-App enable gate on the whole surface (`learning_routes`).

use axum::{
    extract::State,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use crate::learning::learning_ctx;

use super::ServerState;

/// `GET /api/learn/config` — resolved, secret-free learning config.
#[utoipa::path(
    get,
    path = "/api/learn/config",
    tag = "Learning",
    summary = "resolved, secret-free learning config.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn config(State(state): State<ServerState>) -> impl IntoResponse {
    let ctx = learning_ctx(&state);
    Json(ryu_learning::resolve_config(&*ctx.host).await)
}

/// `GET /api/experience/list` — most-recent captured turns (cap 200).
#[utoipa::path(
    get,
    path = "/api/experience/list",
    tag = "Learning",
    summary = "most-recent captured turns (cap 200).",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list(State(state): State<ServerState>) -> Response {
    match state.experience.list(200).await {
        Ok(rows) => {
            let ctx = learning_ctx(&state);
            let min_reward = ryu_learning::resolve_min_reward(&*ctx.host).await;
            let counts = state
                .experience
                .counts(min_reward)
                .await
                .unwrap_or((0, 0, 0));
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
#[utoipa::path(
    post,
    path = "/api/learn/sweep",
    tag = "Learning",
    summary = "capture new turns from the conversation store.",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn sweep(State(state): State<ServerState>) -> Response {
    match ryu_learning::sweep_into_buffer(&learning_ctx(&state)).await {
        Ok(added) => Json(json!({ "captured": added })).into_response(),
        Err(e) => err(e),
    }
}

/// `POST /api/learn/score` — PRM-score unscored samples (cap 256/call).
#[utoipa::path(
    post,
    path = "/api/learn/score",
    tag = "Learning",
    summary = "PRM-score unscored samples (cap 256/call).",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn score(State(state): State<ServerState>) -> Response {
    match ryu_learning::score_buffer(&learning_ctx(&state), 256).await {
        Ok(scored) => Json(json!({ "scored": scored })).into_response(),
        Err(e) => err(e),
    }
}

/// `POST /api/learn/synthesize` — distill + activate a skill from a conversation.
/// Body: `{ "conversation_id": "...", "force": false }`. `force` is set only by a
/// deliberate per-conversation user action; without it the call is a no-op when
/// the global learning opt-in is off (consent gate).
#[utoipa::path(
    post,
    path = "/api/learn/synthesize",
    tag = "Learning",
    summary = "distill + activate a skill from a conversation.",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn synthesize(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(cid) = body.get("conversation_id").and_then(Value::as_str) else {
        return bad_request("missing `conversation_id`");
    };
    // Per-resource ACL: this DISTILLS a client-supplied conversation's content into
    // a skill (and the skill text is then readable by its author), so it is a READ of
    // that conversation by any other name. Gate it like every other by-id
    // conversation route. No-op on an unbound personal node. This ACL is kernel-owned
    // (identity), which is why the handler stays in Core rather than the crate.
    if let Err(resp) = super::require_conversation_read_by_id(&state, &caller, cid).await {
        return resp;
    }
    let force = body.get("force").and_then(Value::as_bool).unwrap_or(false);
    match ryu_learning::synthesize_skill(&learning_ctx(&state), cid, force).await {
        Ok(outcome) => Json(outcome).into_response(),
        Err(e) => err(e),
    }
}

/// `POST /api/learn/cycle` — sweep + score + assemble the reward-filtered SFT
/// dataset. Dry run by default; `{ "execute": true }` dispatches the fine-tune.
#[utoipa::path(
    post,
    path = "/api/learn/cycle",
    tag = "Learning",
    summary = "sweep + score + assemble the reward-filtered SFT",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn cycle(State(state): State<ServerState>, Json(body): Json<Value>) -> Response {
    let execute = body
        .get("execute")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    match ryu_learning::run_cycle(&learning_ctx(&state), execute).await {
        Ok(plan) => Json(plan).into_response(),
        Err(e) => err(e),
    }
}

/// `POST /api/learn/exclude` — per-conversation opt-out. Body:
/// `{ "conversation_id": "...", "excluded": true }`. Sets the pref AND flips any
/// already-buffered rows so an excluded chat is dropped from training retroactively.
#[utoipa::path(
    post,
    path = "/api/learn/exclude",
    tag = "Learning",
    summary = "per-conversation opt-out. Body:",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn exclude(State(state): State<ServerState>, Json(body): Json<Value>) -> Response {
    let Some(cid) = body.get("conversation_id").and_then(Value::as_str) else {
        return bad_request("missing `conversation_id`");
    };
    let excluded = body
        .get("excluded")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    // Flip already-buffered rows FIRST and surface any failure — the retroactive
    // training-exclusion guarantee depends on this UPDATE, so a swallowed error
    // (e.g. a busy WAL) must not be reported as success. Only persist the pref
    // once the rows are consistent.
    let flipped = match state.experience.exclude_conversation(cid, excluded).await {
        Ok(n) => n,
        Err(e) => return err(e),
    };
    let key = format!("{}{cid}", ryu_learning::LEARNING_EXCLUDE_PREFIX);
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
