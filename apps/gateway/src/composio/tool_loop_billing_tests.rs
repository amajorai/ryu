use super::*;

/// A standalone Composio stand-in whose execution log names `logged_account`,
/// which the provider records as owned by `account_owner`.
async fn entity_selected_fixture(
    logged_account: &'static str,
    account_owner: &'static str,
) -> (ComposioClient, tokio::task::JoinHandle<()>) {
    let router = axum::Router::new()
        .route(
            "/tools/execute/:action",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                // The agent loop pins no account: Composio selects one for the
                // Gateway-owned entity.
                assert_eq!(body["user_id"], "caller-entity");
                assert!(body.get("connected_account_id").is_none());
                axum::Json(json!({"data":{"standalone":true},"log_id":"log_fixture"}))
            }),
        )
        .route(
            "/logs/tool_execution/log_fixture",
            axum::routing::get(move || async move {
                axum::Json(json!({
                    "id": "log_fixture",
                    "metadata": {
                        "connected_account_id": logged_account,
                        "auth_config_id": "ac_managed",
                    },
                }))
            }),
        )
        .route(
            "/connected_accounts/:id",
            axum::routing::get(
                move |axum::extract::Path(id): axum::extract::Path<String>| async move {
                    axum::Json(json!({
                        "id": id,
                        "user_id": account_owner,
                        "auth_config": { "id": "ac_managed" },
                    }))
                },
            ),
        )
        .route(
            "/auth_configs/ac_managed",
            axum::routing::get(|| async {
                axum::Json(json!({ "id": "ac_managed", "is_composio_managed": true }))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("local fixture");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    let server =
        tokio::spawn(async move { axum::serve(listener, router).await.expect("fixture server") });
    let mut client = ComposioClient::new(
        ComposioConfig {
            enabled: true,
            api_key: Some("fixture-key".into()),
            ..Default::default()
        },
        Client::new(),
    );
    client.test_base_url = Some(base);
    (client, server)
}

#[tokio::test]
async fn entity_selected_execution_is_charged_for_the_entitys_own_account() {
    let (client, server) = entity_selected_fixture("ca_entity", "caller-entity").await;
    let charges = AtomicUsize::new(0);
    let result = run_action(
        &client,
        None,
        "GMAIL_GET_MESSAGE",
        &["GMAIL_GET_MESSAGE".into()],
        &charges,
    )
    .await;
    assert!(
        result["content"]
            .as_str()
            .expect("content")
            .contains("standalone"),
        "{result}"
    );
    assert_eq!(charges.load(Ordering::SeqCst), 1);

    let (_, cost, transaction) = client
        .execute_metered("GMAIL_GET_MESSAGE", json!({}), "caller-entity", None)
        .await
        .expect("entity-selected receipt");
    assert_eq!(transaction, "log_fixture");
    // Managed-app tool call (500) plus direct execution (100).
    assert_eq!(cost, 600);
    server.abort();
}

#[tokio::test]
async fn entity_selected_execution_never_bills_another_entitys_account() {
    let (client, server) = entity_selected_fixture("ca_foreign", "other-entity").await;
    let outcome = client
        .execute_metered("GMAIL_GET_MESSAGE", json!({}), "caller-entity", None)
        .await;
    assert!(
        matches!(outcome, Err(GatewayError::AccountingUnavailable)),
        "a log naming another entity's account is accounting-unavailable"
    );
    server.abort();
}

/// A standalone Composio stand-in whose execution log carries `metadata`,
/// with no connected-account or auth-config lookups available.
async fn logged_metadata_fixture(metadata: Value) -> (ComposioClient, tokio::task::JoinHandle<()>) {
    let router = axum::Router::new()
        .route(
            "/tools/execute/:action",
            axum::routing::post(|| async {
                axum::Json(json!({"data":{"standalone":true},"log_id":"log_fixture"}))
            }),
        )
        .route(
            "/logs/tool_execution/log_fixture",
            axum::routing::get(move || {
                let metadata = metadata.clone();
                async move { axum::Json(json!({ "id": "log_fixture", "metadata": metadata })) }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("local fixture");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    let server =
        tokio::spawn(async move { axum::serve(listener, router).await.expect("fixture server") });
    let mut client = ComposioClient::new(
        ComposioConfig {
            enabled: true,
            api_key: Some("fixture-key".into()),
            ..Default::default()
        },
        Client::new(),
    );
    client.test_base_url = Some(base);
    (client, server)
}

#[tokio::test]
async fn entity_selected_auth_free_or_instant_logs_for_another_caller_are_never_billed() {
    for metadata in [
        // An auth-free log that does not say who made the call.
        json!({}),
        // An auth-free log recording another entity's call.
        json!({ "user_id": "other-entity" }),
        // Another entity's Instant premium call.
        json!({
            "user_id": "other-entity",
            "connected_account_id": "instant_account",
            "instant_charge": "0.008",
        }),
        // An Instant premium call with no recorded caller.
        json!({ "connected_account_id": "instant_account", "instant_charge": "0.008" }),
    ] {
        let (client, server) = logged_metadata_fixture(metadata.clone()).await;
        let outcome = client
            .execute_metered("GMAIL_GET_MESSAGE", json!({}), "caller-entity", None)
            .await;
        assert!(
            matches!(outcome, Err(GatewayError::AccountingUnavailable)),
            "{metadata} must be accounting-unavailable"
        );
        server.abort();
    }

    // The same Instant call recorded for this entity is charged its premium.
    let (client, server) = logged_metadata_fixture(json!({
        "user_id": "caller-entity",
        "connected_account_id": "instant_account",
        "instant_charge": "0.008",
    }))
    .await;
    let (_, cost, transaction) = client
        .execute_metered("GMAIL_GET_MESSAGE", json!({}), "caller-entity", None)
        .await
        .expect("this entity's Instant receipt");
    assert_eq!(transaction, "log_fixture");
    assert!(cost >= 8_000, "Instant premium is charged: {cost}");
    server.abort();
}

#[tokio::test]
async fn a_pinned_account_log_with_another_auth_config_is_never_priced() {
    let router = axum::Router::new()
        .route(
            "/tools/execute/:action",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                assert_eq!(body["connected_account_id"], "ca_pinned");
                axum::Json(json!({"data":{"ok":true},"log_id":"log_fixture"}))
            }),
        )
        .route(
            "/logs/tool_execution/log_fixture",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "id": "log_fixture",
                    "metadata": {
                        "connected_account_id": "ca_pinned",
                        "auth_config_id": "ac_managed",
                    },
                }))
            }),
        )
        .route(
            "/connected_accounts/ca_pinned",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "id": "ca_pinned",
                    "user_id": "caller-entity",
                    "auth_config": { "id": "ac_own" },
                }))
            }),
        )
        .route(
            "/auth_configs/ac_managed",
            axum::routing::get(|| async {
                axum::Json(json!({ "id": "ac_managed", "is_composio_managed": true }))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("local fixture");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    let server =
        tokio::spawn(async move { axum::serve(listener, router).await.expect("fixture server") });
    let mut client = ComposioClient::new(
        ComposioConfig {
            enabled: true,
            api_key: Some("fixture-key".into()),
            ..Default::default()
        },
        Client::new(),
    );
    client.test_base_url = Some(base);
    let outcome = client
        .execute_metered(
            "GMAIL_GET_MESSAGE",
            json!({}),
            "caller-entity",
            Some("ca_pinned"),
        )
        .await;
    assert!(
        matches!(outcome, Err(GatewayError::AccountingUnavailable)),
        "a log naming a configuration the account does not use is not priced"
    );
    server.abort();
}

/// An organization's `deniedTools: ["composio.*"]` reaches the no-catalog
/// (standalone/hosted) Composio branch: the denied action is neither offered to
/// the model nor executed, the caller sees the documented denial, and the
/// denial is audited. An allowed action under a narrow allowlist still runs.
#[tokio::test]
async fn org_tool_policy_denies_direct_composio_execution() {
    let direct = Arc::new(AtomicUsize::new(0));
    let captured = direct.clone();
    let router = axum::Router::new()
        .route(
            "/tools/execute/:action",
            axum::routing::post(move || {
                captured.fetch_add(1, Ordering::SeqCst);
                async { axum::Json(json!({"data":{"standalone":true},"log_id":"log_fixture"})) }
            }),
        )
        .route(
            "/logs/tool_execution/log_fixture",
            // The permitted call's receipt must name the entity that made it.
            axum::routing::get(|| async {
                axum::Json(json!({"id":"log_fixture","metadata":{"user_id":"caller-entity"}}))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("local fixture");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    let server =
        tokio::spawn(async move { axum::serve(listener, router).await.expect("fixture server") });
    let mut client = ComposioClient::new(
        ComposioConfig {
            enabled: true,
            api_key: Some("fixture-key".into()),
            actions: vec!["GMAIL_SEND_EMAIL".into(), "GMAIL_GET_MESSAGE".into()],
            ..Default::default()
        },
        Client::new(),
    );
    client.test_base_url = Some(base);
    let charges = AtomicUsize::new(0);
    let audited = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let sink = Arc::clone(&audited);
    let audit: crate::policy::ToolDenialAudit = Arc::new(move |tool: &str, reason: &str| {
        sink.lock()
            .expect("audit")
            .push((tool.to_owned(), reason.to_owned()));
    });
    let deny_composio = crate::policy::OrgToolGate::new(
        crate::policy::EffectivePolicy {
            denied_tools: vec!["composio.*".into()],
            ..Default::default()
        },
        Some(Arc::clone(&audit)),
    );
    let allowed = vec![
        "GMAIL_SEND_EMAIL".to_owned(),
        "GMAIL_GET_MESSAGE".to_owned(),
    ];
    let body = run_action_under(
        &client,
        None,
        "GMAIL_SEND_EMAIL",
        &allowed,
        &charges,
        &deny_composio,
    )
    .await;
    let result = body["messages"]
        .as_array()
        .expect("messages")
        .last()
        .expect("tool result")
        .clone();
    let content: Value =
        serde_json::from_str(result["content"].as_str().expect("content")).expect("envelope");
    assert_eq!(
        content["error"],
        "tool 'composio.GMAIL_SEND_EMAIL' is denied by your organization's tool policy (rule 'composio.*')"
    );
    assert!(
        body["tools"].as_array().map_or(true, Vec::is_empty),
        "denied actions are never advertised: {}",
        body["tools"]
    );
    assert_eq!(
        direct.load(Ordering::SeqCst),
        0,
        "execute_metered never runs"
    );
    assert_eq!(charges.load(Ordering::SeqCst), 0);
    assert_eq!(
        audited.lock().expect("audit").as_slice(),
        &[(
            "composio.GMAIL_SEND_EMAIL".to_owned(),
            content["error"].as_str().unwrap().to_owned()
        )]
    );

    // An unresolved caller (no tool rules known) is refused, too.
    let unresolved = crate::policy::OrgToolGate::new(
        crate::policy::policy_for_caller(&crate::policy::EffectivePolicy::default(), None),
        None,
    );
    let refused = run_action_under(
        &client,
        None,
        "GMAIL_GET_MESSAGE",
        &allowed,
        &charges,
        &unresolved,
    )
    .await;
    assert!(
        refused["messages"].as_array().unwrap().last().unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("tool policy is unavailable")
    );
    assert_eq!(direct.load(Ordering::SeqCst), 0);

    // A narrow allowlist keeps the permitted action working and hides the rest.
    let narrow = crate::policy::OrgToolGate::new(
        crate::policy::EffectivePolicy {
            allowed_tools: vec!["composio.GMAIL_GET_*".into()],
            ..Default::default()
        },
        Some(audit),
    );
    let body = run_action_under(
        &client,
        None,
        "GMAIL_GET_MESSAGE",
        &allowed,
        &charges,
        &narrow,
    )
    .await;
    let advertised: Vec<&str> = body["tools"]
        .as_array()
        .expect("advertised tools")
        .iter()
        .filter_map(|tool| tool["function"]["name"].as_str())
        .collect();
    assert_eq!(advertised, vec!["GMAIL_GET_MESSAGE"]);
    assert!(
        body["messages"].as_array().unwrap().last().unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("standalone")
    );
    assert_eq!(direct.load(Ordering::SeqCst), 1);
    assert_eq!(charges.load(Ordering::SeqCst), 1);
    assert_eq!(audited.lock().expect("audit").len(), 1);
    server.abort();
}
