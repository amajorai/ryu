//! The owner's personalization note feeds every owner chat system prompt, so a
//! `gateway:route`-scoped hosted client or paired device must not read or
//! rewrite it, while the owner's own sessions keep reaching the handler.
use crate::authorization::{
    AuthorizationContext, AuthorizationDecision, Capability, CapabilitySet, CredentialKind,
    DenialReason, GrantConstraints, Principal, RequestBindings, RoutePolicy,
};
use crate::server::credential_route_policy;
use axum::http::Method;

const PATH: &str = "/api/preferences/user-personalization";
const METHODS: [Method; 2] = [Method::GET, Method::PUT];

fn routing(credential: CredentialKind, client_id: Option<&str>) -> AuthorizationContext {
    AuthorizationContext {
        credential,
        principal: Principal::User {
            subject_id: "owner".into(),
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

fn decide(context: &AuthorizationContext, method: &Method) -> AuthorizationDecision {
    let bindings = RequestBindings {
        client_id: context.constraints.client_id.clone(),
        ..RequestBindings::default()
    };
    context.authorize(
        &credential_route_policy(method, PATH, context, true),
        &bindings,
        1,
    )
}

#[test]
fn scoped_credentials_cannot_read_or_rewrite_the_personalization_note() {
    for context in [
        routing(CredentialKind::ManagedDelegation, Some("hosted-mcp-client")),
        routing(
            CredentialKind::PairedCapability {
                grant_id: "pc_route".into(),
            },
            None,
        ),
    ] {
        for method in &METHODS {
            assert_eq!(
                credential_route_policy(method, PATH, &context, true),
                RoutePolicy::OwnerOnly,
                "{method}"
            );
            assert_eq!(
                decide(&context, method),
                AuthorizationDecision::Deny(DenialReason::OwnerRequired),
                "{method}"
            );
        }
    }
}

#[test]
fn member_sessions_keep_reaching_the_handler_owner_check() {
    for context in [
        routing(CredentialKind::ManagedUserJwt, None),
        routing(
            CredentialKind::ManagedDelegation,
            Some(crate::authorization::delegation::NODE_LIST_CLIENT_ID),
        ),
    ] {
        for method in &METHODS {
            assert_eq!(
                credential_route_policy(method, PATH, &context, true),
                RoutePolicy::requires([Capability::GatewayRoute]),
                "{method}"
            );
            assert_eq!(decide(&context, method), AuthorizationDecision::Allow);
        }
    }
}
