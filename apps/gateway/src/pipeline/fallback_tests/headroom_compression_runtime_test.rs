//! Gateway egress proof driven by the shipped Headroom policy definition.
//! A local compression service and capturing provider replace external runtimes.
use super::super::run_stream;
use super::*;
use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use std::{
    pin::Pin,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

const MANIFEST: &str = include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/headroom/manifest.json");
type Requests = Arc<tokio::sync::Mutex<Vec<Value>>>;
#[derive(Clone)]
struct ServiceState {
    mode: &'static str,
    requests: Requests,
}
struct CapturingProvider {
    inner: Arc<StubProvider>,
    bodies: Requests,
}
impl Provider for CapturingProvider {
    fn name(&self) -> &'static str {
        "primary"
    }
    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = std::result::Result<Value, ProviderError>> + Send + 'a,
        >,
    > {
        Box::pin(async move {
            self.bodies.lock().await.push(body.clone());
            self.inner.complete(model, body).await
        })
    }
    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<
        Box<dyn std::future::Future<Output = std::result::Result<Body, ProviderError>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.bodies.lock().await.push(body.clone());
            self.inner.complete_stream(model, body).await
        })
    }
}

async fn exercise(
    mode: &'static str,
    enabled: bool,
    message_count: usize,
    streaming: bool,
    should_compress: bool,
    should_call: bool,
) {
    let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
    let policy = &manifest["runnables"][0]["config"];
    assert_eq!(policy["policy_type"], "compression");
    let definition = &policy["definition"];
    assert_eq!(definition["service"], "headroom");
    let mut compression: crate::config::CompressionConfig =
        serde_json::from_value(definition.clone()).unwrap();
    assert_eq!(compression.url, "http://127.0.0.1:8787");
    assert_eq!(compression.timeout_ms, 4000);
    assert_eq!(compression.min_messages, 4);
    assert!(compression.token.is_none());
    compression.enabled = enabled;
    let requests: Requests = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let bodies: Requests = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    compression.url = format!("http://{}", listener.local_addr().unwrap());
    if mode == "timeout" {
        compression.timeout_ms = 30;
    }
    let app = Router::new()
        .route("/v1/compress", post(compress_fixture))
        .with_state(ServiceState {
            mode,
            requests: requests.clone(),
        });
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let config = GatewayConfig {
        compression,
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..Default::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..Default::default()
        },
        cache: crate::config::CacheConfig {
            enabled: false,
            ..Default::default()
        },
        ..Default::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let mut state = AppState::new_for_test(
        config,
        audit,
        crate::evals::EvalsRunner::new(EvalsConfig::default()),
    );
    let (inner, _) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(Arc::new(CapturingProvider {
            inner,
            bodies: bodies.clone(),
        }) as Arc<dyn Provider>);
    let state = Arc::new(state);
    let messages = (0..message_count)
        .map(|index| json!({"role":"user","content":format!("Original message {index}")}))
        .collect::<Vec<_>>();
    let original = json!({"model":"fixture-model","messages":messages,"temperature":0.3,"max_tokens":64,"stream":streaming});
    if streaming {
        let response = run_stream(state.clone(), plain_ctx(), original.clone())
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.body, usize::MAX)
            .await
            .unwrap();
        assert!(!bytes.is_empty(), "provider stream must reach completion");
    } else {
        run(state.clone(), plain_ctx(), original.clone())
            .await
            .unwrap();
    }
    let seen = bodies.lock().await;
    assert_eq!(seen.len(), 1, "exactly one provider call");
    assert_eq!(seen[0]["model"], original["model"]);
    assert_eq!(seen[0]["temperature"], original["temperature"]);
    assert_eq!(seen[0]["max_tokens"], original["max_tokens"]);
    if should_compress {
        assert_eq!(
            seen[0]["messages"],
            json!([{"role":"user","content":"Compressed context"}])
        );
    } else {
        assert_eq!(
            seen[0]["messages"], original["messages"],
            "failed/disabled compression must leave provider input intact"
        );
    }
    assert_eq!(
        state
            .metrics
            .compression_tokens_saved
            .load(Ordering::Relaxed),
        if should_compress { 70 } else { 0 }
    );
    let requests = requests.lock().await;
    assert_eq!(requests.len(), usize::from(should_call));
    if should_call {
        assert_eq!(requests[0]["path"], "/v1/compress");
        assert_eq!(requests[0]["authorization"], Value::Null);
        assert_eq!(
            requests[0]["body"],
            json!({"model":"fixture-model","messages":messages})
        );
    }
    server.abort();
}

#[tokio::test]
async fn headroom_manifest_compresses_both_chat_paths_before_provider_dispatch() {
    for streaming in [false, true] {
        exercise("compressed", true, 4, streaming, true, true).await;
    }
}
#[tokio::test]
async fn headroom_manifest_disabled_and_short_requests_do_not_call_the_service() {
    for streaming in [false, true] {
        exercise("compressed", false, 4, streaming, false, false).await;
        exercise("compressed", true, 3, streaming, false, false).await;
    }
}
#[tokio::test]
async fn headroom_manifest_failures_keep_both_provider_request_bodies_intact() {
    for streaming in [false, true] {
        for mode in [
            "unavailable",
            "invalid-json",
            "malformed-array",
            "missing-role",
            "not-compressed",
            "timeout",
        ] {
            exercise(mode, true, 4, streaming, false, true).await;
        }
    }
}

async fn compress_fixture(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    state.requests.lock().await.push(json!({"path":"/v1/compress","authorization":headers.get("authorization").and_then(|value|value.to_str().ok()),"body":body}));
    match state.mode {
        "unavailable"=>(StatusCode::SERVICE_UNAVAILABLE,Json(json!({"error":"fixture unavailable"}))).into_response(),
        "invalid-json"=>(StatusCode::OK,"not-json").into_response(),
        "malformed-array"=>Json(json!({"compressed":true,"messages":["broken"],"tokens_saved":70})).into_response(),
        "missing-role"=>Json(json!({"compressed":true,"messages":[{"content":"broken"}],"tokens_saved":70})).into_response(),
        "not-compressed"=>Json(json!({"compressed":false,"messages":[{"role":"user","content":"Do not apply"}]})).into_response(),
        "timeout"=>{tokio::time::sleep(Duration::from_millis(100)).await;Json(json!({"compressed":true,"messages":[{"role":"user","content":"Late response"}]})).into_response()},
        _=>Json(json!({"compressed":true,"messages":[{"role":"user","content":"Compressed context"}],"tokens_before":100,"tokens_after":30})).into_response(),
    }
}
