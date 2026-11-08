//! OAuth binding validation, status, and classification.

use super::*;
use crate::vault::broker::services::{test_service, ServiceAuth};

fn binding(resource: &str, scopes: &[&str]) -> OAuthBinding {
    OAuthBinding {
        plugin: "@ryu/linear".into(),
        server: "linear".into(),
        profile: "personal".into(),
        resource: resource.into(),
        client_id: None,
        scopes: scopes.iter().map(|scope| (*scope).to_owned()).collect(),
    }
}

fn record(status: McpOAuthConnectionStatus, scopes: &[&str]) -> McpOAuthConnectionRecord {
    McpOAuthConnectionRecord {
        id: "c1".into(),
        owner_user_id: "local".into(),
        profile_id: "personal".into(),
        plugin_id: "@ryu/linear".into(),
        server_name: "linear".into(),
        resource_uri: "https://mcp.linear.app".into(),
        issuer: "https://linear.app".into(),
        status,
        account_label: None,
        scopes: scopes.iter().map(|scope| (*scope).to_owned()).collect(),
        expires_at: Some(42),
        encrypted_state: None,
        created_at: 0,
        updated_at: 0,
    }
}

#[test]
fn oauth_auth_round_trips_as_the_oauth_kind() {
    let auth: ServiceAuth = serde_json::from_value(serde_json::json!({
        "type": "oauth",
        "plugin": "@ryu/linear",
        "server": "linear",
        "resource": "https://mcp.linear.app/mcp",
        "scopes": ["read", "write"],
    }))
    .unwrap();
    let ServiceAuth::OAuth(parsed) = &auth else {
        panic!("not an oauth rule: {auth:?}");
    };
    assert_eq!(parsed.profile, "personal");
    assert_eq!(auth.kind(), "oauth");
    assert!(auth.refs().is_empty());
    assert_eq!(auth.header_names(), vec!["authorization".to_owned()]);
    let value = serde_json::to_value(&auth).unwrap();
    assert_eq!(value["type"], "oauth");
    assert_eq!(value["scopes"], serde_json::json!(["read", "write"]));
}

#[test]
fn bindings_reject_unsafe_resources_ids_and_scopes() {
    assert!(binding("https://mcp.linear.app/mcp", &["read"])
        .validate()
        .is_ok());
    assert!(binding("http://127.0.0.1:9/mcp", &[]).validate().is_ok());
    for bad in [
        "http://mcp.linear.app/mcp",
        "https://user:pw@mcp.linear.app/mcp",
        "https://mcp.linear.app/mcp#frag",
        "mcp.linear.app",
    ] {
        assert!(binding(bad, &[]).validate().is_err(), "{bad}");
    }
    assert!(binding("https://a.example/mcp", &["has space"])
        .validate()
        .is_err());
    assert!(binding("https://a.example/mcp", &["quo\"te"])
        .validate()
        .is_err());
    let too_many: Vec<String> = (0..=MAX_SCOPES).map(|n| format!("s{n}")).collect();
    let mut many = binding("https://a.example/mcp", &[]);
    many.scopes = too_many;
    assert!(many.validate().is_err());
    let mut blank = binding("https://a.example/mcp", &[]);
    blank.plugin = String::new();
    assert!(blank.validate().is_err());
}

#[test]
fn services_only_carry_the_token_to_the_resource_host() {
    let with = |host: &str, port: Option<u16>, resource: &str, insecure: bool| {
        let mut input = test_service("lin", host, port, "/");
        input.auth = ServiceAuth::OAuth(binding(resource, &[]));
        input.allow_insecure_http = insecure;
        input.normalize()
    };
    assert!(with("mcp.linear.app", None, "https://mcp.linear.app/mcp", false).is_ok());
    assert!(with(
        "MCP.linear.app",
        Some(443),
        "https://mcp.linear.app/mcp",
        false
    )
    .is_ok());
    assert!(with("127.0.0.1", Some(9), "http://127.0.0.1:9/mcp", true).is_ok());
    // Another host, a wildcard, the wrong port, or plain http elsewhere.
    assert!(with("evil.example", None, "https://mcp.linear.app/mcp", false).is_err());
    assert!(with("*.linear.app", None, "https://mcp.linear.app/mcp", false).is_err());
    assert!(with(
        "mcp.linear.app",
        Some(8443),
        "https://mcp.linear.app/mcp",
        false
    )
    .is_err());
    assert!(with("mcp.linear.app", None, "https://mcp.linear.app/mcp", true).is_err());
}

