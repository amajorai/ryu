//! The control plane's purge delegation: how the cloud asks this node to
//! delete one member's app data when they leave its organization or delete
//! their account.
//!
//! The cloud's account-deletion job and member-removal hooks run without the
//! member's session, so they cannot present a user JWT or the node-list
//! delegation. Instead the control plane signs a short-lived Ed25519
//! delegation (at most 60 s, see `authorization::delegation`) with the client
//! id [`DATA_PURGE_CLIENT_ID`], bound to this node, its organization and the
//! member being purged (`sub`).
//!
//! It fails closed everywhere but one place:
//!
//! - [`purge_delegation_policy`] admits it on `POST /api/data/purge-user`
//!   only; every other route answers it as `OwnerOnly`, which it never is.
//! - [`purge_delegation_admits`] lets the handler act only for the subject it
//!   names, and only for `account_deleted` or `member_removed`.

use axum::http::Method;

use super::data_user_purge::PurgeReason;
use crate::authorization::delegation::DATA_PURGE_CLIENT_ID;
use crate::authorization::{AuthorizationContext, CredentialKind, RoutePolicy};

/// The only route a purge delegation reaches.
pub(crate) const DATA_PURGE_ROUTE: &str = "/api/data/purge-user";

/// Whether `context` is the control plane's purge delegation.
pub(crate) fn is_purge_delegation(context: &AuthorizationContext) -> bool {
    matches!(context.credential, CredentialKind::ManagedDelegation)
        && context.constraints.client_id.as_deref() == Some(DATA_PURGE_CLIENT_ID)
}

/// The route policy for a purge delegation: `Authenticated` on
/// `POST /api/data/purge-user`, `OwnerOnly` (a refusal) everywhere else.
pub(crate) fn purge_delegation_policy(method: &Method, path: &str) -> RoutePolicy {
    if *method == Method::POST && path == DATA_PURGE_ROUTE {
        RoutePolicy::Authenticated
    } else {
        RoutePolicy::OwnerOnly
    }
}

/// Whether a purge delegation for `subject` may purge `user_id` for
/// `reason`: only that member, and only because they left or were deleted.
pub(crate) fn purge_delegation_admits(subject: &str, user_id: &str, reason: PurgeReason) -> bool {
    !subject.trim().is_empty()
        && subject == user_id
        && matches!(
            reason,
            PurgeReason::AccountDeleted | PurgeReason::MemberRemoved
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authorization::{CapabilitySet, GrantConstraints, Principal};

    fn delegation(client_id: &str) -> AuthorizationContext {
        AuthorizationContext {
            credential: CredentialKind::ManagedDelegation,
            principal: Principal::User {
                subject_id: "u1".into(),
            },
            capabilities: CapabilitySet::new(std::iter::empty::<crate::authorization::Capability>()),
            constraints: GrantConstraints {
                client_id: Some(client_id.to_owned()),
                ..GrantConstraints::default()
            },
            issued_at: 0,
            expires_at: Some(60),
        }
    }

    #[test]
    fn only_the_purge_client_id_is_a_purge_delegation() {
        assert!(is_purge_delegation(&delegation(DATA_PURGE_CLIENT_ID)));
        assert!(!is_purge_delegation(&delegation(
            crate::authorization::delegation::NODE_LIST_CLIENT_ID
        )));
        let mut jwt = delegation(DATA_PURGE_CLIENT_ID);
        jwt.credential = CredentialKind::ManagedUserJwt;
        assert!(!is_purge_delegation(&jwt));
    }

    #[test]
    fn the_purge_route_is_the_only_one_it_reaches() {
        assert_eq!(
            purge_delegation_policy(&Method::POST, DATA_PURGE_ROUTE),
            RoutePolicy::Authenticated
        );
        for (method, path) in [
            (Method::GET, DATA_PURGE_ROUTE),
            (Method::POST, "/api/data/clear"),
            (Method::POST, "/api/app-delegations"),
            (Method::POST, "/api/data/purge-user/extra"),
            (Method::GET, "/api/conversations"),
        ] {
            assert_eq!(
                purge_delegation_policy(&method, path),
                RoutePolicy::OwnerOnly,
                "{method} {path}"
            );
        }
    }

    #[test]
    fn it_purges_only_its_subject_for_a_departure() {
        assert!(purge_delegation_admits(
            "u1",
            "u1",
            PurgeReason::MemberRemoved
        ));
        assert!(purge_delegation_admits(
            "u1",
            "u1",
            PurgeReason::AccountDeleted
        ));
        assert!(!purge_delegation_admits(
            "u1",
            "u2",
            PurgeReason::MemberRemoved
        ));
        assert!(!purge_delegation_admits(
            "u1",
            "u1",
            PurgeReason::SelfRequested
        ));
        assert!(!purge_delegation_admits("u1", "u1", PurgeReason::Other));
        assert!(!purge_delegation_admits("", "", PurgeReason::MemberRemoved));
    }
}
