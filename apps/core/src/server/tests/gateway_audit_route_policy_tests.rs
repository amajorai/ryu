use crate::authorization::RoutePolicy;
use crate::server::route_policy;
use axum::http::Method;

#[test]
fn gateway_audit_reads_are_owner_only() {
    assert_eq!(
        route_policy(&Method::GET, "/api/gateway/audit"),
        RoutePolicy::OwnerOnly
    );
    assert_eq!(
        route_policy(&Method::GET, "/api/gateway/audit/usage"),
        RoutePolicy::OwnerOnly
    );
}

fn routing_context(
    credential: crate::authorization::CredentialKind,
) -> crate::authorization::AuthorizationContext {
    crate::authorization::AuthorizationContext {
        credential,
        principal: crate::authorization::Principal::User {
            subject_id: "org-admin".into(),
        },
        capabilities: crate::authorization::CapabilitySet::new([
            crate::authorization::Capability::GatewayRoute,
        ]),
        constraints: crate::authorization::GrantConstraints::default(),
        issued_at: 0,
        expires_at: None,
    }
}

fn admitted(context: &crate::authorization::AuthorizationContext, path: &str) -> bool {
    let policy = crate::server::credential_route_policy(&Method::GET, path, context, true);
    context
        .authorize(
            &policy,
            &crate::authorization::RequestBindings::default(),
            1,
        )
        .is_allowed()
}

#[test]
fn scoped_route_credentials_cannot_read_live_traffic_or_budget_spend() {
    use crate::authorization::CredentialKind;
    let operator_reads = [
        "/api/gateway/traffic",
        "/api/gateway/budget/spend",
        "/api/gateway/budget",
    ];
    // A delegation signed for an admin, scoped to `gateway:route` only,
    // keeps routing but never inherits the admin's operator reads.
    for credential in [
        CredentialKind::ManagedDelegation,
        CredentialKind::PairedCapability {
            grant_id: "pc_route".into(),
        },
        CredentialKind::HostedOAuth,
    ] {
        let context = routing_context(credential);
        for path in operator_reads {
            assert_eq!(
                context.authorize(
                    &crate::server::credential_route_policy(&Method::GET, path, &context, true),
                    &crate::authorization::RequestBindings::default(),
                    1,
                ),
                crate::authorization::AuthorizationDecision::Deny(
                    crate::authorization::DenialReason::OwnerRequired
                ),
                "{path}"
            );
        }
        assert!(admitted(&context, "/api/gateway/config"));
    }
    // A member's own Better Auth session and the owner token still reach
    // the handler's `audit.view` / `gateway.configure` role gate.
    for context in [
        routing_context(CredentialKind::ManagedUserJwt),
        crate::authorization::AuthorizationContext::owner(0),
    ] {
        for path in operator_reads {
            assert!(admitted(&context, path), "{path}");
        }
    }
}

fn delegation_for_client(
    client_id: &str,
    capabilities: crate::authorization::CapabilitySet,
) -> (
    crate::authorization::AuthorizationContext,
    crate::authorization::RequestBindings,
) {
    let mut context = routing_context(crate::authorization::CredentialKind::ManagedDelegation);
    context.capabilities = capabilities;
    context.constraints.client_id = Some(client_id.to_owned());
    let bindings = crate::authorization::RequestBindings {
        client_id: Some(client_id.to_owned()),
        ..crate::authorization::RequestBindings::default()
    };
    (context, bindings)
}

#[test]
fn member_session_node_list_delegation_reaches_the_operator_role_gate() {
    use crate::authorization::{AuthorizationDecision, Capability, CapabilitySet, DenialReason};
    let decision = |client_id: &str, capabilities: CapabilitySet, path: &str| {
        let (context, bindings) = delegation_for_client(client_id, capabilities);
        context.authorize(
            &crate::server::credential_route_policy(&Method::GET, path, &context, true),
            &bindings,
            1,
        )
    };
    for path in ["/api/gateway/traffic", "/api/gateway/budget/spend"] {
        // Desktop and the CLI reach a managed node with the node-list
        // delegation minted for the member's own session; the handler's
        // `audit.view` / `gateway.configure` role gate then decides.
        assert_eq!(
            decision(
                crate::authorization::delegation::NODE_LIST_CLIENT_ID,
                CapabilitySet::new([Capability::GatewayRoute]),
                path,
            ),
            AuthorizationDecision::Allow,
            "{path}"
        );
        // The sandbox-status variant of that delegation cannot route, so it
        // still misses the route's own `gateway:route` requirement.
        assert_eq!(
            decision(
                crate::authorization::delegation::NODE_LIST_CLIENT_ID,
                CapabilitySet::new([Capability::NodeSandboxRead]),
                path,
            ),
            AuthorizationDecision::Deny(DenialReason::MissingCapability),
            "{path}"
        );
        // A hosted OAuth/MCP client's delegation keeps routing but never
        // inherits its signer's operator reads.
        assert_eq!(
            decision(
                "hosted-mcp-client",
                CapabilitySet::new([Capability::GatewayRoute]),
                path,
            ),
            AuthorizationDecision::Deny(DenialReason::OwnerRequired),
            "{path}"
        );
    }
    assert_eq!(
        decision(
            "hosted-mcp-client",
            CapabilitySet::new([Capability::GatewayRoute]),
            "/api/gateway/config",
        ),
        AuthorizationDecision::Allow
    );
}

