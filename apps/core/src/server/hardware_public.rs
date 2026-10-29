//! Protected RHP pairing ingress (PROTOCOL.md §5/§6, RHP v1.1 design §5.6):
//!
//! - `POST /api/hardware/pair` — legacy v1 nonce pairing (`426 pairing_v2_required`
//!   once the `hardware-legacy-v1-pairing` node pref is `"false"`);
//! - `POST /api/hardware/pair/{begin,reveal,confirm,cancel}` — pairing v2: two-phase,
//!   press-to-confirm and bound to both static keys;
//! - `POST /api/hardware/identity/reset` — explicit recovery when the node key is lost.
//!
//! This is **kernel ingress** that forwards to the extracted [`ryu_hardware`]
//! crate. It stays Core-side (not in the crate) because the node-URL resolution is
//! welded to two kernel couplings the crate must not depend on:
//!   - the mesh handle (`state.mesh`) for the MagicDNS name, and
//!   - the shared SSRF guard (`super::is_blocked_ip`) that decides whether an
//!     attacker-controllable `Host` header may be reflected into a device's
//!     `node_url`.
//!
//! ## Auth split
//!
//! Every route here is **protected**: they mint durable device credentials (or
//! replace the node identity), so the caller must first be admitted by Core's node
//! bearer gate. The device's proof (nonce, commitment, press-bound confirm tag) is
//! verified on top of that in [`ryu_hardware::pairing`].
//!
//! ## Audit
//!
//! `begin`, `confirm`, `cancel` and identity reset each write one `tracing` line
//! on target `hardware.pairing` with ids and outcomes only — never tokens, keys,
//! Wi-Fi credentials, tags or request bodies.
//!
//! Placement (Core vs Gateway): the registry decides *which device may drive this
//! node*, so it is Core.

