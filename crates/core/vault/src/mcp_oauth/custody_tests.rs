use super::custody_fixtures::*;
use super::*;
use std::sync::atomic::Ordering;
#[tokio::test]
async fn hosted_flow_start_refuses_a_server_without_rfc9207_issuer_support() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let provider = origin.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let origin = provider.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0; 16384];
                let n = stream.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..n]);
                let body = if request.contains("/.well-known/oauth-protected-resource") {
                    serde_json::json!({"resource":origin,"authorization_servers":[origin],"scopes_supported":["read"]})
                } else {
                    serde_json::json!({"issuer":origin,"authorization_endpoint":format!("{origin}/authorize"),"token_endpoint":format!("{origin}/token"),"code_challenge_methods_supported":["S256"],"scopes_supported":["read"]})
                }
                .to_string();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            });
        }
    });
    let manager = McpOAuthManager::new(
        crate::IdentityStore::open_in_memory().unwrap(),
        Some("https://passport.example/callback".into()),
        None,
    );
    let spec = |callback_mode| ConnectSpec {
        access_level: crate::ConnectionAccessLevel::ReadOnly,
        owner_user_id: "owner".into(),
        profile_id: "profile".into(),
        plugin_id: "plugin".into(),
        server_name: "server".into(),
        resource_url: format!("{origin}/mcp"),
        auth: OAuthClient {
            client_id: Some("client".into()),
        },
        callback_mode,
        static_headers: Default::default(),
        challenge: Some(format!(
            "Bearer resource_metadata=\"{origin}/.well-known/oauth-protected-resource\""
        )),
    };
    // Hosted (explicit, and Auto on a node with an HTTPS public URL) is
    // refused up front with an actionable message.
    for mode in [CallbackMode::Hosted, CallbackMode::Auto] {
        let error = manager
            .start_connect(spec(mode))
            .await
            .expect_err("hosted flows need RFC 9207 issuer support");
        assert!(error.to_string().contains("RFC 9207"), "{error}");
    }
    // A loopback flow binds the redirect itself, so the same server starts.
    manager
        .start_connect(spec(CallbackMode::Loopback))
        .await
        .expect("loopback flows do not need `iss`");
    task.abort();
}

#[tokio::test]
async fn discovery_pkce_hosted_callback_and_metadata_roundtrip() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let provider = origin.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let origin = provider.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0; 16384];
                let n = stream.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..n]);
                let body=if request.contains("/.well-known/oauth-protected-resource") {
                    serde_json::json!({"resource":origin,"authorization_servers":[origin],"scopes_supported":["read"]})
                } else if request.contains("/.well-known/oauth-authorization-server") {
                    serde_json::json!({"issuer":origin,"authorization_endpoint":format!("{origin}/authorize"),"token_endpoint":format!("{origin}/token"),"code_challenge_methods_supported":["S256"],"authorization_response_iss_parameter_supported":true,"scopes_supported":["read","directory.admin","offline_access"]})
                } else {
                    assert!(request.contains("code_verifier=")); assert!(request.contains("grant_type=authorization_code"));
                    serde_json::json!({"access_token":"fixture-authorized","refresh_token":"fixture-rotation","expires_in":3600})
                }.to_string();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            });
        }
    });
    let manager = McpOAuthManager::new(
        crate::IdentityStore::open_in_memory().unwrap(),
        Some("https://passport.example/callback".into()),
        None,
    );
    let started = manager
        .start_connect(ConnectSpec {
            access_level: crate::ConnectionAccessLevel::ReadOnly,
            owner_user_id: "owner".into(),
            profile_id: "profile".into(),
            plugin_id: "plugin".into(),
            server_name: "server".into(),
            resource_url: format!("{origin}/mcp"),
            auth: OAuthClient {
                client_id: Some("client".into()),
            },
            callback_mode: CallbackMode::Hosted,
            static_headers: Default::default(),
            challenge: Some(format!(
                "Bearer resource_metadata=\"{origin}/.well-known/oauth-protected-resource\""
            )),
        })
        .await
        .unwrap();
    let url = Url::parse(&started.authorization_url).unwrap();
    let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(params["redirect_uri"], "https://passport.example/callback");
    // Only the protected resource's scopes (plus offline_access for a
    // refresh token), not the server-wide list.
    assert_eq!(params["scope"], "offline_access read");
    assert!(manager.flow("other", &started.flow_id).await.is_err());
    assert!(manager
        .complete_hosted_callback(
            Some("code".into()),
            Some("wrong-state".into()),
            Some(origin.clone()),
            None
        )
        .await
        .is_err());
    let confirmation = manager
        .complete_hosted_callback(
            Some("code".into()),
            Some(params["state"].clone()),
            Some(origin),
            None,
        )
        .await
        .unwrap();
    let held = manager.flow("owner", &started.flow_id).await.unwrap();
    assert_eq!(held.status, FlowState::AwaitingConfirmation);
    manager
        .confirm_hosted_flow("owner", &started.flow_id, &confirmation)
        .await
        .unwrap();
    let flow = manager.flow("owner", &started.flow_id).await.unwrap();
    assert_eq!(flow.status, FlowState::Connected);
    assert!(!serde_json::to_string(&flow)
        .unwrap()
        .contains("fixture-authorized"));
    let rows = manager
        .store
        .list_mcp_oauth_connections("owner", "plugin")
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].encrypted_state.is_some());
    assert!(!serde_json::to_string(&rows)
        .unwrap()
        .contains("fixture-rotation"));
    assert!(manager
        .complete_hosted_callback(
            Some("code".into()),
            Some(params["state"].clone()),
            None,
            None
        )
        .await
        .is_err());
    task.abort();
}

