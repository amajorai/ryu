//! Coverage probes for the hazard screener glue (screener addendum sections
//! 5 to 9 and 13.1 G3/G4, spec 02.5 to 02.12). They reach the screener through
//! the real router wherever a route exists: the unified tool loop against a
//! mock Core, fallback attempts across two providers, the compat dialects
//! buffered and streamed, the response cache, the systemone wire against the
//! mock decision server, and self-hosted custody.
//!
//! Content is the spec 00.9 sentinels only. A context-reading test backend
//! stands in for a decision model that reads the `context` it is sent; it
//! scores the same sentinels, never real text.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::routing::{get, post};
use axum::Json;
use ryu_gw_screening::backends::test::{sentinel_codes, SENTINEL_HAZARD_S4};
use ryu_gw_screening::{
    BackendDescriptor, BackendHealth, BackendVerdict, ConfidenceSource, ItemVerdict, ModelSignal,
    ScreenRequest,
};

use super::*;
use crate::config::{ApiKeyConfig, ApiKeyOperation, CoreProviderConfig, FirewallOverlay};
use crate::tools::{catalog_client::model_tool_name, ToolSearchClient};

const PRIMARY: &str = "screening-primary";
const SPARE: &str = "screening-spare";
const TENANT: &str = "screening-tenant-key";
const UNIFIED_TOOL: &str = "exa.search";

// ── harness ────────────────────────────────────────────────────────────────

/// `build_state` with a config hook and a provider hook.
fn gateway_with(
    custody: GatewayCustody,
    runtime: ScreeningRuntime,
    floor: Option<Arc<PlatformFloor>>,
    reply: &str,
    configure: impl FnOnce(&mut GatewayConfig),
    register: impl FnOnce(&mut AppState),
) -> Gateway {
    let mut config = GatewayConfig::default();
    config.auth.require_auth = true;
    config.auth.master_key = Some(MASTER.to_owned());
    config.cache.enabled = false;
    config.routing.default_provider = ProviderId::from(FIXTURE);
    config.routing.fallback_chain = vec![];
    configure(&mut config);
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let mut state = AppState::new_for_test(config, audit, EvalsRunner::new(Default::default()));
    state.custody = custody;
    state.screening = Arc::new(runtime);
    if let Some(floor) = floor {
        state.platform_floor = FloorStore::with(floor);
    }
    let calls = Arc::new(AtomicUsize::new(0));
    state.provider_runtime.register_for_test(Arc::new(Upstream {
        calls: Arc::clone(&calls),
        reply: reply.to_owned(),
    }));
    register(&mut state);
    let state = Arc::new(state);
    Gateway {
        app: crate::api::router(Arc::clone(&state)),
        state,
        calls,
    }
}

fn qualified_floor(version: u64) -> Arc<PlatformFloor> {
    floor(
        version,
        Some(screener_json(&["decision_local"], true, json!({}))),
    )
}

async fn send_with(
    app: &Router,
    method: Method,
    uri: &str,
    bearer: &str,
    headers: &[(&str, &str)],
    body: Option<&Value>,
) -> (StatusCode, HeaderMap, String) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {bearer}"))
        .extension(ConnectInfo(std::net::SocketAddr::from((
            [203, 0, 113, 7],
            40_000,
        ))));
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = app
        .clone()
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
                .expect("request builds"),
        )
        .await
        .expect("router responds");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body reads");
    (
        status,
        headers,
        String::from_utf8_lossy(&bytes).into_owned(),
    )
}

fn short(raw: &str) -> String {
    raw.chars().take(300).collect()
}

fn ctx_for(org: &str) -> crate::pipeline::RequestContext {
    let mut ctx = plain_ctx();
    ctx.org_id = Some(org.to_owned());
    ctx
}

/// A provider with a fixed name: `reply` answers, `None` fails like an outage
/// so the pipeline moves to the next member of the fallback chain.
struct Named {
    name: &'static str,
    calls: Arc<AtomicUsize>,
    reply: Option<String>,
}

impl Provider for Named {
    fn name(&self) -> &'static str {
        self.name
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let reply = self.reply.clone();
        Box::pin(async move {
            let Some(reply) = reply else {
                return Err(ryu_gw_providers::ProviderError::Provider(
                    "screening probe primary is down".to_owned(),
                ));
            };
            Ok(json!({
                "id": "chatcmpl-screening-named",
                "object": "chat.completion",
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": reply },
                    "finish_reason": "stop"
                }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
            }))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> ProviderFuture<'a, Body> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Err(ryu_gw_providers::ProviderError::Provider(
                "screening probe streams are not served here".to_owned(),
            ))
        })
    }
}

type Bodies = Arc<std::sync::Mutex<Vec<Value>>>;

/// Records every body it is sent and answers "ok".
struct Capture {
    bodies: Bodies,
}

impl Provider for Capture {
    fn name(&self) -> &'static str {
        FIXTURE
    }

    fn complete<'a>(&'a self, _model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        self.bodies.lock().unwrap().push(body.clone());
        Box::pin(async {
            Ok(json!({
                "id": "chatcmpl-screening-capture",
                "object": "chat.completion",
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": "ok" },
                    "finish_reason": "stop"
                }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
            }))
        })
    }

    fn complete_stream<'a>(&'a self, _model: &'a str, body: &'a Value) -> ProviderFuture<'a, Body> {
        self.bodies.lock().unwrap().push(body.clone());
        Box::pin(async {
            Err(ryu_gw_providers::ProviderError::Provider(
                "capture does not stream".to_owned(),
            ))
        })
    }
}

