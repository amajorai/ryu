//! The desktop's side of the security-key relay, on the authenticated router:
//!
//! * `GET /api/security-key/requests` → `{ "requests": PendingRelayRequest[] }`,
//!   the caller's unanswered, unexpired requests, oldest first.
//! * `POST /api/security-key/requests/:id/response` with a [`RelayDecision`] →
//!   `200 {"ok":true}`; `404` for an unknown, expired or someone else's
//!   request, `409` once it was answered, `400` for a malformed body or a
//!   credential of the other ceremony.
//!
//! The route policy admits a current Gateway authority (as for session Boxes);
//! each handler then scopes to the request's owner: the node's personal owner
//! account, or the node token holder.

use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use ryu_webauthn_relay::RelayDecision;
use serde_json::json;

use super::{node_owner_key, now_ms, store, AnswerError};
use crate::server::{ResolvedAuthorization, ServerState};

/// Largest answer body: an attestation object with a certificate chain fits.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

pub(crate) fn routes() -> Router<ServerState> {
    Router::new()
        .route("/api/security-key/requests", get(list_requests))
        .route(
            "/api/security-key/requests/:id/response",
            post(answer_request).layer(axum::extract::DefaultBodyLimit::max(MAX_RESPONSE_BYTES)),
        )
}

/// Who a caller is, as far as request ownership goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Caller {
    /// `user:<id>` or `node-owner`, when the caller has a personal identity.
    pub owner: Option<String>,
    /// The caller is this node's owner (the node token, or the registered
    /// personal owner's verified session).
    pub node_owner: bool,
}

impl Caller {
    fn of(auth: &ResolvedAuthorization) -> Self {
        Self {
            owner: crate::server::cloud_environments::owner(auth).ok(),
            node_owner: crate::server::subscription_cloud::caller_is_node_owner(auth),
        }
    }

    /// Whether this caller may see and answer a request held for
    /// `request_owner` on a node whose owner key is `node_owner_key`.
    pub(super) fn owns(&self, request_owner: &str, node_owner_key: &str) -> bool {
        self.owner.as_deref() == Some(request_owner)
            || (self.node_owner && request_owner == node_owner_key)
    }
}

pub(super) fn answer_status(result: Result<(), AnswerError>) -> (StatusCode, serde_json::Value) {
    match result {
        Ok(()) => (StatusCode::OK, json!({ "ok": true })),
        Err(AnswerError::NotFound) => (
            StatusCode::NOT_FOUND,
            json!({ "error": "security-key request not found or expired" }),
        ),
        Err(AnswerError::AlreadyAnswered) => (
            StatusCode::CONFLICT,
            json!({ "error": "security-key request already answered" }),
        ),
        Err(AnswerError::KindMismatch) => (
            StatusCode::BAD_REQUEST,
            json!({ "error": "the credential does not answer this ceremony" }),
        ),
    }
}

async fn list_requests(Extension(auth): Extension<ResolvedAuthorization>) -> Response {
    let caller = Caller::of(&auth);
    let node_owner = node_owner_key();
    let requests = store().pending_for(|owner| caller.owns(owner, &node_owner), now_ms());
    Json(json!({ "requests": requests })).into_response()
}

async fn answer_request(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(id): Path<String>,
    body: axum::body::Bytes,
) -> Response {
    let decision: RelayDecision = match serde_json::from_slice(&body) {
        Ok(decision) => decision,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid decision: {error}") })),
            )
                .into_response()
        }
    };
    let caller = Caller::of(&auth);
    let node_owner = node_owner_key();
    let result = store().answer(
        &id,
        |owner| caller.owns(owner, &node_owner),
        decision,
        now_ms(),
    );
    let (status, body) = answer_status(result);
    (status, Json(body)).into_response()
}
