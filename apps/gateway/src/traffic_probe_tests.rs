//! Coverage probes for the live traffic verdicts (spec 07.2).
//!
//! `traffic_tests` proves the verdict fields on the chat route. These probes
//! drive the real router down every other path a request can take and check
//! each event the feed publishes: streaming and buffered, the compat routes
//! (`/v1/messages`, `/v1beta`, `/v1/responses`), the multimodal routes,
//! `POST /v1/providers/call`, a tool-loop round, a fallback attempt, a cache
//! hit, a detached (metered) run, and a trusted forwarder next to an `rgw_`
//! key. A probe is discriminating: the pattern lives in an org overlay or the
//! policy is Sanitize, so a path that never wires its verdict reads `node`
//! or `allow` and fails.
//!
//! Markers are only test values: the test-only lexicon `RYU_TEST_LEXICON`,
//! the AWS documentation example key and the published test card number.
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::*;
use crate::config::{
    ApiKeyConfig, ApiKeyOperation, CoreProviderConfig, CustomPattern, CustomPatternKind,
    FirewallOverlay, FirewallPolicy, GatewayConfig, ProviderId,
};
use crate::platform_floor::PlatformFloor;
use crate::policy::ResolveCache;
use crate::providers::Provider;
use crate::state::AppState;

const LEXICON: &str = "RYU_TEST_LEXICON";
const AWS_EXAMPLE_KEY: &str = "AKIAIOSFODNN7EXAMPLE";
const TEST_CARD: &str = "4111 1111 1111 1111";
const PRIMARY: &str = "traffic-probe-primary";
const FALLBACK: &str = "traffic-probe-fallback";
const ORG_PATTERN: &str = "org_probe_lexicon";
const NODE_PATTERN: &str = "node_probe_lexicon";
const FLOOR_PATTERN: &str = "ryu_floor_probe_lexicon";
/// The trusted forwarder's static key and the org it is bound to.
const FORWARDER_KEY: &str = "sk-probe-forwarder-0123456789";
const FORWARDER_ORG: &str = "org_probe";
const TENANT_TOKEN: &str = "rgw_probe_tenant_key_0123456789";
const UNIFIED_TOOL: &str = "exa.search";

fn prompt() -> String {
    format!("echo {LEXICON} and {AWS_EXAMPLE_KEY} and {TEST_CARD} please")
}

/// Only the lexicon, so no curated node detector (the AWS key, the card)
/// decides first and an org or floor attribution is what is tested.
fn lexicon_only() -> String {
    format!("echo {LEXICON} please")
}

fn pattern(name: &str) -> CustomPattern {
    CustomPattern {
        name: name.to_owned(),
        regex: LEXICON.to_owned(),
        kind: CustomPatternKind::Secret,
    }
}

// ─── Fixture provider ──────────────────────────────────────────────────────

type ProviderFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>>;

/// Records every body, answers `reply`, and fails its first call when
/// `fail_first` is set. A failure names the lexicon, so a feed that echoed
/// upstream error text would leak it.
struct Fixture {
    name: &'static str,
    reply: String,
    fail_first: bool,
    script: Vec<Value>,
    calls: Arc<Mutex<Vec<Value>>>,
}

impl Fixture {
    fn record(&self, body: &Value) -> usize {
        let mut calls = self.calls.lock().unwrap();
        calls.push(body.clone());
        calls.len()
    }

    fn failure() -> ryu_gw_providers::ProviderError {
        ryu_gw_providers::ProviderError::Provider(format!("upstream outage {LEXICON}"))
    }
}

impl Provider for Fixture {
    fn name(&self) -> &'static str {
        self.name
    }

    fn complete<'a>(&'a self, _model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        let round = self.record(body);
        if self.fail_first && round == 1 {
            return Box::pin(async { Err(Self::failure()) });
        }
        let index = if self.fail_first {
            round - 2
        } else {
            round - 1
        };
        let message = self
            .script
            .get(index)
            .cloned()
            .unwrap_or_else(|| json!({ "role": "assistant", "content": self.reply }));
        Box::pin(async move {
            Ok(json!({
                "id": format!("chatcmpl-probe-{round}"),
                "object": "chat.completion",
                "model": "fixture-model",
                "choices": [{ "index": 0, "message": message, "finish_reason": "stop" }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
            }))
        })
    }

    fn complete_stream<'a>(&'a self, _model: &'a str, body: &'a Value) -> ProviderFuture<'a, Body> {
        let round = self.record(body);
        if self.fail_first && round == 1 {
            return Box::pin(async { Err(Self::failure()) });
        }
        let chunk = json!({
            "id": "chatcmpl-probe-stream",
            "object": "chat.completion.chunk",
            "model": "fixture-model",
            "choices": [{ "index": 0, "delta": { "content": self.reply }, "finish_reason": null }]
        });
        let done = json!({
            "id": "chatcmpl-probe-stream",
            "object": "chat.completion.chunk",
            "model": "fixture-model",
            "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
        });
        let sse = format!("data: {chunk}\n\ndata: {done}\n\ndata: [DONE]\n\n");
        Box::pin(async move { Ok(Body::from(sse)) })
    }

    fn embed<'a>(&'a self, _model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        self.record(body);
        Box::pin(async {
            Ok(json!({
                "object": "list",
                "data": [{ "object": "embedding", "index": 0, "embedding": [0.1, 0.2] }],
                "model": "fixture-embed",
                "usage": { "prompt_tokens": 1, "total_tokens": 1 }
            }))
        })
    }

    fn generate_image<'a>(&'a self, _model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        self.record(body);
        Box::pin(async {
            Ok(json!({ "created": 0, "data": [{ "url": "https://x.invalid/i.png" }] }))
        })
    }
}