use axum::{
    extract::{rejection::JsonRejection, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde_json::json;

use super::ServerState;
use ryu_hardware::pairing::{self, PairError};
use ryu_hardware::protocol::{
    IdentityResetResponse, PairBeginRequest, PairCancelRequest, PairConfirmRequest, PairRequest,
    PairRevealRequest,
};
use ryu_hardware::session::live::{self, EndReason};
use ryu_hardware::store::DeviceStore;

/// Node pref that turns legacy (v1 nonce) pairing off when set to `"false"`.
pub(crate) const LEGACY_PAIRING_PREF: &str = "hardware-legacy-v1-pairing";

/// Audit target for pairing and identity events.
const AUDIT: &str = "hardware.pairing";

/// Resolve the WS URL a freshly-paired device should connect to. Prefers the
/// `Host` the app actually reached the node on (the address that demonstrably
/// works from the app's network), then the mesh MagicDNS name, then the bound
/// address. Nothing is hardcoded; `RYU_HARDWARE_NODE_URL` overrides everything.
async fn resolve_node_url(state: &ServerState, headers: &HeaderMap) -> String {
    // 1. Explicit operator override always wins.
    if let Ok(explicit) = std::env::var("RYU_HARDWARE_NODE_URL") {
        if !explicit.trim().is_empty() {
            return explicit;
        }
    }
    let bind = std::env::var("RYU_BIND").unwrap_or_else(|_| "127.0.0.1:7980".to_string());
    let magic_dns = state
        .mesh
        .status()
        .await
        .magic_dns_name
        .filter(|d| !d.is_empty());

    // 2. The `Host` the app reached the node on — but ONLY when it names an
    // address in the device's own trust domain. The `Host` header is attacker-
    // controllable, so a forged public host must never be reflected into the
    // node_url: that would redirect the freshly-paired device (and its
    // device_token) to attacker infrastructure. See `host_is_trusted`.
    if let Some(host) = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .filter(|h| !h.is_empty())
    {
        if host_is_trusted(&host, &bind, magic_dns.as_deref()) {
            return format!("{}://{host}/api/hardware/ws", ws_scheme(&host));
        }
        tracing::warn!(
            host = %host,
            "hardware: ignoring untrusted Host header for device node_url; using mesh/bind address"
        );
    }

    // 3. Mesh MagicDNS name (stable across networks) when the daemon is up. A
    // tailnet host is not loopback, so it uses the secure scheme.
    if let Some(dns) = magic_dns {
        return format!("wss://{dns}:7980/api/hardware/ws");
    }
    // 4. The bound address.
    format!("{}://{bind}/api/hardware/ws", ws_scheme(&bind))
}

/// Extract the IP literal from a `Host`/bind value, with or without a `:port`
/// and with or without `[..]` brackets for IPv6. Returns `None` for hostnames.
fn host_ip(host: &str) -> Option<std::net::IpAddr> {
    if let Ok(sa) = host.parse::<std::net::SocketAddr>() {
        return Some(sa.ip());
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return Some(ip);
    }
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .ok()
}

/// Whether a `Host` header may be reflected verbatim into a device's `node_url`.
///
/// The header is attacker-controllable, so it is honored ONLY when it names an
/// address in the device's own trust domain:
///   - a loopback / private / link-local / CGNAT IP literal (leaking the token
///     to such an address keeps it on the same LAN/tailnet as the device), as
///     classified by the shared SSRF guard [`super::is_blocked_ip`];
///   - `localhost`, or the address Core is actually bound to (`RYU_BIND`);
///   - the node's mesh MagicDNS name;
///   - an operator allowlist (`RYU_HARDWARE_ALLOWED_HOSTS`, comma-separated).
///
/// Any other host (an arbitrary public name/IP) is refused, so a forged `Host`
/// cannot redirect a paired device and its token off-box.
fn host_is_trusted(host: &str, bind: &str, magic_dns: Option<&str>) -> bool {
    // IP literal: trust exactly the private/loopback/link-local ranges.
    if let Some(ip) = host_ip(host) {
        return super::is_blocked_ip(ip);
    }
    // Hostname: strip an optional `:port`, then match known-good names.
    let name = host
        .rsplit_once(':')
        .map_or(host, |(h, _)| h)
        .to_ascii_lowercase();
    if name == "localhost" {
        return true;
    }
    let bind_name = bind
        .rsplit_once(':')
        .map_or(bind, |(h, _)| h)
        .to_ascii_lowercase();
    if name == bind_name {
        return true;
    }
    if magic_dns.is_some_and(|d| d.to_ascii_lowercase() == name) {
        return true;
    }
    if let Ok(allowed) = std::env::var("RYU_HARDWARE_ALLOWED_HOSTS") {
        return allowed
            .split(',')
            .map(|s| s.trim().to_ascii_lowercase())
            .any(|a| !a.is_empty() && a == name);
    }
    false
}

/// The WS scheme for a host: plain `ws` for loopback (no TLS in front), secure
/// `wss` for anything reachable off-box (PROTOCOL.md §2 uses `wss` for the
/// non-loopback endpoint). A node fronted by a non-loopback bind / tunnel is
/// expected to terminate TLS, so the device dials `wss`.
fn ws_scheme(host: &str) -> &'static str {
    let bare = host.split(':').next().unwrap_or(host);
    let loopback = bare == "localhost"
        || bare == "127.0.0.1"
        || bare == "::1"
        || bare == "[::1]"
        || bare.starts_with("127.");
    if loopback {
        "ws"
    } else {
        "wss"
    }
}

/// The HTTP status RHP v1.1 design §5.6 assigns to a pairing error.
pub(crate) fn pair_error_status(error: PairError) -> StatusCode {
    match error {
        PairError::BadRequest(_) => StatusCode::BAD_REQUEST,
        PairError::BadNonce | PairError::CommitmentMismatch | PairError::ConfirmationMismatch => {
            StatusCode::UNAUTHORIZED
        }
        PairError::UnknownOrExpired => StatusCode::NOT_FOUND,
        PairError::AlreadyPaired | PairError::BadState => StatusCode::CONFLICT,
        PairError::BadDeviceKey | PairError::NodeUrlTooLong => StatusCode::UNPROCESSABLE_ENTITY,
        PairError::TooManyPending => StatusCode::TOO_MANY_REQUESTS,
        PairError::Storage => StatusCode::INTERNAL_SERVER_ERROR,
        PairError::IdentityUnavailable => StatusCode::SERVICE_UNAVAILABLE,
    }
}

type JsonResponse = (StatusCode, Json<serde_json::Value>);

/// `{"error":{"code","message"}}` with the given status.
fn error_response(status: StatusCode, code: &str, message: &str) -> JsonResponse {
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
}

fn pair_error_response(error: PairError) -> JsonResponse {
    error_response(pair_error_status(error), error.code(), error.message())
}

/// A malformed or mistyped body is a `400 bad_request` (not axum's default 422),
/// and the rejection text is not echoed (it can quote the body).
fn bad_body(_rejection: JsonRejection) -> JsonResponse {
    error_response(
        StatusCode::BAD_REQUEST,
        "bad_request",
        "the request body is not valid JSON for this route",
    )
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Whether legacy v1 pairing is allowed under the `hardware-legacy-v1-pairing`
/// pref (on unless explicitly `"false"`).
pub(crate) fn legacy_pairing_allowed(pref: Option<&str>) -> bool {
    !pref.is_some_and(|value| value.trim().eq_ignore_ascii_case("false"))
}

/// `POST /api/hardware/pair` — register a device from a pairing nonce (legacy v1).
/// **Protected**.
#[utoipa::path(
    post,
    path = "/api/hardware/pair",
    tag = "Hardware",
    summary = "register a legacy (v1) device from a pairing nonce. **Protected**.",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 426, description = "Legacy pairing is disabled; use pairing v2", body = serde_json::Value)
    )
)]
pub async fn pair_device(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(req): Json<PairRequest>,
) -> JsonResponse {
    let pref = state
        .preferences
        .get(LEGACY_PAIRING_PREF)
        .await
        .ok()
        .flatten();
    if !legacy_pairing_allowed(pref.as_deref()) {
        return error_response(
            StatusCode::UPGRADE_REQUIRED,
            "pairing_v2_required",
            "legacy pairing is disabled on this node; update the app and device firmware",
        );
    }
    let node_url = resolve_node_url(&state, &headers).await;
    match pairing::pair(&state.hardware, &req, &node_url).await {
        Ok(resp) => (StatusCode::OK, Json(json!(resp))),
        Err(e) => pair_error_response(e),
    }
}

