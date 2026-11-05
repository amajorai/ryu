use super::*;

pub(super) fn pending_flow(flow_id: &str) -> PendingFlow {
    PendingFlow {
        static_headers_hash: crate::mcp_transport::default_configuration_hash(),
        view: FlowView {
            access_level: "risk_based".to_owned(),
            flow_id: flow_id.to_owned(),
            plugin_id: "com.example.mail".to_owned(),
            server_name: "mail".to_owned(),
            profile_id: "personal".to_owned(),
            callback_mode: CallbackMode::Hosted,
            scopes: vec!["email.send".to_owned()],
            status: FlowState::Pending,
            expires_at: i64::MAX,
            error: None,
            error_code: None,
        },
        authorization_url: "https://auth.example/authorize".to_owned(),
        owner_user_id: "user".to_owned(),
        resource: "https://mcp.example".to_owned(),
        mcp_server_url: "https://mcp.example/mcp".to_owned(),
        declared_client_id: None,
        issuer: "https://auth.example".to_owned(),
        token_endpoint: "https://auth.example/token".to_owned(),
        revocation_endpoint: None,
        client_id: "client".to_owned(),
        client_secret: Some("client-secret".to_owned()),
        redirect_uri: "https://node.example/api/mcp/oauth/callback".to_owned(),
        verifier: "verifier".to_owned(),
        state: "one-time-state".to_owned(),
        callback_claimed: false,
        held: None,
        require_issuer_parameter: false,
    }
}

#[test]
fn challenge_parameters_and_metadata_urls_are_strict() {
    let challenge = r#"Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource", scope="email.send domains.read""#;
    assert_eq!(
        bearer_parameter(challenge, "resource_metadata").as_deref(),
        Some("https://mcp.example/.well-known/oauth-protected-resource")
    );
    assert_eq!(
        split_scopes(&bearer_parameter(challenge, "scope").unwrap()),
        ["email.send", "domains.read"]
    );
    assert!(validate_oauth_url("http://169.254.169.254/token", false).is_err());
    assert!(validate_oauth_url("http://127.0.0.1:8080/token", false).is_ok());
}

#[test]
fn custom_mcp_parameter_headers_are_token_validated_and_bounded() {
    assert!(validate_mcp_transport_headers(&[
        ("Mcp-Method".into(), "tools/call".into()),
        ("Mcp-Param-Region".into(), "us-west1".into()),
    ])
    .is_ok());
    assert!(
        validate_mcp_transport_headers(&[("Mcp-Param-Bad Name".into(), "value".into(),)]).is_err()
    );
    assert!(validate_mcp_transport_headers(&[(
        "Mcp-Param-Region".into(),
        "x".repeat(8 * 1024 + 1),
    )])
    .is_err());
}

#[test]
fn token_bundle_debug_is_always_redacted() {
    let bundle = TokenBundle {
        static_headers_hash: crate::mcp_transport::default_configuration_hash(),
        access_token: "secret-access".to_owned(),
        refresh_token: Some("secret-refresh".to_owned()),
        id_token: None,
        token_type: "Bearer".to_owned(),
        client_id: "public".to_owned(),
        client_secret: None,
        token_endpoint: "https://auth.example/token".to_owned(),
        revocation_endpoint: None,
        issuer: "https://auth.example".to_owned(),
        resource: "https://mcp.example".to_owned(),
        mcp_server_url: "https://mcp.example/mcp".to_owned(),
        declared_client_id: Some("public".to_owned()),
    };
    let shown = format!("{bundle:?}");
    assert_eq!(shown, "TokenBundle(<redacted>)");
}

#[test]
fn non_success_token_error_preserves_invalid_grant() {
    let response = parse_token_response(
        reqwest::StatusCode::BAD_REQUEST,
        br#"{"error":"invalid_grant","error_description":"refresh token expired"}"#,
    )
    .expect("OAuth errors are typed responses");
    assert_eq!(response.error.as_deref(), Some("invalid_grant"));
    assert_eq!(
        response.error_description.as_deref(),
        Some("refresh token expired")
    );
    assert!(response.access_token.is_empty());
}

#[tokio::test]
async fn callback_state_is_claimed_exactly_once() {
    let manager = McpOAuthManager::new(crate::IdentityStore::open_in_memory().unwrap(), None, None);
    let flow_id = "flow".to_owned();
    manager
        .flows
        .write()
        .await
        .insert(flow_id.clone(), pending_flow(&flow_id));

    manager
        .claim_callback(&flow_id, Some("one-time-state"))
        .await
        .expect("first callback claims the state");
    assert!(manager
        .claim_callback(&flow_id, Some("one-time-state"))
        .await
        .is_err());
}

/// A token endpoint that only counts requests and answers each with an OAuth
/// error, so a test can prove whether Core ever sent the code + PKCE verifier.
async fn counting_token_endpoint() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/token", listener.local_addr().unwrap());
    let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = hits.clone();
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            tokio::spawn(async move {
                let mut buffer = vec![0; 16384];
                let _ = stream.read(&mut buffer).await;
                let body = r#"{"error":"invalid_grant"}"#;
                let _ = stream
                    .write_all(
                        format!(
                            "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await;
            });
        }
    });
    (endpoint, hits)
}