// ─── Harness ───────────────────────────────────────────────────────────────

/// One probe Gateway. Fields not set keep the self-hosted defaults: no auth,
/// no cache, audit off, no fallback.
#[derive(Default)]
struct Setup {
    custody: Option<GatewayCustody>,
    audit_on: bool,
    reply: Option<String>,
    fail_primary_once: bool,
    with_fallback: bool,
    script: Vec<Value>,
    /// Bind every request to the trusted forwarder's org with a static key.
    forwarder: bool,
    /// Put the lexicon in the forwarder org's overlay, not the node base.
    org_pattern: bool,
    /// Put the lexicon in the node base.
    node_pattern: bool,
    policy: Option<FirewallPolicy>,
    scan_outbound: bool,
    cache: bool,
    /// Credits active, so a request with an org runs detached.
    credits: bool,
    /// Core mock for the tool loop: every tool call answers this output.
    tool_output: Option<Value>,
    master_key: Option<&'static str>,
}

struct Harness {
    state: Arc<AppState>,
    app: axum::Router,
    primary: Arc<Mutex<Vec<Value>>>,
    servers: Vec<tokio::task::JoinHandle<()>>,
    _audit_dir: Option<tempfile::TempDir>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        for server in &self.servers {
            server.abort();
        }
    }
}

impl Harness {
    fn events(&self) -> Vec<Value> {
        self.state.traffic.recent()
    }

    fn primary_bodies(&self) -> Vec<Value> {
        self.primary.lock().unwrap().clone()
    }
}

async fn serve(router: axum::Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{address}"), task)
}

fn forwarder_key() -> ApiKeyConfig {
    ApiKeyConfig {
        key: FORWARDER_KEY.to_owned(),
        name: "core".to_owned(),
        org_id: Some(FORWARDER_ORG.to_owned()),
        team_id: None,
        channel_id: None,
        project_id: None,
        requests_per_minute: None,
        tokens_per_minute: None,
        token_budget_total: None,
        downgrade_to: None,
        trusted_forwarder: true,
        allowed_operations: vec![ApiKeyOperation::Inference],
    }
}

/// A control plane answering the debit, resolve and any other call with the
/// smallest body each client accepts.
async fn control_plane() -> (String, tokio::task::JoinHandle<()>) {
    let app = axum::Router::new()
        .route(
            "/api/control-plane/gateway/resolve",
            axum::routing::get(|headers: axum::http::HeaderMap| async move {
                let token = headers
                    .get("x-gateway-key")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_owned();
                if !token.starts_with("rgw_") {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(json!({
                    "organization": { "id": "org_tenant" },
                    "credential": {
                        "id": "cred_probe_0123456789",
                        "purpose": "gateway_relay",
                        "allowedOperations": ["gateway.inference"]
                    },
                    "managedInference": false,
                    "standing": { "state": "active", "refuses": "none" },
                    "platformFloorUnavailable": false
                }))
                .into_response()
            }),
        )
        .fallback(|| async {
            axum::Json(json!({ "balanceMicroUsd": 900_000, "wentNonPositive": false }))
        });
    serve(app).await
}

/// A local Core for the tool loop: every tool call answers `output`.
async fn core_mock(output: Value) -> (String, tokio::task::JoinHandle<()>) {
    let app = axum::Router::new()
        .route(
            "/api/mcp/tools/call",
            axum::routing::post(move || {
                let output = output.clone();
                async move { axum::Json(json!({ "ok": true, "output": output })) }
            }),
        )
        .route(
            "/api/tools/search",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "object": "list",
                    "data": [{
                        "id": UNIFIED_TOOL,
                        "name": "search",
                        "description": "Search the web",
                        "kind": "mcp"
                    }]
                }))
            }),
        )
        .route(
            "/api/tools/describe",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "id": UNIFIED_TOOL,
                    "name": "search",
                    "description": "Search the web.",
                    "args": [{ "name": "query", "type": "string", "description": "Search terms", "required": true }]
                }))
            }),
        )
        .fallback(|| async { axum::Json(json!({})) });
    serve(app).await
}

