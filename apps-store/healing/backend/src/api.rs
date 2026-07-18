//! HTTP API for the self-healing loop (`/api/healing/config` + `/api/healing/status`).
//!
//! Thin handlers over the healing engine: read/write the `healing.*` config
//! (master switch + auto-decide + caps + diagnosis model) and inspect the
//! in-memory per-source attempt map.
//!
//! The router is built with its own state ([`HealingCtx`]) inside this crate so it
//! returns a state-less, mergeable `Router<()>`. The routes are declared relative
//! to `/api/healing` (Core nests this service at that prefix behind the
//! Self-Healing-App gate, alongside the kernel-coupled `/api/healing/simulate-failure`
//! debug endpoint that stays Core-side), while the OpenAPI annotations keep the
//! full external paths.

use std::sync::Arc;

use axum::{
    extract::State,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

use crate::{
    global_engine, resolve_config, HealSource, HealVerdict, HealingHost, HEALING_AUTO_DECIDE_PREF,
    HEALING_COOLDOWN_SECS_PREF, HEALING_DIAGNOSE_EFFORT_PREF, HEALING_DIAGNOSE_MODEL_PREF,
    HEALING_ENABLED_PREF, HEALING_MAX_ATTEMPTS_PREF,
};

/// Router state for the healing HTTP surface: the inverted [`HealingHost`] (for
/// reading/writing `healing.*` prefs). The per-source attempt map is read from the
/// process-global engine ([`global_engine`]).
#[derive(Clone)]
pub struct HealingCtx {
    pub host: Arc<dyn HealingHost>,
}

impl HealingCtx {
    pub fn new(host: Arc<dyn HealingHost>) -> Self {
        Self { host }
    }
}

/// Build the `/api/healing/*` config+status router with its own state baked in,
/// returning a state-less `Router<()>` the host nests at `/api/healing` behind the
/// App gate.
pub fn routes(ctx: HealingCtx) -> Router<()> {
    Router::new()
        .route("/config", get(config).post(set_config))
        .route("/status", get(status))
        .route("/report-failure", post(report_failure))
        .with_state(ctx)
}

/// The OpenAPI sub-document for the healing config+status surface, merged into
/// Core's spec when the `healing` feature is enabled.
pub fn openapi() -> utoipa::openapi::OpenApi {
    <HealingApiDoc as utoipa::OpenApi>::openapi()
}

#[derive(utoipa::OpenApi)]
#[openapi(paths(config, set_config, status))]
struct HealingApiDoc;

/// `GET /api/healing/config` — resolved healing config (switches + caps + model).
#[utoipa::path(
    get,
    path = "/api/healing/config",
    tag = "Healing",
    summary = "resolved healing config (switches + caps + model).",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn config(State(ctx): State<HealingCtx>) -> impl IntoResponse {
    Json(resolve_config(&*ctx.host).await)
}

/// `POST /api/healing/config` — set any provided `healing.*` prefs. Body accepts
/// any of: `enabled`, `auto_decide` (bool), `max_attempts`, `cooldown_secs`
/// (number), `diagnose_model`, `diagnose_effort` (string).
#[utoipa::path(
    post,
    path = "/api/healing/config",
    tag = "Healing",
    summary = "set any provided `healing.*` prefs. Body accepts",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn set_config(State(ctx): State<HealingCtx>, Json(body): Json<Value>) -> Response {
    async fn set_bool(host: &dyn HealingHost, key: &str, v: Option<bool>) {
        if let Some(b) = v {
            let _ = host.pref_set(key, if b { "true" } else { "false" }).await;
        }
    }
    async fn set_str(host: &dyn HealingHost, key: &str, v: Option<&str>) {
        if let Some(s) = v {
            let _ = host.pref_set(key, s).await;
        }
    }
    set_bool(&*ctx.host, HEALING_ENABLED_PREF, body.get("enabled").and_then(Value::as_bool)).await;
    set_bool(
        &*ctx.host,
        HEALING_AUTO_DECIDE_PREF,
        body.get("auto_decide").and_then(Value::as_bool),
    )
    .await;
    if let Some(n) = body.get("max_attempts").and_then(Value::as_u64) {
        let _ = ctx.host.pref_set(HEALING_MAX_ATTEMPTS_PREF, &n.to_string()).await;
    }
    if let Some(n) = body.get("cooldown_secs").and_then(Value::as_i64) {
        let _ = ctx.host.pref_set(HEALING_COOLDOWN_SECS_PREF, &n.to_string()).await;
    }
    set_str(
        &*ctx.host,
        HEALING_DIAGNOSE_MODEL_PREF,
        body.get("diagnose_model").and_then(Value::as_str),
    )
    .await;
    set_str(
        &*ctx.host,
        HEALING_DIAGNOSE_EFFORT_PREF,
        body.get("diagnose_effort").and_then(Value::as_str),
    )
    .await;
    Json(resolve_config(&*ctx.host).await).into_response()
}

/// `POST /api/healing/report-failure` — the INTERNAL Core→sidecar ingress. Core's
/// loopback client posts a failed run's context (already extracted host-side: the
/// run-status bus, scheduler, and workflow executor all stay kernel), the sidecar
/// engine runs the cap/cooldown/never-heal-a-heal decision + the Gateway diagnosis,
/// and returns a [`HealVerdict`] JSON for Core to `apply_verdict` (Core owns the
/// welded approvals write + agent/workflow re-run). Deliberately NOT listed in the
/// manifest's public `routes[]` — it is reachable only on loopback with the ext
/// bearer, never through the public ext-proxy mount.
///
/// Body: `{ "source_id": string, "kind": "agent"|"workflow", "agent_id"?: string,
/// "instruction"?: string, "failure"?: string }`.
pub async fn report_failure(State(_ctx): State<HealingCtx>, Json(body): Json<Value>) -> Response {
    let Some(engine) = global_engine() else {
        return Json(HealVerdict::Skip {
            reason: "heal engine unavailable".to_owned(),
        })
        .into_response();
    };
    let source_id = body
        .get("source_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let agent_id = body
        .get("agent_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let instruction = body
        .get("instruction")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let failure = body
        .get("failure")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let source = match body.get("kind").and_then(Value::as_str) {
        Some("workflow") => HealSource::Workflow,
        _ => HealSource::Agent { agent_id },
    };
    let verdict = engine
        .evaluate(&source_id, source, instruction, failure)
        .await;
    Json(verdict).into_response()
}

/// `GET /api/healing/status` — the in-memory per-source attempt map.
#[utoipa::path(
    get,
    path = "/api/healing/status",
    tag = "Healing",
    summary = "the in-memory per-source attempt map.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn status(State(_ctx): State<HealingCtx>) -> Response {
    let attempts = match global_engine() {
        Some(engine) => engine.attempt_snapshot().await,
        None => Default::default(),
    };
    Json(json!({ "attempts": attempts })).into_response()
}