/// `POST /api/hardware/pair/begin` — start a v2 pairing: validate the device key
/// and commitment, persist the pending pairing (TTL 180 s) and return a fresh
/// node-chosen `pairing_id` plus the node key. **Protected**.
#[utoipa::path(
    post,
    path = "/api/hardware/pair/begin",
    tag = "Hardware",
    summary = "start a v2 pairing and return the pairing id and the node key. **Protected**.",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "`{pairing_id, node_pub, node_fingerprint, expires_in}`", body = serde_json::Value),
        (status = 400, description = "bad_request", body = serde_json::Value),
        (status = 409, description = "already_paired", body = serde_json::Value),
        (status = 422, description = "bad_device_key", body = serde_json::Value),
        (status = 429, description = "too_many_pending", body = serde_json::Value),
        (status = 500, description = "storage", body = serde_json::Value),
        (status = 503, description = "node_identity_unavailable", body = serde_json::Value)
    )
)]
pub async fn pair_begin(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Result<Json<PairBeginRequest>, JsonRejection>,
) -> JsonResponse {
    let Json(req) = match body {
        Ok(body) => body,
        Err(rejection) => return bad_body(rejection),
    };
    let node_url = resolve_node_url(&state, &headers).await;
    let result = pairing::begin_pair(&state.hardware, &req, &node_url, now_ms()).await;
    match &result {
        Ok(_) => tracing::info!(
            target: AUDIT,
            device_id = %req.device_id,
            device_type = %req.device_type,
            key_source = %req.key_source,
            "hardware pairing v2 begun"
        ),
        Err(e) => tracing::info!(
            target: AUDIT,
            device_id = %req.device_id,
            outcome = e.code(),
            "hardware pairing v2 begin refused"
        ),
    }
    match result {
        Ok(resp) => (StatusCode::OK, Json(json!(resp))),
        Err(e) => pair_error_response(e),
    }
}

