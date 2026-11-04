//! Ryu Pi config (the managed Pi's isolated model/provider config).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Ryu Pi config (the managed Pi's isolated model/provider config) ───────────

/// The current configuration of the Ryu-managed Pi agent (provider, model,
/// thinking level, routing mode). Reads from the isolated `PI_CODING_AGENT_DIR`.
/// Never returns secrets.
#[utoipa::path(
    get,
    path = "/api/pi-config",
    tag = "Agents",
    summary = "Get the Ryu-managed Pi configuration",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_pi_config() -> Json<serde_json::Value> {
    Json(json!({ "config": crate::pi_config::current() }))
}

/// The catalog of providers + models + thinking levels the managed Pi supports,
/// with per-provider `configured` flags. Mirrors pi.dev's supported set.
#[utoipa::path(
    get,
    path = "/api/pi-config/catalog",
    tag = "Agents",
    summary = "List supported Pi providers and models",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_pi_config_catalog() -> Json<serde_json::Value> {
    Json(crate::pi_config::catalog())
}

/// Update the Ryu-managed Pi configuration. Writes `settings.json` (and, in
/// direct-provider mode, `models.json`/`auth.json`) into the isolated config dir.
#[utoipa::path(
    put,
    path = "/api/pi-config",
    tag = "Agents",
    summary = "Update the Ryu-managed Pi configuration",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn put_pi_config(
    Json(input): Json<crate::pi_config::PiConfigInput>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::pi_config::apply(input) {
        Ok(view) => (StatusCode::OK, Json(json!({ "config": view }))),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Configure a provider's credential / base URL / routing **without** activating
/// it (the Zed-style "set up many, activate one" flow). Returns the refreshed
/// catalog.
#[utoipa::path(
    post,
    path = "/api/pi-config/providers",
    tag = "Agents",
    summary = "Configure a Pi provider without activating it",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn configure_pi_provider(
    Json(input): Json<crate::pi_config::ProviderConfigInput>,
) -> (StatusCode, Json<serde_json::Value>) {
    let provider_id = input.provider.trim().to_owned();
    let refresh_models = input.base_url.is_some()
        || input
            .api_key
            .as_ref()
            .is_some_and(|key| !key.trim().is_empty());
    match crate::pi_config::configure_provider(input) {
        Ok(catalog) => {
            let custom_provider = catalog["providers"].as_array().is_some_and(|providers| {
                providers.iter().any(|provider| {
                    provider["id"].as_str() == Some(provider_id.as_str())
                        && provider["custom"].as_bool() == Some(true)
                })
            });
            if refresh_models && custom_provider {
                // Discovery is best-effort: a temporarily offline endpoint must
                // not roll back the saved connection or erase hand-authored IDs.
                let _ = crate::pi_config::refresh_custom_provider_models(&provider_id).await;
                return (StatusCode::OK, Json(crate::pi_config::catalog()));
            }
            (StatusCode::OK, Json(catalog))
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Remove a provider's stored credential (and, for custom providers, its entry).
#[utoipa::path(
    delete,
    path = "/api/pi-config/providers/{id}",
    tag = "Agents",
    summary = "Remove a Pi provider's stored credential",
    params(("id" = String, Path, description = "Provider id")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn delete_pi_provider(
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::pi_config::remove_provider(&id) {
        Ok(catalog) => (StatusCode::OK, Json(catalog)),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Discover a provider's live model list via its OpenAI-compatible `GET /models`,
/// falling back to the provider's static suggestions when discovery is
/// unavailable. Runs server-side so keys never reach the browser.
#[utoipa::path(
    post,
    path = "/api/pi-config/discover-models",
    tag = "Agents",
    summary = "Discover a provider's models (with static fallback)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn discover_pi_models(
    Json(input): Json<crate::pi_config::DiscoverInput>,
) -> Json<serde_json::Value> {
    Json(crate::pi_config::discover_models(input).await)
}

/// Live-check a provider's connectivity with one authenticated GET to its models
/// endpoint. Persists nothing; reports `{ ok, latencyMs, modelCount, error }`.
#[utoipa::path(
    post,
    path = "/api/pi-config/providers/check",
    tag = "Agents",
    summary = "Live-check a Pi provider's connectivity",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn check_pi_provider(
    Json(input): Json<crate::pi_config::CheckInput>,
) -> Json<crate::pi_config::CheckResult> {
    Json(crate::pi_config::check_provider(input).await)
}

/// Enable/disable a single model within a provider (persisted as an `enabled`
/// flag on the provider's models.json entry). Returns the refreshed catalog.
#[utoipa::path(
    post,
    path = "/api/pi-config/providers/model-enabled",
    tag = "Agents",
    summary = "Toggle a Pi provider's model on/off",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_pi_model_enabled(
    Json(input): Json<crate::pi_config::ModelEnabledInput>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::pi_config::set_model_enabled(input) {
        Ok(catalog) => (StatusCode::OK, Json(catalog)),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}
