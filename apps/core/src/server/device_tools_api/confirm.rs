//! `POST /api/device-tools/confirm` (on-device approval of a Home security
//! action) and `POST /api/device-tools/home-accessories` (the signed
//! accessory cache that decides the security class). Design P6.

use super::auth::{device_error, require_principal, require_store, verify_signed};
use super::routes::{parse_body, require_enabled, CONFIRM_ROUTE, HOME_ACCESSORIES_ROUTE};
use crate::device_tools::confirm::{verify_confirmation, ConfirmError, Confirmation};
use crate::device_tools::prompts::{self, PromptAnswer, ResolveError};
use crate::device_tools::{home, identity, now_ms, DeviceErrorCode};
use crate::server::*;
use axum::response::Response;

#[derive(Debug, Deserialize)]
pub(in crate::server) struct ConfirmBody {
    device_id: String,
    request_id: String,
    option_id: String,
    input_sha256: String,
    #[serde(default)]
    confirmed_at_ms: i64,
    /// Signature by the user-presence key over the confirmation string;
    /// required for an approval, ignored for a deny.
    #[serde(default)]
    confirm_signature: Option<String>,
}

fn same_device(body_device: &str, signed_device: &str) -> bool {
    uuid::Uuid::parse_str(body_device.trim())
        .map(|id| id.to_string())
        .is_ok_and(|id| id == signed_device)
}

/// `POST /api/device-tools/confirm` (signed) — the target phone answers an
/// approval card with `requiresOnDeviceConfirmation`. An approval also carries
/// a signature from the phone's user-presence key (usable only after
/// biometrics or the passcode) over the request id, the frozen input hash, the
/// option and a fresh timestamp. A deny needs only the device signature.
#[utoipa::path(post, path = "/api/device-tools/confirm", tag = "Device tools",
    summary = "Confirm a phone action on the phone", request_body = serde_json::Value,
    responses((status = 200, description = "Answered", body = serde_json::Value)))]
pub(in crate::server) async fn device_tools_confirm(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Extension(VerifiedUserJwt(user_jwt)): Extension<VerifiedUserJwt>,
    auth: Option<Extension<ResolvedAuthorization>>,
    body: axum::body::Bytes,
) -> Response {
    let principal = match require_principal(auth.as_ref().map(|a| &a.0), caller.as_ref()) {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    if let Err(response) = require_enabled(&state, &principal, user_jwt.as_deref()).await {
        return response;
    }
    let store = match require_store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    let device_id = match verify_signed(&headers, "POST", CONFIRM_ROUTE, &principal, &body, &store)
    {
        Ok(device_id) => device_id,
        Err(response) => return response,
    };
    let request: ConfirmBody = match parse_body(&body) {
        Ok(request) => request,
        Err(response) => return response,
    };
    if !same_device(&request.device_id, &device_id) {
        return super::auth::signature_refusal(identity::SignatureError::Mismatch);
    }
    let principal_id = principal.id();
    // Another principal's prompt, or one for another phone, is "not found".
    match prompts::on_device_binding(&request.request_id) {
        Some((owner, binding))
            if owner == principal_id && binding.target_device_id == device_id => {}
        _ => return device_error(StatusCode::NOT_FOUND, DeviceErrorCode::NotFound),
    }
    let now = now_ms();
    let confirmation = Confirmation {
        request_id: &request.request_id,
        input_sha256: &request.input_sha256,
        option_id: &request.option_id,
        confirmed_at_ms: request.confirmed_at_ms,
        signature: request.confirm_signature.as_deref(),
    };
    let confirm_key = store.confirm_key(&principal_id, &device_id);
    match verify_confirmation(&confirmation, confirm_key.as_deref(), now) {
        Ok(()) => {}
        Err(ConfirmError::NoConfirmKey) => {
            return device_error(StatusCode::FORBIDDEN, DeviceErrorCode::ApprovalRequired)
        }
        Err(ConfirmError::BadSignature) => {
            return device_error(StatusCode::UNAUTHORIZED, DeviceErrorCode::InvalidSignature)
        }
    }
    match prompts::confirm_on_device(
        &request.request_id,
        &request.option_id,
        &principal_id,
        &device_id,
        &request.input_sha256,
    ) {
        Ok(answer) => Json(json!({
            "resolved": true,
            "decision": if answer == PromptAnswer::AllowOnce { "allow_once" } else { "deny" },
        }))
        .into_response(),
        Err(ResolveError::InputMismatch) => {
            device_error(StatusCode::CONFLICT, DeviceErrorCode::InputMismatch)
        }
        Err(_) => device_error(StatusCode::NOT_FOUND, DeviceErrorCode::NotFound),
    }
}

#[derive(Debug, Deserialize)]
pub(in crate::server) struct HomeAccessoriesBody {
    device_id: String,
    accessories: Value,
}

/// `POST /api/device-tools/home-accessories` (signed) — after every
/// `device.home.list` the phone reports `{accessory_id, name, services}` for
/// each accessory. The snapshot replaces the previous one and decides, for 24
/// hours, which `device.home.set` calls are security class.
#[utoipa::path(post, path = "/api/device-tools/home-accessories", tag = "Device tools",
    summary = "Report a phone's Home accessory service types", request_body = serde_json::Value,
    responses((status = 200, description = "Stored", body = serde_json::Value)))]
pub(in crate::server) async fn device_tools_home_accessories(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Extension(VerifiedUserJwt(user_jwt)): Extension<VerifiedUserJwt>,
    auth: Option<Extension<ResolvedAuthorization>>,
    body: axum::body::Bytes,
) -> Response {
    let principal = match require_principal(auth.as_ref().map(|a| &a.0), caller.as_ref()) {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    if let Err(response) = require_enabled(&state, &principal, user_jwt.as_deref()).await {
        return response;
    }
    let store = match require_store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    let device_id = match verify_signed(
        &headers,
        "POST",
        HOME_ACCESSORIES_ROUTE,
        &principal,
        &body,
        &store,
    ) {
        Ok(device_id) => device_id,
        Err(response) => return response,
    };
    let request: HomeAccessoriesBody = match parse_body(&body) {
        Ok(request) => request,
        Err(response) => return response,
    };
    if !same_device(&request.device_id, &device_id) {
        return super::auth::signature_refusal(identity::SignatureError::Mismatch);
    }
    let Some(accessories) = home::parse_accessories(&request.accessories) else {
        return device_error(StatusCode::BAD_REQUEST, DeviceErrorCode::InvalidInput);
    };
    match store.replace_home_accessories(&principal.id(), &device_id, &accessories, now_ms()) {
        Ok(()) => Json(json!({ "ok": true, "accessories": accessories.len() })).into_response(),
        Err(_) => device_error(
            StatusCode::SERVICE_UNAVAILABLE,
            DeviceErrorCode::DeviceUnavailable,
        ),
    }
}
