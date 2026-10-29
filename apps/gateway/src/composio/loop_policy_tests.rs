use super::*;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

struct ToolProvider {
    action: String,
    calls: AtomicUsize,
}

impl Provider for ToolProvider {
    fn name(&self) -> &'static str {
        "composio-policy-fixture"
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(async move {
            Ok(if first {
                json!({"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"call_fixture","type":"function","function":{"name":self.action,"arguments":"{\"message_id\":\"fixture\"}"}}]}}]})
            } else {
                json!({"choices":[{"message":{"role":"assistant","content":"done"}}]})
            })
        })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async {
            Err(ryu_gw_providers::ProviderError::Provider(
                "stream not used".into(),
            ))
        })
    }
}

async fn run_action(
    client: &ComposioClient,
    catalog: Option<&dyn crate::tools::CoreCatalog>,
    action: &str,
    allowed: &[String],
    charges: &AtomicUsize,
) -> Value {
    let body = run_action_under(
        client,
        catalog,
        action,
        allowed,
        charges,
        &crate::policy::OrgToolGate::default(),
    )
    .await;
    body["messages"]
        .as_array()
        .expect("messages")
        .last()
        .expect("tool result")
        .clone()
}

/// Run one tool-call round under `org_tools` and return the final request body
/// (advertised tools plus the message transcript).
async fn run_action_under(
    client: &ComposioClient,
    catalog: Option<&dyn crate::tools::CoreCatalog>,
    action: &str,
    allowed: &[String],
    charges: &AtomicUsize,
    org_tools: &crate::policy::OrgToolGate,
) -> Value {
    let provider = ToolProvider {
        action: action.into(),
        calls: AtomicUsize::new(0),
    };
    let mut body = json!({"messages":[]});
    let on_charge = |_cost, transaction: &str| {
        assert_eq!(transaction, "log_fixture");
        charges.fetch_add(1, Ordering::SeqCst);
    };
    let (_, billable) = client
        .run_tool_loop_for_session(
            &mut body,
            &provider,
            "fixture-model",
            "caller-entity",
            allowed,
            catalog,
            Some("installed-agent"),
            None,
            None,
            org_tools,
            &on_charge,
        )
        .await
        .expect("bounded loop");
    assert_eq!(billable, 0);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    body
}

