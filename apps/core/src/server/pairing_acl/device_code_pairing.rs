//! Device-code pairing handlers.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Device-code pairing handlers ─────────────────────────────────────────────
//
// See `crate::pairing` for the model. Split across the two routers: the code +
// poll pair is public (an unpaired client has no bearer), while approve/deny and
// the client list sit behind `require_auth`, so only an already-trusted caller
// can turn a pending request into a credential.

#[derive(serde::Deserialize)]
pub(in crate::server) struct PairStartBody {
    /// Self-declared, display-only label shown to the approver.
    #[serde(default)]
    pub(in crate::server) client_name: Option<String>,
    #[serde(default)]
    pub(in crate::server) requested_scopes: Option<crate::authorization::CapabilitySet>,
    #[serde(default)]
    pub(in crate::server) requested_constraints: Option<crate::authorization::GrantConstraints>,
    #[serde(default)]
    pub(in crate::server) requested_expires_at: Option<u64>,
}

/// `POST /api/pair/code` — begin pairing. PUBLIC.
pub(in crate::server) async fn pair_start(
    Json(body): Json<PairStartBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let now = crate::pairing::now_secs();
    if body
        .requested_expires_at
        .is_some_and(|expires_at| expires_at <= now)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "requested_expires_at must be in the future" })),
        );
    }
    let options = crate::pairing::PairingRequestOptions {
        client_name: body.client_name.unwrap_or_default(),
        requested_scopes: body
            .requested_scopes
            .unwrap_or_else(crate::authorization::CapabilitySet::paired_read_only),
        requested_constraints: body.requested_constraints.unwrap_or_default(),
        requested_expires_at: body.requested_expires_at,
    };
    let req = match crate::pairing::try_start_request_with_options(options) {
        Ok(request) => request,
        Err(crate::pairing::StartRequestError::CapacityExceeded) => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({ "error": "too many pending pairing requests" })),
            );
        }
    };
    (
        StatusCode::OK,
        Json(json!({
            "device_code": req.device_code,
            "user_code": req.user_code,
            "interval": crate::pairing::PAIRING_POLL_INTERVAL_SECS,
            "expires_in": crate::pairing::PAIRING_CODE_TTL_SECS,
        })),
    )
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct PairPollBody {
    pub(in crate::server) device_code: String,
}

/// `POST /api/pair/token` — poll for the outcome. PUBLIC.
///
/// Mirrors the OAuth device-grant error vocabulary (`authorization_pending`,
/// `access_denied`, `expired_token`) so a client written against that spec works
/// unchanged. A pending poll is 200-with-error rather than a 4xx, matching the
/// grant and keeping it out of clients' error paths.
pub(in crate::server) async fn pair_poll(
    Json(body): Json<PairPollBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::pairing::PollOutcome;
    match crate::pairing::poll(&body.device_code) {
        PollOutcome::Token(token) => (StatusCode::OK, Json(json!({ "token": token }))),
        PollOutcome::AuthorizationPending => (
            StatusCode::OK,
            Json(json!({ "error": "authorization_pending" })),
        ),
        PollOutcome::AccessDenied => (StatusCode::OK, Json(json!({ "error": "access_denied" }))),
        PollOutcome::ExpiredToken => (StatusCode::OK, Json(json!({ "error": "expired_token" }))),
    }
}

/// `GET /api/pair/requests` — what a human could approve right now. PROTECTED.
pub(in crate::server) async fn pair_requests() -> Json<serde_json::Value> {
    let pending: Vec<serde_json::Value> = crate::pairing::pending_requests()
        .into_iter()
        .map(|r| {
            json!({
                // `device_code` is deliberately NOT exposed: it is the client's
                // polling secret, and the approver never needs it.
                "user_code": r.user_code,
                "client_name": r.client_name,
                "created_at": r.created_at,
                "requested_scopes": r.requested_scopes.iter().map(|scope| scope.as_str()).collect::<Vec<_>>(),
                "requested_constraints": r.requested_constraints,
                "requested_expires_at": r.requested_expires_at,
            })
        })
        .collect();
    Json(json!({ "requests": pending }))
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct PairDecisionBody {
    pub(in crate::server) user_code: String,
    #[serde(default)]
    pub(in crate::server) granted_scopes: Option<crate::authorization::CapabilitySet>,
    #[serde(default)]
    pub(in crate::server) expires_at: Option<u64>,
}

/// `POST /api/pair/approve` — mint a bearer for a pending request. PROTECTED.
pub(in crate::server) async fn pair_approve(
    Json(body): Json<PairDecisionBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::pairing::approve_with_grant(
        &body.user_code,
        crate::pairing::PairingApproval {
            granted_scopes: body.granted_scopes,
            expires_at: body.expires_at,
        },
    ) {
        crate::pairing::DecisionOutcome::Approved => {
            (StatusCode::OK, Json(json!({ "approved": true })))
        }
        crate::pairing::DecisionOutcome::InvalidGrant => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "approval may only narrow the requested grant" })),
        ),
        crate::pairing::DecisionOutcome::PersistenceFailed => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "could not persist paired client" })),
        ),
        _ => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no pending pairing request with that code" })),
        ),
    }
}

/// `POST /api/pair/deny` — reject a pending request. PROTECTED.
pub(in crate::server) async fn pair_deny(
    Json(body): Json<PairDecisionBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::pairing::deny(&body.user_code) {
        crate::pairing::DecisionOutcome::Denied => {
            (StatusCode::OK, Json(json!({ "denied": true })))
        }
        _ => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no pending pairing request with that code" })),
        ),
    }
}

/// `GET /api/pair/clients` — paired clients, for the revoke UI. PROTECTED.
///
/// Returns no token material: only the SHA-256 is stored, and even that is not
/// served — a client is identified by its opaque `id`.
pub(in crate::server) async fn pair_clients() -> Json<serde_json::Value> {
    let clients: Vec<serde_json::Value> = crate::pairing::load_paired_clients()
        .clients
        .into_iter()
        .map(|c| {
            json!({
                "id": c.id,
                "name": c.name,
                "created_at": c.created_at,
                "last_seen": c.last_seen,
                "granted_scopes": c.effective_scopes().iter().map(|scope| scope.as_str()).collect::<Vec<_>>(),
                "constraints": c.constraints,
                "expires_at": c.expires_at,
                "revoked_at": c.revoked_at,
            })
        })
        .collect();
    Json(json!({ "clients": clients }))
}

/// `DELETE /api/pair/clients/:id` — revoke one paired client. PROTECTED.
pub(in crate::server) async fn pair_revoke(
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::pairing::revoke(&id) {
        Ok(true) => (StatusCode::OK, Json(json!({ "revoked": true }))),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no paired client with that id" })),
        ),
        Err(error) => {
            tracing::error!(%error, paired_client_id = %id, "pairing: revocation persistence failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(
                    json!({ "error": "revocation is active locally but could not be persisted; retry" }),
                ),
            )
        }
    }
}

/// `POST /api/node/token/rotate` — mint a new node auth token. ROOT-ONLY.
///
/// The protected route policy is OwnerOnly. `node_token::rotate` persists and
/// swaps the live verifier before returning, so the old bearer is invalid and the
/// returned bearer is usable immediately.
pub(in crate::server) async fn node_token_rotate() -> (StatusCode, Json<serde_json::Value>) {
    match crate::node_token::rotate() {
        Ok(token) => (
            StatusCode::OK,
            Json(json!({
                "token": token,
                "restart_required": false,
                "message": "The new owner token is active. Paired clients are unaffected.",
            })),
        ),
        Err(e) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}