/// A gateway with a qualified floor whose only provider records bodies.
fn capture_gateway(
    custody: GatewayCustody,
    runtime: ScreeningRuntime,
    configure: impl FnOnce(&mut GatewayConfig),
    register: impl FnOnce(&mut AppState),
) -> (Gateway, Bodies) {
    let bodies: Bodies = Arc::default();
    let recorded = Arc::clone(&bodies);
    let gateway = gateway_with(
        custody,
        runtime,
        Some(qualified_floor(3)),
        "unused",
        configure,
        move |state| {
            state
                .provider_runtime
                .register_for_test(Arc::new(Capture { bodies: recorded }));
            register(state);
        },
    );
    (gateway, bodies)
}

struct Pair {
    gateway: Gateway,
    primary: Arc<AtomicUsize>,
    spare: Arc<AtomicUsize>,
}

/// A Fleet gateway whose default provider is `PRIMARY`, with `SPARE` behind
/// it in the fallback chain.
fn fallback_pair(
    runtime: ScreeningRuntime,
    floor: Option<Arc<PlatformFloor>>,
    primary_reply: Option<&str>,
    spare_reply: &str,
) -> Pair {
    let primary = Arc::new(AtomicUsize::new(0));
    let spare = Arc::new(AtomicUsize::new(0));
    let (p, s) = (Arc::clone(&primary), Arc::clone(&spare));
    let primary_reply = primary_reply.map(str::to_owned);
    let spare_reply = spare_reply.to_owned();
    let gateway = gateway_with(
        GatewayCustody::Fleet,
        runtime,
        floor,
        "unused",
        |config| {
            config.routing.default_provider = ProviderId::from(PRIMARY);
            config.routing.fallback_chain =
                vec![ProviderId::from(PRIMARY), ProviderId::from(SPARE)];
        },
        move |state| {
            state.provider_runtime.register_for_test(Arc::new(Named {
                name: PRIMARY,
                calls: p,
                reply: primary_reply,
            }));
            state.provider_runtime.register_for_test(Arc::new(Named {
                name: SPARE,
                calls: s,
                reply: Some(spare_reply),
            }));
        },
    );
    Pair {
        gateway,
        primary,
        spare,
    }
}

/// Answers round 1 with a call to [`UNIFIED_TOOL`] carrying `arguments`, and
/// every later round with a plain answer.
struct ToolRounds {
    calls: Arc<AtomicUsize>,
    arguments: String,
}

impl Provider for ToolRounds {
    fn name(&self) -> &'static str {
        FIXTURE
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        let round = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let message = if round == 1 {
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": model_tool_name(UNIFIED_TOOL),
                        "arguments": self.arguments
                    }
                }]
            })
        } else {
            json!({ "role": "assistant", "content": "done" })
        };
        Box::pin(async move {
            Ok(json!({
                "id": format!("chatcmpl-screening-round-{round}"),
                "object": "chat.completion",
                "model": "fixture-model",
                "choices": [{ "index": 0, "message": message, "finish_reason": "stop" }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
            }))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> ProviderFuture<'a, Body> {
        Box::pin(async {
            Err(ryu_gw_providers::ProviderError::Provider(
                "the buffered tool loop never streams".to_owned(),
            ))
        })
    }
}

struct CoreMock {
    base: String,
    executions: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for CoreMock {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A Core whose tool executions answer `output`.
async fn spawn_core(output: Value) -> CoreMock {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("core mock binds");
    let base = format!("http://{}", listener.local_addr().expect("core address"));
    let executions = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&executions);
    let router = Router::new()
        .route(
            "/api/mcp/tools/call",
            post(move || {
                let counted = Arc::clone(&counted);
                let output = output.clone();
                async move {
                    counted.fetch_add(1, Ordering::SeqCst);
                    Json(json!({ "ok": true, "output": output }))
                }
            }),
        )
        .route(
            "/api/tools/search",
            get(|| async {
                Json(json!({ "object": "list", "data": [{
                    "id": UNIFIED_TOOL, "name": "search",
                    "description": "Search the web", "kind": "mcp"
                }] }))
            }),
        )
        .route(
            "/api/tools/describe",
            get(|| async {
                Json(json!({
                    "id": UNIFIED_TOOL, "name": "search", "description": "Search the web.",
                    "args": [{ "name": "query", "type": "string",
                               "description": "Search terms", "required": true }]
                }))
            }),
        )
        .fallback(|| async { Json(json!({})) });
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    CoreMock {
        base,
        executions,
        task,
    }
}

/// A Fleet gateway with a qualified screener and the unified tool loop wired
/// to `core`. Returns the gateway, the screener backend and the provider's
/// round counter.
fn tool_loop_gateway(core: &CoreMock, arguments: &str) -> (Gateway, Arc<AtomicUsize>) {
    let rounds = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&rounds);
    let base = core.base.clone();
    let arguments = arguments.to_owned();
    let gateway = gateway_with(
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), &[test_backend("decision_local")]),
        Some(qualified_floor(3)),
        "unused",
        |config| config.tools.enabled = true,
        move |state| {
            state.tools = Some(ToolSearchClient::new(
                &CoreProviderConfig {
                    base_url: base,
                    token: None,
                },
                reqwest::Client::builder()
                    .no_proxy()
                    .build()
                    .expect("core client"),
            ));
            state
                .provider_runtime
                .register_for_test(Arc::new(ToolRounds {
                    calls: counted,
                    arguments,
                }));
        },
    );
    (gateway, rounds)
}

/// A decision model that reads the `context` it is sent: a code scores 1.0
/// when its sentinel appears in the item text, or in the context and the text
/// read together. Its build matches the qualification `screener_json` writes.
struct ContextReader {
    descriptor: BackendDescriptor,
    calls: AtomicUsize,
}