/// `POST /api/hardware/pair/reveal` — open the device commitment with its random
/// value and return the 6-digit code the user compares. Single use. **Protected**.
#[utoipa::path(
    post,
    path = "/api/hardware/pair/reveal",
    tag = "Hardware",
    summary = "open the device commitment and return the comparison code. **Protected**.",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "`{sas, transcript_hash, device_fingerprint}`", body = serde_json::Value),
        (status = 400, description = "bad_request", body = serde_json::Value),
        (status = 401, description = "commitment_mismatch", body = serde_json::Value),
        (status = 404, description = "unknown_or_expired", body = serde_json::Value),
        (status = 409, description = "bad_state", body = serde_json::Value),
        (status = 500, description = "storage", body = serde_json::Value),
        (status = 503, description = "node_identity_unavailable", body = serde_json::Value)
    )
)]
pub async fn pair_reveal(
    State(state): State<ServerState>,
    body: Result<Json<PairRevealRequest>, JsonRejection>,
) -> JsonResponse {
    let Json(req) = match body {
        Ok(body) => body,
        Err(rejection) => return bad_body(rejection),
    };
    match pairing::reveal_pair(&state.hardware, &req, now_ms()).await {
        Ok(resp) => (StatusCode::OK, Json(json!(resp))),
        Err(e) => {
            if e == PairError::CommitmentMismatch {
                tracing::warn!(
                    target: AUDIT,
                    outcome = e.code(),
                    "hardware pairing v2 reveal did not match the device commitment"
                );
            }
            pair_error_response(e)
        }
    }
}

/// `POST /api/hardware/pair/confirm` — verify the device's press-bound confirm
/// tag, then register the device, mint its tokens and seal its credentials.
/// Single use: a replay is `404`. **Protected**.
#[utoipa::path(
    post,
    path = "/api/hardware/pair/confirm",
    tag = "Hardware",
    summary = "verify the device confirmation and register the device. **Protected**.",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "`{relay_token, sealed_credentials, device}`", body = serde_json::Value),
        (status = 400, description = "bad_request", body = serde_json::Value),
        (status = 401, description = "confirmation_mismatch", body = serde_json::Value),
        (status = 404, description = "unknown_or_expired", body = serde_json::Value),
        (status = 409, description = "bad_state or already_paired", body = serde_json::Value),
        (status = 422, description = "bad_device_key or node_url_too_long", body = serde_json::Value),
        (status = 500, description = "storage", body = serde_json::Value),
        (status = 503, description = "node_identity_unavailable", body = serde_json::Value)
    )
)]
pub async fn pair_confirm(
    State(state): State<ServerState>,
    body: Result<Json<PairConfirmRequest>, JsonRejection>,
) -> JsonResponse {
    let Json(req) = match body {
        Ok(body) => body,
        Err(rejection) => return bad_body(rejection),
    };
    let result = pairing::confirm_pair(&state.hardware, &req, now_ms()).await;
    match &result {
        Ok(resp) => tracing::info!(
            target: AUDIT,
            device_id = %resp.device.device_id,
            key_verification = %req.key_verification,
            wifi = req.wifi.is_some(),
            "hardware pairing v2 confirmed; device registered"
        ),
        Err(e @ PairError::ConfirmationMismatch) => tracing::warn!(
            target: AUDIT,
            outcome = e.code(),
            "hardware pairing v2 confirmation tag did not verify (possible interference)"
        ),
        Err(e) => tracing::info!(
            target: AUDIT,
            outcome = e.code(),
            "hardware pairing v2 confirm refused"
        ),
    }
    match result {
        Ok(resp) => (StatusCode::OK, Json(json!(resp))),
        Err(e) => pair_error_response(e),
    }
}

