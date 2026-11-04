//! A hosted callback alone never stores tokens: only the initiating owner,
//! with the code the callback page showed, commits the connection.

use super::custody_fixtures::fixture;
use super::tests::pending_flow;
use super::*;

const ISSUER: &str = "https://auth.example";

/// A hosted flow started by owner `b`, whose token endpoint is the fixture.
async fn hosted_flow_for_b(base: &str) -> (Arc<McpOAuthManager>, String) {
    let manager = McpOAuthManager::new(crate::IdentityStore::open_in_memory().unwrap(), None, None);
    let flow_id = "hosted-for-b".to_owned();
    let mut pending = pending_flow(&flow_id);
    pending.owner_user_id = "b".into();
    pending.token_endpoint = format!("{base}/token");
    manager.flows.write().await.insert(flow_id.clone(), pending);
    (manager, flow_id)
}

async fn stored_access_token(manager: &McpOAuthManager, owner: &str) -> Option<String> {
    let connection = manager
        .store
        .find_mcp_oauth_connection(owner, "personal", "com.example.mail", "mail")
        .await
        .unwrap()?;
    Some(
        open_bundle(&manager.store, &connection)
            .await
            .unwrap()
            .access_token,
    )
}

async fn complete(manager: &Arc<McpOAuthManager>) -> Result<String> {
    manager
        .complete_hosted_callback(
            Some("fixture-code".into()),
            Some("one-time-state".into()),
            Some(ISSUER.into()),
            None,
        )
        .await
}

#[tokio::test]
async fn hosted_callback_holds_tokens_until_the_initiating_owner_confirms() {
    let (base, _, task) = fixture().await;
    let (manager, flow_id) = hosted_flow_for_b(&base).await;

    let code = complete(&manager)
        .await
        .expect("the code exchange succeeds");
    assert_eq!(code.len(), 9, "{code}");
    assert_eq!(code.as_bytes()[4], b'-', "{code}");
    // The public callback alone stores nothing.
    assert_eq!(stored_access_token(&manager, "b").await, None);
    let flow = manager.flow("b", &flow_id).await.unwrap();
    assert_eq!(flow.status, FlowState::AwaitingConfirmation);

    // Another user on the node cannot confirm, even with the shown code.
    assert!(manager
        .confirm_hosted_flow("a", &flow_id, &code)
        .await
        .is_err());
    assert_eq!(stored_access_token(&manager, "a").await, None);
    assert_eq!(stored_access_token(&manager, "b").await, None);

    // The owner with a wrong code is refused and the flow stays held.
    assert!(manager
        .confirm_hosted_flow("b", &flow_id, "AAAA-AAAA")
        .await
        .is_err());
    assert_eq!(
        manager.flow("b", &flow_id).await.unwrap().status,
        FlowState::AwaitingConfirmation
    );

    // The owner with the shown code (case and separators ignored) connects.
    let typed = code.replace('-', " ").to_ascii_lowercase();
    manager
        .confirm_hosted_flow("b", &flow_id, &typed)
        .await
        .expect("the owner's confirmation commits the connection");
    assert_eq!(
        stored_access_token(&manager, "b").await.as_deref(),
        Some("fixture-fresh")
    );
    let flow = manager.flow("b", &flow_id).await.unwrap();
    assert_eq!(flow.status, FlowState::Connected);
    // The code is single use.
    assert!(manager
        .confirm_hosted_flow("b", &flow_id, &code)
        .await
        .is_err());
    task.abort();
}

#[tokio::test]
async fn an_unconfirmed_hosted_callback_never_replaces_an_existing_binding() {
    let (base, _, task) = fixture().await;
    let (manager, flow_id) = hosted_flow_for_b(&base).await;
    let original = TokenBundle {
        static_headers_hash: crate::mcp_transport::default_configuration_hash(),
        access_token: "b-own-account".into(),
        refresh_token: None,
        id_token: None,
        token_type: "Bearer".into(),
        client_id: "client".into(),
        client_secret: None,
        token_endpoint: format!("{base}/token"),
        revocation_endpoint: None,
        issuer: ISSUER.into(),
        resource: "https://mcp.example".into(),
        mcp_server_url: "https://mcp.example/mcp".into(),
        declared_client_id: None,
    };
    manager
        .store
        .upsert_mcp_oauth_connection(
            "b",
            "personal",
            "com.example.mail",
            "mail",
            "https://mcp.example",
            ISSUER,
            None,
            &[],
            None,
            &SecretState::new(serde_json::to_string(&original).unwrap()),
        )
        .await
        .unwrap();

    // Someone else's browser completes b's leaked authorization URL.
    let code = complete(&manager).await.unwrap();
    assert_eq!(
        stored_access_token(&manager, "b").await.as_deref(),
        Some("b-own-account")
    );

    // Nobody confirms before the confirmation window closes.
    manager
        .flows
        .write()
        .await
        .get_mut(&flow_id)
        .unwrap()
        .view
        .expires_at = chrono::Utc::now().timestamp();
    manager.expire_flow(&flow_id).await;
    let flow = manager.flow("b", &flow_id).await.unwrap();
    assert_eq!(flow.status, FlowState::Failed);
    assert!(manager.flows.read().await[&flow_id].held.is_none());
    assert!(manager
        .confirm_hosted_flow("b", &flow_id, &code)
        .await
        .is_err());
    assert_eq!(
        stored_access_token(&manager, "b").await.as_deref(),
        Some("b-own-account")
    );
    task.abort();
}

#[tokio::test]
async fn repeated_wrong_codes_fail_the_flow_and_discard_the_tokens() {
    let (base, _, task) = fixture().await;
    let (manager, flow_id) = hosted_flow_for_b(&base).await;
    let code = complete(&manager).await.unwrap();
    for _ in 0..5 {
        assert!(manager
            .confirm_hosted_flow("b", &flow_id, "ZZZZ-ZZZZ")
            .await
            .is_err());
    }
    let flow = manager.flow("b", &flow_id).await.unwrap();
    assert_eq!(flow.status, FlowState::Failed);
    assert!(manager
        .confirm_hosted_flow("b", &flow_id, &code)
        .await
        .is_err());
    assert_eq!(stored_access_token(&manager, "b").await, None);
    task.abort();
}

#[tokio::test]
async fn uninstalling_the_plugin_drops_a_held_hosted_flow() {
    let (base, _, task) = fixture().await;
    let (manager, flow_id) = hosted_flow_for_b(&base).await;
    let code = complete(&manager).await.unwrap();
    manager.disconnect_plugin("com.example.mail").await.unwrap();
    assert!(manager
        .confirm_hosted_flow("b", &flow_id, &code)
        .await
        .is_err());
    assert_eq!(stored_access_token(&manager, "b").await, None);
    task.abort();
}

#[test]
fn typed_codes_are_normalized() {
    assert_eq!(confirm::normalize_code(" ab2c-d3ef "), "AB2CD3EF");
}