impl ContextReader {
    fn new() -> Self {
        Self {
            descriptor: TestBackend::new("decision_local").descriptor().clone(),
            calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait::async_trait]
impl ScreenerBackend for ContextReader {
    fn descriptor(&self) -> &BackendDescriptor {
        &self.descriptor
    }

    async fn screen(&self, req: &ScreenRequest<'_>) -> Result<BackendVerdict, BackendError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let covers = &self.descriptor.covers;
        let items = req
            .items
            .iter()
            .map(|item| {
                let text = item.text.as_deref().unwrap_or("");
                let context = item.context.as_deref().unwrap_or("");
                let joined: String = format!("{context}{text}")
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .collect();
                let hits = sentinel_codes(text).union(&sentinel_codes(&joined));
                let scores = covers
                    .iter()
                    .map(|code| (code, if hits.contains(code) { 1.0 } else { 0.0 }))
                    .collect();
                ItemVerdict {
                    key: item.key,
                    scores,
                    covered: covers.clone(),
                    model_signal: if hits.iter().next().is_some() {
                        ModelSignal::Block
                    } else {
                        ModelSignal::Allow
                    },
                    confidence: ConfidenceSource::Fixed,
                }
            })
            .collect();
        Ok(BackendVerdict {
            backend: self.descriptor.reference.clone(),
            items,
            latency_ms: 0,
        })
    }

    async fn probe(&self) -> BackendHealth {
        BackendHealth::Ready
    }
}

fn context_runtime() -> (ScreeningRuntime, Arc<ContextReader>) {
    let backend = Arc::new(ContextReader::new());
    let runtime = ScreeningRuntime::with_backends(
        &Default::default(),
        vec![(
            Arc::clone(&backend) as Arc<dyn ScreenerBackend>,
            ScreeningBackendKind::DecisionLocal,
            None,
        )],
    );
    (runtime, backend)
}

/// A local decision model on the systemone wire, against `mock`, with the
/// build the qualification names.
fn systemone_runtime(
    mock: &MockServer,
    config: &crate::config::ScreeningConfig,
) -> ScreeningRuntime {
    let backend = DecisionBackend::local(
        DecisionConfig {
            id: "decision_local".into(),
            url: mock.base_url.clone(),
            model: "test-model".into(),
            weights_sha256: Some(ZEROS.into()),
            hard_timeout_ms: 800,
            max_concurrency: 4,
        },
        ryu_gw_screening::Locality::Loopback,
    )
    .expect("local decision backend over the mock");
    ScreeningRuntime::with_backends(
        config,
        vec![(
            Arc::new(backend) as Arc<dyn ScreenerBackend>,
            ScreeningBackendKind::DecisionLocal,
            None,
        )],
    )
}

// ── tool rounds ─────────────────────────────────────────────────────────────

/// A tool result carrying a hard code ends the unified loop before the
/// result reaches the provider: one provider round, then 403.
#[tokio::test]
async fn probe_tool_round_result_with_a_hard_code_ends_the_loop() {
    assert!(crate::config::ToolsConfig::default().enabled);
    let core = spawn_core(json!({ "result": format!("{SENTINEL_HAZARD_S9} tool probe") })).await;
    let (g, rounds) = tool_loop_gateway(&core, "{\"query\":\"weather\"}");
    let body = json!({ "model": "fixture-model", "messages": [
        { "role": "user", "content": "benign tool loop question" }
    ] });
    let (status, _, raw) = send_with(
        &g.app,
        Method::POST,
        "/v1/chat/completions",
        MASTER,
        &[("x-ryu-tools", UNIFIED_TOOL)],
        Some(&body),
    )
    .await;
    assert_eq!(
        core.executions.load(Ordering::SeqCst),
        1,
        "the tool never ran, so the loop was not exercised: {status} {}",
        short(&raw)
    );
    assert_eq!(status, StatusCode::FORBIDDEN, "{}", short(&raw));
    assert!(raw.contains("platform_floor_blocked"), "{}", short(&raw));
    assert_eq!(
        rounds.load(Ordering::SeqCst),
        1,
        "the result reached a second round"
    );
}

/// The model's own tool call arguments are screened before the tool runs.
#[tokio::test]
async fn probe_tool_round_arguments_with_a_hard_code_block_before_execution() {
    let core = spawn_core(json!({ "result": "sunny" })).await;
    let (g, rounds) = tool_loop_gateway(
        &core,
        &format!("{{\"query\":\"{SENTINEL_HAZARD_S9} lookup\"}}"),
    );
    let body = json!({ "model": "fixture-model", "messages": [
        { "role": "user", "content": "benign tool loop question" }
    ] });
    let (status, _, raw) = send_with(
        &g.app,
        Method::POST,
        "/v1/chat/completions",
        MASTER,
        &[("x-ryu-tools", UNIFIED_TOOL)],
        Some(&body),
    )
    .await;
    assert_eq!(rounds.load(Ordering::SeqCst), 1, "{status} {}", short(&raw));
    assert_eq!(status, StatusCode::FORBIDDEN, "{}", short(&raw));
    assert!(raw.contains("platform_floor_blocked"), "{}", short(&raw));
    assert_eq!(core.executions.load(Ordering::SeqCst), 0, "the tool ran");
}

// ── fallback attempts ───────────────────────────────────────────────────────

/// A fallback attempt re-admits the same body from the segment cache: the
/// screener sees the same number of calls as a request served first time.
#[tokio::test]
async fn probe_fallback_attempt_re_admission_answers_from_the_cache() {
    let body = json!({ "model": "fixture-model", "messages": [
        { "role": "user", "content": "benign fallback probe" }
    ] });
    let direct_backend = test_backend("decision_local");
    let direct = fallback_pair(
        runtime_with(&Default::default(), std::slice::from_ref(&direct_backend)),
        Some(qualified_floor(3)),
        Some("ok"),
        "ok",
    );
    let (status, _, raw) = send(
        &direct.gateway.app,
        Method::POST,
        "/v1/chat/completions",
        Some(&body),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", short(&raw));

    let backend = test_backend("decision_local");
    let pair = fallback_pair(
        runtime_with(&Default::default(), std::slice::from_ref(&backend)),
        Some(qualified_floor(3)),
        None,
        "ok",
    );
    let (status, _, raw) = send(
        &pair.gateway.app,
        Method::POST,
        "/v1/chat/completions",
        Some(&body),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", short(&raw));
    assert_eq!(pair.primary.load(Ordering::SeqCst), 1);
    assert_eq!(pair.spare.load(Ordering::SeqCst), 1, "no fallback happened");
    assert_eq!(backend.calls(), direct_backend.calls());
}

/// In the degraded row a request that falls back is charged to the org's
/// throttle once, not once per attempt.
#[tokio::test]
async fn probe_fallback_charges_the_degraded_throttle_once() {
    let config = crate::config::ScreeningConfig {
        degraded_rpm: 1,
        ..Default::default()
    };
    let pair = fallback_pair(
        runtime_with(&config, &[test_backend("decision_local")]),
        Some(floor(3, None)),
        None,
        "ok",
    );
    let body = json!({ "model": "fixture-model", "messages": [
        { "role": "user", "content": "degraded fallback probe" }
    ] });
    let (status, _, raw) = send(
        &pair.gateway.app,
        Method::POST,
        "/v1/chat/completions",
        Some(&body),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", short(&raw));
    assert_eq!(pair.spare.load(Ordering::SeqCst), 1, "no fallback happened");
    let (status, _, raw) = send(
        &pair.gateway.app,
        Method::POST,
        "/v1/chat/completions",
        Some(&body),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{}", short(&raw));
    assert!(raw.contains("screening_degraded_throttle"));
}

/// An output block is a safety outcome: it never moves the request to the
/// spare and never trips the primary's circuit.
#[tokio::test]
async fn probe_an_output_block_never_falls_back_or_trips_the_circuit() {
    let pair = fallback_pair(
        runtime_with(&Default::default(), &[test_backend("decision_local")]),
        Some(qualified_floor(3)),
        Some(&format!("reply {SENTINEL_HAZARD_S9}")),
        "ok",
    );
    let body = json!({ "model": "fixture-model", "messages": [
        { "role": "user", "content": "benign output probe" }
    ] });
    for attempt in 0..6 {
        let (status, _, raw) = send(
            &pair.gateway.app,
            Method::POST,
            "/v1/chat/completions",
            Some(&body),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{attempt}: {}", short(&raw));
        assert!(raw.contains("platform_floor_output_blocked"), "{attempt}");
    }
    assert_eq!(
        pair.spare.load(Ordering::SeqCst),
        0,
        "a block moved to the spare"
    );
    assert_eq!(
        pair.primary.load(Ordering::SeqCst),
        6,
        "the primary was skipped, so its circuit opened"
    );
}

// ── compat dialects ─────────────────────────────────────────────────────────

fn compat_routes(stream: bool) -> Vec<(&'static str, String, Value)> {
    let mut anthropic = json!({
        "model": "fixture-model",
        "max_tokens": 16,
        "messages": [{ "role": "user", "content": "benign question" }]
    });
    let mut responses = json!({ "model": "fixture-model", "input": "benign question" });
    let mut chat = json!({
        "model": "fixture-model",
        "messages": [{ "role": "user", "content": "benign question" }]
    });
    if stream {
        anthropic["stream"] = json!(true);
        responses["stream"] = json!(true);
        chat["stream"] = json!(true);
    }
    let gemini =
        json!({ "contents": [{ "role": "user", "parts": [{ "text": "benign question" }] }] });
    let gemini_uri = if stream {
        "/v1beta/models/fixture-model:streamGenerateContent?alt=sse"
    } else {
        "/v1beta/models/fixture-model:generateContent"
    };
    vec![
        (
            "cursor alias",
            "/v1/cursor/chat/completions".to_owned(),
            chat,
        ),
        ("anthropic messages", "/v1/messages".to_owned(), anthropic),
        ("gemini", gemini_uri.to_owned(), gemini),
        ("responses", "/v1/responses".to_owned(), responses),
    ]
}

#[tokio::test]
async fn probe_compat_buffered_output_blocks_on_every_dialect() {
    let (g, _) = qualified_fleet(&format!("reply {SENTINEL_HAZARD_S9}"));
    let mut misses = Vec::new();
    for (route, uri, body) in compat_routes(false) {
        let (status, _, raw) = send(&g.app, Method::POST, &uri, Some(&body)).await;
        if status != StatusCode::FORBIDDEN
            || !raw.contains("platform_floor_output_blocked")
            || raw.contains(SENTINEL_HAZARD_S9)
        {
            misses.push(format!("{route}: {status} {}", short(&raw)));
        }
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// A blocked compat stream carries the output-blocked error and none of the
/// clean-finish markers its benign twin carries.
#[tokio::test]
async fn probe_compat_stream_output_block_never_finishes_cleanly() {
    let (clean, _) = qualified_fleet("all good");
    let (blocked, _) = qualified_fleet(SENTINEL_HAZARD_S4);
    let markers = [
        "[DONE]",
        "message_stop",
        "response.completed",
        "\"finishReason\"",
        "finish_reason\":\"stop",
    ];
    let mut misses = Vec::new();
    for (route, uri, body) in compat_routes(true) {
        let (status, _, benign) = send(&clean.app, Method::POST, &uri, Some(&body)).await;
        assert_eq!(status, StatusCode::OK, "{route} benign: {}", short(&benign));
        let finish: Vec<&str> = markers
            .iter()
            .copied()
            .filter(|m| benign.contains(m))
            .collect();
        assert!(
            !finish.is_empty(),
            "{route}: no clean-finish marker in the benign stream: {}",
            short(&benign)
        );
        let (status, _, raw) = send(&blocked.app, Method::POST, &uri, Some(&body)).await;
        let finished: Vec<&&str> = finish.iter().filter(|m| raw.contains(**m)).collect();
        if !raw.contains("platform_floor_output_blocked") || !finished.is_empty() {
            let tail: String = raw
                .chars()
                .rev()
                .take(400)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            misses.push(format!(
                "{route}: {status}, error frame {}, clean finish {finished:?}; tail {tail}",
                raw.contains("platform_floor_output_blocked")
            ));
        }
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// Media in every dialect's own shape is media no backend can screen on the
/// fleet: it never reaches the provider. A translator that drops the media
/// before dispatch is not a bypass, so the forwarded body is checked too.
#[tokio::test]
async fn probe_compat_media_shapes_are_refused_on_the_fleet() {
    let backend = test_backend("decision_local");
    let (g, bodies) = capture_gateway(
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), std::slice::from_ref(&backend)),
        |_| {},
        |_| {},
    );
    const PNG: &str = "iVBORw0KGgo=";
    const PDF: &str = "JVBERi0xLjQ=";
    let cases = vec![
        (
            "anthropic image",
            "/v1/messages",
            json!({ "model": "fixture-model", "max_tokens": 16, "messages": [{ "role": "user", "content": [
                { "type": "text", "text": "describe" },
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": PNG } }
            ] }] }),
        ),
        (
            "anthropic image url",
            "/v1/messages",
            json!({ "model": "fixture-model", "max_tokens": 16, "messages": [{ "role": "user", "content": [
                { "type": "text", "text": "describe" },
                { "type": "image", "source": { "type": "url", "url": "https://x.invalid/a.png" } }
            ] }] }),
        ),
        (
            "anthropic document",
            "/v1/messages",
            json!({ "model": "fixture-model", "max_tokens": 16, "messages": [{ "role": "user", "content": [
                { "type": "text", "text": "summarise" },
                { "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": PDF } }
            ] }] }),
        ),
        (
            "gemini inlineData",
            "/v1beta/models/fixture-model:generateContent",
            json!({ "contents": [{ "role": "user", "parts": [
                { "text": "describe" },
                { "inlineData": { "mimeType": "image/png", "data": PNG } }
            ] }] }),
        ),
        (
            "gemini fileData",
            "/v1beta/models/fixture-model:generateContent",
            json!({ "contents": [{ "role": "user", "parts": [
                { "text": "describe" },
                { "fileData": { "mimeType": "image/png", "fileUri": "https://x.invalid/a.png" } }
            ] }] }),
        ),
        (
            "responses input_image",
            "/v1/responses",
            json!({ "model": "fixture-model", "input": [{ "role": "user", "content": [
                { "type": "input_text", "text": "describe" },
                { "type": "input_image", "image_url": format!("data:image/png;base64,{PNG}") }
            ] }] }),
        ),
        (
            "responses input_file",
            "/v1/responses",
            json!({ "model": "fixture-model", "input": [{ "role": "user", "content": [
                { "type": "input_text", "text": "summarise" },
                { "type": "input_file", "filename": "a.pdf", "file_data": format!("data:application/pdf;base64,{PDF}") }
            ] }] }),
        ),
        (
            "chat file part",
            "/v1/chat/completions",
            json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": [
                { "type": "text", "text": "summarise" },
                { "type": "file", "file": { "filename": "a.pdf", "file_data": format!("data:application/pdf;base64,{PDF}") } }
            ] }] }),
        ),
        (
            "chat input_audio",
            "/v1/chat/completions",
            json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": [
                { "type": "text", "text": "transcribe" },
                { "type": "input_audio", "input_audio": { "data": "UklGRg==", "format": "wav" } }
            ] }] }),
        ),
        (
            "image edit input",
            "/v1/images/generations",
            json!({ "model": "fixture-model", "prompt": "edit this",
                    "image": format!("data:image/png;base64,{PNG}") }),
        ),
    ];
    let mut misses = Vec::new();
    for (case, uri, body) in cases {
        let before = bodies.lock().unwrap().len();
        let (status, _, raw) = send(&g.app, Method::POST, uri, Some(&body)).await;
        let forwarded: Vec<String> = bodies.lock().unwrap()[before..]
            .iter()
            .map(Value::to_string)
            .collect();
        let carried = forwarded
            .iter()
            .any(|wire| wire.contains(PNG) || wire.contains(PDF) || wire.contains("x.invalid"));
        if carried {
            misses.push(format!(
                "{case}: {status}, media forwarded in {} upstream call(s): {}",
                forwarded.len(),
                short(&raw)
            ));
        }
    }
    assert_eq!(backend.seen().iter().filter(|t| t.contains(PNG)).count(), 0);
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

