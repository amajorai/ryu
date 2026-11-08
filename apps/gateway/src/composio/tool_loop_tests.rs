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

#[path = "tool_loop_billing_tests.rs"]
mod billing;
