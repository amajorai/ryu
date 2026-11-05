//! Node-wide package lifecycle mutations admitted on `gateway:route` alone.
//!
//! [`super::route_policy`] admits `/api/marketplace/packages` and the language
//! pack import on `GatewayRoute` so a managed member reaches the handler's
//! role-based lifecycle ACL. That ACL answers from the caller's organization
//! role, and a scoped credential carries its signer's role with a narrower
//! client scope: a hosted OAuth/MCP client an admin authorized for
//! `gateway:route` must not install, update, enable, disable or uninstall the
//! node's packages through that role. [`super::credential_route_policy`] keeps
//! these mutations for the owner token and a member's own signed-in session.
//!
//! The node onboarding mutations follow the same rule: saving or resetting the
//! onboarding state and the node-wide skill-pack selection gate on
//! `gateway.configure`, and the onboarding profile job (start, cancel,
//! background) gates on the Admin role and can write an organization-wide
//! memory. Every non-read `GatewayRoute`-admitted route whose handler
//! authorizes from the caller's organization role belongs in this table.

use axum::http::Method;

/// Whether a request mutates node-wide packages through a handler whose
/// lifecycle ACL decides from the caller's organization role.
pub(super) fn is_role_gated_lifecycle_mutation(method: &Method, path: &str) -> bool {
    if matches!(*method, Method::GET | Method::HEAD) {
        return false;
    }
    super::path_has_prefix(path, "/api/marketplace/packages")
        || path == "/api/language-packs/import"
        || path == "/api/onboarding/state"
        || path == "/api/onboarding/skills"
        || super::path_has_prefix(path, "/api/onboarding/profile")
}

#[cfg(test)]
mod tests {
    use crate::authorization::{
        AuthorizationContext, AuthorizationDecision, Capability, CapabilitySet, CredentialKind,
        DenialReason, GrantConstraints, Principal, RequestBindings, RoutePolicy,
    };
    use axum::http::Method;

    const MUTATIONS: [(Method, &str); 13] = [
        (Method::POST, "/api/marketplace/packages/install"),
        (Method::POST, "/api/marketplace/packages/update"),
        (Method::POST, "/api/marketplace/packages/plugin/x/enable"),
        (Method::POST, "/api/marketplace/packages/plugin/x/disable"),
        (Method::POST, "/api/marketplace/packages/plugin/x/uninstall"),
        (Method::POST, "/api/language-packs/import"),
        (Method::PUT, "/api/onboarding/state"),
        (Method::DELETE, "/api/onboarding/state"),
        (Method::PUT, "/api/onboarding/skills"),
        (Method::POST, "/api/onboarding/profile/start"),
        (Method::POST, "/api/onboarding/profile/cancel/job-1"),
        (Method::POST, "/api/onboarding/profile/background/job-1"),
        (Method::POST, "/api/onboarding/profile"),
    ];

    fn context(credential: CredentialKind, client_id: Option<&str>) -> AuthorizationContext {
        AuthorizationContext {
            credential,
            principal: Principal::User {
                subject_id: "admin-1".into(),
            },
            capabilities: CapabilitySet::new([Capability::GatewayRoute]),
            constraints: GrantConstraints {
                client_id: client_id.map(str::to_owned),
                ..Default::default()
            },
            issued_at: 0,
            expires_at: None,
        }
    }

    /// The bindings a real request from this credential carries: its own
    /// client id, so the grant's client constraint is satisfied and the
    /// decision comes from the route policy under test.
    fn bindings(context: &AuthorizationContext) -> RequestBindings {
        RequestBindings {
            client_id: context.constraints.client_id.clone(),
            ..Default::default()
        }
    }

    fn policy(method: &Method, path: &str, context: &AuthorizationContext) -> RoutePolicy {
        super::super::credential_route_policy(method, path, context, true)
    }

    #[test]
    fn scoped_clients_cannot_mutate_node_packages_through_their_signers_role() {
        let refused = [
            context(CredentialKind::ManagedDelegation, Some("hosted-mcp-client")),
            context(CredentialKind::HostedOAuth, None),
            context(
                CredentialKind::PairedCapability {
                    grant_id: "grant-1".into(),
                },
                None,
            ),
        ];
        for (method, path) in &MUTATIONS {
            for context in &refused {
                let policy = policy(method, path, context);
                assert_eq!(
                    policy,
                    RoutePolicy::OwnerOnly,
                    "{path} {:?}",
                    context.credential
                );
                assert_eq!(
                    context.authorize(&policy, &bindings(context), 0),
                    AuthorizationDecision::Deny(DenialReason::OwnerRequired),
                    "{path} {:?}",
                    context.credential
                );
            }
        }
    }

    #[test]
    fn member_sessions_still_reach_the_lifecycle_acl() {
        let admitted = [
            context(CredentialKind::ManagedUserJwt, None),
            context(
                CredentialKind::ManagedDelegation,
                Some(crate::authorization::delegation::NODE_LIST_CLIENT_ID),
            ),
        ];
        for (method, path) in &MUTATIONS {
            for context in &admitted {
                let policy = policy(method, path, context);
                assert_eq!(
                    policy,
                    RoutePolicy::requires([Capability::GatewayRoute]),
                    "{path} {:?}",
                    context.credential
                );
                assert_eq!(
                    context.authorize(&policy, &bindings(context), 0),
                    AuthorizationDecision::Allow
                );
            }
        }
    }

    #[test]
    fn scoped_clients_keep_package_reads() {
        let hosted = context(CredentialKind::ManagedDelegation, Some("hosted-mcp-client"));
        for path in [
            "/api/marketplace/packages/installed",
            "/api/language-packs/installed",
            "/api/onboarding/state",
            "/api/onboarding/skills",
            "/api/onboarding/access",
            "/api/onboarding/profile/availability",
            "/api/onboarding/profile/status/job-1",
        ] {
            assert_eq!(
                policy(&Method::GET, path, &hosted),
                RoutePolicy::requires([Capability::GatewayRoute]),
                "{path}"
            );
        }
    }
}
