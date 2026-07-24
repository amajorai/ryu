//! HTTP API for predictive typing (`/api/predict/*`): the system-wide inline
//! autocomplete brain.
//!
//! - `GET  /api/predict/config`   → the normalized [`PredictConfig`] (defaults
//!   applied) so the desktop settings tab and the `apps-store/predict` overlay both
//!   read one shape in a single call.
//! - `PUT  /api/predict/config`   → persist the config blob.
//! - `POST /api/predict/complete` → given the caret context, return a single
//!   inline suggestion. Enforces the app allowlist + the secure-field denylist
//!   here (Core decides *what runs*), then hands the model call to the Gateway
//!   via [`PredictHost::call_side_model`] (the same path `/btw` uses).
//!
//! Pure logic (prompt assembly, denylist, cleanup) lives in the crate root.
//!
//! The router is built with its own state ([`PredictCtx`]) inside this crate so it
//! returns a state-less, mergeable `Router<()>`. Routes are declared relative to
//! `/api/predict` (Core nests this service at that prefix behind the Predict-App
//! gate), while the OpenAPI annotations keep the full external paths.

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{PredictConfig, PredictHost, PREDICT_CONFIG_PREF};

/// Router state for the predict HTTP surface: the [`PredictHost`] that inverts the
/// kernel couplings (enabled flag, preferences, agent-bound model, default model,
/// Gateway side-model call). Cloneable so the router bakes a concrete state and
/// returns `Router<()>`.
#[derive(Clone)]
pub struct PredictCtx {
    host: Arc<dyn PredictHost>,
}

impl PredictCtx {
    pub fn new(host: Arc<dyn PredictHost>) -> Self {
        Self { host }
    }
}

/// Build the `/api/predict/*` router with its own state baked in, returning a
/// state-less `Router<()>` the host nests at `/api/predict` behind the App gate.
pub fn routes(ctx: PredictCtx) -> Router<()> {
    Router::new()
        .route("/config", get(get_config).put(put_config))
        .route("/complete", post(complete))
        .with_state(ctx)
}

/// The OpenAPI sub-document for the predict surface, merged into Core's spec.
pub fn openapi() -> utoipa::openapi::OpenApi {
    <PredictApiDoc as utoipa::OpenApi>::openapi()
}

#[derive(utoipa::OpenApi)]
#[openapi(paths(complete, get_config, put_config))]
struct PredictApiDoc;

/// Build a JSON error response with a `{ "error": msg }` body and the given status.
fn json_error(status: StatusCode, msg: String) -> axum::response::Response {
    (status, Json(json!({ "error": msg }))).into_response()
}

/// Load the persisted config (defaults applied) for the current node.
async fn load_config(ctx: &PredictCtx) -> PredictConfig {
    let raw = ctx.host.pref_get(PREDICT_CONFIG_PREF).await;
    PredictConfig::from_pref(raw.as_deref())
}

/// Resolve the model that answers predictions: an explicit `agent_id`'s bound
/// model → `config.model` → env `RYU_PREDICT_MODEL`/`RYU_DEFAULT_LLM_MODEL` →
/// the built-in default. Nothing hardcoded.
async fn resolve_model(ctx: &PredictCtx, config: &PredictConfig, agent_id: Option<&str>) -> String {
    // An explicit agent's bound chat model wins — it makes the prediction agent
    // a real, swappable card.
    if let Some(id) = agent_id.filter(|s| !s.is_empty()) {
        if let Some(m) = ctx
            .host
            .agent_bound_model(id)
            .await
            .filter(|m| !m.trim().is_empty())
        {
            return m;
        }
    }
    let configured = config.model.trim();
    if !configured.is_empty() {
        return configured.to_string();
    }
    for var in ["RYU_PREDICT_MODEL", "RYU_DEFAULT_LLM_MODEL"] {
        if let Ok(val) = std::env::var(var) {
            if !val.is_empty() {
                return val;
            }
        }
    }
    ctx.host.default_model()
}

