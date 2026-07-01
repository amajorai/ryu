//! HTTP API for predictive typing (`/api/predict/*`): the system-wide inline
//! autocomplete brain.
//!
//! - `GET  /api/predict/config`   → the normalized [`PredictConfig`] (defaults
//!   applied) so the desktop settings tab and the `apps/predict` overlay both
//!   read one shape in a single call.
//! - `PUT  /api/predict/config`   → persist the config blob.
//! - `POST /api/predict/complete` → given the caret context, return a single
//!   inline suggestion. Enforces the app allowlist + the secure-field denylist
//!   here (Core decides *what runs*), then hands the model call to the Gateway
//!   via [`super::call_side_model`] (the same path `/btw` uses).
//!
//! Pure logic (prompt assembly, denylist, cleanup) lives in [`crate::predict`].

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{call_side_model, json_error, ServerState};
use crate::predict::{self, PredictConfig, PREDICT_CONFIG_PREF};

/// Load the persisted config (defaults applied) for the current node.
async fn load_config(state: &ServerState) -> PredictConfig {
    let raw = state
        .preferences
        .get(PREDICT_CONFIG_PREF)
        .await
        .ok()
        .flatten();
    PredictConfig::from_pref(raw.as_deref())
}

/// Resolve the model that answers predictions: an explicit `agent_id`'s bound
/// model → `config.model` → env `RYU_PREDICT_MODEL`/`RYU_DEFAULT_LLM_MODEL` →
/// the built-in default. Nothing hardcoded.
async fn resolve_model(
    state: &ServerState,
    config: &PredictConfig,
    agent_id: Option<&str>,
) -> String {
    // An explicit agent's bound chat model wins — it makes the prediction agent
    // a real, swappable card.
    if let Some(id) = agent_id.filter(|s| !s.is_empty()) {
        if let Ok(Some(agent)) = state.agent_store.get(id).await {
            let bound = agent
                .chat_model
                .as_ref()
                .and_then(|s| s.model_id.clone())
                .or(agent.model.clone());
            if let Some(m) = bound.filter(|m| !m.trim().is_empty()) {
                return m;
            }
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
    crate::registry::DEFAULT_LLM_MODEL.to_string()
}

/// `GET /api/predict/config` — the normalized predictive-typing config.
#[utoipa::path(
    get,
    path = "/api/predict/config",
    tag = "Predict",
    summary = "Get predictive-typing config",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_config(State(state): State<ServerState>) -> Json<PredictConfig> {
    Json(load_config(&state).await)
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
    State(state): State<ServerState>,
    Json(config): Json<PredictConfig>,
) -> axum::response::Response {
    let raw = match serde_json::to_string(&config) {
        Ok(s) => s,
        Err(e) => {
            return json_error(StatusCode::BAD_REQUEST, format!("invalid config: {e}"));
        }
    };
    match state.preferences.set(PREDICT_CONFIG_PREF, &raw).await {
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
    State(state): State<ServerState>,
    Json(body): Json<CompleteBody>,
) -> axum::response::Response {
    let config = load_config(&state).await;

    if !config.enabled {
        return refused("predictive typing is disabled").into_response();
    }

    // Privacy floor: never read context or suggest in a password/secure field.
    if let Some(control) = body.control.as_deref() {
        if predict::is_secure_control(control) {
            return refused("secure field").into_response();
        }
    }

    // App allowlist (empty = all apps).
    if let Some(app) = body.app.as_deref() {
        if !predict::app_allowed(&config.app_allowlist, app) {
            return refused("app not in allowlist").into_response();
        }
    }

    let context = body.context.trim();
    if context.is_empty() {
        return refused("no context").into_response();
    }

    let agent_id = body.agent_id.as_deref().or(config.agent_id.as_deref());
    let model = resolve_model(&state, &config, agent_id).await;
    let (system, user) = predict::build_messages(context);

    match call_side_model(&state, &model, config.effort.trim(), &system, &user).await {
        Ok(text) => {
            let suggestion = predict::clean_suggestion(&text, config.max_chars);
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