#[test]
fn batch_results_and_main_thread_creation_require_owner() {
    for path in ["/api/gateway/batches", "/api/gateway/batches/batch_example"] {
        assert_eq!(route_policy(&Method::GET, path), RoutePolicy::OwnerOnly);
    }
    assert_eq!(
        route_policy(&Method::POST, "/api/hierarchy/main-threads"),
        RoutePolicy::OwnerOnly
    );
}

#[test]
fn phone_call_data_and_controls_are_owner_only() {
    assert_eq!(
        route_policy(&Method::GET, "/api/gateway/phone-calls"),
        RoutePolicy::OwnerOnly
    );
    assert_eq!(
        route_policy(&Method::POST, "/api/gateway/phone-calls"),
        RoutePolicy::OwnerOnly
    );
    assert_eq!(
        route_policy(
            &Method::POST,
            "/api/gateway/phone-calls/CA1234567890abcdef1234567890abcdef/control"
        ),
        RoutePolicy::OwnerOnly
    );
}

#[test]
fn vault_mutation_requires_separate_write_consent() {
    assert_eq!(
        route_policy(&Method::GET, "/api/vault/secrets"),
        RoutePolicy::requires([crate::authorization::Capability::GatewayRoute])
    );
    for method in [Method::PUT, Method::DELETE] {
        assert_eq!(
            route_policy(&method, "/api/vault/secrets/EXAMPLE_KEY"),
            RoutePolicy::requires([crate::authorization::Capability::VaultWrite])
        );
    }
    // Metadata reads stay routable; decrypting reads and KV v2 mutations
    // need vault-write consent.
    for path in [
        "/api/vault/secrets/EXAMPLE_KEY/metadata",
        "/api/vault/transit/keys",
        "/api/vault/transit/wrapping-key",
        "/api/vault/static/roles/db",
        "/api/vault/totp/keys/github",
        "/api/vault/sys/password-policies/strong",
        "/api/vault/items/login",
        "/api/vault/cards/approvals",
    ] {
        assert_eq!(
            route_policy(&Method::GET, path),
            RoutePolicy::requires([crate::authorization::Capability::GatewayRoute]),
            "{path}"
        );
    }
    for (method, path) in [
        (Method::GET, "/api/vault/secrets/EXAMPLE_KEY/subkeys"),
        (Method::GET, "/api/vault/transit/export/encryption-key/app"),
        (Method::GET, "/api/vault/transit/export/signing-key/app/2"),
        (Method::GET, "/api/vault/transit/backup/app"),
        (Method::GET, "/api/vault/static/creds/db"),
        (Method::GET, "/api/vault/totp/code/github"),
        (
            Method::GET,
            "/api/vault/sys/password-policies/strong/generate",
        ),
        (Method::POST, "/api/vault/secrets/EXAMPLE_KEY/reveal"),
        (Method::PATCH, "/api/vault/secrets/EXAMPLE_KEY/metadata"),
        (Method::PATCH, "/api/vault/secrets/EXAMPLE_KEY/data"),
        (
            Method::POST,
            "/api/vault/secrets/EXAMPLE_KEY/versions/delete",
        ),
        (
            Method::POST,
            "/api/vault/secrets/EXAMPLE_KEY/versions/undelete",
        ),
        (Method::POST, "/api/vault/items/visa/fill"),
        (Method::POST, "/api/vault/cards/approvals/cap_1/approve"),
    ] {
        assert_eq!(
            route_policy(&method, path),
            RoutePolicy::requires([crate::authorization::Capability::VaultWrite]),
            "{method} {path}"
        );
    }
}

#[test]
fn my_usage_is_reachable_by_members_and_pinned_to_the_caller() {
    assert_eq!(
        route_policy(&Method::GET, "/api/usage/me"),
        RoutePolicy::requires([crate::authorization::Capability::GatewayRoute])
    );
    let parts = crate::server::my_usage_query_parts(
        "user 1",
        &crate::server::MyUsageQueryParams {
            limit: Some(20),
            from: None,
            until: None,
        },
    );
    assert_eq!(parts[0], "user_id=user%201");
    assert!(parts.contains(&"limit=20".to_owned()));
}

#[test]
fn sandbox_visibility_is_read_scoped_but_creation_stays_owner_only() {
    assert_eq!(
        route_policy(&Method::GET, "/api/sandboxes"),
        RoutePolicy::requires([crate::authorization::Capability::NodeSandboxRead])
    );
    assert_eq!(
        route_policy(&Method::POST, "/api/sandboxes"),
        RoutePolicy::OwnerOnly
    );
}

