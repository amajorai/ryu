//! `/api/device-tools/*`: pairing, host approval, catalog, presence and claim.

use super::auth::{device_error, require_principal, require_store, status_for, verify_signed};
use crate::device_tools::claims::{self, ClaimPhase, ClaimRequest};
use crate::device_tools::declaration::{clean_label, ClientDeviceDecl, MAX_LABEL};
use crate::device_tools::identity::{self, DevicePrincipal};
use crate::device_tools::registry::{DeviceState, NewDevice};
use crate::device_tools::{catalog, flag, now_ms, presence, DeviceErrorCode};
use crate::server::*;
use axum::response::Response;

pub(in crate::server) const PAIR_ROUTE: &str = "/api/device-tools/devices/pair";
pub(in crate::server) const PRESENCE_ROUTE: &str = "/api/device-tools/presence";
pub(in crate::server) const CLAIM_ROUTE: &str = "/api/device-tools/claim";
pub(in crate::server) const CONFIRM_ROUTE: &str = "/api/device-tools/confirm";
pub(in crate::server) const HOME_ACCESSORIES_ROUTE: &str = "/api/device-tools/home-accessories";

/// Whether device tools are enabled for this caller (design §2.4 step 1).
///
/// The flag source follows the principal, never the mere presence of a JWT:
/// a verified user on an org-bound node is judged by the signed `ryu_flags`
/// of that user's token for this node's org; the local owner of an unbound
/// node by the node preference only. An unbound node cannot tie a cloud JWT
/// to its owner, so a JWT sent there (any account's) is ignored and can
/// neither turn the lane on nor override a preference set to off.
pub(in crate::server) async fn device_tools_enabled(
    state: &ServerState,
    principal: &DevicePrincipal,
    user_jwt: Option<&str>,
) -> bool {
    let node_org = node_org_id();
    let profile = crate::profile::profile();
    match principal {
        DevicePrincipal::User(_) => {
            let flags = match user_jwt {
                Some(token) => crate::identity_verify::verified_feature_flags(token).await,
                None => None,
            };
            flag::enabled(
                flag::FlagSubject::Cloud {
                    flags: flags.as_ref().map(|f| &f.keys),
                    flags_org: flags.as_ref().and_then(|f| f.org.as_deref()),
                },
                node_org.as_deref(),
                profile,
            )
        }
        DevicePrincipal::LocalOwner => {
            let pref = state
                .preferences
                .get(flag::LOCAL_PREF_KEY)
                .await
                .ok()
                .flatten();
            flag::enabled(
                flag::FlagSubject::LocalOwner {
                    pref: pref.as_deref(),
                },
                node_org.as_deref(),
                profile,
            )
        }
    }
}

/// Refuse every device-lane route while `mobile.device_tools` is off for this
/// caller (the lane ships dark): 403 `admin_blocked`.
pub(in crate::server) async fn require_enabled(
    state: &ServerState,
    principal: &DevicePrincipal,
    user_jwt: Option<&str>,
) -> Result<(), Response> {
    if device_tools_enabled(state, principal, user_jwt).await {
        Ok(())
    } else {
        Err(device_error(
            StatusCode::FORBIDDEN,
            DeviceErrorCode::AdminBlocked,
        ))
    }
}

/// The state a new pairing starts in. Only a verified user on an org-bound
/// node (where that user IS the principal) is active at once; the local owner
/// of an unbound node always starts pending until approved on the host, even
/// when the request also carries a cloud JWT, because nothing ties that JWT
/// to this node's owner.
pub(in crate::server) fn initial_pair_state(principal: &DevicePrincipal) -> DeviceState {
    match principal {
        DevicePrincipal::User(_) => DeviceState::Active,
        DevicePrincipal::LocalOwner => DeviceState::Pending,
    }
}

pub(super) fn parse_body<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<T, Response> {
    serde_json::from_slice(body)
        .map_err(|_| device_error(StatusCode::BAD_REQUEST, DeviceErrorCode::InvalidInput))
}

#[derive(Debug, Deserialize)]
pub(in crate::server) struct PairBody {
    device_id: String,
    app: String,
    platform: String,
    #[serde(default)]
    label: String,
    public_key_spki: String,
    /// The user-presence key that approves Home security actions
    /// (`POST /api/device-tools/confirm`). Optional; without it the phone
    /// cannot confirm them and such calls are refused.
    #[serde(default)]
    confirm_public_key_spki: Option<String>,
    #[serde(default)]
    attestation: Option<String>,
}

