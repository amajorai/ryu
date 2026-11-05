//! Failed flows carry a stable `error_code` next to their English `error`.

use super::custody_fixtures::fixture;
use super::tests::pending_flow;
use super::*;

async fn hosted_flow(token_base: &str) -> (Arc<McpOAuthManager>, String) {
    let manager = McpOAuthManager::new(crate::IdentityStore::open_in_memory().unwrap(), None, None);
    let flow_id = "coded".to_owned();
    let mut pending = pending_flow(&flow_id);
    pending.token_endpoint = format!("{token_base}/token");
    manager.flows.write().await.insert(flow_id.clone(), pending);
    (manager, flow_id)
}

async fn callback(
    manager: &Arc<McpOAuthManager>,
    issuer: &str,
    error: Option<&str>,
) -> Result<String> {
    manager
        .complete_hosted_callback(
            Some("fixture-code".into()),
            Some("one-time-state".into()),
            Some(issuer.into()),
            error.map(str::to_owned),
        )
        .await
}

async fn error_code(manager: &McpOAuthManager, flow_id: &str) -> Option<FlowErrorCode> {
    manager.flow("user", flow_id).await.unwrap().error_code
}

#[tokio::test]
async fn wrong_codes_are_code_mismatch_until_the_last_attempt_fails_the_flow() {
    let (base, _, task) = fixture().await;
    let (manager, flow_id) = hosted_flow(&base).await;
    callback(&manager, "https://auth.example", None)
        .await
        .unwrap();
    let mut codes = Vec::new();
    for _ in 0..5 {
        let error = manager
            .confirm_hosted_flow("user", &flow_id, "ZZZZ-ZZZZ")
            .await
            .unwrap_err();
        codes.push(FlowErrorCode::classify(&error.to_string()));
    }
    assert_eq!(codes[0], FlowErrorCode::CodeMismatch);
    assert_eq!(codes[4], FlowErrorCode::TooManyAttempts);
    let flow = manager.flow("user", &flow_id).await.unwrap();
    assert_eq!(flow.status, FlowState::Failed);
    assert_eq!(
        flow.error.as_deref(),
        Some("Too many incorrect confirmation codes")
    );
    assert_eq!(flow.error_code, Some(FlowErrorCode::TooManyAttempts));
    // A failed flow refuses further codes as no longer awaiting one.
    let late = manager
        .confirm_hosted_flow("user", &flow_id, "ZZZZ-ZZZZ")
        .await
        .unwrap_err();
    assert_eq!(
        FlowErrorCode::classify(&late.to_string()),
        FlowErrorCode::NotAwaiting
    );
    task.abort();
}

#[tokio::test]
async fn an_expired_flow_is_coded_expired() {
    let (manager, flow_id) = hosted_flow("http://127.0.0.1:9").await;
    manager.expire_flow(&flow_id).await;
    let flow = manager.flow("user", &flow_id).await.unwrap();
    assert_eq!(flow.error.as_deref(), Some("OAuth flow expired"));
    assert_eq!(flow.error_code, Some(FlowErrorCode::Expired));
}

#[tokio::test]
async fn callback_failures_are_coded() {
    let (manager, flow_id) = hosted_flow("http://127.0.0.1:9").await;
    assert!(callback(&manager, "https://evil.example", None)
        .await
        .is_err());
    assert_eq!(
        error_code(&manager, &flow_id).await,
        Some(FlowErrorCode::IssuerMismatch)
    );

    let (manager, flow_id) = hosted_flow("http://127.0.0.1:9").await;
    assert!(
        callback(&manager, "https://auth.example", Some("access_denied"))
            .await
            .is_err()
    );
    assert_eq!(
        error_code(&manager, &flow_id).await,
        Some(FlowErrorCode::Protocol)
    );
}

#[test]
fn a_flow_view_serializes_its_error_code_and_old_views_still_parse() {
    let mut view = pending_flow("f").view;
    view.error_code = Some(FlowErrorCode::CodeMismatch);
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["error_code"], "code_mismatch");
    let mut legacy = json.clone();
    legacy.as_object_mut().unwrap().remove("error_code");
    let parsed: FlowView = serde_json::from_value(legacy).unwrap();
    assert_eq!(parsed.error_code, None);
}
