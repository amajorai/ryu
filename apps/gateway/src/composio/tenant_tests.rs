//! Tenant-scoped Composio user ids and path-safe action/connection slugs.

use super::tenant::{valid_action_slug, valid_connection_id};
use super::{ComposioClient, ComposioTenantScope};
use crate::config::ComposioConfig;
use crate::error::GatewayError;

#[test]
fn managed_orgs_get_distinct_users_and_local_calls_keep_the_configured_entity() {
    let config = ComposioConfig {
        entity_id: "local-user".to_owned(),
        ..Default::default()
    };
    let client = ComposioClient::for_test(
        config,
        reqwest::Client::new(),
        "http://unused.test".to_owned(),
    );
    let alpha = client.entity_for_request(Some("org-alpha"), None).unwrap();
    let beta = client.entity_for_request(Some("org-beta"), None).unwrap();
    assert_ne!(alpha, beta);
    assert_ne!(alpha, "local-user");
    assert_ne!(
        client
            .entity_for_request(Some("org-alpha"), Some("same-user"))
            .unwrap(),
        client
            .entity_for_request(Some("org-beta"), Some("same-user"))
            .unwrap()
    );
    assert_eq!(client.entity_for_request(None, None).unwrap(), "local-user");
    assert_eq!(
        client
            .entity_for_request(None, Some("local-member"))
            .unwrap(),
        "local-member"
    );

    let alpha_scope = ComposioTenantScope::new("org-alpha").unwrap();
    let account_user = alpha_scope.account_user_id("social-account-1").unwrap();
    assert!(alpha_scope.owns_user_id(&account_user, None));
    assert!(!ComposioTenantScope::new("org-beta")
        .unwrap()
        .owns_user_id(&account_user, None));
    assert!(!alpha_scope.owns_user_id("local-user", None));
    assert!(alpha_scope.owns_user_id(&alpha_scope.default_user_id(), None));

    // A member's personal entity is theirs alone.
    let member = alpha_scope.user_id("member-a");
    assert!(alpha_scope.owns_user_id(&member, Some("member-a")));
    assert!(!alpha_scope.owns_user_id(&member, Some("member-b")));
    assert!(!alpha_scope.owns_user_id(&member, None));
    assert!(valid_connection_id("ca_abc-123"));
    assert!(!valid_connection_id("ca_abc/../other"));
    assert!(!valid_connection_id("ca_abc?other=1"));
}

#[test]
fn action_slugs_accept_plain_slugs_and_refuse_path_syntax() {
    assert!(valid_action_slug("GITHUB_CREATE_ISSUE"));
    assert!(valid_action_slug("gmail-send_email2"));
    for slug in [
        "",
        "GITHUB_X/../GMAIL_SEND_EMAIL",
        "GITHUB_X%2f..",
        "GITHUB_X?other=1",
        "GITHUB_X#frag",
        "GITHUB_X\\Y",
        "GITHUB X",
        "..",
    ] {
        assert!(!valid_action_slug(slug), "slug {slug:?} must be refused");
    }
    assert!(!valid_action_slug(&"A".repeat(257)));
}

#[tokio::test]
async fn execute_and_disconnect_refuse_path_syntax_before_any_request() {
    // The base URL is unroutable, so a request that slipped past the check
    // would fail with a different error than `BadRequest`.
    let client = ComposioClient::for_test(
        ComposioConfig {
            api_key: Some("composio-project-test-key".to_owned()),
            ..Default::default()
        },
        reqwest::Client::new(),
        "http://unused.test".to_owned(),
    );
    let execute = client
        .execute_response(
            "GITHUB_X/../GMAIL_SEND_EMAIL",
            serde_json::json!({}),
            "entity",
            None,
            None,
        )
        .await;
    assert!(matches!(execute, Err(GatewayError::BadRequest(_))));
    let disconnect = client.disconnect("ca_abc/../x").await;
    assert!(matches!(disconnect, Err(GatewayError::BadRequest(_))));
}
