use crate::authorization::{
    AuthorizationContext, CapabilitySet, CredentialKind, GrantConstraints, Principal, RoutePolicy,
};
use crate::server::{credential_route_policy, route_policy};
use axum::http::Method;

const ROUTE_CASES: [(Method, &str); 5] = [
    (Method::GET, "/api/local-egress/route"),
    (Method::DELETE, "/api/local-egress/route"),
    (Method::GET, "/api/local-egress/route/ws"),
    (Method::GET, "/api/local-egress/route/providers"),
    (Method::PUT, "/api/local-egress/route/providers"),
];
const OWNER_ONLY_CASES: [(Method, &str); 3] = [
    (Method::GET, "/api/local-egress/desktop"),
    (Method::PUT, "/api/local-egress/desktop"),
    (Method::GET, "/api/local-egress/routex"),
];

fn context(credential: CredentialKind) -> AuthorizationContext {
    AuthorizationContext {
        credential,
        principal: Principal::User {
            subject_id: "u1".into(),
        },
        capabilities: CapabilitySet::default(),
        constraints: GrantConstraints::default(),
        issued_at: 0,
        expires_at: None,
    }
}

#[test]
fn route_paths_are_authenticated_and_left_to_the_handler_owner_check() {
    for (method, path) in ROUTE_CASES {
        assert_eq!(
            route_policy(&method, path),
            RoutePolicy::Authenticated,
            "{method} {path}"
        );
    }
}

#[test]
fn desktop_setting_and_lookalike_paths_fall_to_owner_only() {
    for (method, path) in OWNER_ONLY_CASES {
        assert_eq!(
            route_policy(&method, path),
            RoutePolicy::OwnerOnly,
            "{method} {path}"
        );
    }
}

#[test]
fn no_credential_specific_override_applies_to_local_egress() {
    let contexts = [
        context(CredentialKind::ManagedUserJwt),
        context(CredentialKind::PairedCapability {
            grant_id: "pc_egress".into(),
        }),
    ];
    for context in &contexts {
        for (method, path) in ROUTE_CASES {
            assert_eq!(
                credential_route_policy(&method, path, context, true),
                RoutePolicy::Authenticated,
                "{method} {path}"
            );
        }
        for (method, path) in OWNER_ONLY_CASES {
            assert_eq!(
                credential_route_policy(&method, path, context, true),
                RoutePolicy::OwnerOnly,
                "{method} {path}"
            );
        }
    }
}
