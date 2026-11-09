//! Minting an app route delegation and purging a member's app data are open to
//! the owner token and a member's own session, never to scoped credentials.
use crate::authorization::{
    AuthorizationContext, Capability, CapabilitySet, CredentialKind, GrantConstraints, Principal,
    RoutePolicy,
};
use axum::http::Method;

const PATHS: [&str; 2] = ["/api/app-delegations", "/api/data/purge-user"];

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
