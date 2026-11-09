//! `/api/device-tools/devices[/:device_id]`: list, rename / revoke a grant,
//! forget. Managed from any of the user's own app sessions (no device
//! signature), but only ever over the caller's own devices.

use super::auth::{device_error, require_principal, require_store};
use crate::device_tools::declaration::{clean_label, MAX_LABEL};
use crate::device_tools::registry::DeviceState;
use crate::device_tools::{catalog, presence, DeviceErrorCode};
use crate::server::*;
use axum::response::Response;

/// `GET /api/device-tools/devices` — the caller's paired devices and their
/// per-tool "Always allow" grants.
#[utoipa::path(get, path = "/api/device-tools/devices", tag = "Device tools",
    summary = "List paired phones", responses((status = 200, description = "OK", body = serde_json::Value)))]
pub(in crate::server) async fn device_tools_devices(
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    auth: Option<Extension<ResolvedAuthorization>>,
) -> Response {
    let principal = match require_principal(auth.as_ref().map(|a| &a.0), caller.as_ref()) {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    let store = match require_store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    let principal_id = principal.id();
    let Ok(rows) = store.devices(&principal_id) else {
        return device_error(
            StatusCode::SERVICE_UNAVAILABLE,
            DeviceErrorCode::DeviceUnavailable,
        );
    };
    let now = crate::device_tools::now_ms();
    let devices: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "device_id": row.device_id,
                "label": row.label,
                "app": row.app,
                "platform": row.platform,
                "state": if row.state == DeviceState::Active { "active" } else { "pending" },
                "paired_at_ms": row.paired_at_ms,
                "last_seen_ms": row.last_seen_ms,
                "foreground": presence::is_foreground(&principal_id, &row.device_id, now),
                "always_allowed": store.grants(&principal_id, &row.device_id).unwrap_or_default(),
            })
        })
        .collect();
    Json(json!({ "principal_id": principal_id, "devices": devices })).into_response()
}

#[derive(Debug, Deserialize)]
pub(in crate::server) struct DevicePatch {
    #[serde(default)]
    label: Option<String>,
    /// Canonical tool ids whose "Always allow" to revoke.
    #[serde(default)]
    revoke: Vec<String>,
}

/// `PATCH /api/device-tools/devices/:device_id` — rename, or revoke per-tool
/// "Always allow" grants.
#[utoipa::path(patch, path = "/api/device-tools/devices/{device_id}", tag = "Device tools",
    summary = "Rename a phone or revoke a grant", params(("device_id" = String, Path)),
    request_body = serde_json::Value, responses((status = 200, description = "OK", body = serde_json::Value)))]
pub(in crate::server) async fn device_tools_patch_device(
    Path(device_id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    auth: Option<Extension<ResolvedAuthorization>>,
    Json(patch): Json<DevicePatch>,
) -> Response {
    let principal = match require_principal(auth.as_ref().map(|a| &a.0), caller.as_ref()) {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    let store = match require_store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    let principal_id = principal.id();
    let device_id = device_id.trim();
    if !matches!(store.device(&principal_id, device_id), Ok(Some(_))) {
        return device_error(StatusCode::NOT_FOUND, DeviceErrorCode::NotFound);
    }
    if let Some(label) = patch.label.as_deref() {
        if store
            .rename(&principal_id, device_id, &clean_label(label, MAX_LABEL))
            .is_err()
        {
            return device_error(
                StatusCode::SERVICE_UNAVAILABLE,
                DeviceErrorCode::DeviceUnavailable,
            );
        }
    }
    for tool in &patch.revoke {
        let Some(canonical) = catalog::canonical(tool) else {
            return device_error(StatusCode::BAD_REQUEST, DeviceErrorCode::InvalidInput);
        };
        if store
            .revoke_grant(&principal_id, device_id, canonical)
            .is_err()
        {
            return device_error(
                StatusCode::SERVICE_UNAVAILABLE,
                DeviceErrorCode::DeviceUnavailable,
            );
        }
    }
    Json(json!({
        "device_id": device_id,
        "always_allowed": store.grants(&principal_id, device_id).unwrap_or_default(),
    }))
    .into_response()
}

/// `DELETE /api/device-tools/devices/:device_id` — forget the device with its
/// key, grants, quota rows, device stream and parked calls.
#[utoipa::path(delete, path = "/api/device-tools/devices/{device_id}", tag = "Device tools",
    summary = "Forget a paired phone", params(("device_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value)))]
pub(in crate::server) async fn device_tools_forget_device(
    Path(device_id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    auth: Option<Extension<ResolvedAuthorization>>,
) -> Response {
    let principal = match require_principal(auth.as_ref().map(|a| &a.0), caller.as_ref()) {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    let store = match require_store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    let principal_id = principal.id();
    match store.forget(&principal_id, device_id.trim()) {
        Ok(true) => {
            presence::forget(&principal_id, device_id.trim());
            crate::device_tools::device_stream::disconnect(&principal_id, device_id.trim());
            if let Some(parked) = crate::device_tools::pending::store() {
                parked.forget_device(&principal_id, device_id.trim());
            }
            Json(json!({ "forgotten": true })).into_response()
        }
        Ok(false) => device_error(StatusCode::NOT_FOUND, DeviceErrorCode::NotFound),
        Err(_) => device_error(
            StatusCode::SERVICE_UNAVAILABLE,
            DeviceErrorCode::DeviceUnavailable,
        ),
    }
}