// ── the systemone wire: garbage, timeouts, outages ──────────────────────────

/// Output outside the systemone grammar is treated as down: 503 while the
/// breaker is closed, then the degraded row once it opens. It is never a pass
/// and never cached.
#[tokio::test]
async fn probe_garbage_systemone_output_is_a_503_then_degrades() {
    let mock = MockServer::systemone().await;
    mock.set(|b| b.raw_body = Some("this is not a systemone answer".into()));
    let g = gateway(
        GatewayCustody::Fleet,
        systemone_runtime(&mock, &Default::default()),
        Some(qualified_floor(3)),
        "ok",
    );
    let mut events = g.state.traffic.subscribe();
    let (status, headers, body) = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"]["code"], "screening_unavailable");
    assert!(headers.get("retry-after").is_some());
    assert_eq!(g.calls.load(Ordering::SeqCst), 0);
    assert!(mock.calls() >= 1, "the mock was never asked");

    let mut flipped = None;
    for attempt in 0..10 {
        let (status, _, _) = chat(&g, "benign garbage probe").await;
        if status != StatusCode::SERVICE_UNAVAILABLE {
            flipped = Some((attempt, status));
            break;
        }
    }
    let (_, status) = flipped.expect("garbage kept the fleet at 503 instead of degrading");
    assert_eq!(status, StatusCode::OK);
    let mut saw_open = false;
    while let Ok(event) = events.try_recv() {
        if event["kind"] == "screening_degraded" && event["breaker"] == "open" {
            saw_open = true;
        }
    }
    assert!(saw_open, "no breaker-open screening_degraded event");
    assert_eq!(
        g.state.screening.cache_stats().entries,
        0,
        "a failed screen was cached"
    );
}