/// `POST /api/hardware/pair/cancel` — drop a pending v2 pairing. Idempotent.
/// `reason: "mismatch"` (the user saw different codes) logs a security warning.
/// **Protected**.
#[utoipa::path(
    post,
    path = "/api/hardware/pair/cancel",
    tag = "Hardware",
    summary = "cancel a pending v2 pairing (idempotent). **Protected**.",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "`{ok:true}`", body = serde_json::Value),
        (status = 400, description = "bad_request", body = serde_json::Value),
        (status = 500, description = "storage", body = serde_json::Value)
    )
)]
pub async fn pair_cancel(
    State(state): State<ServerState>,
    body: Result<Json<PairCancelRequest>, JsonRejection>,
) -> JsonResponse {
    let Json(req) = match body {
        Ok(body) => body,
        Err(rejection) => return bad_body(rejection),
    };
    match pairing::cancel_pair(&state.hardware, &req, now_ms()).await {
        Ok(pending) => {
            let device_id = pending.as_ref().map(|p| p.device_id.as_str()).unwrap_or("");
            if req.reason.as_deref() == Some("mismatch") {
                tracing::warn!(
                    target: AUDIT,
                    device_id = %device_id,
                    "hardware pairing v2 cancelled: the user reported mismatched codes (possible interference)"
                );
            } else {
                tracing::info!(
                    target: AUDIT,
                    device_id = %device_id,
                    found = pending.is_some(),
                    "hardware pairing v2 cancelled"
                );
            }
            (StatusCode::OK, Json(json!({ "ok": true })))
        }
        Err(e) => pair_error_response(e),
    }
}

/// Regenerate the node identity, mark every pinned device `needs_repair`, and end
/// their live secure sessions as superseded (not revoked: the rows stay).
pub(crate) async fn reset_identity(
    store: &DeviceStore,
) -> Result<IdentityResetResponse, ryu_hardware::identity::IdentityError> {
    let (identity, devices_needing_repair) = store.reset_node_identity().await?;
    for device_id in &devices_needing_repair {
        live::end(device_id, EndReason::Superseded).await;
    }
    Ok(IdentityResetResponse {
        node_fingerprint: identity.fingerprint(),
        devices_needing_repair,
    })
}

