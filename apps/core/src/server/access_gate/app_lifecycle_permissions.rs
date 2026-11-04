//! The App route gate, verified-caller extraction, permission enforcement and marketplace package routes: `app_lifecycle_capabilities` through `install_portable_marketplace_package`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Read-only capability projection for the desktop. The booleans are advisory
/// UI state; every mutating handler calls `enforce_app_lifecycle_permission`
/// again immediately before it can mutate anything.
pub(in crate::server) async fn app_lifecycle_capabilities(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    let node = crate::sidecar::control_plane::registered_node();
    let mut permissions = serde_json::Map::new();
    let mut reasons = serde_json::Map::new();
    for permission in APP_LIFECYCLE_PERMISSIONS {
        let allowed = enforce_app_lifecycle_permission(&state, &caller, permission)
            .await
            .is_ok();
        permissions.insert((*permission).to_owned(), json!(allowed));
        reasons.insert(
            (*permission).to_owned(),
            json!(if allowed {
                "allowed"
            } else {
                "node ACL or node membership does not grant this operation"
            }),
        );
    }
    Json(json!({
        "node": node.as_ref().map(|registered| json!({
            "id": registered.node_id,
            "scope": match registered.scope {
                crate::sidecar::control_plane::NodeScope::Org => "org",
                crate::sidecar::control_plane::NodeScope::Team => "team",
                crate::sidecar::control_plane::NodeScope::Personal => "personal",
            },
            "orgId": registered.org.id,
            "teamId": registered.team_id,
            "ownerUserId": registered.owner_user_id,
        })),
        "permissions": permissions,
        "reasons": reasons,
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
pub(in crate::server) struct PortableMarketplacePackageBody {
    pub(in crate::server) kind: String,
    pub(in crate::server) id: String,
    /// Exact Marketplace release tag selected from the Versions tab. When
    /// absent, the control plane resolves the current build as before.
    #[serde(default)]
    pub(in crate::server) version: Option<String>,
    /// Short-lived control-plane session redeemed from a private package code.
    /// It is forwarded only to the first-party Marketplace resolver and is
    /// never persisted in Core's installed-package record.
    #[serde(default)]
    pub(in crate::server) install_session: Option<String>,
}

pub(in crate::server) fn portable_package_identity(
    body: &PortableMarketplacePackageBody,
) -> Result<(String, String), axum::response::Response> {
    let kind = body.kind.trim().to_ascii_lowercase();
    let id = body.id.trim().to_owned();
    if kind.is_empty() || id.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "portable package `kind` and `id` are required".to_owned(),
        ));
    }
    Ok((kind, id))
}

pub(in crate::server) fn portable_package_install_session(
    body: &PortableMarketplacePackageBody,
) -> Result<Option<String>, axum::response::Response> {
    let session = body
        .install_session
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if session.as_ref().is_some_and(|value| value.len() > 2048) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "portable package `install_session` is too long".to_owned(),
        ));
    }
    Ok(session)
}

pub(in crate::server) fn portable_package_version(
    body: &PortableMarketplacePackageBody,
) -> Result<Option<String>, axum::response::Response> {
    let version = body
        .version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if version.as_ref().is_some_and(|value| {
        value.len() > 128
            || !value
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || ".-+vV".contains(character))
    }) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "portable package `version` must be a semver release tag".to_owned(),
        ));
    }
    Ok(version)
}

