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

/// `POST /api/learn/synthesize` — distill a skill from a conversation and propose
/// it in the approval inbox (direct activation only when the approval gate is
/// off). Body: `{ "conversation_id": "...", "force": false }`. `force` is set
/// only by a deliberate per-conversation user action; without it the call is a
/// no-op when the skills opt-in is off (consent gate). `force` never bypasses the
/// approval inbox — an activated skill is node-global context, and this route is
/// reachable with only the per-conversation READ ACL (H13).
#[utoipa::path(
    post,
    path = "/api/learn/synthesize",
    tag = "Learning",
    summary = "distill a skill from a conversation and propose it for approval.",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn synthesize(State(ctx): State<LearningCtx>, Json(body): Json<Value>) -> Response {
    let Some(cid) = body.get("conversation_id").and_then(Value::as_str) else {
        return bad_request("missing `conversation_id`");
    };
    let force = body.get("force").and_then(Value::as_bool).unwrap_or(false);
    // No verified caller on the sidecar surface (identity is kernel-owned, see the
    // module NOTE ON ACL), so provenance carries no `requested-by`.
    match engine::synthesize_skill(&ctx, cid, force, None).await {
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

#[cfg(test)]
mod tests {
    //! Handler-level coverage. Handlers are called directly (no tower) with a
    //! state-baked [`LearningCtx`] over the in-memory [`crate::test_support::MockHost`]
    //! and a tempfile-backed store — fully hermetic.

    use super::*;
    use crate::engine::{LearningCtx, LEARNING_ENABLED_PREF, LEARNING_EXCLUDE_PREFIX};
    use crate::store::ExperienceStore;
    use crate::test_support::MockHost;
    use axum::response::IntoResponse;
    use std::sync::Arc;

    fn store(tag: &str) -> ExperienceStore {
        let dir = std::env::temp_dir().join(format!(
            "ryu-learn-api-{}-{tag}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        ExperienceStore::open(dir.join("experience.db")).expect("open store")
    }

    fn ctx(host: MockHost, store: ExperienceStore) -> LearningCtx {
        LearningCtx::new(store, Arc::new(host), reqwest::Client::new())
    }

    async fn body(resp: Response) -> (axum::http::StatusCode, Value) {
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let v = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, v)
    }

    #[tokio::test]
    async fn config_reports_default_posture() {
        let c = ctx(MockHost::new(), store("config"));
        let resp = config(State(c)).await.into_response();
        let (status, v) = body(resp).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(v["enabled"], false); // training default OFF
        assert_eq!(v["skills_enabled"], true); // skills default ON
    }

    #[tokio::test]
    async fn list_reports_rows_and_counts() {
        let c = ctx(MockHost::new(), store("list"));
        let exp = crate::store::Experience {
            id: "a".into(),
            conversation_id: "c1".into(),
            agent_id: None,
            user_text: "q".into(),
            assistant_text: "a".into(),
            outcome: "completed".into(),
            reward: Some(0.9),
            base_model: None,
            skill_generation: 0,
            excluded: false,
            created_at: "t".into(),
        };
        c.store.record_if_absent(&exp).await.unwrap();
        let resp = list(State(c)).await;
        let (status, v) = body(resp).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(v["total"], 1);
        assert_eq!(v["scored"], 1);
        assert_eq!(v["experiences"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn sweep_and_score_are_gated_off_by_default() {
        let host = MockHost::new()
            .with_conversation("c1", 10, 2)
            .with_messages("c1", &[("user", "q"), ("assistant", "a")]);
        let c = ctx(host, store("sweep-gated"));
        let (_, swept) = body(sweep(State(c.clone())).await).await;
        assert_eq!(swept["captured"], 0);
        let (_, scored) = body(score(State(c)).await).await;
        assert_eq!(scored["scored"], 0);
    }

    #[tokio::test]
    async fn sweep_captures_when_enabled() {
        let host = MockHost::new()
            .with_pref(LEARNING_ENABLED_PREF, "true")
            .with_conversation("c1", 10, 2)
            .with_messages("c1", &[("user", "q"), ("assistant", "a")]);
        let c = ctx(host, store("sweep-on"));
        let (status, v) = body(sweep(State(c)).await).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(v["captured"], 1);
    }

    #[tokio::test]
    async fn synthesize_rejects_missing_conversation_id() {
        let c = ctx(MockHost::new(), store("synth-bad"));
        let resp = synthesize(State(c), Json(json!({}))).await;
        let (status, v) = body(resp).await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().contains("conversation_id"));
    }

    #[tokio::test]
    async fn synthesize_queues_for_approval() {
        let mut host =
            MockHost::new().with_messages("c1", &[("user", "how"), ("assistant", "do it")]);
        host.synth_reply = Some(
            r#"{"name":"A skill","description":"d","instructions":"steps here"}"#.to_string(),
        );
        let c = ctx(host, store("synth-ok"));
        let resp = synthesize(
            State(c),
            Json(json!({ "conversation_id": "c1", "force": true })),
        )
        .await;
        let (status, v) = body(resp).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(v["created"], false); // deferred to inbox approval
        assert!(v["slug"].as_str().unwrap().starts_with("learned-"));
    }

    #[tokio::test]
    async fn cycle_dry_run_reports_disabled_note() {
        let c = ctx(MockHost::new(), store("cycle"));
        let resp = cycle(State(c), Json(json!({}))).await;
        let (status, v) = body(resp).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(v["dispatched"], false);
        assert!(v["note"].as_str().unwrap().contains("disabled"));
    }

    #[tokio::test]
    async fn exclude_rejects_missing_id_then_flips_rows_and_pref() {
        let c = ctx(MockHost::new(), store("exclude"));
        // Missing id -> 400.
        let (status, _) = body(exclude(State(c.clone()), Json(json!({}))).await).await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);

        // Seed a buffered row for the conversation.
        let exp = crate::store::Experience {
            id: "a".into(),
            conversation_id: "c1".into(),
            agent_id: None,
            user_text: "q".into(),
            assistant_text: "a".into(),
            outcome: "completed".into(),
            reward: Some(0.9),
            base_model: None,
            skill_generation: 0,
            excluded: false,
            created_at: "t".into(),
        };
        c.store.record_if_absent(&exp).await.unwrap();

        let resp = exclude(
            State(c.clone()),
            Json(json!({ "conversation_id": "c1", "excluded": true })),
        )
        .await;
        let (status, v) = body(resp).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(v["rows_updated"], 1);
        assert_eq!(v["excluded"], true);
        // Row flag flipped AND the pref persisted.
        assert_eq!(c.store.list(10).await.unwrap()[0].excluded, true);
        let pref = format!("{LEARNING_EXCLUDE_PREFIX}c1");
        assert_eq!(c.host.pref_get(&pref).await.as_deref(), Some("true"));
    }

    #[tokio::test]
    async fn openapi_lists_every_route() {
        let doc = openapi();
        let paths = &doc.paths.paths;
        assert!(paths.contains_key("/api/learn/config"));
        assert!(paths.contains_key("/api/learn/synthesize"));
        assert!(paths.contains_key("/api/experience/list"));
    }
}

/// OpenAPI document for the standalone sidecar surface.
#[derive(utoipa::OpenApi)]
#[openapi(paths(config, list, sweep, score, synthesize, cycle, exclude))]
pub struct ApiDoc;

/// The generated OpenAPI document (parity with Core's registration).
pub fn openapi() -> utoipa::openapi::OpenApi {
    <ApiDoc as utoipa::OpenApi>::openapi()
}
