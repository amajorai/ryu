//! `POST /api/app-delegations/revoke` `{ user_id }`: revoke every outstanding
//! app route delegation of one member (see [`super::app_route_revocation`]).
//!
//! The same people who may purge a member's data may revoke their
//! delegations: the member themselves, an owner or admin of the organization
//! this node is bound to, or the node owner token (from this machine on an
//! org-bound node, from anywhere on an unbound one). Scoped credentials,
//! including the control plane's purge delegation, are kept out by
//! `credential_route_policy`. Not in the OpenAPI document, so no agent tool
//! can reach it.

use axum::{http::StatusCode, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::data_user_purge::{may_purge, OwnerToken};
use crate::identity_verify::VerifiedCaller;

const MAX_USER_ID_BYTES: usize = 256;

/// Body of `POST /api/app-delegations/revoke`.
#[derive(Debug, Deserialize)]
pub struct RevokeRequest {
    /// The member whose delegations are revoked.
    pub user_id: String,
}

/// `POST /api/app-delegations/revoke` → `{ user_id, revoked_before }`, where
/// `revoked_before` is the epoch (Unix seconds) at or before which this
/// member's delegations are refused.
pub async fn revoke(
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Json(request): Json<RevokeRequest>,
) -> (StatusCode, Json<Value>) {
    let user_id = request.user_id.trim();
    if user_id.is_empty() || user_id.len() > MAX_USER_ID_BYTES {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "user_id is required" })),
        );
    }
    let owner_token = if !crate::server::request_presents_owner_token() {
        OwnerToken::Absent
    } else if crate::server::request_is_from_local_owner() {
        OwnerToken::LocalPeer
    } else {
        OwnerToken::Remote
    };
    let node_org = super::node_org_id();
    if !may_purge(owner_token, caller.as_ref(), user_id, node_org.as_deref()) {
        return (
            StatusCode::FORBIDDEN,
            Json(
                json!({ "error": "forbidden: only the member, an admin of this node's organization or the node owner may revoke these delegations" }),
            ),
        );
    }
    let epoch = super::app_route_revocation::revoke_user(user_id, crate::pairing::now_secs());
    tracing::info!("app-delegations: revoked one member's delegations");
    (
        StatusCode::OK,
        Json(json!({ "user_id": user_id, "revoked_before": epoch })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(user_id: &str) -> VerifiedCaller {
        VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org-1".to_owned()),
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        }
    }

    #[tokio::test]
    async fn another_member_cannot_revoke_and_a_blank_id_is_refused() {
        let (status, _) = revoke(
            Extension(Some(member("someone-else"))),
            Json(RevokeRequest {
                user_id: "target-user".to_owned(),
            }),
        )
        .await;
        // Outside an HTTP request no owner token is presented, and the test
        // node is unbound, so only the member themselves may revoke.
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = revoke(
            Extension(Some(member("u"))),
            Json(RevokeRequest {
                user_id: "  ".to_owned(),
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn a_member_revokes_their_own_delegations() {
        let user = format!("revoke-self-{}", uuid::Uuid::new_v4().simple());
        let (status, Json(body)) = revoke(
            Extension(Some(member(&user))),
            Json(RevokeRequest {
                user_id: user.clone(),
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let epoch = body["revoked_before"].as_u64().expect("epoch");
        assert!(super::super::app_route_revocation::is_revoked(
            Some(&user),
            epoch
        ));
        assert!(!super::super::app_route_revocation::is_revoked(
            Some(&user),
            epoch + 1
        ));
    }
}
