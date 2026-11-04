//! Alert delivery targets (node-level policy-alert recipients).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// -- Alert delivery targets (node-level policy-alert recipients) ------------------

/// Node-level alert delivery targets for self-host policy alerts. `targets` are
/// the Fanout-tier channels (webhook / Telegram / Expo push); `emails` are the
/// Email-tier recipients (sent over the shared BYO SMTP transport).
#[derive(serde::Deserialize)]
pub(in crate::server) struct AlertDeliveryBody {
    /// Targets as the GET view returns them: a credential the client did not
    /// change comes back as the redaction placeholder plus its `secret_ref`.
    #[serde(default)]
    pub(in crate::server) targets: Vec<serde_json::Value>,
    #[serde(default)]
    pub(in crate::server) emails: Vec<String>,
}

/// `GET /api/alerts/delivery` - the node's configured policy-alert delivery
/// targets (empty default when unset). Credentials (webhook URLs, Telegram bot
/// tokens, Expo push tokens) are redacted; see [`crate::notify::delivery_view`].
#[utoipa::path(
    get,
    path = "/api/alerts/delivery",
    tag = "Notifications",
    summary = "Get the node's policy-alert delivery targets",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_alert_delivery(
    State(state): State<ServerState>,
) -> axum::response::Response {
    let Some(store) = crate::notify::global_store() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "notify store not ready" })),
        )
            .into_response();
    };
    let _ = &state;
    match store.get_alert_delivery().await {
        Ok(cfg) => (
            StatusCode::OK,
            Json(crate::notify::delivery_view::redacted_view(&cfg)),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `PUT /api/alerts/delivery` - persist the node's policy-alert delivery targets.
/// A target that echoes the GET placeholder with its `secret_ref` keeps the
/// stored credential.
#[utoipa::path(
    put,
    path = "/api/alerts/delivery",
    tag = "Notifications",
    summary = "Set the node's policy-alert delivery targets",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn put_alert_delivery(
    State(state): State<ServerState>,
    Json(body): Json<AlertDeliveryBody>,
) -> axum::response::Response {
    let Some(store) = crate::notify::global_store() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "notify store not ready" })),
        )
            .into_response();
    };
    let _ = &state;
    let has_placeholder = body.targets.iter().any(|target| {
        target.as_object().is_some_and(|object| {
            object
                .values()
                .any(|v| v.as_str().is_some_and(ryu_crypto::redact::is_placeholder))
        })
    });
    // Only a placeholder needs the stored targets; a full replacement must still
    // succeed when the stored row cannot be read.
    let current = if has_placeholder {
        match store.get_alert_delivery().await {
            Ok(current) => current,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": format!("{e:#}") })),
                )
                    .into_response()
            }
        }
    } else {
        crate::policy_alerts::AlertDeliveryTargets::default()
    };
    let targets = match crate::notify::delivery_view::merge_put(body.targets, &current) {
        Ok(targets) => targets,
        Err(error) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response()
        }
    };
    let cfg = crate::policy_alerts::AlertDeliveryTargets {
        targets,
        emails: body.emails,
    };
    match store.set_alert_delivery(&cfg).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

// ── Per-model launch config (advanced inference) ───────────────────────────────

/// `GET /api/models/{id}/launch-config` — the stored engine-launch config for a
/// model (context size, GPU layers, MoE offload, chat template, speculative draft
/// model, ...). Returns the empty/default config when none is set. The `{id}` must
/// be percent-encoded by the client when it contains a slash.
#[utoipa::path(
    get,
    path = "/api/models/{id}/launch-config",
    tag = "Models",
    summary = "Get a model's advanced launch config",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_model_launch_config(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    let cfg = state.preferences.get_launch_config(&id).await;
    let value = serde_json::to_value(&cfg).unwrap_or_else(|_| json!({}));
    (StatusCode::OK, Json(value)).into_response()
}

/// `PUT /api/models/{id}/launch-config` — persist the engine-launch config for a
/// model. Body is a `LaunchConfig` JSON object. Changes apply the next time the
/// engine loads this model (a respawn is required).
#[utoipa::path(
    put,
    path = "/api/models/{id}/launch-config",
    tag = "Models",
    summary = "Set a model's advanced launch config",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_model_launch_config(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(cfg): Json<crate::inference::LaunchConfig>,
) -> axum::response::Response {
    if let Err(message) = crate::inference::validate_native(None, &cfg.native) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response();
    }
    match state.preferences.set_launch_config(&id, &cfg).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true, "id": id }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `GET /api/models/{id}/sampling-config` — a model's per-request sampling
