//! Scoped credentials must not reach the vault manager's operator reads
//! (audit trail, chain verification, event stream, policies) through their
//! signer's `gateway.configure` role.

use crate::authorization::{
    AuthorizationContext, AuthorizationDecision, Capability, CapabilitySet, CredentialKind,
    DenialReason, RequestBindings,
};
use axum::http::Method;

const OPERATOR_READS: [&str; 8] = [
    "/api/vault/audit",
    "/api/vault/audit/verify",
    "/api/vault/audit/devices",
    "/api/vault/events",
    "/api/vault/policies",
    "/api/vault/broker/sessions",
    "/api/vault/sys/seal-provider",
    "/api/vault/sys/rekey",
];

fn context_for(
    credential: CredentialKind,
    client_id: Option<&str>,
) -> (AuthorizationContext, RequestBindings) {
    let mut context = AuthorizationContext {
        credential,
        principal: crate::authorization::Principal::User {
            subject_id: "org-admin".into(),
        },
        capabilities: CapabilitySet::new([Capability::GatewayRoute]),
        constraints: crate::authorization::GrantConstraints::default(),
        issued_at: 0,
        expires_at: None,
    };
    context.constraints.client_id = client_id.map(str::to_owned);
    let bindings = RequestBindings {
        client_id: client_id.map(str::to_owned),
        ..RequestBindings::default()
    };
    (context, bindings)
}

fn decide(
    (context, bindings): &(AuthorizationContext, RequestBindings),
    method: &Method,
    path: &str,
) -> AuthorizationDecision {
    let policy = crate::server::credential_route_policy(method, path, context, true);
    context.authorize(&policy, bindings, 1)
}

#[test]
fn hosted_client_route_delegation_cannot_read_vault_operator_data() {
    let scoped = [
        context_for(CredentialKind::ManagedDelegation, Some("hosted-mcp-client")),
        context_for(CredentialKind::HostedOAuth, None),
        context_for(
            CredentialKind::PairedCapability {
                grant_id: "pc_route".into(),
            },
            None,
        ),
    ];
    for credential in &scoped {
        for path in OPERATOR_READS {
            for method in [Method::GET, Method::HEAD] {
                assert_eq!(
                    decide(credential, &method, path),
                    AuthorizationDecision::Deny(DenialReason::OwnerRequired),
                    "{method} {path}"
                );
            }
        }
        // Ordinary metadata reads stay routable, so the fix does not over-block.
        for path in [
            "/api/vault/secrets",
            "/api/vault/sys/status",
            "/api/vault/folders",
        ] {
            assert_eq!(
                decide(credential, &Method::GET, path),
                AuthorizationDecision::Allow,
                "{path}"
            );
        }
    }
}

#[test]
fn member_sessions_and_owner_still_reach_the_vault_role_gate() {
    let node_list = Some(crate::authorization::delegation::NODE_LIST_CLIENT_ID);
    let owner = AuthorizationContext::owner(0);
    let reaching = [
        context_for(CredentialKind::ManagedUserJwt, None),
        context_for(CredentialKind::ManagedDelegation, node_list),
        (owner, RequestBindings::default()),
    ];
    for credential in &reaching {
        for path in OPERATOR_READS {
            assert_eq!(
                decide(credential, &Method::GET, path),
                AuthorizationDecision::Allow,
                "{path}"
            );
        }
    }
}

#[test]
fn vault_operator_read_paths_are_exact() {
    use crate::server::is_vault_operator_read_path;
    for path in OPERATOR_READS {
        assert!(is_vault_operator_read_path(path), "{path}");
    }
    for path in [
        "/api/vault/auditor",
        "/api/vault/agent/events",
        "/api/vault/policies/admins",
        "/api/vault/secrets",
        "/api/vault/sys/status",
    ] {
        assert!(!is_vault_operator_read_path(path), "{path}");
    }
}
