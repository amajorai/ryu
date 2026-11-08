//! Management HTTP calls refuse bad input and missing credentials before any
//! request leaves the Gateway.

use crate::composio::ComposioClient;
use crate::config::ComposioConfig;
use crate::error::GatewayError;

fn client(api_key: Option<&str>) -> ComposioClient {
    // Unroutable base URL: a request that got past the guards would fail
    // with a different error than the one asserted.
    ComposioClient::for_test(
        ComposioConfig {
            api_key: api_key.map(str::to_owned),
            ..Default::default()
        },
        reqwest::Client::new(),
        "http://unused.test".to_owned(),
    )
}

#[tokio::test]
async fn disconnect_refuses_path_syntax_before_any_request() {
    let result = client(Some("key")).disconnect("ca_abc/../x").await;
    assert!(matches!(result, Err(GatewayError::BadRequest(_))));
}

#[tokio::test]
async fn calls_without_an_api_key_fail_before_any_request() {
    let client = client(None);
    assert!(matches!(
        client.list_tools("gmail").await,
        Err(GatewayError::Internal(_))
    ));
    assert!(matches!(
        client.connect("gmail", "user-1").await,
        Err(GatewayError::Internal(_))
    ));
}