#[test]
fn cloud_task_routes_stay_gateway_routed_with_handler_level_execution_checks() {
    for (method, path) in [
        (Method::GET, "/api/cloud-tasks/x"),
        (Method::POST, "/api/cloud-tasks/x/prompt"),
        (Method::GET, "/api/cloud-tasks/x/diff"),
        (Method::POST, "/api/cloud-tasks/x/finish"),
    ] {
        assert_eq!(
            route_policy(&method, path),
            RoutePolicy::requires([crate::authorization::Capability::GatewayRoute]),
            "{method} {path}"
        );
    }
}

#[test]
fn node_onboarding_state_uses_gateway_route_for_handler_level_permission_checks() {
    assert_eq!(
        route_policy(&Method::GET, "/api/onboarding/state"),
        RoutePolicy::requires([crate::authorization::Capability::GatewayRoute])
    );
    assert_eq!(
        route_policy(&Method::PUT, "/api/onboarding/state"),
        RoutePolicy::requires([crate::authorization::Capability::GatewayRoute])
    );
    assert_eq!(
        route_policy(&Method::DELETE, "/api/onboarding/state"),
        RoutePolicy::requires([crate::authorization::Capability::GatewayRoute])
    );
    assert_eq!(
        route_policy(&Method::GET, "/api/onboarding/skills"),
        RoutePolicy::requires([crate::authorization::Capability::GatewayRoute])
    );
    assert_eq!(
        route_policy(&Method::PUT, "/api/onboarding/skills"),
        RoutePolicy::requires([crate::authorization::Capability::GatewayRoute])
    );
}

#[test]
fn installed_language_packs_are_readable_with_gateway_route() {
    assert_eq!(
        route_policy(&Method::GET, "/api/language-packs/installed"),
        RoutePolicy::requires([crate::authorization::Capability::GatewayRoute])
    );
    assert_eq!(
        route_policy(&Method::POST, "/api/language-packs/import"),
        RoutePolicy::requires([crate::authorization::Capability::GatewayRoute])
    );
}

#[test]
fn onboarding_profile_and_package_routes_reach_handler_level_checks() {
    let gateway_route = RoutePolicy::requires([crate::authorization::Capability::GatewayRoute]);
    assert_eq!(
        route_policy(&Method::GET, "/api/onboarding/access"),
        gateway_route
    );
    assert_eq!(
        route_policy(&Method::GET, "/api/onboarding/profile/availability"),
        gateway_route
    );
    assert_eq!(
        route_policy(&Method::POST, "/api/onboarding/profile/start"),
        gateway_route
    );
    assert_eq!(
        route_policy(&Method::GET, "/api/marketplace/packages/installed"),
        gateway_route
    );
    assert_eq!(
        route_policy(
            &Method::POST,
            "/api/marketplace/packages/language_pack/id/enable"
        ),
        gateway_route
    );
}

#[test]
fn personal_onboarding_preference_reaches_its_owner_check() {
    assert_eq!(
        route_policy(&Method::GET, "/api/preferences/user-personalization"),
        RoutePolicy::requires([crate::authorization::Capability::GatewayRoute])
    );
    assert_eq!(
        route_policy(&Method::PUT, "/api/preferences/user-personalization"),
        RoutePolicy::requires([crate::authorization::Capability::GatewayRoute])
    );
}

#[test]
fn annotation_queue_routes_use_agent_capabilities_before_handler_acl_checks() {
    assert_eq!(
        route_policy(&Method::GET, "/api/annotation-queues"),
        RoutePolicy::requires([crate::authorization::Capability::AgentsRead])
    );
    assert_eq!(
        route_policy(&Method::GET, "/api/annotation-queues/q/items"),
        RoutePolicy::requires([crate::authorization::Capability::AgentsRead])
    );
    for path in [
        "/api/annotation-queues/q/next",
        "/api/annotation-queues/q/items/i/submit",
        "/api/annotation-queues/q/export",
    ] {
        assert_eq!(
            route_policy(&Method::POST, path),
            RoutePolicy::requires([crate::authorization::Capability::AgentsManage])
        );
    }
    assert_eq!(
        route_policy(&Method::DELETE, "/api/annotation-queues/q"),
        RoutePolicy::requires([crate::authorization::Capability::AgentsManage])
    );
}

#[test]
fn prompt_suite_routes_use_agent_capabilities_before_handler_acl_checks() {
    assert_eq!(
        route_policy(&Method::GET, "/api/prompt-suites"),
        RoutePolicy::requires([crate::authorization::Capability::AgentsRead])
    );
    assert_eq!(
        route_policy(&Method::GET, "/api/prompt-suites/suite/runs"),
        RoutePolicy::requires([crate::authorization::Capability::AgentsRead])
    );
    assert_eq!(
        route_policy(&Method::POST, "/api/prompt-suites/suite/runs"),
        RoutePolicy::requires([crate::authorization::Capability::AgentsManage])
    );
    assert_eq!(
        route_policy(&Method::DELETE, "/api/prompt-suites/suite/runs/run"),
        RoutePolicy::requires([crate::authorization::Capability::AgentsManage])
    );
}