/// overrides. Applies to local and cloud models alike; returns `{}` when unset.
#[utoipa::path(
    get,
    path = "/api/models/{id}/sampling-config",
    tag = "Models",
    summary = "Get a model's sampling overrides",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_model_sampling_config(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    let cfg = state.preferences.get_model_sampling_config(&id).await;
    let value = serde_json::to_value(&cfg).unwrap_or_else(|_| json!({}));
    (StatusCode::OK, Json(value)).into_response()
}

/// `PUT /api/models/{id}/sampling-config` — persist a model's sampling overrides
/// on this node. Body is a `SamplingConfig`; `{}` clears them. Takes effect on
/// the next request, with no engine restart.
#[utoipa::path(
    put,
    path = "/api/models/{id}/sampling-config",
    tag = "Models",
    summary = "Set a model's sampling overrides",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_model_sampling_config(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(cfg): Json<crate::inference::SamplingConfig>,
) -> axum::response::Response {
    match state.preferences.set_model_sampling_config(&id, &cfg).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true, "id": id }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SamplingFieldsQuery {
    #[serde(default)]
    pub(in crate::server) engine: Option<String>,
    #[serde(default)]
    pub(in crate::server) provider: Option<String>,
}

/// `GET /api/inference/sampling-fields?engine=<id>|provider=<id>` — the sampling
/// fields a model actually receives. `engine` names a local engine (llamacpp,
/// vllm, …); otherwise `provider` names the cloud provider behind the model.
#[utoipa::path(
    get,
    path = "/api/inference/sampling-fields",
    tag = "Models",
    summary = "List the sampling fields a local engine or cloud provider honours",
    params(
        ("engine" = Option<String>, Query, description = "Local engine id"),
        ("provider" = Option<String>, Query, description = "Cloud provider id")
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn inference_sampling_fields(
    axum::extract::Query(q): axum::extract::Query<SamplingFieldsQuery>,
) -> Json<serde_json::Value> {
    let engine = q.engine.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let local_engine = engine
        .map(crate::inference::Engine::from_name)
        .filter(|engine| engine.is_local());
    let fields = match local_engine {
        Some(engine) => crate::inference::local_sampling_fields(engine),
        None => crate::inference::remote_sampling_fields(q.provider.as_deref().unwrap_or("")),
    };
    Json(json!({ "local": local_engine.is_some(), "fields": fields }))
}

/// `GET /api/inference/presets` — built-in and saved model-parameter presets for
/// this node.
#[utoipa::path(
    get,
    path = "/api/inference/presets",
    tag = "Models",
    summary = "List model-parameter presets",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_inference_presets(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    Json(json!({ "presets": state.preferences.list_inference_presets().await }))
}

pub(in crate::server) fn inference_preset_response(
    result: anyhow::Result<crate::inference::InferencePreset>,
) -> axum::response::Response {
    match result {
        Ok(preset) => (StatusCode::OK, Json(json!({ "preset": preset }))).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/inference/presets` — save a new preset on this node. The id is
/// assigned by Core.
#[utoipa::path(
    post,
    path = "/api/inference/presets",
    tag = "Models",
    summary = "Create a model-parameter preset",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_inference_preset(
    State(state): State<ServerState>,
    Json(mut preset): Json<crate::inference::InferencePreset>,
) -> axum::response::Response {
    preset.id = format!("preset_{}", uuid::Uuid::new_v4().simple());
    let now = chrono::Utc::now().timestamp();
    inference_preset_response(state.preferences.upsert_inference_preset(preset, now).await)
}

/// `PUT /api/inference/presets/{id}` — replace a saved preset. Built-ins are
/// read-only.
#[utoipa::path(
    put,
    path = "/api/inference/presets/{id}",
    tag = "Models",
    summary = "Update a model-parameter preset",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn update_inference_preset(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(mut preset): Json<crate::inference::InferencePreset>,
) -> axum::response::Response {
    preset.id = id;
    let now = chrono::Utc::now().timestamp();
    inference_preset_response(state.preferences.upsert_inference_preset(preset, now).await)
}

/// `DELETE /api/inference/presets/{id}` — remove a saved preset.
#[utoipa::path(
    delete,
    path = "/api/inference/presets/{id}",
    tag = "Models",
    summary = "Delete a model-parameter preset",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn delete_inference_preset(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    match state.preferences.delete_inference_preset(&id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "preset not found" })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}
