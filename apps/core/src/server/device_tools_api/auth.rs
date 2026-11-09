//! Device-lane admission: the token-kind allowlist, the device principal and
//! signed-request verification.

use crate::device_tools::identity::{self, DevicePrincipal, SignatureError, SignedHeaders};
use crate::device_tools::registry::DeviceToolStore;
use crate::device_tools::DeviceErrorCode;
use crate::server::*;
use axum::response::Response;

/// A device-lane error response: `{ "error": <message>, "code": <code> }`.
pub(in crate::server) fn device_error(status: StatusCode, code: DeviceErrorCode) -> Response {
    (
        status,
        Json(json!({ "error": code.message(), "code": code.as_str() })),
    )
        .into_response()
}

/// The HTTP status for a device-lane refusal.
pub(in crate::server) fn status_for(code: DeviceErrorCode) -> StatusCode {
    match code {
        DeviceErrorCode::NotFound => StatusCode::NOT_FOUND,
        DeviceErrorCode::AlreadyClaimed
        | DeviceErrorCode::ForegroundRequired
        | DeviceErrorCode::InputMismatch => StatusCode::CONFLICT,
        DeviceErrorCode::DeviceTimeout => StatusCode::GONE,
        DeviceErrorCode::InvalidSignature => StatusCode::UNAUTHORIZED,
        DeviceErrorCode::DeviceNotPaired | DeviceErrorCode::NotOwnChat => StatusCode::FORBIDDEN,
        DeviceErrorCode::DeviceUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_REQUEST,
    }
}

/// The device principal for a request, or `None` when this credential may not
/// use the device lane at all.
///
/// Only the user's own app session qualifies: the node owner token, a member's
/// signed-in session JWT, or the node-list delegation. API keys and paired
/// capabilities, MCP / hosted OAuth clients, plugin grants and workload
/// credentials never do. An unbound node has one principal, the local owner
/// (its conversations are unowned); a bound node needs a verified user.
pub(in crate::server) fn principal_for(
    context: &crate::authorization::AuthorizationContext,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    node_bound: bool,
) -> Option<DevicePrincipal> {
    if !is_owner_or_member_session(context) {
        return None;
    }
    if node_bound {
        return caller.map(|caller| DevicePrincipal::User(caller.user_id.clone()));
    }
    context.is_owner().then_some(DevicePrincipal::LocalOwner)
}

/// [`principal_for`] for a live request, as a refusal response.
pub(in crate::server) fn require_principal(
    auth: Option<&ResolvedAuthorization>,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
) -> Result<DevicePrincipal, Response> {
    auth.and_then(|auth| principal_for(&auth.context, caller, node_org_id().is_some()))
        .ok_or_else(|| device_error(StatusCode::FORBIDDEN, DeviceErrorCode::DeviceNotPaired))
}

/// Read the three signed-request headers.
pub(in crate::server) fn signed_headers(headers: &axum::http::HeaderMap) -> Option<SignedHeaders> {
    let device_id = header_str(headers, identity::CLIENT_ID_HEADER)?;
    let device_id = uuid::Uuid::parse_str(device_id.trim()).ok()?.to_string();
    let timestamp_ms = header_str(headers, identity::TS_HEADER)?.parse().ok()?;
    let signature = header_str(headers, identity::SIG_HEADER)?;
    Some(SignedHeaders {
        device_id,
        timestamp_ms,
        signature,
    })
}

pub(in crate::server) fn signature_refusal(error: SignatureError) -> Response {
    match error {
        SignatureError::NotPaired => {
            device_error(StatusCode::FORBIDDEN, DeviceErrorCode::DeviceNotPaired)
        }
        SignatureError::Mismatch => {
            device_error(StatusCode::BAD_REQUEST, DeviceErrorCode::InvalidSignature)
        }
        SignatureError::Missing
        | SignatureError::Stale
        | SignatureError::Replayed
        | SignatureError::BadSignature => {
            device_error(StatusCode::UNAUTHORIZED, DeviceErrorCode::InvalidSignature)
        }
    }
}

/// Verify a signed request from an ACTIVE paired device of `principal` and
/// return its device id.
pub(in crate::server) fn verify_signed(
    headers: &axum::http::HeaderMap,
    method: &str,
    route: &str,
    principal: &DevicePrincipal,
    body: &[u8],
    store: &DeviceToolStore,
) -> Result<String, Response> {
    let signed =
        signed_headers(headers).ok_or_else(|| signature_refusal(SignatureError::Missing))?;
    let principal_id = principal.id();
    let key = store.active_key(&principal_id, &signed.device_id);
    verify_and_accept(
        &signed,
        method,
        route,
        &principal_id,
        key.as_deref(),
        body,
        store,
    )?;
    Ok(signed.device_id)
}

/// Verify a signed request and persist its replay key, so neither a
/// re-encoded signature nor a restart lets the same signature in twice.
pub(in crate::server) fn verify_and_accept(
    signed: &SignedHeaders,
    method: &str,
    route: &str,
    principal_id: &str,
    stored_key: Option<&[u8]>,
    body: &[u8],
    store: &DeviceToolStore,
) -> Result<(), Response> {
    let now = crate::device_tools::now_ms();
    let replay_key =
        identity::verify_request(signed, method, route, principal_id, stored_key, body, now)
            .map_err(signature_refusal)?;
    if !store.accept_signature(&signed.device_id, &replay_key, now) {
        return Err(signature_refusal(SignatureError::Replayed));
    }
    Ok(())
}

/// The store, or 503 `device_unavailable`.
pub(in crate::server) fn require_store() -> Result<std::sync::Arc<DeviceToolStore>, Response> {
    crate::device_tools::registry::store().ok_or_else(|| {
        device_error(
            StatusCode::SERVICE_UNAVAILABLE,
            DeviceErrorCode::DeviceUnavailable,
        )
    })
}