#[tokio::test]
async fn refresh_is_serialized_consumption_is_sealed_and_uninstall_wins() {
    let (base, count, task) = fixture().await;
    let (manager, binding) = seeded(&base, "mcp", true).await;
    let consume = || {
        manager.consume(
            &binding,
            vec![],
            b"{}".to_vec(),
            crate::ConnectionAction::Read,
            false,
            true,
        )
    };
    let (a, b) = tokio::join!(consume(), consume());
    assert_eq!(a.unwrap().status, 200);
    assert_eq!(b.unwrap().status, 200);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let (consumed, removed) = tokio::join!(consume(), manager.disconnect_plugin("plugin"));
    consumed.unwrap();
    removed.unwrap();
    assert!(consume().await.is_err());
    assert!(manager
        .store
        .list_mcp_oauth_connections("owner", "plugin")
        .await
        .unwrap()
        .is_empty());
    task.abort();
}
#[tokio::test]
async fn exact_binding_and_response_custody_are_enforced() {
    let (base, _, task) = fixture().await;
    let (manager, binding) = seeded(&base, "mcp", false).await;
    for index in 0..6 {
        let mut other = binding.clone();
        match index {
            0 => other.owner_user_id.push('x'),
            1 => other.profile_id.push('x'),
            2 => other.plugin_id.push('x'),
            3 => other.server_name.push('x'),
            4 => other.resource_url.push('x'),
            _ => other.client_id = Some("other".into()),
        }
        assert!(manager
            .consume(
                &other,
                vec![],
                vec![],
                crate::ConnectionAction::Read,
                false,
                false
            )
            .await
            .is_err());
    }
    let (manager, binding) = seeded(&base, "echo", false).await;
    assert!(manager
        .consume(
            &binding,
            vec![],
            vec![],
            crate::ConnectionAction::Read,
            false,
            false
        )
        .await
        .is_err());
    let (manager, binding) = seeded(&base, "redirect", false).await;
    let result = manager
        .consume(
            &binding,
            vec![],
            vec![],
            crate::ConnectionAction::Read,
            false,
            false,
        )
        .await
        .unwrap();
    assert_eq!(result.status, 302);
    assert!(result
        .headers
        .iter()
        .all(|(name, _)| !name.eq_ignore_ascii_case("location")));
    assert!(manager
        .consume(
            &binding,
            vec![("authorization".into(), "Bearer other".into())],
            vec![],
            crate::ConnectionAction::Read,
            false,
            false
        )
        .await
        .is_err());
    task.abort();
}
#[tokio::test]
async fn callback_race_cannot_resurrect_an_uninstalled_connection() {
    let (base, count, task) = fixture().await;
    let (manager, _) = seeded(&base, "mcp", true).await;
    let mut pending = super::tests::pending_flow("racing");
    pending.token_endpoint = format!("{base}/token");
    pending.view.plugin_id = "plugin".into();
    // The loopback path commits on callback; hosted commits on confirmation,
    // whose uninstall race `confirm_tests` covers.
    pending.view.callback_mode = CallbackMode::Loopback;
    let state = pending.state.clone();
    manager.flows.write().await.insert("racing".into(), pending);
    let callback = manager.complete_callback(
        "racing",
        Some("fixture-code".into()),
        Some(state.clone()),
        Some("https://auth.example".into()),
        None,
    );
    let uninstall = async {
        while count.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        manager.disconnect_plugin("plugin").await.unwrap();
    };
    let (result, _) = tokio::join!(callback, uninstall);
    assert!(result.is_err());
    assert!(manager
        .store
        .list_mcp_oauth_connections_for_plugin("plugin")
        .await
        .unwrap()
        .is_empty());
    assert!(manager
        .complete_callback(
            "racing",
            Some("fixture-code".into()),
            Some(state),
            Some("https://auth.example".into()),
            None
        )
        .await
        .is_err());
    task.abort();
}
