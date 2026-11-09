//! Minting or revoking app route delegations and purging a member's app data
//! are open to the owner token and a member's own session, never to scoped
//! credentials. The control plane's purge delegation reaches the purge route
//! and nothing else.
use crate::authorization::{
    AuthorizationContext, Capability, CapabilitySet, CredentialKind, GrantConstraints, Principal,
    RoutePolicy,
};
use axum::http::Method;

const PATHS: [&str; 3] = [
    "/api/app-delegations",
    "/api/app-delegations/revoke",
    "/api/data/purge-user",
];

fn context(credential: CredentialKind, client_id: Option<&str>) -> AuthorizationContext {
    AuthorizationContext {
        credential,
        principal: Principal::User {
            subject_id: "user-u".into(),
        },
        capabilities: CapabilitySet::new([Capability::GatewayRoute]),
        constraints: GrantConstraints {
            client_id: client_id.map(str::to_owned),
            ..GrantConstraints::default()
        },
        issued_at: 0,
        expires_at: None,
    }
}

#[test]
fn member_sessions_reach_the_handlers_scoped_credentials_do_not() {
    for path in PATHS {
        let member = context(CredentialKind::ManagedUserJwt, None);
        assert_eq!(
            crate::server::credential_route_policy(&Method::POST, path, &member, true),
            RoutePolicy::Authenticated,
            "{path}"
        );
        let session = context(
            CredentialKind::ManagedDelegation,
            Some(crate::authorization::delegation::NODE_LIST_CLIENT_ID),
        );
        assert_eq!(
            crate::server::credential_route_policy(&Method::POST, path, &session, true),
            RoutePolicy::Authenticated,
            "{path}"
        );
        for scoped in [
            context(CredentialKind::ManagedDelegation, Some("hosted-mcp-client")),
            context(CredentialKind::HostedOAuth, None),
            context(
                CredentialKind::PairedCapability {
                    grant_id: "pc_x".into(),
                },
                None,
            ),
        ] {
            assert_eq!(
                crate::server::credential_route_policy(&Method::POST, path, &scoped, true),
                RoutePolicy::OwnerOnly,
                "{path}"
            );
        }
    }
}

#[test]
fn the_purge_delegation_reaches_the_purge_route_only() {
    let purge = context(
        CredentialKind::ManagedDelegation,
        Some(crate::authorization::delegation::DATA_PURGE_CLIENT_ID),
    );
    assert_eq!(
        crate::server::credential_route_policy(&Method::POST, "/api/data/purge-user", &purge, true),
        RoutePolicy::Authenticated
    );
    for (method, path) in [
        (Method::GET, "/api/data/purge-user"),
        (Method::POST, "/api/app-delegations"),
        (Method::POST, "/api/app-delegations/revoke"),
        (Method::POST, "/api/data/clear"),
        (Method::GET, "/api/conversations"),
        (Method::POST, "/api/chat/stream"),
        (Method::GET, "/api/device-tools/devices"),
    ] {
        assert_eq!(
            crate::server::credential_route_policy(&method, path, &purge, true),
            RoutePolicy::OwnerOnly,
            "{method} {path}"
        );
    }
}