#[tokio::test]
async fn legacy_loop_uses_core_policy_identity_and_billing_without_provider_fallback() {
    // Successful action output is untrusted content and is boundary-wrapped;
    // pin the process-global flag on for the duration of this test.
    let _guard = crate::untrusted::FLAG_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    crate::untrusted::set_enabled(true);
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let direct = Arc::new(AtomicUsize::new(0));
    let captured = calls.clone();
    let direct_calls = direct.clone();
    let router = axum::Router::new()
        .route(
            "/api/mcp/tools/call",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                captured.lock().expect("calls").push(body.clone());
                async move {
                    axum::Json(if body["tool"] == "composio.GMAIL_GET_MESSAGE" {
                        json!({"ok":true,"output":{"read":true}})
                    } else {
                        json!({"ok":false,"error":"connection ceiling denied"})
                    })
                }
            }),
        )
        .route(
            "/tools/execute/:action",
            axum::routing::post(move || {
                direct_calls.fetch_add(1, Ordering::SeqCst);
                async { axum::Json(json!({"data":{"standalone":true},"log_id":"log_fixture"})) }
            }),
        )
        .route(
            "/logs/tool_execution/log_fixture",
            axum::routing::get(|| async { axum::Json(json!({"id":"log_fixture","metadata":{}})) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("local fixture");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    let server =
        tokio::spawn(async move { axum::serve(listener, router).await.expect("fixture server") });
    let http = Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .expect("client");
    let mut client = ComposioClient::new(
        ComposioConfig {
            enabled: true,
            api_key: Some("fixture-key".into()),
            ..Default::default()
        },
        http.clone(),
    );
    client.test_base_url = Some(base.clone());
    let catalog = crate::tools::ToolSearchClient::new(
        &crate::config::CoreProviderConfig {
            base_url: base.clone(),
            token: Some("fixture-core-token".into()),
        },
        http.clone(),
    );
    let charges = AtomicUsize::new(0);
    for action in [
        "GMAIL_GET_MESSAGE",
        "GMAIL_SEND_EMAIL",
        "GMAIL_DELETE_MESSAGE",
    ] {
        let result = run_action(&client, Some(&catalog), action, &[action.into()], &charges).await;
        let raw = result["content"].as_str().expect("content");
        if action == "GMAIL_GET_MESSAGE" {
            let inner = raw
                .strip_prefix(crate::untrusted::UNTRUSTED_OPEN)
                .and_then(|rest| rest.strip_suffix(crate::untrusted::UNTRUSTED_CLOSE))
                .expect("successful action output must be boundary-wrapped");
            let content: Value = serde_json::from_str(inner.trim()).expect("result");
            assert_eq!(content["read"], true);
        } else {
            let content: Value = serde_json::from_str(raw).expect("result");
            assert_eq!(content["error"], "connection ceiling denied");
        }
    }
    assert_eq!(direct.load(Ordering::SeqCst), 0);
    assert_eq!(
        charges.load(Ordering::SeqCst),
        0,
        "Core owns the charge exactly once"
    );
    {
        let captured = calls.lock().expect("captured");
        assert_eq!(captured.len(), 3);
        for call in captured.iter() {
            assert_eq!(call["user_id"], "caller-entity");
            assert_eq!(call["agent_id"], "installed-agent");
            assert_eq!(call["arguments"], json!({"message_id":"fixture"}));
            assert!(call["host_conversation_id"].is_null());
            assert!(call["host_conversation_proof"].is_null());
        }
    }
    run_action(
        &client,
        Some(&catalog),
        "GMAIL_DELETE_MESSAGE",
        &["GMAIL_GET_MESSAGE".into()],
        &charges,
    )
    .await;
    assert_eq!(
        calls.lock().expect("calls").len(),
        3,
        "allowlist denial stays before Core"
    );
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("unavailable authority address");
    let closed_base = format!("http://{}", closed.local_addr().expect("closed address"));
    drop(closed);
    let unavailable_catalog = crate::tools::ToolSearchClient::new(
        &crate::config::CoreProviderConfig {
            base_url: closed_base,
            token: Some("fixture-core-token".into()),
        },
        http,
    );
    let unavailable = run_action(
        &client,
        Some(&unavailable_catalog),
        "GMAIL_SEND_EMAIL",
        &["GMAIL_SEND_EMAIL".into()],
        &charges,
    )
    .await;
    assert!(unavailable["content"]
        .as_str()
        .expect("error result")
        .contains("tools/call request failed"));
    assert_eq!(direct.load(Ordering::SeqCst), 0);
    assert_eq!(charges.load(Ordering::SeqCst), 0);
    server.abort();
}

#[tokio::test]
async fn standalone_legacy_loop_keeps_direct_execution_and_one_receipt_charge() {
    let direct = Arc::new(AtomicUsize::new(0));
    let captured = direct.clone();
    let router = axum::Router::new()
        .route(
            "/tools/execute/:action",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                assert_eq!(body["user_id"], "caller-entity");
                captured.fetch_add(1, Ordering::SeqCst);
                async { axum::Json(json!({"data":{"standalone":true},"log_id":"log_fixture"})) }
            }),
        )
        .route(
            "/logs/tool_execution/log_fixture",
            // An auth-free tool call the log records as made by this entity.
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
            ..Default::default()
        },
        Client::new(),
    );
    client.test_base_url = Some(base);
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
    assert_eq!(direct.load(Ordering::SeqCst), 1);
    assert_eq!(charges.load(Ordering::SeqCst), 1);
    server.abort();
}

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