/// `GET /api/marketplace/packages/installed` — local package state only.
///
/// This endpoint deliberately does not consult the control plane. Once an
/// archive has been installed, its local bytes and lifecycle state remain
/// usable regardless of its listed price or optional commerce state.
#[utoipa::path(
    get,
    path = "/api/marketplace/packages/installed",
    tag = "Plugins",
    summary = "List installed Marketplace packages",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn marketplace_packages_installed() -> axum::response::Response {
    match crate::portable_packages::list() {
        Ok(packages) => Json(json!({ "packages": packages })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct MarketplaceUsageBody {
    pub(in crate::server) event: String,
    pub(in crate::server) id: String,
    pub(in crate::server) kind: String,
}

/// `POST /api/marketplace/usage` — record a local, content-free Marketplace
/// install signal. The caller cannot submit counters; Core increments the one
/// event after the normal lifecycle permission check and the existing beacon
/// later sends its aggregate snapshot when community stats are enabled.
pub(in crate::server) async fn record_marketplace_usage(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<MarketplaceUsageBody>,
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
    if body.event != "download" {
        return json_error(
            StatusCode::BAD_REQUEST,
            "`event` must be `download`".to_owned(),
        );
    }
    crate::stats_beacon::record_marketplace_event(&body.kind, &body.id, true);
    Json(json!({ "success": true })).into_response()
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(in crate::server) struct PublicMarketplaceCatalogBody {
    /// Public Marketplace category to refresh. No local item identifier is accepted.
    pub(in crate::server) kind: String,
}

/// Explicit preparation for a public catalog install. No item identifier is sent.
#[utoipa::path(
    post,
    path = "/api/marketplace/public-catalog",
    tag = "Catalog",
    summary = "Refresh public listing witnesses before a Marketplace install",
    request_body = PublicMarketplaceCatalogBody,
    responses((status = 200, description = "Refresh attempted", body = serde_json::Value))
)]
pub(in crate::server) async fn refresh_public_marketplace_catalog(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<PublicMarketplaceCatalogBody>,
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
    crate::stats_beacon::refresh_public_marketplace_catalog(&body.kind).await;
    Json(json!({"success": true})).into_response()
}

/// Catalog source id recorded in the provenance of a Ryu Marketplace plugin install.
pub(in crate::server) const MARKETPLACE_PLUGIN_SOURCE_ID: &str = "ryu-marketplace";

/// Enable-time license re-check for a Marketplace install, forwarding the
/// caller's buyer token. A revoked license (refund, dispute, lapse) or an
/// expired offline grace refuses with 402.
pub(in crate::server) async fn require_marketplace_enable_license(
    state: &ServerState,
    headers: &axum::http::HeaderMap,
    kind: &str,
    id: &str,
) -> Result<(), axum::response::Response> {
    crate::catalog_source::with_buyer_token(
        buyer_bearer_from_headers(headers),
        crate::catalog_source::license::require_enable_license(&state.client, kind, id),
    )
    .await
    .map_err(|error| json_error(StatusCode::PAYMENT_REQUIRED, error.to_string()))
}

pub(in crate::server) async fn install_portable_marketplace_package(
    state: &ServerState,
    headers: &axum::http::HeaderMap,
    kind: &str,
    id: &str,
    install_session: Option<String>,
    update: bool,
    version: Option<String>,
    owner: &crate::server::spaces::DocOwner,
) -> axum::response::Response {
    let buyer_token = buyer_bearer_from_headers(headers);
    let detail = match crate::catalog_source::with_install_session(
        install_session.clone(),
        crate::catalog_source::with_buyer_token(
            buyer_token.clone(),
            crate::catalog_source::sources::fetch_ryu_package_detail(
                &state.client,
                kind,
                id,
                update,
                version.as_deref(),
            ),
        ),
    )
    .await
    {
        Ok(detail) => detail,
        Err(error) => return json_error(StatusCode::BAD_GATEWAY, error.to_string()),
    };
    if let Err(error) =
        crate::catalog_source::sources::verify_ryu_package_signature(&state.client, id, &detail)
            .await
    {
        return json_error(StatusCode::BAD_GATEWAY, error.to_string());
    }
    let descriptor = detail
        .get("descriptor")
        .and_then(serde_json::Value::as_object);
    let expected_package_digest = descriptor
        .and_then(|value| value.get("package_digest"))
        .and_then(serde_json::Value::as_str);
    let expected_archive_digest = descriptor
        .and_then(|value| value.get("sha256"))
        .and_then(serde_json::Value::as_str);
    let expected_version = descriptor
        .and_then(|value| value.get("version"))
        .and_then(serde_json::Value::as_str);
    let archive = match crate::catalog_source::with_install_session(
        install_session,
        crate::catalog_source::with_buyer_token(
            buyer_token,
            crate::catalog_source::sources::fetch_ryu_package_archive(
                &state.client,
                &detail,
                update,
            ),
        ),
    )
    .await
    {
        Ok(archive) => archive,
        Err(error) => return json_error(StatusCode::BAD_GATEWAY, error.to_string()),
    };
    let was_enabled = update
        && crate::portable_packages::get(kind, id)
            .ok()
            .flatten()
            .is_some_and(|package| package.enabled);
    if was_enabled {
        if let Err(error) =
            crate::server::portable_package_runtime::disable_with_owner(state, kind, id, owner)
                .await
        {
            return json_error(StatusCode::UNPROCESSABLE_ENTITY, error.to_string());
        }
    }
    let installed = crate::portable_packages::install(
        kind,
        id,
        &archive,
        expected_package_digest,
        expected_archive_digest,
        expected_version,
        update,
    );
    match installed {
        Ok(_) if was_enabled => {
            crate::stats_beacon::witness_public_marketplace_install(kind, id).await;
            match crate::server::portable_package_runtime::enable_with_owner(state, kind, id, owner)
                .await
            {
                Ok(package) => {
                    for runtime in &package.runtime_ids {
                        crate::stats_beacon::associate_marketplace_runtime(kind, id, runtime);
                    }
                    Json(json!({ "success": true, "package": package })).into_response()
                }
                Err(error) => json_error(StatusCode::UNPROCESSABLE_ENTITY, error.to_string()),
            }
        }
        Ok(package) => {
            crate::stats_beacon::witness_public_marketplace_install(kind, id).await;
            Json(json!({ "success": true, "package": package })).into_response()
        }
        Err(error) => {
            if was_enabled {
                if let Err(restore_error) =
                    crate::server::portable_package_runtime::enable_with_owner(
                        state, kind, id, owner,
                    )
                    .await
                {
                    tracing::error!(
                        package_kind = kind,
                        package_id = id,
                        %restore_error,
                        "portable package update failed and the previous activation could not be restored"
                    );
                }
            }
            json_error(StatusCode::UNPROCESSABLE_ENTITY, error.to_string())
        }
    }
}