async fn harness(setup: Setup) -> Harness {
    let mut servers = Vec::new();
    let mut config = GatewayConfig::default();
    config.auth.require_auth = setup.forwarder || setup.custody == Some(GatewayCustody::Fleet);
    if setup.forwarder {
        config.auth.api_keys = vec![forwarder_key()];
    }
    config.auth.master_key = setup.master_key.map(str::to_owned);
    config.rate_limit.max_burst_per_second = 100_000;
    config.cache.enabled = setup.cache;
    config.routing.default_provider = ProviderId::from(PRIMARY);
    config.routing.fallback_chain = if setup.with_fallback {
        vec![ProviderId::from(FALLBACK)]
    } else {
        vec![]
    };
    config.firewall.enabled = true;
    config.firewall.scan_inbound = true;
    config.firewall.scan_outbound = setup.scan_outbound;
    config.firewall.policy = setup.policy.unwrap_or(FirewallPolicy::Block);
    config.firewall.locked_fields = Vec::new();
    if setup.node_pattern {
        config.firewall.custom_patterns = vec![pattern(NODE_PATTERN)];
    }
    let control = if setup.credits || setup.custody == Some(GatewayCustody::Fleet) {
        let (url, task) = control_plane().await;
        servers.push(task);
        Some(url)
    } else {
        None
    };
    if setup.credits {
        config.credits.enabled = true;
        config.credits.base_url = control.clone().unwrap_or_default();
        config.credits.internal_secret = Some("internal-test-secret".to_owned());
    }
    let audit_dir = setup.audit_on.then(|| tempfile::tempdir().unwrap());
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: setup.audit_on,
        db_path: audit_dir
            .as_ref()
            .map(|dir| dir.path().join("audit.db").to_string_lossy().into_owned())
            .unwrap_or_default(),
    })
    .unwrap();
    let mut state = AppState::new_for_test(
        config,
        audit,
        crate::evals::EvalsRunner::new(Default::default()),
    );
    state.custody = setup.custody.unwrap_or(GatewayCustody::SelfHosted);
    state.platform_floor.clear();
    if let Some(url) = control {
        state.resolve_cache = Some(ResolveCache::for_test(url, reqwest::Client::new()));
    }
    if let Some(output) = setup.tool_output {
        let (url, task) = core_mock(output).await;
        servers.push(task);
        state.tools = Some(crate::tools::ToolSearchClient::new(
            &CoreProviderConfig {
                base_url: url,
                token: None,
            },
            reqwest::Client::builder().no_proxy().build().unwrap(),
        ));
    }
    let primary = Arc::new(Mutex::new(Vec::new()));
    let reply = setup.reply.unwrap_or_else(|| "ok".to_owned());
    state.provider_runtime.register_for_test(Arc::new(Fixture {
        name: PRIMARY,
        reply: reply.clone(),
        fail_first: setup.fail_primary_once,
        script: setup.script.clone(),
        calls: Arc::clone(&primary),
    }));
    state.provider_runtime.register_for_test(Arc::new(Fixture {
        name: FALLBACK,
        reply,
        fail_first: false,
        script: setup.script,
        calls: Arc::new(Mutex::new(Vec::new())),
    }));
    if setup.org_pattern {
        state.resolver.set_org_overlay(
            FORWARDER_ORG.to_owned(),
            FirewallOverlay {
                custom_patterns: vec![pattern(ORG_PATTERN)],
                ..FirewallOverlay::default()
            },
        );
    }
    let state = Arc::new(state);
    Harness {
        app: crate::api::router(Arc::clone(&state)),
        state,
        primary,
        servers,
        _audit_dir: audit_dir,
    }
}

fn loopback() -> axum::extract::ConnectInfo<std::net::SocketAddr> {
    axum::extract::ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 9)))
}

fn post(uri: &str, token: Option<&str>, body: &Value, headers: &[(&str, &str)]) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .extension(loopback());
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::from(body.to_string())).unwrap()
}

/// Send and read the whole body, so a stream finishes and writes its row.
async fn send(harness: &Harness, request: Request<Body>) -> (StatusCode, String) {
    let response = harness.app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn chat(stream: bool, content: &str) -> Value {
    json!({
        "model": "fixture-model",
        "stream": stream,
        "messages": [{ "role": "user", "content": content }]
    })
}

fn token(setup_forwarder: bool) -> Option<&'static str> {
    setup_forwarder.then_some(FORWARDER_KEY)
}