#[tokio::test]
async fn probe_a_systemone_timeout_is_a_503_with_retry_after() {
    let mock = MockServer::systemone().await;
    mock.set(|b| b.delay = Some(Duration::from_secs(3)));
    let g = gateway(
        GatewayCustody::Fleet,
        systemone_runtime(&mock, &Default::default()),
        Some(floor(
            3,
            Some(screener_json(
                &["decision_local"],
                true,
                json!({ "deadlinesMs": { "chat": 200 } }),
            )),
        )),
        "ok",
    );
    let started = std::time::Instant::now();
    let (status, headers, body) = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"]["code"], "screening_unavailable");
    assert!(headers.get("retry-after").is_some());
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the deadline was not kept"
    );
    assert_eq!(g.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn probe_an_engine_5xx_is_a_503_never_a_pass() {
    let mock = MockServer::systemone().await;
    mock.set(|b| b.status = Some(500));
    let g = gateway(
        GatewayCustody::Fleet,
        systemone_runtime(&mock, &Default::default()),
        Some(qualified_floor(3)),
        "ok",
    );
    let (status, _, body) = chat(&g, SENTINEL_HAZARD_S4).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(g.calls.load(Ordering::SeqCst), 0);
}

/// The real parser blocks through the wire end to end, so the probes above
/// are not passing for a mock that never answers.
#[tokio::test]
async fn probe_a_healthy_systemone_blocks_and_passes_its_twin() {
    let mock = MockServer::systemone().await;
    let g = gateway(
        GatewayCustody::Fleet,
        systemone_runtime(&mock, &Default::default()),
        Some(qualified_floor(3)),
        "ok",
    );
    let (status, _, body) = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "platform_floor_blocked");
    let (status, _, body) = chat(&g, "benign systemone twin").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(g.calls.load(Ordering::SeqCst), 1);
}

