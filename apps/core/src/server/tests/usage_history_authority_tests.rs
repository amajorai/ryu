#[test]
fn global_credentials_and_privileged_replays_require_owner_authority() {
    use crate::authorization::RoutePolicy;
    for path in [
        "/api/agents/a/native-accounts",
        "/api/agents/a/native-accounts/victim/disconnect",
        "/api/agents/a/accounts",
        "/api/agents/a/accounts/switch",
        "/api/agents/a/accounts/logout",
        "/api/agents/a/optimizations/analyze",
        "/api/agents/a/composio/connections",
        "/api/agents/a/composio/connections/initiate",
        "/api/agents/a/composio/connections/ca_1",
    ] {
        for method in [
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::DELETE,
        ] {
            assert_eq!(
                crate::server::route_policy(&method, path),
                RoutePolicy::OwnerOnly
            );
        }
    }
    assert_eq!(
        crate::server::route_policy(&axum::http::Method::GET, "/api/agents/a"),
        RoutePolicy::requires([crate::authorization::Capability::AgentsRead])
    );
}
#[test]
fn history_and_provider_reports_require_node_owner() {
    for (method, path) in [
        (axum::http::Method::GET, "/api/usage/history"),
        (axum::http::Method::POST, "/api/usage/history/import"),
        (axum::http::Method::POST, "/api/usage/history/account-sync"),
        (axum::http::Method::PUT, "/api/usage/history/tracking"),
        (axum::http::Method::GET, "/api/usage/subscriptions"),
        (
            axum::http::Method::GET,
            "/api/usage/subscriptions/claude-pro-max/reading",
        ),
    ] {
        assert!(matches!(
            crate::server::route_policy(&method, path),
            crate::authorization::RoutePolicy::OwnerOnly
        ));
    }
}