/// Wait briefly for a row a spawned task writes (a stream end or a detached
/// run), then return the first event of `kind`.
async fn wait_for(harness: &Harness, kind: &str) -> Option<Value> {
    for _ in 0..100 {
        if let Some(event) = harness.events().into_iter().find(|e| e["kind"] == kind) {
            return Some(event);
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    None
}

/// No event carries a marker, a full key or a pattern name of the floor.
fn assert_no_leak(harness: &Harness, what: &str) {
    for event in harness.events() {
        let serialized = event.to_string();
        for private in [
            LEXICON,
            AWS_EXAMPLE_KEY,
            TEST_CARD,
            FORWARDER_KEY,
            TENANT_TOKEN,
            FLOOR_PATTERN,
        ] {
            assert!(
                !serialized.contains(private),
                "GAP {what}: event leaked {private}: {serialized}"
            );
        }
        for absent in ["end_user_hash", "messages", "prompt"] {
            assert!(
                event.get(absent).is_none(),
                "{what}: event carries {absent}"
            );
        }
    }
}

/// Every event of a blocked request reports the block by `layer`.
fn assert_blocked_by(harness: &Harness, layer: &str, what: &str) {
    let events = harness.events();
    assert!(!events.is_empty(), "GAP {what}: no event on the feed");
    assert!(
        events.iter().any(|e| e["verdict"]["action"] == "block"),
        "GAP {what}: no event reports the block: {events:#?}"
    );
    for event in &events {
        assert_eq!(
            event["verdict"]["action"], "block",
            "GAP {what}: an event of a blocked request reads otherwise: {event}"
        );
        assert_eq!(
            event["verdict"]["decided_by"], layer,
            "GAP {what}: wrong deciding layer: {event}"
        );
    }
    assert_no_leak(harness, what);
}

/// The completion of an allowed request names its route, origin and stages.
fn assert_completion(event: &Value, route: &str, what: &str) {
    assert_eq!(event["route"], route, "GAP {what}: route: {event}");
    assert_ne!(
        event["credential_origin"], "unknown",
        "GAP {what}: origin unknown on a completion: {event}"
    );
    assert!(
        event["stage_latency_ms"]["screen"].is_u64(),
        "GAP {what}: no screen latency: {event}"
    );
    assert!(
        event["stage_latency_ms"]["upstream"].is_u64(),
        "GAP {what}: no upstream latency: {event}"
    );
    assert!(event["seq"].is_u64(), "{what}: no seq");
}

// ─── Detached (metered) runs ───────────────────────────────────────────────

#[tokio::test]
async fn probe_a_detached_metered_run_keeps_its_route() {
    let harness = harness(Setup {
        forwarder: true,
        credits: true,
        ..Setup::default()
    })
    .await;
    let (status, body) = send(
        &harness,
        post(
            "/v1/chat/completions",
            token(true),
            &chat(false, "hello"),
            &[],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let event = wait_for(&harness, "completion").await.expect("completion");
    assert_eq!(event["org_id"], FORWARDER_ORG);
    assert_eq!(event["api_key"], "sk-pro***");
    assert_eq!(event["credential_id_prefix"], Value::Null);
    assert_completion(&event, "/v1/chat/completions", "detached buffered chat");
    assert_no_leak(&harness, "detached buffered chat");
}

#[tokio::test]
async fn probe_a_detached_metered_block_keeps_its_route() {
    let harness = harness(Setup {
        forwarder: true,
        credits: true,
        org_pattern: true,
        ..Setup::default()
    })
    .await;
    let (status, body) = send(
        &harness,
        post(
            "/v1/chat/completions",
            token(true),
            &chat(false, &lexicon_only()),
            &[],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let event = wait_for(&harness, "failure").await.expect("failure");
    assert_eq!(event["route"], "/v1/chat/completions", "GAP route: {event}");
    assert_blocked_by(&harness, "org", "detached block");
}

// ─── Streaming vs buffered ─────────────────────────────────────────────────

#[tokio::test]
async fn probe_a_streamed_completion_carries_route_stages_and_origin() {
    let harness = harness(Setup::default()).await;
    let (status, body) = send(
        &harness,
        post("/v1/chat/completions", None, &chat(true, "hello"), &[]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let event = wait_for(&harness, "completion").await.expect("completion");
    assert_eq!(event["verdict"]["action"], "allow");
    assert_eq!(event["credential_origin"], "node_operator");
    assert_completion(&event, "/v1/chat/completions", "streamed chat");
}

#[tokio::test]
async fn probe_a_streamed_sanitize_rides_on_the_completion() {
    let harness = harness(Setup {
        forwarder: true,
        org_pattern: true,
        policy: Some(FirewallPolicy::Sanitize),
        ..Setup::default()
    })
    .await;
    let (status, body) = send(
        &harness,
        post(
            "/v1/chat/completions",
            token(true),
            &chat(true, &format!("echo {LEXICON}")),
            &[],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!json!(harness.primary_bodies())
        .to_string()
        .contains(LEXICON));
    let event = wait_for(&harness, "completion").await.expect("completion");
    assert_eq!(event["verdict"]["decided_by"], "org", "{event}");
    assert_eq!(event["verdict"]["action"], "sanitize", "{event}");
    assert_eq!(event["verdict"]["detector_ids"], json!([ORG_PATTERN]));
    assert_completion(&event, "/v1/chat/completions", "streamed sanitize");
    assert_no_leak(&harness, "streamed sanitize");
}

#[tokio::test]
async fn probe_a_streamed_block_is_attributed_to_the_org() {
    let harness = harness(Setup {
        forwarder: true,
        org_pattern: true,
        ..Setup::default()
    })
    .await;
    let (status, body) = send(
        &harness,
        post(
            "/v1/chat/completions",
            token(true),
            &chat(true, &lexicon_only()),
            &[],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let event = wait_for(&harness, "failure").await.expect("failure");
    assert_eq!(event["verdict"]["code"], "policy_violation");
    assert_eq!(event["route"], "/v1/chat/completions");
    assert_blocked_by(&harness, "org", "streamed block");
}

#[tokio::test]
async fn probe_a_buffered_outbound_sanitize_is_reported() {
    let harness = harness(Setup {
        node_pattern: true,
        policy: Some(FirewallPolicy::Sanitize),
        scan_outbound: true,
        reply: Some(format!("the answer is {LEXICON}")),
        ..Setup::default()
    })
    .await;
    let (status, body) = send(
        &harness,
        post("/v1/chat/completions", None, &chat(false, "hello"), &[]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!body.contains(LEXICON), "the reply was redacted: {body}");
    let event = wait_for(&harness, "completion").await.expect("completion");
    assert_eq!(
        event["verdict"]["action"], "sanitize",
        "GAP outbound sanitize: {event}"
    );
    assert_eq!(event["verdict"]["decided_by"], "node", "{event}");
    assert_no_leak(&harness, "outbound sanitize");
}

#[tokio::test]
async fn probe_a_buffered_outbound_block_is_reported_as_a_block() {
    let harness = harness(Setup {
        forwarder: true,
        org_pattern: true,
        scan_outbound: true,
        reply: Some(format!("the answer is {LEXICON}")),
        ..Setup::default()
    })
    .await;
    let (status, body) = send(
        &harness,
        post(
            "/v1/chat/completions",
            token(true),
            &chat(false, "hello"),
            &[],
        ),
    )
    .await;
    assert!(!body.contains(LEXICON), "the reply was withheld: {body}");
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_blocked_by(&harness, "org", "buffered outbound block");
}

// ─── Compat routes ─────────────────────────────────────────────────────────

fn anthropic(stream: bool, content: &str) -> Value {
    json!({
        "model": "fixture-model",
        "max_tokens": 64,
        "stream": stream,
        "messages": [{ "role": "user", "content": content }]
    })
}

fn responses(stream: bool, content: &str) -> Value {
    json!({
        "model": "fixture-model",
        "stream": stream,
        "input": [{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": content }] }]
    })
}

fn gemini(content: &str) -> Value {
    json!({ "contents": [{ "role": "user", "parts": [{ "text": content }] }] })
}

const GEMINI_GENERATE: &str = "/v1beta/models/fixture-model:generateContent";
const GEMINI_STREAM: &str = "/v1beta/models/fixture-model:streamGenerateContent?alt=sse";

/// Each compat route, buffered and streamed: (uri, route template, body).
fn compat_cases(content: &str) -> Vec<(&'static str, &'static str, Value)> {
    vec![
        ("/v1/messages", "/v1/messages", anthropic(false, content)),
        ("/v1/messages", "/v1/messages", anthropic(true, content)),
        ("/v1/responses", "/v1/responses", responses(false, content)),
        ("/v1/responses", "/v1/responses", responses(true, content)),
        (GEMINI_GENERATE, "/v1beta/models/:spec", gemini(content)),
        (GEMINI_STREAM, "/v1beta/models/:spec", gemini(content)),
    ]
}

async fn compat_allow(uri: &str, route: &str, body: Value) {
    let what = format!("{uri} stream={}", body["stream"]);
    let harness = harness(Setup::default()).await;
    let (status, text) = send(&harness, post(uri, None, &body, &[])).await;
    assert_eq!(status, StatusCode::OK, "{what}: {text}");
    let event = wait_for(&harness, "completion")
        .await
        .unwrap_or_else(|| panic!("GAP {what}: no completion: {:#?}", harness.events()));
    assert_eq!(event["verdict"]["action"], "allow", "{what}");
    assert_completion(&event, route, &what);
    assert!(
        !event.to_string().contains("fixture-model:"),
        "GAP {what}: raw path segment on the feed: {event}"
    );
}

async fn compat_block(uri: &str, route: &str, body: Value) {
    let what = format!("{uri} stream={}", body["stream"]);
    let harness = harness(Setup {
        forwarder: true,
        org_pattern: true,
        ..Setup::default()
    })
    .await;
    let (status, text) = send(&harness, post(uri, token(true), &body, &[])).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{what}: {text}");
    assert_eq!(harness.primary_bodies().len(), 0, "{what}: dispatched");
    let event = wait_for(&harness, "failure")
        .await
        .unwrap_or_else(|| panic!("GAP {what}: no failure: {:#?}", harness.events()));
    assert_eq!(event["route"], route, "GAP {what}: route: {event}");
    assert_eq!(event["verdict"]["code"], "policy_violation", "{what}");
    assert_blocked_by(&harness, "org", &what);
}

async fn compat_sanitize(uri: &str, route: &str, body: Value) {
    let what = format!("{uri} stream={}", body["stream"]);
    let harness = harness(Setup {
        forwarder: true,
        org_pattern: true,
        policy: Some(FirewallPolicy::Sanitize),
        ..Setup::default()
    })
    .await;
    let (status, text) = send(&harness, post(uri, token(true), &body, &[])).await;
    assert_eq!(status, StatusCode::OK, "{what}: {text}");
    assert!(
        !json!(harness.primary_bodies())
            .to_string()
            .contains(LEXICON),
        "{what}: sanitized upstream"
    );
    let event = wait_for(&harness, "completion")
        .await
        .unwrap_or_else(|| panic!("GAP {what}: no completion: {:#?}", harness.events()));
    assert_eq!(event["route"], route, "GAP {what}: route");
    assert_eq!(event["verdict"]["decided_by"], "org", "GAP {what}: {event}");
    assert_eq!(
        event["verdict"]["action"], "sanitize",
        "GAP {what}: {event}"
    );
    assert_no_leak(&harness, &what);
}

const MESSAGES: &str = "/v1/messages";
const RESPONSES: &str = "/v1/responses";
const GEMINI_ROUTE: &str = "/v1beta/models/:spec";

#[tokio::test]
async fn probe_messages_buffered_allow() {
    compat_allow(MESSAGES, MESSAGES, anthropic(false, "hello")).await;
}

#[tokio::test]
async fn probe_messages_streamed_allow() {
    compat_allow(MESSAGES, MESSAGES, anthropic(true, "hello")).await;
}

#[tokio::test]
async fn probe_responses_buffered_allow() {
    compat_allow(RESPONSES, RESPONSES, responses(false, "hello")).await;
}

#[tokio::test]
async fn probe_responses_streamed_allow() {
    compat_allow(RESPONSES, RESPONSES, responses(true, "hello")).await;
}

#[tokio::test]
async fn probe_gemini_buffered_allow() {
    compat_allow(GEMINI_GENERATE, GEMINI_ROUTE, gemini("hello")).await;
}

#[tokio::test]
async fn probe_gemini_streamed_allow() {
    compat_allow(GEMINI_STREAM, GEMINI_ROUTE, gemini("hello")).await;
}

#[tokio::test]
async fn probe_messages_buffered_block() {
    compat_block(MESSAGES, MESSAGES, anthropic(false, &lexicon_only())).await;
}

#[tokio::test]
async fn probe_messages_streamed_block() {
    compat_block(MESSAGES, MESSAGES, anthropic(true, &lexicon_only())).await;
}

#[tokio::test]
async fn probe_responses_buffered_block() {
    compat_block(RESPONSES, RESPONSES, responses(false, &lexicon_only())).await;
}

#[tokio::test]
async fn probe_responses_streamed_block() {
    compat_block(RESPONSES, RESPONSES, responses(true, &lexicon_only())).await;
}

#[tokio::test]
async fn probe_gemini_buffered_block() {
    compat_block(GEMINI_GENERATE, GEMINI_ROUTE, gemini(&lexicon_only())).await;
}

#[tokio::test]
async fn probe_gemini_streamed_block() {
    compat_block(GEMINI_STREAM, GEMINI_ROUTE, gemini(&lexicon_only())).await;
}

#[tokio::test]
async fn probe_messages_buffered_sanitize() {
    compat_sanitize(MESSAGES, MESSAGES, anthropic(false, &lexicon_only())).await;
}

#[tokio::test]
async fn probe_messages_streamed_sanitize() {
    compat_sanitize(MESSAGES, MESSAGES, anthropic(true, &lexicon_only())).await;
}

#[tokio::test]
async fn probe_responses_buffered_sanitize() {
    compat_sanitize(RESPONSES, RESPONSES, responses(false, &lexicon_only())).await;
}

#[tokio::test]
async fn probe_responses_streamed_sanitize() {
    compat_sanitize(RESPONSES, RESPONSES, responses(true, &lexicon_only())).await;
}

#[tokio::test]
async fn probe_gemini_buffered_sanitize() {
    compat_sanitize(GEMINI_GENERATE, GEMINI_ROUTE, gemini(&lexicon_only())).await;
}

#[tokio::test]
async fn probe_gemini_streamed_sanitize() {
    compat_sanitize(GEMINI_STREAM, GEMINI_ROUTE, gemini(&lexicon_only())).await;
}

// ─── Multimodal routes ─────────────────────────────────────────────────────

const IMAGES: &str = "/v1/images/generations";
const EMBEDDINGS: &str = "/v1/embeddings";

fn image(content: &str) -> Value {
    json!({ "model": "fixture-image", "prompt": content })
}

fn embedding(content: &str) -> Value {
    json!({ "model": "fixture-embed", "input": content })
}

async fn multimodal_completion(uri: &str, body: Value) {
    let harness = harness(Setup::default()).await;
    let (status, text) = send(&harness, post(uri, None, &body, &[])).await;
    assert_eq!(status, StatusCode::OK, "{uri}: {text}");
    let event = wait_for(&harness, "completion")
        .await
        .unwrap_or_else(|| panic!("GAP {uri}: no completion: {:#?}", harness.events()));
    assert_completion(&event, uri, uri);
}

async fn multimodal_block(uri: &str, body: Value) {
    let harness = harness(Setup {
        forwarder: true,
        org_pattern: true,
        ..Setup::default()
    })
    .await;
    let (status, text) = send(&harness, post(uri, token(true), &body, &[])).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {text}");
    let event = wait_for(&harness, "failure")
        .await
        .unwrap_or_else(|| panic!("GAP {uri}: no failure: {:#?}", harness.events()));
    assert_eq!(event["route"], uri, "{uri}");
    assert_blocked_by(&harness, "org", uri);
}

async fn multimodal_sanitize(uri: &str, body: Value) {
    let harness = harness(Setup {
        node_pattern: true,
        policy: Some(FirewallPolicy::Sanitize),
        ..Setup::default()
    })
    .await;
    let (status, text) = send(&harness, post(uri, None, &body, &[])).await;
    assert_eq!(status, StatusCode::OK, "{uri}: {text}");
    assert!(
        !json!(harness.primary_bodies())
            .to_string()
            .contains(LEXICON),
        "{uri}: sanitized upstream"
    );
    let event = wait_for(&harness, "completion")
        .await
        .unwrap_or_else(|| panic!("GAP {uri}: no completion: {:#?}", harness.events()));
    assert_eq!(
        event["verdict"]["action"], "sanitize",
        "GAP {uri}: sanitize not on the feed: {event}"
    );
    assert_eq!(event["verdict"]["decided_by"], "node", "{uri}: {event}");
    assert_no_leak(&harness, uri);
}

#[tokio::test]
async fn probe_image_completion_carries_route_and_stages() {
    multimodal_completion(IMAGES, image("a watercolor cat")).await;
}

#[tokio::test]
async fn probe_embedding_completion_carries_route_and_stages() {
    multimodal_completion(EMBEDDINGS, embedding("hello")).await;
}

#[tokio::test]
async fn probe_image_block_is_attributed_to_the_org() {
    multimodal_block(IMAGES, image(&lexicon_only())).await;
}

#[tokio::test]
async fn probe_embedding_block_is_attributed_to_the_org() {
    multimodal_block(EMBEDDINGS, embedding(&lexicon_only())).await;
}

#[tokio::test]
async fn probe_image_sanitize_is_reported() {
    multimodal_sanitize(IMAGES, image(&lexicon_only())).await;
}

#[tokio::test]
async fn probe_embedding_sanitize_is_reported() {
    multimodal_sanitize(EMBEDDINGS, embedding(&lexicon_only())).await;
}

#[tokio::test]
async fn probe_a_fleet_floor_block_on_an_image_names_only_the_kind() {
    let harness = harness(Setup {
        custody: Some(GatewayCustody::Fleet),
        ..Setup::default()
    })
    .await;
    harness.state.platform_floor.observe(Some(&floor()));
    let (status, text) = send(
        &harness,
        post(IMAGES, Some(TENANT_TOKEN), &image(&lexicon_only()), &[]),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
    let event = wait_for(&harness, "failure").await.expect("failure");
    assert_eq!(event["org_id"], "org_tenant");
    assert_eq!(event["credential_id_prefix"], "cred_pro***");
    assert_blocked_by(&harness, "platform_floor", "fleet image floor block");
}

fn floor() -> Arc<PlatformFloor> {
    PlatformFloor::from_wire(
        Some(&json!({
            "version": 1,
            "contentHash": "hash-probe",
            "issuedAt": "2026-10-23T09:00:00.000Z",
            "overlay": {
                "enabled": true,
                "scan_inbound": true,
                "policy": "block",
                "custom_patterns": [{ "name": FLOOR_PATTERN, "regex": LEXICON, "kind": "secret" }]
            },
            "allowedProviders": [],
            "allowedModels": []
        })),
        false,
    )
    .expect("valid floor")
}

// ─── Provider calls ────────────────────────────────────────────────────────

/// A trusted forwarder's provider call with the lexicon in its body, on a
/// Gateway whose Treg points at a dead address: a block never dispatches.
fn provider_call(body: Value) -> Value {
    json!({
        "provider": "treg",
        "toolId": "x.post.create",
        "operation": "execute",
        "method": "POST",
        "query": [],
        "body": body,
        "requestId": "req-probe-provider-call",
        "callerId": "@ryu/probe",
    })
}

async fn provider_call_harness(audit_on: bool) -> Harness {
    let harness = harness(Setup {
        forwarder: true,
        node_pattern: true,
        audit_on,
        ..Setup::default()
    })
    .await;
    harness
}

#[tokio::test]
async fn probe_a_provider_call_block_with_audit_on_reports_the_block() {
    let harness = provider_call_harness(true).await;
    let (status, text) = send(
        &harness,
        post(
            "/v1/providers/call",
            token(true),
            &provider_call(json!({ "text": prompt() })),
            &[],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
    let event = wait_for(&harness, "failure")
        .await
        .unwrap_or_else(|| panic!("GAP: no failure: {:#?}", harness.events()));
    assert_eq!(event["route"], "/v1/providers/call", "{event}");
    assert_eq!(event["status"], 403, "GAP provider call status: {event}");
    assert_eq!(
        event["verdict"]["code"], "policy_violation",
        "GAP provider call code: {event}"
    );
    assert_blocked_by(&harness, "node", "provider call, audit on");
}

#[tokio::test]
async fn probe_a_provider_call_block_with_audit_off_reaches_the_feed() {
    let harness = provider_call_harness(false).await;
    let (status, text) = send(
        &harness,
        post(
            "/v1/providers/call",
            token(true),
            &provider_call(json!({ "text": prompt() })),
            &[],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
    assert!(
        wait_for(&harness, "failure").await.is_some(),
        "GAP provider call, audit off: the block never reached the feed: {:#?}",
        harness.events()
    );
    assert_no_leak(&harness, "provider call, audit off");
}

// ─── Tool-loop rounds ──────────────────────────────────────────────────────

fn tool_call_turn() -> Value {
    json!({
        "role": "assistant",
        "content": null,
        "tool_calls": [{
            "id": "call_1",
            "type": "function",
            "function": {
                "name": crate::tools::catalog_client::model_tool_name(UNIFIED_TOOL),
                "arguments": json!({ "query": "weather" }).to_string()
            }
        }]
    })
}

#[tokio::test]
async fn probe_a_tool_loop_round_block_is_attributed_to_the_org() {
    let harness = harness(Setup {
        forwarder: true,
        org_pattern: true,
        script: vec![tool_call_turn()],
        tool_output: Some(json!({ "result": format!("found {LEXICON}") })),
        ..Setup::default()
    })
    .await;
    let (status, text) = send(
        &harness,
        post(
            "/v1/chat/completions",
            token(true),
            &chat(false, "look up the weather"),
            &[("x-ryu-tools", UNIFIED_TOOL)],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
    let events = harness.events();
    let failure = events
        .iter()
        .find(|e| e["kind"] == "failure")
        .unwrap_or_else(|| panic!("GAP: no failure: {events:#?}"));
    assert!(
        events
            .iter()
            .any(|e| e["verdict"]["decided_by"] == "org" && e["verdict"]["action"] == "block"),
        "GAP tool-loop block not attributed: {events:#?}"
    );
    for event in events.iter().filter(|e| e["kind"] == "failure") {
        assert_eq!(
            event["verdict"]["action"], "block",
            "GAP tool-loop failure row: {event}"
        );
    }
    assert_eq!(failure["route"], "/v1/chat/completions");
    for event in &events {
        assert!(
            event["route"].is_string(),
            "GAP tool round without route: {event}"
        );
    }
    assert_no_leak(&harness, "tool-loop block");
}

#[tokio::test]
async fn probe_a_benign_tool_loop_publishes_routed_rows() {
    let harness = harness(Setup {
        script: vec![tool_call_turn()],
        tool_output: Some(json!({ "result": "sunny" })),
        ..Setup::default()
    })
    .await;
    let (status, text) = send(
        &harness,
        post(
            "/v1/chat/completions",
            None,
            &chat(false, "look up the weather"),
            &[("x-ryu-tools", UNIFIED_TOOL)],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let events = harness.events();
    assert!(!events.is_empty(), "GAP: no events");
    for event in &events {
        assert_eq!(event["route"], "/v1/chat/completions", "GAP {event}");
        assert_eq!(event["verdict"]["action"], "allow", "{event}");
    }
    let seqs: Vec<u64> = events.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
    assert!(seqs.windows(2).all(|pair| pair[0] < pair[1]));
}

// ─── Retries and fallback ──────────────────────────────────────────────────

#[tokio::test]
async fn probe_a_fallback_completion_keeps_the_noted_sanitize() {
    for stream in [false, true] {
        let harness = harness(Setup {
            node_pattern: true,
            policy: Some(FirewallPolicy::Sanitize),
            fail_primary_once: true,
            with_fallback: true,
            ..Setup::default()
        })
        .await;
        let (status, text) = send(
            &harness,
            post(
                "/v1/chat/completions",
                None,
                &chat(stream, &format!("echo {LEXICON}")),
                &[],
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "stream={stream}: {text}");
        let event = wait_for(&harness, "completion").await.expect("completion");
        assert_eq!(event["provider"], FALLBACK, "stream={stream}: {event}");
        assert_eq!(
            event["verdict"]["action"], "sanitize",
            "GAP stream={stream}: {event}"
        );
        assert_eq!(event["verdict"]["decided_by"], "node", "stream={stream}");
        assert_completion(&event, "/v1/chat/completions", "fallback");
        for other in harness.events().iter().filter(|e| e["kind"] == "failure") {
            assert_ne!(other["verdict"]["action"], "block", "{other}");
        }
        assert_no_leak(&harness, "fallback");
    }
}

#[tokio::test]
async fn probe_an_exhausted_chain_reports_a_provider_failure_without_its_text() {
    let harness = harness(Setup {
        fail_primary_once: true,
        ..Setup::default()
    })
    .await;
    let (status, text) = send(
        &harness,
        post("/v1/chat/completions", None, &chat(false, "hello"), &[]),
    )
    .await;
    assert!(status.is_server_error(), "{status}: {text}");
    let event = wait_for(&harness, "failure").await.expect("failure");
    assert_eq!(event["verdict"]["decided_by"], "none", "{event}");
    assert_eq!(event["verdict"]["action"], "allow", "{event}");
    assert_eq!(event["status"], status.as_u16(), "{event}");
    assert!(event["verdict"]["code"].is_string(), "{event}");
    assert_eq!(event["route"], "/v1/chat/completions");
    assert_no_leak(&harness, "exhausted chain");
}

// ─── Cache hits ────────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_a_cache_hit_is_local_and_keeps_its_sanitize() {
    let harness = harness(Setup {
        cache: true,
        node_pattern: true,
        policy: Some(FirewallPolicy::Sanitize),
        ..Setup::default()
    })
    .await;
    let body = chat(false, &format!("echo {LEXICON}"));
    for _ in 0..2 {
        let (status, text) = send(&harness, post("/v1/chat/completions", None, &body, &[])).await;
        assert_eq!(status, StatusCode::OK, "{text}");
    }
    assert_eq!(
        harness.primary_bodies().len(),
        1,
        "the second was served from cache"
    );
    let hit = wait_for(&harness, "cache_hit")
        .await
        .unwrap_or_else(|| panic!("GAP: no cache_hit: {:#?}", harness.events()));
    assert_eq!(hit["credential_origin"], "local", "{hit}");
    assert_eq!(hit["route"], "/v1/chat/completions", "GAP {hit}");
    assert_eq!(hit["stage_latency_ms"]["upstream"], Value::Null, "{hit}");
    assert!(hit["stage_latency_ms"]["screen"].is_u64(), "GAP {hit}");
    assert_eq!(hit["verdict"]["action"], "sanitize", "GAP {hit}");
    assert_eq!(hit["status"], 200);
    assert_no_leak(&harness, "cache hit");
}

// ─── Trusted forwarder vs rgw_ key, and the org scope ──────────────────────

#[tokio::test]
async fn probe_a_forwarder_and_a_tenant_key_land_in_their_own_org() {
    let master = "traffic-probe-master-key";
    let harness = harness(Setup {
        custody: Some(GatewayCustody::Fleet),
        forwarder: true,
        master_key: Some(master),
        ..Setup::default()
    })
    .await;
    harness.state.platform_floor.observe(Some(&floor()));
    for token in [FORWARDER_KEY, TENANT_TOKEN] {
        let (status, text) = send(
            &harness,
            post(
                "/v1/chat/completions",
                Some(token),
                &chat(false, "hello"),
                &[],
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{token}: {text}");
    }
    let events = harness.events();
    let orgs: Vec<&str> = events.iter().filter_map(|e| e["org_id"].as_str()).collect();
    assert!(orgs.contains(&FORWARDER_ORG), "{events:#?}");
    assert!(orgs.contains(&"org_tenant"), "{events:#?}");
    for event in &events {
        assert_eq!(event["custody"], "fleet");
        assert_eq!(event["route"], "/v1/chat/completions", "GAP {event}");
    }
    assert_no_leak(&harness, "forwarder and tenant");

    for (org, other) in [(FORWARDER_ORG, "org_tenant"), ("org_tenant", FORWARDER_ORG)] {
        let response = harness
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/traffic?org={org}"))
                    .header("authorization", format!("Bearer {master}"))
                    .extension(loopback())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let seen = read_sse(response.into_body()).await;
        assert!(!seen.is_empty(), "{org}: no events");
        assert!(
            seen.iter().all(|e| e["org_id"] == org),
            "GAP {org} saw {other}: {seen:#?}"
        );
    }
}

/// Read SSE `data:` payloads until the stream is quiet for a moment.
async fn read_sse(body: Body) -> Vec<Value> {
    use futures_util::StreamExt;
    let mut stream = body.into_data_stream();
    let mut text = String::new();
    while let Ok(Some(Ok(chunk))) =
        tokio::time::timeout(std::time::Duration::from_millis(300), stream.next()).await
    {
        text.push_str(&String::from_utf8_lossy(&chunk));
    }
    text.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|data| serde_json::from_str(data).expect("event JSON"))
        .collect()
}
