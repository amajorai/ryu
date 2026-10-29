//! HTTP projection of Core-owned data-folder operations.

use axum::{http::StatusCode, response::IntoResponse, Json};
use serde_json::json;

use super::node_org_id;

#[derive(serde::Deserialize)]
pub(super) struct DataPathTarget {
    path: String,
}

#[derive(serde::Deserialize)]
pub(super) struct DataPathExportReq {
    out: String,
    /// Passphrase the archive is encrypted under (at least 12 characters). The
    /// export carries the data folder's key custody file and every store, so it
    /// is never written unencrypted. Not stored or echoed.
    #[serde(default)]
    passphrase: String,
}

/// `GET /api/data-path` — current data-folder location, default, size, free space.
/// All path logic lives in Core (`crate::data_path`); the desktop only renders it.
#[utoipa::path(
    get,
    path = "/api/data-path",
    tag = "Data",
    summary = "The active data folder and its disk info",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(super) async fn get_data_path() -> impl IntoResponse {
    match tokio::task::spawn_blocking(crate::data_path::info).await {
        Ok(info) => Json(info).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/data-path/validate` — check a candidate target folder (writable,
/// empty, not nested in the current folder, enough free space for a copy).
#[utoipa::path(
    post,
    path = "/api/data-path/validate",
    tag = "Data",
    summary = "Validate a candidate data folder",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(super) async fn validate_data_path(Json(req): Json<DataPathTarget>) -> impl IntoResponse {
    let target = std::path::PathBuf::from(&req.path);
    let res = tokio::task::spawn_blocking(move || {
        crate::data_path::validate_target(&crate::paths::ryu_dir(), &target, true)
    })
    .await;
    match res {
        Ok(v) => Json(v).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/data-path/switch` — point-only relocation (NO copy). Writes the
/// pointer; takes effect on the next Core restart. The old data stays intact, so
/// this is the "start fresh in a new folder" path. (Copy-and-migrate runs as the
/// offline `data-path migrate` subcommand the desktop invokes while Core is down.)
#[utoipa::path(
    post,
    path = "/api/data-path/switch",
    tag = "Data",
    summary = "Relocate the data folder (restart required)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(super) async fn switch_data_path(Json(req): Json<DataPathTarget>) -> impl IntoResponse {
    let target = std::path::PathBuf::from(&req.path);
    let v = crate::data_path::validate_target(&crate::paths::ryu_dir(), &target, false);
    if !v.ok {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": v.error })),
        )
            .into_response();
    }
    match crate::paths::set_data_dir(Some(&target)) {
        Ok(()) => Json(json!({ "ok": true, "restart_required": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/data-path/reset` — revert to the default `~/.ryu` (point-only).
#[utoipa::path(
    post,
    path = "/api/data-path/reset",
    tag = "Data",
    summary = "Reset the data folder to the default location",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(super) async fn reset_data_path() -> impl IntoResponse {
    match crate::paths::set_data_dir(None) {
        Ok(()) => Json(json!({ "ok": true, "restart_required": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/data-path/export` — zip the current data folder to `out`, encrypted
/// under the request's `passphrase` (refused without one). Read-only
/// on the data folder, so it runs online (no restart). Import/restore is offline
/// (the `data-path import` subcommand) because it overwrites the live DB files.
#[utoipa::path(
    post,
    path = "/api/data-path/export",
    tag = "Data",
    summary = "Export the data folder to a zip backup",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(super) async fn export_data_path(
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(req): Json<DataPathExportReq>,
) -> impl IntoResponse {
    // ── ACL ──────────────────────────────────────────────────────────────────
    // This zips the ENTIRE data folder — every user's conversations, documents and
    // memory DBs — so on an org-bound node it is inherently cross-tenant and there is
    // no scoped variant. Mirror `data_clear`'s danger-zone posture:
    //   - Node UNBOUND (personal): one principal, `RYU_TOKEN` is the boundary — the
    //     user backing up their own machine. Behaves exactly as before.
    //   - Node ORG-BOUND: a whole-folder export dumps other users' data. Even a
    //     signed-in member must not exfiltrate the shared node, so REFUSE outright.
    if node_org_id().is_some() {
        let _ = &caller;
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "ok": false,
                "error": "forbidden: the data-folder export dumps every user's data and is disabled on a shared (org-bound) node"
            })),
        )
            .into_response();
    }
    let out = std::path::PathBuf::from(&req.out);
    let passphrase = req.passphrase;
    let res = tokio::task::spawn_blocking(move || {
        crate::data_path::export_zip(&crate::paths::ryu_dir(), &out, &passphrase)
    })
    .await;
    match res {
        Ok(Ok(bytes)) => {
            Json(json!({ "ok": true, "bytes": bytes, "encrypted": true })).into_response()
        }
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::InvalidInput => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}