/// `POST /api/hardware/identity/reset` — explicitly replace the node identity
/// (recovery after the sealed key became unreadable). Every v1.1-paired device
/// must be re-paired. **Protected**.
#[utoipa::path(
    post,
    path = "/api/hardware/identity/reset",
    tag = "Hardware",
    summary = "replace the node identity; v1.1-paired devices must re-pair. **Protected**.",
    responses(
        (status = 200, description = "`{node_fingerprint, devices_needing_repair}`", body = serde_json::Value),
        (status = 503, description = "node_identity_unavailable", body = serde_json::Value)
    )
)]
pub async fn hardware_identity_reset(State(state): State<ServerState>) -> JsonResponse {
    match reset_identity(&state.hardware).await {
        Ok(resp) => {
            tracing::warn!(
                target: AUDIT,
                node_fingerprint = %resp.node_fingerprint,
                devices_needing_repair = resp.devices_needing_repair.len(),
                "hardware node identity reset"
            );
            (StatusCode::OK, Json(json!(resp)))
        }
        Err(e) => {
            tracing::warn!(target: AUDIT, "hardware node identity reset failed: {e}");
            error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                PairError::IdentityUnavailable.code(),
                PairError::IdentityUnavailable.message(),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_hardware::identity::PlaintextSealerForTests;
    use ryu_hardware::protocol::DeviceType;
    use ryu_hardware::session::live::LiveMeta;
    use ryu_hardware::store::{hash_token, DeviceRecord, PROTOCOL_LEVEL_SECURE};

    #[test]
    fn pair_error_status_follows_the_design_table() {
        let cases = [
            (PairError::BadRequest("x"), 400),
            (PairError::BadNonce, 401),
            (PairError::CommitmentMismatch, 401),
            (PairError::ConfirmationMismatch, 401),
            (PairError::UnknownOrExpired, 404),
            (PairError::AlreadyPaired, 409),
            (PairError::BadState, 409),
            (PairError::BadDeviceKey, 422),
            (PairError::NodeUrlTooLong, 422),
            (PairError::TooManyPending, 429),
            (PairError::Storage, 500),
            (PairError::IdentityUnavailable, 503),
        ];
        for (error, status) in cases {
            assert_eq!(pair_error_status(error).as_u16(), status, "{error:?}");
            // Core's table and the crate's hint never drift apart.
            assert_eq!(pair_error_status(error).as_u16(), error.http_status_hint());
        }
    }

    #[test]
    fn error_bodies_carry_code_and_message() {
        let (status, Json(body)) = pair_error_response(PairError::UnknownOrExpired);
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "unknown_or_expired");
        assert!(body["error"]["message"]
            .as_str()
            .is_some_and(|m| !m.is_empty()));
    }

    #[test]
    fn legacy_pairing_is_on_unless_explicitly_false() {
        assert!(legacy_pairing_allowed(None));
        assert!(legacy_pairing_allowed(Some("true")));
        assert!(legacy_pairing_allowed(Some("")));
        assert!(!legacy_pairing_allowed(Some("false")));
        assert!(!legacy_pairing_allowed(Some(" False ")));
    }

    #[tokio::test]
    async fn identity_reset_marks_pinned_devices_and_supersedes_their_sessions() {
        let path = std::env::temp_dir()
            .join(format!("ryu-core-hw-reset-{}", uuid::Uuid::new_v4()))
            .join("hardware.db");
        let store = DeviceStore::open(path).unwrap();
        store.set_key_sealer(std::sync::Arc::new(PlaintextSealerForTests));
        let before = store.node_identity().await.unwrap().fingerprint();

        let id = format!(
            "rhw_reset_{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
        store
            .insert(DeviceRecord {
                noise_pubkey: Some(ryu_hardware::pair_crypto::b64u_encode(&[5u8; 32])),
                protocol_level: PROTOCOL_LEVEL_SECURE,
                ..DeviceRecord::new_legacy(id.clone(), DeviceType::Watch, "W", hash_token("t"), 1)
            })
            .await
            .unwrap();
        let (tx, _rx) = tokio::sync::mpsc::channel(4);
        let mut handle = live::register(
            &id,
            tx,
            LiveMeta {
                name: "W".into(),
                device_type: DeviceType::Watch,
                secure: true,
                relay: false,
            },
        )
        .await;

        let resp = reset_identity(&store).await.unwrap();
        assert_ne!(resp.node_fingerprint, before);
        assert_eq!(resp.devices_needing_repair, vec![id.clone()]);
        assert!(store.get(&id).await.unwrap().unwrap().needs_repair);
        handle.ended.changed().await.unwrap();
        assert_eq!(*handle.ended.borrow(), Some(EndReason::Superseded));
        live::unregister(&id, handle.generation).await;
    }

    #[tokio::test]
    async fn identity_reset_without_a_sealer_is_unavailable() {
        let path = std::env::temp_dir()
            .join(format!("ryu-core-hw-reset-{}", uuid::Uuid::new_v4()))
            .join("hardware.db");
        let store = DeviceStore::open(path).unwrap();
        assert!(reset_identity(&store).await.is_err());
    }
}
