//! The App route gate, verified-caller extraction, permission enforcement and marketplace package routes: `marketplace_package_install` through `marketplace_package_uninstall`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/marketplace/packages/install { kind, id }` — download and install
/// a signed GitHub Release package. The lifecycle ACL runs before any
/// control-plane request or filesystem work; listed price does not gate access.
#[utoipa::path(
    post,
    path = "/api/marketplace/packages/install",
    tag = "Plugins",
    summary = "Install a Marketplace package",
    request_body(content = serde_json::Value, description = "`{ \"kind\": string, \"id\": string, \"version\"?: string }`"),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 422, description = "Install failed", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn marketplace_package_install(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<PortableMarketplacePackageBody>,
) -> axum::response::Response {
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_INSTALL,
    )
    .await
    {
        return response;
    }
    let (kind, id) = match portable_package_identity(&body) {
        Ok(identity) => identity,
        Err(response) => return response,
    };
    let install_session = match portable_package_install_session(&body) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let version = match portable_package_version(&body) {
        Ok(version) => version,
        Err(response) => return response,
    };
    let owner = spaces::owner_of(&caller_tenancy(&caller));
    install_portable_marketplace_package(
        &state,
        &headers,
        &kind,
        &id,
        install_session,
        false,
        version,
        &owner,
    )
    .await
}

/// `POST /api/marketplace/packages/update { kind, id }` — the signed detail and
/// download handoff is checked before the old local package is replaced. A failed
/// download or digest check leaves the old version intact.
#[utoipa::path(
    post,
    path = "/api/marketplace/packages/update",
    tag = "Plugins",
    summary = "Update an installed Marketplace package",
    request_body(content = serde_json::Value, description = "`{ \"kind\": string, \"id\": string, \"version\"?: string }`"),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 422, description = "Update failed", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn marketplace_package_update(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<PortableMarketplacePackageBody>,
) -> axum::response::Response {
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_UPDATE,
    )
    .await
    {
        return response;
    }
    let (kind, id) = match portable_package_identity(&body) {
        Ok(identity) => identity,
        Err(response) => return response,
    };
    let install_session = match portable_package_install_session(&body) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let version = match portable_package_version(&body) {
        Ok(version) => version,
        Err(response) => return response,
    };
    let owner = spaces::owner_of(&caller_tenancy(&caller));
    install_portable_marketplace_package(
        &state,
        &headers,
        &kind,
        &id,
        install_session,
        true,
        version,
        &owner,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/marketplace/packages/{kind}/{id}/enable",
    tag = "Plugins",
    summary = "Enable an installed Marketplace package",
    params(("kind" = String, Path), ("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn marketplace_package_enable(
    State(state): State<ServerState>,
    Path((kind, id)): Path<(String, String)>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_ENABLE,
    )
    .await
    {
        return response;
    }
    // Portable packages always come from the Marketplace: re-check the license.
    if let Err(response) = require_marketplace_enable_license(
        &state,
        &headers,
        &kind.trim().to_ascii_lowercase(),
        id.trim(),
    )
    .await
    {
        return response;
    }
    let owner = spaces::owner_of(&caller_tenancy(&caller));
    match crate::server::portable_package_runtime::enable_with_owner(&state, &kind, &id, &owner)
        .await
    {
        Ok(package) => {
            for runtime in &package.runtime_ids {
                crate::stats_beacon::associate_marketplace_runtime(&kind, &id, runtime);
            }
            Json(json!({ "success": true, "package": package })).into_response()
        }
        Err(error) => json_error(StatusCode::UNPROCESSABLE_ENTITY, error.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/marketplace/packages/{kind}/{id}/disable",
    tag = "Plugins",
    summary = "Disable an installed Marketplace package",
    params(("kind" = String, Path), ("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn marketplace_package_disable(
    State(state): State<ServerState>,
    Path((kind, id)): Path<(String, String)>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_DISABLE,
    )
    .await
    {
        return response;
    }
    let owner = spaces::owner_of(&caller_tenancy(&caller));
    match crate::server::portable_package_runtime::disable_with_owner(&state, &kind, &id, &owner)
        .await
    {
        Ok(package) => Json(json!({ "success": true, "package": package })).into_response(),
        Err(error) => json_error(StatusCode::UNPROCESSABLE_ENTITY, error.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/marketplace/packages/{kind}/{id}/uninstall",
    tag = "Plugins",
    summary = "Uninstall a Marketplace package",
    params(("kind" = String, Path), ("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn marketplace_package_uninstall(
    State(state): State<ServerState>,
    Path((kind, id)): Path<(String, String)>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_UNINSTALL,
    )
    .await
    {
        return response;
    }
    let owner = spaces::owner_of(&caller_tenancy(&caller));
    match crate::server::portable_package_runtime::uninstall_with_owner(&state, &kind, &id, &owner)
        .await
    {
        Ok(()) => match crate::portable_packages::uninstall(&kind, &id) {
            Ok(()) => Json(json!({ "success": true, "kind": kind, "id": id })).into_response(),
            Err(error) => json_error(StatusCode::NOT_FOUND, error.to_string()),
        },
        Err(error) => json_error(StatusCode::UNPROCESSABLE_ENTITY, error.to_string()),
    }
}