/// `POST /api/device-tools/devices/pair` — register this device's P-256 key.
/// Signed with the key being registered (proof of possession). The local
/// owner of an unbound node gets a `pending` device that the host owner must
/// approve on this machine (a cloud JWT does not change that); a verified user
/// on an org-bound node is active at once. Refused while the flag is off.
#[utoipa::path(post, path = "/api/device-tools/devices/pair", tag = "Device tools",
    summary = "Pair a phone for device tools", request_body = serde_json::Value,
    responses((status = 200, description = "Paired", body = serde_json::Value)))]
pub(in crate::server) async fn device_tools_pair(
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
    let request: PairBody = match parse_body(&body) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let Ok(device_id) = uuid::Uuid::parse_str(request.device_id.trim()).map(|id| id.to_string())
    else {
        return device_error(StatusCode::BAD_REQUEST, DeviceErrorCode::InvalidInput);
    };
    if !matches!(request.app.as_str(), "ryu-bot" | "ryu-native")
        || !matches!(request.platform.as_str(), "ios" | "android")
    {
        return device_error(StatusCode::BAD_REQUEST, DeviceErrorCode::InvalidInput);
    }
    let Some(public_key) = identity::decode_public_key(&request.public_key_spki) else {
        return device_error(StatusCode::BAD_REQUEST, DeviceErrorCode::InvalidInput);
    };
    let confirm_key = match request.confirm_public_key_spki.as_deref() {
        None => None,
        Some(spki) => match identity::decode_public_key(spki) {
            // The confirmation key must be a second key, not the signing key.
            Some(key) if key != public_key => Some(key),
            _ => return device_error(StatusCode::BAD_REQUEST, DeviceErrorCode::InvalidInput),
        },
    };
    let Some(signed) = super::auth::signed_headers(&headers) else {
        return super::auth::signature_refusal(identity::SignatureError::Missing);
    };
    if signed.device_id != device_id {
        return super::auth::signature_refusal(identity::SignatureError::Mismatch);
    }
    let principal_id = principal.id();
    let store = match require_store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    if let Err(response) = super::auth::verify_and_accept(
        &signed,
        "POST",
        PAIR_ROUTE,
        &principal_id,
        Some(&public_key),
        &body,
        &store,
    ) {
        return response;
    }
    let initial_state = initial_pair_state(&principal);
    let attestation = request
        .attestation
        .as_deref()
        .map(|value| value.chars().take(16_384).collect::<String>());
    let label = clean_label(&request.label, MAX_LABEL);
    match store.pair(
        &NewDevice {
            principal_id: &principal_id,
            device_id: &device_id,
            public_key: &public_key,
            app: &request.app,
            platform: &request.platform,
            label: &label,
            attestation: attestation.as_deref(),
            initial_state,
        },
        now_ms(),
    ) {
        Ok(state) => {
            if store
                .set_confirm_key(&principal_id, &device_id, confirm_key.as_deref(), now_ms())
                .is_err()
            {
                return device_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    DeviceErrorCode::DeviceUnavailable,
                );
            }
            Json(json!({
                "device_id": device_id,
                "principal_id": principal_id,
                "state": if state == DeviceState::Active { "active" } else { "pending" },
                "confirmations": confirm_key.is_some(),
            }))
            .into_response()
        }
        Err(_) => device_error(
            StatusCode::SERVICE_UNAVAILABLE,
            DeviceErrorCode::DeviceUnavailable,
        ),
    }
}

/// `POST /api/device-tools/devices/:device_id/approve-pair` — the host owner
/// activates a pending device. Only from this machine: a phone holding the
/// node token cannot approve itself remotely.
#[utoipa::path(post, path = "/api/device-tools/devices/{device_id}/approve-pair", tag = "Device tools",
    summary = "Approve a pending phone pairing on the host", params(("device_id" = String, Path)),
    responses((status = 200, description = "Approved", body = serde_json::Value)))]
pub(in crate::server) async fn device_tools_approve_pair(
    Path(device_id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    auth: Option<Extension<ResolvedAuthorization>>,
) -> Response {
    let local = REQUEST_PEER_IS_LOCAL
        .try_with(|local| *local)
        .unwrap_or(false);
    let principal = match require_principal(auth.as_ref().map(|a| &a.0), caller.as_ref()) {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    if !local || principal != DevicePrincipal::LocalOwner {
        return device_error(StatusCode::FORBIDDEN, DeviceErrorCode::DeviceNotPaired);
    }
    let store = match require_store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.approve(&principal.id(), device_id.trim()) {
        Ok(true) => {
            Json(json!({ "device_id": device_id.trim(), "state": "active" })).into_response()
        }
        Ok(false) => device_error(StatusCode::NOT_FOUND, DeviceErrorCode::NotFound),
        Err(_) => device_error(
            StatusCode::SERVICE_UNAVAILABLE,
            DeviceErrorCode::DeviceUnavailable,
        ),
    }
}

/// `GET /api/device-tools/catalog` — the closed catalog, the caller's caps and
/// whether the flag is on for this caller.
#[utoipa::path(get, path = "/api/device-tools/catalog", tag = "Device tools",
    summary = "Device-tool catalog and flag state",
    responses((status = 200, description = "OK", body = serde_json::Value)))]