#[tokio::test]
async fn hosted_callback_requires_issuer_even_when_provider_metadata_does_not() {
    let (token_endpoint, token_hits) = counting_token_endpoint().await;
    let manager = McpOAuthManager::new(crate::IdentityStore::open_in_memory().unwrap(), None, None);
    let flow_id = "issuer-bound-hosted".to_owned();
    let mut pending = pending_flow(&flow_id);
    // The selected (possibly malicious) server does not advertise RFC 9207.
    pending.require_issuer_parameter = false;
    pending.token_endpoint = token_endpoint;
    manager.flows.write().await.insert(flow_id.clone(), pending);

    // A relayed, issuerless code arrives at the shared hosted callback with
    // the state the selected server saw.
    let error = manager
        .complete_hosted_callback(
            Some("foreign-code".to_owned()),
            Some("one-time-state".to_owned()),
            None,
            None,
        )
        .await
        .expect_err("a shared hosted callback must bind every response to its issuer");
    assert!(error.to_string().contains("omitted the required issuer"));
    assert_eq!(
        token_hits.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "neither the code nor the PKCE verifier may reach the selected token endpoint"
    );
    let flows = manager.flows.read().await;
    let failed = flows.get(&flow_id).unwrap();
    assert_eq!(failed.view.status, FlowState::Failed);
    assert!(
        failed.verifier.is_empty(),
        "failed callbacks scrub PKCE state"
    );
}

#[tokio::test]
async fn hosted_callback_with_matching_issuer_and_issuerless_loopback_reach_the_token_endpoint() {
    let (token_endpoint, token_hits) = counting_token_endpoint().await;
    let manager = McpOAuthManager::new(crate::IdentityStore::open_in_memory().unwrap(), None, None);

    // Hosted + the stored issuer (trailing slash is canonicalised away).
    let hosted = "hosted-with-iss".to_owned();
    let mut pending = pending_flow(&hosted);
    pending.token_endpoint = token_endpoint.clone();
    manager.flows.write().await.insert(hosted.clone(), pending);
    let error = manager
        .complete_hosted_callback(
            Some("code".to_owned()),
            Some("one-time-state".to_owned()),
            Some("https://auth.example/".to_owned()),
            None,
        )
        .await
        .expect_err("the fixture token endpoint answers invalid_grant");
    assert!(
        error.to_string().contains("token exchange failed"),
        "{error:#}"
    );
    assert_eq!(token_hits.load(std::sync::atomic::Ordering::SeqCst), 1);

    // Loopback: the per-flow listener port binds the response, so a server
    // that does not support RFC 9207 still completes without `iss`.
    let loopback = "loopback-without-iss".to_owned();
    let mut pending = pending_flow(&loopback);
    pending.view.callback_mode = CallbackMode::Loopback;
    pending.state = "loopback-state".to_owned();
    pending.redirect_uri = "http://127.0.0.1:1/oauth/callback".to_owned();
    pending.token_endpoint = token_endpoint;
    manager
        .flows
        .write()
        .await
        .insert(loopback.clone(), pending);
    let error = manager
        .complete_callback(
            &loopback,
            Some("code".to_owned()),
            Some("loopback-state".to_owned()),
            None,
            None,
        )
        .await
        .expect_err("the fixture token endpoint answers invalid_grant");
    assert!(
        error.to_string().contains("token exchange failed"),
        "{error:#}"
    );
    assert_eq!(token_hits.load(std::sync::atomic::Ordering::SeqCst), 2);
}

#[tokio::test]
async fn every_error_after_callback_claim_fails_and_scrubs_the_flow() {
    let manager = McpOAuthManager::new(crate::IdentityStore::open_in_memory().unwrap(), None, None);
    let flow_id = "post-claim-error".to_owned();
    manager
        .flows
        .write()
        .await
        .insert(flow_id.clone(), pending_flow(&flow_id));

    let error = manager
        .complete_callback(
            &flow_id,
            None,
            Some("one-time-state".to_owned()),
            Some("https://auth.example".to_owned()),
            None,
        )
        .await
        .expect_err("a callback without a code must fail");
    assert!(error.to_string().contains("did not contain a code"));

    let flows = manager.flows.read().await;
    let flow = flows.get(&flow_id).expect("failed flow is retained for UI");
    assert_eq!(flow.view.status, FlowState::Failed);
    assert!(flow
        .view
        .error
        .as_deref()
        .is_some_and(|message| message.contains("did not contain a code")));
    assert!(flow.verifier.is_empty());
    assert!(flow.state.is_empty());
    assert!(flow.client_secret.is_none());
}

#[tokio::test]
async fn connected_transition_rechecks_current_state_and_expiry() {
    let manager = McpOAuthManager::new(crate::IdentityStore::open_in_memory().unwrap(), None, None);
    let flow_id = "stale-callback".to_owned();
    let mut flow = pending_flow(&flow_id);
    flow.callback_claimed = true;
    let binding = BindingKey::from_flow(&flow);
    manager.flows.write().await.insert(flow_id.clone(), flow);

    manager
        .ensure_flow_can_connect(&flow_id, &binding)
        .await
        .expect("a live claimed flow may connect");
    manager
        .flows
        .write()
        .await
        .get_mut(&flow_id)
        .expect("flow exists")
        .view
        .status = FlowState::Failed;
    assert!(manager
        .ensure_flow_can_connect(&flow_id, &binding)
        .await
        .is_err());

    let mut expired = pending_flow("expired-callback");
    expired.callback_claimed = true;
    expired.view.expires_at = chrono::Utc::now().timestamp();
    let expired_binding = BindingKey::from_flow(&expired);
    manager
        .flows
        .write()
        .await
        .insert("expired-callback".to_owned(), expired);
    assert!(manager
        .ensure_flow_can_connect("expired-callback", &expired_binding)
        .await
        .is_err());
}
