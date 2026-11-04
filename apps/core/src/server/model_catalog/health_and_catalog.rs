//! Vault route builders, shared JSON helpers, the model catalog and Composio integrations: `health` through `composio_toolkit_categories`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    get,
    path = "/api/health",
    tag = "Health",
    summary = "Service health check",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn health() -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "version": crate::capabilities::version(),
        // Null until a real Gateway readiness probe observed its build. Update
        // startup must not mistake Core's version fallback for Gateway health.
        "gatewayVersion": crate::sidecar::gateway::observed_gateway_version(),
        "requiredRuntimeReady": crate::required_update_runtime::ready(),
        "updateRuntimeNonce": crate::required_update_runtime::nonce(),
        // The release channel this build came from, derived from the version's
        // prerelease identifier (`0.0.18-nightly.…` ⇒ "nightly", a bare `0.0.18`
        // ⇒ "stable"), so a build is self-describing with nothing stored.
        //
        // Clients need this because version alone cannot answer "am I a stable
        // desktop talking to a canary node?" — the desktop's own comparator
        // (`node-compat.ts`) parses major.minor.patch and DISCARDS the prerelease,
        // so channel skew was structurally invisible to it.
        //
        // Additive, per this module's rule: a client that does not know the field
        // ignores it, and no existing field changed.
        "channel": crate::update::channel_of(crate::capabilities::version()),
        "capabilities": crate::capabilities::CAPABILITIES,
    }))
}

#[utoipa::path(
    get,
    path = "/api/catalog",
    tag = "Sidecars",
    summary = "List the sidecar (engine/tool/agent) catalog",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_catalog(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    let items = state.catalog.get_catalog(&state.install_status).await;
    Json(json!({ "sidecars": items }))
}

// ── Model catalog (Hugging Face browse + install, all logic in Core) ─────────
//
// The desktop/mobile/extension are pure GUI layers over these endpoints. Search,
// sorting, device-fit, stats, and install all happen here so every surface
// behaves identically. See `crate::model_catalog`.

/// True when an active Model source resolves search/detail/install through the
/// CatalogSource seam (a flat descriptor) rather than the HF Hub resolve path:
/// a model-index source (#461) or a Ryu Marketplace model source (#467). HF /
/// ModelScope sources go through the dedicated `model_catalog` HF helpers.
pub(in crate::server) fn is_seam_model_source(source: &crate::catalog_source::Source) -> bool {
    matches!(
        source,
        crate::catalog_source::Source::ModelIndex(_)
            | crate::catalog_source::Source::RyuMarketplace(_)
    )
}

/// Resolve the active Model [`HfEndpoint`] from the catalog-source registry.
/// The active source (HF by default, or a selected ModelScope/custom source)
/// owns the host every model fetch points at — this is the seam in action
/// (#460). Falls back to the Hugging Face default when no model source resolves.
pub(in crate::server) async fn active_model_endpoint(
    state: &ServerState,
) -> crate::model_catalog::HfEndpoint {
    use crate::catalog_source::{CatalogKind, Source};
    match state
        .catalog_sources
        .get_active(CatalogKind::Model, &state.preferences)
        .await
    {
        Some(Source::Hf(hf)) => hf.endpoint(),
        _ => crate::model_catalog::HfEndpoint::huggingface(),
    }
}

/// `GET /api/composio/status` — is a Composio key configured + the active base.
#[utoipa::path(
    get,
    path = "/api/composio/status",
    tag = "Composio",
    summary = "Composio integration status",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn composio_status(
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Some(status) = ryu_composio::service::configuration_status(
        caller.as_ref().map(|caller| caller.user_id.as_str()),
    ) {
        return (StatusCode::OK, Json(status));
    }
    (
        StatusCode::OK,
        Json(json!({
            "configured": crate::composio_auth::is_configured(),
            "base_url": crate::composio_catalog::base_url(),
        })),
    )
}

/// `GET /api/composio/toolkits` — browse the user's Composio toolkits.
#[utoipa::path(
    get,
    path = "/api/composio/toolkits",
    tag = "Composio",
    summary = "Browse Composio toolkits",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn composio_toolkits(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Some(result) =
        ryu_composio::service::toolkits(caller.as_ref().map(|caller| caller.user_id.as_str())).await
    {
        return match result {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(error) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error":error.to_string(),"data":[]})),
            ),
        };
    }
    match crate::composio_catalog::list_toolkits(&state.client).await {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string(), "data": [] })),
        ),
    }
}

/// Pull a list of category names out of a Composio toolkit's `categories` field,
/// which the upstream API may serialize as bare strings or `{name|slug|id}`
/// objects. Non-string / unrecognized shapes are skipped rather than surfaced as
/// empty strings.
pub(in crate::server) fn composio_toolkit_categories(value: &serde_json::Value) -> Vec<String> {
    let Some(arr) = value.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|cat| {
            if let Some(s) = cat.as_str() {
                return Some(s.to_string());
            }
            for key in ["name", "slug", "id"] {
                if let Some(s) = cat.get(key).and_then(serde_json::Value::as_str) {
                    return Some(s.to_string());
                }
            }
            None
        })
        .collect()
}