pub(in crate::server) async fn device_tools_catalog(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Extension(VerifiedUserJwt(user_jwt)): Extension<VerifiedUserJwt>,
    auth: Option<Extension<ResolvedAuthorization>>,
) -> Response {
    let principal = match require_principal(auth.as_ref().map(|a| &a.0), caller.as_ref()) {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    let enabled = device_tools_enabled(&state, &principal, user_jwt.as_deref()).await;
    let catalog: Value = serde_json::from_str(catalog::FIXTURE).unwrap_or(Value::Null);
    // The caller's own caps (P5): none on a personal node; on an org-bound
    // node the per-caller rules, or "never" when they cannot be resolved.
    let caps = crate::device_tools::caps_resolver::caps_for(&principal)
        .await
        .to_json();
    Json(json!({
        "enabled": enabled,
        "principal_id": principal.id(),
        "catalog": catalog,
        "caps": caps,
    }))
    .into_response()
}

/// `POST /api/device-tools/presence` (signed) — the foreground lease.
#[utoipa::path(post, path = "/api/device-tools/presence", tag = "Device tools",
    summary = "Refresh a phone's foreground lease", request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value)))]
pub(in crate::server) async fn device_tools_presence(
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
    let device_id = match verify_signed(&headers, "POST", PRESENCE_ROUTE, &principal, &body, &store)
    {
        Ok(device_id) => device_id,
        Err(response) => return response,
    };
    let mut decl: ClientDeviceDecl = match parse_body(&body) {
        Ok(decl) => decl,
        Err(response) => return response,
    };
    if decl.validate(Some(&device_id)).is_err() {
        return device_error(StatusCode::BAD_REQUEST, DeviceErrorCode::InvalidInput);
    }
    let now = now_ms();
    presence::refresh_with_decl(&principal.id(), &device_id, &decl, now);
    store.touch(&principal.id(), &device_id, now);
    Json(json!({ "ok": true, "lease_ttl_ms": presence::LEASE_TTL_MS })).into_response()
}

#[derive(Debug, Deserialize)]
pub(in crate::server) struct ClaimBody {
    conversation_id: String,
    tool_call_id: String,
    device_id: String,
    #[serde(default)]
    phase: Option<String>,
}

/// `POST /api/device-tools/claim` (signed) — claim a device call once and
/// receive its frozen input.
#[utoipa::path(post, path = "/api/device-tools/claim", tag = "Device tools",
    summary = "Claim a pending device call", request_body = serde_json::Value,
    responses((status = 200, description = "Claimed", body = serde_json::Value)))]
pub(in crate::server) async fn device_tools_claim(
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
    let device_id = match verify_signed(&headers, "POST", CLAIM_ROUTE, &principal, &body, &store) {
        Ok(device_id) => device_id,
        Err(response) => return response,
    };
    let request: ClaimBody = match parse_body(&body) {
        Ok(request) => request,
        Err(response) => return response,
    };
    if uuid::Uuid::parse_str(request.device_id.trim())
        .map(|id| id.to_string())
        .ok()
        .as_deref()
        != Some(device_id.as_str())
    {
        return super::auth::signature_refusal(identity::SignatureError::Mismatch);
    }
    let phase = match request.phase.as_deref() {
        None | Some("execute") => ClaimPhase::Execute,
        Some("permission") => ClaimPhase::Permission,
        Some(_) => return device_error(StatusCode::BAD_REQUEST, DeviceErrorCode::InvalidInput),
    };
    let principal_id = principal.id();
    let now = now_ms();
    let outcome = claims::claim(&ClaimRequest {
        conversation_id: &request.conversation_id,
        tool_call_id: &request.tool_call_id,
        principal_id: &principal_id,
        device_id: &device_id,
        phase,
        foreground: presence::is_foreground(&principal_id, &device_id, now),
        now_ms: now,
    });
    match outcome {
        Ok(grant) => Json(json!({
            "claim_id": grant.claim_id,
            "tool": grant.tool,
            "input": grant.input,
            "input_sha256": grant.input_sha256,
            "deadline_ms": grant.deadline_ms,
            "security_confirmed": grant.security_confirmed,
        }))
        .into_response(),
        Err(code) => device_error(status_for(code), code),
    }
}
