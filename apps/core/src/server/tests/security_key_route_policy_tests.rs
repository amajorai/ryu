use crate::authorization::{
    AuthorizationContext, Capability, CapabilitySet, CredentialKind, GrantConstraints, Principal,
    RoutePolicy,
};
use crate::server::{credential_route_policy, route_policy};
use axum::http::Method;

const RELAY_CASES: [(Method, &str); 2] = [
    (Method::GET, "/api/security-key/requests"),
    (Method::POST, "/api/security-key/requests/skr_x/response"),
];

fn context(credential: CredentialKind) -> AuthorizationContext {
    AuthorizationContext {
        credential,
        principal: Principal::User {
            subject_id: "owner".into(),
        },
        capabilities: CapabilitySet::new([Capability::GatewayRoute]),
        constraints: GrantConstraints::default(),
        issued_at: 0,
        expires_at: None,
    }
}

fn delegation(client_id: &str) -> AuthorizationContext {
    let mut context = context(CredentialKind::ManagedDelegation);
    context.constraints.client_id = Some(client_id.into());
    context
}

#[test]
fn base_route_policy_requires_gateway_route() {
    for (method, path) in RELAY_CASES {
        assert_eq!(
            route_policy(&method, path),
            RoutePolicy::requires([Capability::GatewayRoute]),
            "{method} {path}"
        );
    }
}

#[test]
fn member_sessions_keep_gateway_route_admission() {
    let contexts = [
        context(CredentialKind::ManagedUserJwt),
        delegation(crate::authorization::delegation::NODE_LIST_CLIENT_ID),
    ];
    for context in &contexts {
        for (method, path) in RELAY_CASES {
            assert_eq!(
                credential_route_policy(&method, path, context, true),
                RoutePolicy::requires([Capability::GatewayRoute]),
                "{method} {path}"
            );
        }
    }
}

#[test]
fn scoped_credentials_cannot_list_or_answer_security_key_ceremonies() {
    let contexts = [
        delegation("hosted-mcp-client"),
        context(CredentialKind::ManagedDelegation),
        context(CredentialKind::PairedCapability {
            grant_id: "pc_relay".into(),
        }),
    ];
    for context in &contexts {
        for (method, path) in RELAY_CASES {
            assert_eq!(
                credential_route_policy(&method, path, context, true),
                RoutePolicy::OwnerOnly,
                "{method} {path}"
            );
        }
    }
}