// ── caches ──────────────────────────────────────────────────────────────────

/// The segment cache is org-scoped: one org's screen is never another org's
/// cache hit (spec 02.8).
#[tokio::test]
async fn probe_the_segment_cache_is_not_shared_across_orgs() {
    let (g, backend) = qualified_fleet("ok");
    let body = chat_body("shared text across tenants");
    screen_chat(&g.state, &ctx_for("org-a"), &body, Surface::Chat)
        .await
        .unwrap();
    let after_a = backend.calls();
    screen_chat(&g.state, &ctx_for("org-b"), &body, Surface::Chat)
        .await
        .unwrap();
    assert_eq!(
        backend.calls(),
        after_a * 2,
        "org-b was served org-a's scores"
    );
}

/// A response cached while the fleet ran the degraded row is screened again
/// once a qualified backend is back: at admission for its request, and at
/// output for its response.
#[tokio::test]
async fn probe_a_response_cache_hit_is_rescreened() {
    let g = gateway_with(
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), &[test_backend("decision_local")]),
        Some(floor(
            3,
            Some(screener_json(&["decision_local"], false, json!({}))),
        )),
        &format!("reply {SENTINEL_HAZARD_S9}"),
        |config| config.cache.enabled = true,
        |_| {},
    );
    // Degraded: neither the request nor the response is decided.
    let (status, _, body) = chat(&g, "benign cache probe").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _, body) = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(g.calls.load(Ordering::SeqCst), 2);
    let (status, _, _) = chat(&g, "benign cache probe").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        g.calls.load(Ordering::SeqCst),
        2,
        "the response cache did not answer, so the hit path is not exercised"
    );

    assert!(g.state.platform_floor.observe(Some(&qualified_floor(4))));
    let (status, _, body) = chat(&g, "benign cache probe").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "platform_floor_output_blocked");
    let (status, _, body) = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "platform_floor_blocked");
    assert_eq!(g.calls.load(Ordering::SeqCst), 2);
}

/// Spec 02.8: a new combination is classified as a whole even when every
/// segment is a cache hit, so pre-seeding a segment alone does not let it
/// pass later beside the context that makes it a hazard.
#[tokio::test]
async fn probe_a_pre_seeded_segment_is_reclassified_in_a_new_combination() {
    let combined = json!({ "messages": [
        { "role": "user", "content": "prefix RYU_TEST_" },
        { "role": "assistant", "content": "HAZARD_S9 tail" }
    ] });
    // Control: classified fresh, the combination is a hazard.
    let (runtime, _) = context_runtime();
    let control = gateway(
        GatewayCustody::Fleet,
        runtime,
        Some(qualified_floor(3)),
        "ok",
    );
    let error = screen_chat(&control.state, &ctx_for("org-a"), &combined, Surface::Chat)
        .await
        .expect_err("the context reader blocks the combination");
    assert!(matches!(error, GatewayError::ContentBlocked(_)));

    let (runtime, _) = context_runtime();
    let g = gateway(
        GatewayCustody::Fleet,
        runtime,
        Some(qualified_floor(3)),
        "ok",
    );
    let seed = json!({ "messages": [{ "role": "assistant", "content": "HAZARD_S9 tail" }] });
    screen_chat(&g.state, &ctx_for("org-a"), &seed, Surface::Chat)
        .await
        .expect("the segment alone is benign");
    let result = screen_chat(&g.state, &ctx_for("org-a"), &combined, Surface::Chat).await;
    assert!(
        matches!(result, Err(GatewayError::ContentBlocked(_))),
        "a pre-seeded segment passed beside its hazardous context: {result:?}"
    );
}