/// `GET /api/predict/config` — the normalized predictive-typing config.
#[utoipa::path(
    get,
    path = "/api/predict/config",
    tag = "Predict",
    summary = "Get predictive-typing config",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_config(State(ctx): State<PredictCtx>) -> Json<PredictConfig> {
    Json(load_config(&ctx).await)
}

/// `PUT /api/predict/config` — persist the predictive-typing config.
#[utoipa::path(
    put,
    path = "/api/predict/config",
    tag = "Predict",
    summary = "Update predictive-typing config",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn put_config(
    State(ctx): State<PredictCtx>,
    Json(config): Json<PredictConfig>,
) -> axum::response::Response {
    let raw = match serde_json::to_string(&config) {
        Ok(s) => s,
        Err(e) => {
            return json_error(StatusCode::BAD_REQUEST, format!("invalid config: {e}"));
        }
    };
    match ctx.host.pref_set(PREDICT_CONFIG_PREF, &raw).await {
        Ok(()) => Json(config).into_response(),
        Err(e) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to persist config: {e}"),
        ),
    }
}

/// `POST /api/predict/complete` request body. `context` is the text immediately
/// before the caret (the model context). `app` is the focused process name (for
/// the allowlist). `control` is the focused control's localized type (for the
/// secure-field denylist). `agent_id` optionally overrides the model.
#[derive(Debug, Deserialize)]
pub struct CompleteBody {
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub control: Option<String>,
    #[serde(default, rename = "agentId")]
    pub agent_id: Option<String>,
}

/// `POST /api/predict/complete` response. `suggestion` is empty when there is
/// nothing to suggest OR the request was refused (disabled / app not allowed /
/// secure field / no context) — `reason` says which, for diagnostics.
#[derive(Debug, Serialize)]
pub struct CompleteResponse {
    pub suggestion: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn refused(reason: &str) -> Json<CompleteResponse> {
    Json(CompleteResponse {
        suggestion: String::new(),
        model: String::new(),
        reason: Some(reason.to_string()),
    })
}

/// `POST /api/predict/complete` — return one inline suggestion for the caret
/// context. Always 200 with a (possibly empty) suggestion; refusals carry a
/// `reason` rather than an error status, so the dumb overlay never has to branch
/// on HTTP codes.
#[utoipa::path(
    post,
    path = "/api/predict/complete",
    tag = "Predict",
    summary = "Predict the inline continuation for caret context",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn complete(
    State(ctx): State<PredictCtx>,
    Json(body): Json<CompleteBody>,
) -> axum::response::Response {
    // The built-in Predict plugin's enabled state is the single on/off switch
    // (Core seeds it at boot and flips it live from the plugin enable/disable
    // path). Cheap flag check before touching prefs; there is no separate config
    // toggle any more.
    if !ctx.host.is_enabled() {
        return refused("predictive typing plugin is disabled").into_response();
    }

    let config = load_config(&ctx).await;

    // Privacy floor: never read context or suggest in a password/secure field.
    if let Some(control) = body.control.as_deref() {
        if crate::is_secure_control(control) {
            return refused("secure field").into_response();
        }
    }

    // App allowlist (empty = all apps).
    if let Some(app) = body.app.as_deref() {
        if !crate::app_allowed(&config.app_allowlist, app) {
            return refused("app not in allowlist").into_response();
        }
    }

    let context = body.context.trim();
    if context.is_empty() {
        return refused("no context").into_response();
    }

    let agent_id = body.agent_id.as_deref().or(config.agent_id.as_deref());
    let model = resolve_model(&ctx, &config, agent_id).await;
    let (system, user) = crate::build_messages(context);

    match ctx
        .host
        .call_side_model(&model, config.effort.trim(), &system, &user)
        .await
    {
        Ok(text) => {
            let suggestion = crate::clean_suggestion(&text, config.max_chars);
            Json(CompleteResponse {
                suggestion,
                model,
                reason: None,
            })
            .into_response()
        }
        Err(e) => json_error(
            StatusCode::BAD_GATEWAY,
            format!("prediction model unavailable: {e}"),
        ),
    }
}
