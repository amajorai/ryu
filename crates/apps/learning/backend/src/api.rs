//! Continual-learning HTTP surface (`/api/learn/*`, `/api/experience/list`).
//!
//! State-baked, state-less `Router<()>` whose absolute paths match Core's
//! in-process mount byte-for-byte, so the generic ext-proxy forwards them
//! unchanged. Thin handlers over [`crate::engine`]: config read, experience-buffer
//! inspection, PRM scoring, skill synthesis, and the reward-filtered retrain cycle.
//! All capture/scoring is gated on the global opt-in inside the engine (default
//! OFF). See `docs/continual-learning-metaclaw-spec.md`.
//!
//! NOTE ON ACL: Core's in-process copy of these handlers additionally enforces the
//! per-conversation read ACL on `/api/learn/synthesize` (a client-supplied
//! conversation id is distilled — a READ) and gates the whole surface on the
//! Learning App being enabled. Those checks are kernel-owned (identity + plugin
//! store) and stay in Core; this crate's surface is the plain engine passthrough
//! the out-of-process sidecar would serve once a broker-back identity hop exists.

use axum::{
    extract::State,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

use crate::engine;
use crate::LearningCtx;

/// The `/api/learn/*` + `/api/experience/list` router, state-baked with `ctx`.
pub fn routes(ctx: LearningCtx) -> Router<()> {
    Router::new()
        .route("/api/learn/config", get(config))
        .route("/api/learn/sweep", post(sweep))
        .route("/api/learn/score", post(score))
        .route("/api/learn/synthesize", post(synthesize))
        .route("/api/learn/cycle", post(cycle))
        .route("/api/learn/exclude", post(exclude))
        .route("/api/experience/list", get(list))
        .with_state(ctx)
}

/// `GET /api/learn/config` — resolved, secret-free learning config.
#[utoipa::path(
    get,
    path = "/api/learn/config",
    tag = "Learning",
    summary = "resolved, secret-free learning config.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn config(State(ctx): State<LearningCtx>) -> impl IntoResponse {
    Json(engine::resolve_config(&*ctx.host).await)
}

/// `GET /api/experience/list` — most-recent captured turns (cap 200).
#[utoipa::path(
    get,
    path = "/api/experience/list",
    tag = "Learning",
    summary = "most-recent captured turns (cap 200).",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list(State(ctx): State<LearningCtx>) -> Response {
    match ctx.store.list(200).await {
        Ok(rows) => {
            let min_reward = engine::resolve_min_reward(&*ctx.host).await;
            let counts = ctx.store.counts(min_reward).await.unwrap_or((0, 0, 0));
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
pub async fn sweep(State(ctx): State<LearningCtx>) -> Response {
    match engine::sweep_into_buffer(&ctx).await {
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
pub async fn score(State(ctx): State<LearningCtx>) -> Response {
    match engine::score_buffer(&ctx, 256).await {
        Ok(scored) => Json(json!({ "scored": scored })).into_response(),
        Err(e) => err(e),
    }
}

/// `POST /api/learn/synthesize` — distill + activate a skill from a conversation.
/// Body: `{ "conversation_id": "...", "force": false }`. `force` is set only by a
/// deliberate per-conversation user action; without it the call is a no-op when
/// the skills opt-in is off (consent gate).
#[utoipa::path(
    post,
    path = "/api/learn/synthesize",
    tag = "Learning",
    summary = "distill + activate a skill from a conversation.",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn synthesize(State(ctx): State<LearningCtx>, Json(body): Json<Value>) -> Response {
    let Some(cid) = body.get("conversation_id").and_then(Value::as_str) else {
        return bad_request("missing `conversation_id`");
    };
    let force = body.get("force").and_then(Value::as_bool).unwrap_or(false);
    match engine::synthesize_skill(&ctx, cid, force).await {
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
pub async fn cycle(State(ctx): State<LearningCtx>, Json(body): Json<Value>) -> Response {
    let execute = body
        .get("execute")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    match engine::run_cycle(&ctx, execute).await {
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
pub async fn exclude(State(ctx): State<LearningCtx>, Json(body): Json<Value>) -> Response {
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
    let flipped = match ctx.store.exclude_conversation(cid, excluded).await {
        Ok(n) => n,
        Err(e) => return err(e),
    };
    let key = format!("{}{cid}", engine::LEARNING_EXCLUDE_PREFIX);
    if let Err(e) = ctx.host.pref_set(&key, &excluded.to_string()).await {
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

/// OpenAPI document for the standalone sidecar surface.
#[derive(utoipa::OpenApi)]
#[openapi(paths(config, list, sweep, score, synthesize, cycle, exclude))]
pub struct ApiDoc;

/// The generated OpenAPI document (parity with Core's registration).
pub fn openapi() -> utoipa::openapi::OpenApi {
    <ApiDoc as utoipa::OpenApi>::openapi()
}