/// `Definition` segments share a global cache scope (spec 02.8). A score one
/// org's context produced must not decide another org's request.
#[tokio::test]
async fn probe_a_definition_scored_in_one_orgs_context_never_blocks_another_org() {
    let tools = json!([{ "function": { "description": "HAZARD_S9 lookup", "name": "lookup" } }]);
    let org_b = json!({
        "messages": [{ "role": "user", "content": "benign question" }],
        "tools": tools
    });
    // Control: org-b alone is benign.
    let (runtime, _) = context_runtime();
    let control = gateway(
        GatewayCustody::Fleet,
        runtime,
        Some(qualified_floor(3)),
        "ok",
    );
    screen_chat(&control.state, &ctx_for("org-b"), &org_b, Surface::Chat)
        .await
        .expect("org-b alone is benign");

    let (runtime, _) = context_runtime();
    let g = gateway(
        GatewayCustody::Fleet,
        runtime,
        Some(qualified_floor(3)),
        "ok",
    );
    let org_a = json!({
        "messages": [{ "role": "user", "content": "prefix RYU_TEST_" }],
        "tools": tools
    });
    let seeded = screen_chat(&g.state, &ctx_for("org-a"), &org_a, Surface::Chat).await;
    assert!(
        matches!(seeded, Err(GatewayError::ContentBlocked(_))),
        "org-a's own combination should block: {seeded:?}"
    );
    let result = screen_chat(&g.state, &ctx_for("org-b"), &org_b, Surface::Chat).await;
    assert!(
        result.is_ok(),
        "org-b was blocked by a definition score org-a's context produced: {result:?}"
    );
}

/// Spec 02.5.4: chunks overlap by 128 tokens, so a hard code that straddles
/// a chunk boundary is still inside one item a backend reads.
#[tokio::test]
async fn probe_a_chunk_boundary_never_splits_a_hard_code_out_of_view() {
    let (g, _) = qualified_fleet("ok");
    let text = format!(
        "{}{SENTINEL_HAZARD_S9} tail",
        "a".repeat(admit::CHUNK_CHARS - 9)
    );
    let result = screen_chat(&g.state, &plain_ctx(), &chat_body(&text), Surface::Chat).await;
    assert!(
        matches!(result, Err(GatewayError::ContentBlocked(_))),
        "a hard code split across the chunk boundary passed: {:?}",
        result.map(|r| r.blocked)
    );
}

/// Buffered output windows have no overlap rule; each window is sent with
/// the prior output as context (spec 02.10, addendum section 8), so a
/// backend that reads its context still sees a hard code split across the
/// window boundary.
#[tokio::test]
async fn probe_a_buffered_output_window_boundary_is_covered_by_context() {
    let reply = format!(
        "{}{SENTINEL_HAZARD_S9} tail",
        "a".repeat(output::WINDOW_CHARS * 4 - 9)
    );
    let (runtime, _) = context_runtime();
    let g = gateway(
        GatewayCustody::Fleet,
        runtime,
        Some(qualified_floor(3)),
        &reply,
    );
    let (status, _, body) = chat(&g, "benign long answer").await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a hard code split across the output window boundary was returned: {}",
        short(&body.to_string())
    );
}

// ── remote processors ───────────────────────────────────────────────────────

fn fleet_with_jev(mock: &MockServer, permit: RemotePermit, screener: Value) -> Gateway {
    let local: Arc<dyn ScreenerBackend> =
        Arc::new(TestBackend::new("decision_local").fail_always(BackendError::Unavailable("down")));
    let runtime = ScreeningRuntime::with_backends(
        &Default::default(),
        vec![
            (local, ScreeningBackendKind::DecisionLocal, None),
            (
                jev(mock, permit.clone()),
                ScreeningBackendKind::DecisionRemote,
                Some(permit),
            ),
        ],
    );
    // Installed directly, past the replica check, so the permit alone is
    // what keeps floor traffic away from the processor.
    gateway(
        GatewayCustody::Fleet,
        runtime,
        Some(floor(3, Some(screener))),
        "ok",
    )
}

/// A node operator's opt-in admits node-tier traffic only: floor traffic
/// never reaches Jev without an approved retention record.
#[tokio::test]
async fn probe_jev_with_only_the_node_opt_in_never_receives_floor_traffic() {
    let mock = MockServer::systemone().await;
    let permit = RemotePermit::new();
    permit.set_node_opt_in(true);
    let g = fleet_with_jev(
        &mock,
        permit,
        screener_json(&["decision_local", "jev"], true, json!({})),
    );
    let (status, _, body) = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_ne!(status, StatusCode::OK, "{body}");
    let _ = chat(&g, "benign remote probe").await;
    assert_eq!(
        mock.calls(),
        0,
        "floor traffic reached the remote processor"
    );
}

/// A record approved for another processor is not a record for this one.
#[tokio::test]
async fn probe_jev_with_a_record_for_another_processor_receives_nothing() {
    let mock = MockServer::systemone().await;
    let other = json!({ "remoteProcessors": [{
        "processorId": "another-vendor", "backendId": "jev", "retentionDays": 0, "zdr": true,
        "dpaRef": "dpa-2", "region": "eu", "recordedBy": "admin-a", "approvedBy": "admin-b"
    }] });
    let g = fleet_with_jev(
        &mock,
        RemotePermit::new(),
        screener_json(&["decision_local", "jev"], true, other),
    );
    let _ = chat(&g, SENTINEL_HAZARD_S9).await;
    let _ = chat(&g, "benign remote probe").await;
    assert_eq!(
        mock.calls(),
        0,
        "a record for another processor admitted this one"
    );
}

// ── tenant switches ─────────────────────────────────────────────────────────

