//! A `gateway:route`-scoped credential must not author the user's cloud
//! environment templates or vault bindings, which later execute with the
//! user's sealed variables.
use crate::authorization::{
    AuthorizationContext, AuthorizationDecision, Capability, CapabilitySet, CredentialKind,
    DenialReason, GrantConstraints, Principal, RequestBindings, RoutePolicy,
};
use axum::http::Method;

const HOSTED_CLIENT: &str = "hosted-mcp-client";

fn routing(credential: CredentialKind, client_id: Option<&str>) -> AuthorizationContext {
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

fn decide(context: &AuthorizationContext, method: &Method, path: &str) -> AuthorizationDecision {
    let bindings = RequestBindings {
        client_id: context.constraints.client_id.clone(),
        ..RequestBindings::default()
    };
    context.authorize(
        &crate::server::credential_route_policy(method, path, context, true),
        &bindings,
        1,
    )
}

const MUTATIONS: [(Method, &str); 5] = [
    (Method::PUT, "/api/cloud-environments"),
    (Method::POST, "/api/cloud-environments/import"),
    (Method::POST, "/api/cloud-environments/shared/x/import"),
    (Method::POST, "/api/cloud-environments/github"),
    (Method::DELETE, "/api/cloud-environments"),
];

#[test]
fn route_only_scoped_credentials_cannot_write_cloud_environments() {
    for context in [
        routing(CredentialKind::ManagedDelegation, Some(HOSTED_CLIENT)),
        routing(CredentialKind::HostedOAuth, None),
        routing(
            CredentialKind::PairedCapability {
                grant_id: "pc_route".into(),
            },
            None,
        ),
    ] {
        for (method, path) in &MUTATIONS {
            assert_eq!(
                crate::server::credential_route_policy(method, path, &context, true),
                RoutePolicy::OwnerOnly,
                "{method} {path}"
            );
            assert_eq!(
                decide(&context, method, path),
                AuthorizationDecision::Deny(DenialReason::OwnerRequired),
                "{method} {path}"
            );
        }
    }
}

#[test]
fn route_only_scoped_credentials_keep_cloud_environment_reads_and_launch_gate() {
    let context = routing(CredentialKind::ManagedDelegation, Some(HOSTED_CLIENT));
    for path in [
        "/api/cloud-environments",
        "/api/cloud-environments/shared",
        "/api/cloud-environments/task-binding/c1",
    ] {
        assert_eq!(
            crate::server::credential_route_policy(&Method::GET, path, &context, true),
            RoutePolicy::requires([Capability::GatewayRoute]),
            "{path}"
        );
        assert_eq!(
            decide(&context, &Method::GET, path),
            AuthorizationDecision::Allow
        );
    }
    // The setup check keeps its own `tools:exec` requirement.
    assert_eq!(
        crate::server::credential_route_policy(
            &Method::POST,
            "/api/cloud-environments/env-1/launch",
            &context,
            true
        ),
        RoutePolicy::requires([Capability::GatewayRoute, Capability::ToolsExec])
    );
}

#[test]
fn member_sessions_still_write_their_cloud_environments() {
    for context in [
        routing(CredentialKind::ManagedUserJwt, None),
        routing(
            CredentialKind::ManagedDelegation,
            Some(crate::authorization::delegation::NODE_LIST_CLIENT_ID),
        ),
        AuthorizationContext::owner(0),
    ] {
        for (method, path) in &MUTATIONS {
            assert_eq!(
                decide(&context, method, path),
                AuthorizationDecision::Allow,
                "{method} {path}"
            );
        }
    }
}