#[test]
fn status_reports_missing_scopes_and_reconnects() {
    let wants = binding("https://mcp.linear.app/mcp", &["write", "read", "write"]);
    assert_eq!(
        status_from_record(&wants, None).state,
        OAuthState::NeedsConnect
    );
    assert_eq!(
        status_from_record(
            &wants,
            Some(&record(
                McpOAuthConnectionStatus::ReauthRequired,
                &["read", "write"]
            ))
        )
        .state,
        OAuthState::ReauthRequired
    );
    let partial = status_from_record(
        &wants,
        Some(&record(McpOAuthConnectionStatus::Connected, &["read"])),
    );
    assert_eq!(partial.state, OAuthState::NeedsScopes);
    assert_eq!(partial.missing_scopes, vec!["write".to_owned()]);
    let json = serde_json::to_value(&partial).unwrap();
    assert_eq!(json["state"], "needs_scopes");
    assert_eq!(json["missingScopes"], serde_json::json!(["write"]));
    let full = status_from_record(
        &wants,
        Some(&record(
            McpOAuthConnectionStatus::Connected,
            &["read", "write", "admin"],
        )),
    );
    assert_eq!(full.state, OAuthState::Connected);
    assert_eq!(full.expires_at, Some(42));
    assert!(serde_json::to_value(&full)
        .unwrap()
        .get("missingScopes")
        .is_none());
}

#[test]
fn methods_map_to_connection_actions() {
    assert_eq!(action_for_method(&Method::GET), ConnectionAction::Read);
    assert_eq!(action_for_method(&Method::HEAD), ConnectionAction::Read);
    assert_eq!(action_for_method(&Method::POST), ConnectionAction::Write);
    assert_eq!(action_for_method(&Method::PATCH), ConnectionAction::Write);
    assert_eq!(action_for_method(&Method::DELETE), ConnectionAction::Delete);
    assert_eq!(
        action_for_method(&Method::from_bytes(b"PURGE").unwrap()),
        ConnectionAction::Unknown
    );
}

#[test]
fn token_failures_are_classified_without_their_text() {
    let code = |message: &str| token_failure(&anyhow::anyhow!("{message}"));
    let (status, name, text) = code("MCP authentication expired; reconnect required");
    assert_eq!(status, StatusCode::PRECONDITION_REQUIRED);
    assert_eq!(name, "oauth_reconnect_required");
    assert!(!text.contains("expired"));
    assert_eq!(
        code("MCP connection access level denied this action").1,
        "oauth_access_denied"
    );
    assert_eq!(
        code("Passport remote mode forbids local OAuth credential access").1,
        "oauth_unavailable"
    );
    let (status, name, text) = code("OAuth refresh failed: server_error at https://x/?t=abc");
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(name, "oauth_token_failed");
    assert!(!text.contains("abc"));
}

#[test]
fn sessions_use_their_minters_connection() {
    assert_eq!(owner_for_session(Some("alice")).unwrap(), "alice");
}

struct FixedStatus(OAuthState);

#[async_trait::async_trait]
impl OAuthTokens for FixedStatus {
    async fn status(&self, _owner: &str, _binding: &OAuthBinding) -> OAuthStatus {
        OAuthStatus::of(self.0)
    }

    async fn access_token(
        &self,
        _owner: &str,
        _binding: &OAuthBinding,
        _action: ConnectionAction,
        _session_id: &str,
        _force_refresh: bool,
    ) -> Result<String> {
        bail!("not used")
    }
}

#[tokio::test]
async fn statuses_cover_only_oauth_services_and_need_an_owner() {
    use crate::vault::broker::services::BrokerService;
    let stored = |input| BrokerService {
        input,
        created_at: 0,
        updated_at: 0,
    };
    let mut oauth = test_service("lin", "mcp.linear.app", None, "/");
    oauth.auth = ServiceAuth::OAuth(binding("https://mcp.linear.app/mcp", &[]));
    let services = vec![
        stored(oauth),
        stored(test_service("plain", "api.example.com", None, "/")),
    ];
    let source = FixedStatus(OAuthState::Connected);
    let known = statuses(&source, Some("local"), &services).await;
    assert_eq!(known.len(), 1);
    assert_eq!(known["lin"].state, OAuthState::Connected);
    let unknown = statuses(&source, None, &services).await;
    assert_eq!(unknown["lin"].state, OAuthState::Unavailable);
}