/// The floor keys off custody only: with the node and tenant firewall off,
/// a hard code outside `messages` is still screened on the fleet.
#[tokio::test]
async fn probe_the_floor_screens_fields_outside_messages_with_the_tenant_firewall_off() {
    let backend = test_backend("decision_local");
    let (g, bodies) = capture_gateway(
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), std::slice::from_ref(&backend)),
        |config| {
            config.firewall.enabled = false;
            config.firewall.scan_inbound = false;
            config.firewall.scan_outbound = false;
            config.firewall.policy = crate::config::FirewallPolicy::WarnAndContinue;
        },
        |state| {
            state.policy.write().unwrap().firewall = Some(FirewallOverlay {
                enabled: Some(false),
                scan_inbound: Some(false),
                scan_outbound: Some(false),
                redact_pii: Some(false),
                redact_secrets: Some(false),
                policy: Some(crate::config::FirewallPolicy::WarnAndContinue),
                ..FirewallOverlay::default()
            });
        },
    );
    let cases = [
        (
            "prediction",
            json!({ "model": "fixture-model",
                    "messages": [{ "role": "user", "content": "benign" }],
                    "prediction": { "type": "content", "content": format!("{SENTINEL_HAZARD_S9} probe") } }),
        ),
        (
            "response_format schema",
            json!({ "model": "fixture-model",
                    "messages": [{ "role": "user", "content": "benign" }],
                    "response_format": { "type": "json_schema", "json_schema": {
                        "name": "probe",
                        "schema": { "type": "object", "description": format!("{SENTINEL_HAZARD_S9} probe") }
                    } } }),
        ),
        (
            "tool call arguments",
            json!({ "model": "fixture-model", "messages": [
                { "role": "user", "content": "benign" },
                { "role": "assistant", "content": null, "tool_calls": [{
                    "id": "call_1", "type": "function",
                    "function": { "name": "lookup", "arguments": format!("{{\"q\":\"{SENTINEL_HAZARD_S9}\"}}") }
                }] },
                { "role": "tool", "tool_call_id": "call_1", "content": "done" }
            ] }),
        ),
    ];
    let mut misses = Vec::new();
    for (case, body) in cases {
        let before = bodies.lock().unwrap().len();
        let (status, _, raw) =
            send(&g.app, Method::POST, "/v1/chat/completions", Some(&body)).await;
        let forwarded = bodies.lock().unwrap()[before..]
            .iter()
            .any(|wire| wire.to_string().contains(SENTINEL_HAZARD_S9));
        if status != StatusCode::FORBIDDEN || !raw.contains("platform_floor_blocked") || forwarded {
            misses.push(format!(
                "{case}: {status}, sentinel forwarded upstream {forwarded}: {}",
                short(&raw)
            ));
        }
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

// ── self-hosted custody and the status route ────────────────────────────────

/// Self-hosted and BYOK nodes are never bound by Ryu's floor: an opted-in
/// node never refuses media as unscreenable and an outage never throttles.
#[tokio::test]
async fn probe_self_hosted_opt_in_never_refuses_media_or_throttles() {
    let opt_in = crate::config::ScreeningConfig {
        node_classifiers: true,
        degraded_rpm: 1,
        ..Default::default()
    };
    let image = json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": [
        { "type": "text", "text": "describe" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo=" } }
    ] }] });
    let healthy = gateway(
        GatewayCustody::SelfHosted,
        runtime_with(&opt_in, &[test_backend("decision_local")]),
        Some(qualified_floor(3)),
        "ok",
    );
    let (status, _, raw) = send(
        &healthy.app,
        Method::POST,
        "/v1/chat/completions",
        Some(&image),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", short(&raw));

    let down =
        Arc::new(TestBackend::new("decision_local").fail_always(BackendError::Unavailable("down")));
    let g = gateway(
        GatewayCustody::SelfHosted,
        runtime_with(&opt_in, std::slice::from_ref(&down)),
        Some(qualified_floor(3)),
        "ok",
    );
    for attempt in 0..4 {
        let (status, _, body) = chat(&g, &format!("self-hosted outage probe {attempt}")).await;
        assert_eq!(status, StatusCode::OK, "{attempt}: {body}");
    }
    let (status, _, raw) = send(&g.app, Method::POST, "/v1/chat/completions", Some(&image)).await;
    assert_eq!(status, StatusCode::OK, "{}", short(&raw));
    // A floor stored on a self-hosted node never makes S1 a hard block there.
    let strict = gateway(
        GatewayCustody::SelfHosted,
        runtime_with(&opt_in, &[test_backend("decision_local")]),
        Some(floor(
            4,
            Some(screener_json(
                &["decision_local"],
                true,
                json!({ "hazards": { "hazard.S1": { "action": "block", "blockThreshold": 0.1, "flagThreshold": 0.05, "hard": true } } }),
            )),
        )),
        "ok",
    );
    let (status, _, body) = chat(&strict, SENTINEL_HAZARD_S1).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn probe_the_status_route_refuses_a_tenant_key() {
    let g = gateway_with(
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), &[test_backend("decision_local")]),
        Some(qualified_floor(3)),
        "ok",
        |config| {
            config.auth.api_keys = vec![ApiKeyConfig {
                key: TENANT.to_owned(),
                name: "tenant".to_owned(),
                allowed_operations: vec![ApiKeyOperation::Inference],
                org_id: Some("org-tenant".to_owned()),
                team_id: None,
                channel_id: None,
                project_id: None,
                requests_per_minute: None,
                tokens_per_minute: None,
                token_budget_total: None,
                downgrade_to: None,
                trusted_forwarder: false,
            }];
        },
        |_| {},
    );
    let (status, _, raw) = send_with(
        &g.app,
        Method::GET,
        "/v1/screening/status",
        TENANT,
        &[],
        None,
    )
    .await;
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED,
        "{status} {}",
        short(&raw)
    );
    assert!(!raw.contains("decision_local"), "{}", short(&raw));
}

#[path = "violation_probe_tests.rs"]
mod violation_probe_tests;
