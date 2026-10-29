//! Coverage probes for the tool-loop screen (see `tool_loop_screen`).
//!
//! `tool_loop_screen_tests` proves the screen stops the obvious shapes. These
//! probes place a harmless marker in the shapes a screen tends to miss: deep
//! nesting, arrays of objects, stringified JSON, object keys, query strings,
//! unusual message fields, object-shaped arguments, long benign padding, a
//! later round, a fallback attempt, Core error envelopes, tool definitions the
//! loop injects itself, and the streaming variants.
//!
//! Markers are only test values: the AWS documentation example key, the
//! published test card number, and `RYU_TEST_LEXICON`, a test-only custom
//! prompt-injection pattern configured on the harness firewall.
//!
//! Every blocked shape runs next to its benign twin, built by the same shape
//! function with the marker swapped for plain text. Blocked means a 403
//! `policy_violation`, the provider never sees the marker, the expected
//! number of provider rounds (no round after the stop, no fallback replay),
//! and a failure row in the audit log. The benign twin must answer 200.
use std::{
    collections::HashSet,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{Method, Request, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::{
    api,
    audit::{AuditLogger, AuditQuery},
    composio::ComposioClient,
    config::{
        AuditConfig, CoreProviderConfig, CustomPattern, CustomPatternKind, FirewallPolicy,
        GatewayConfig, ProviderId,
    },
    evals::EvalsRunner,
    providers::Provider,
    state::AppState,
    tools::{catalog_client::model_tool_name, ToolSearchClient, TOOL_SEARCH_NAME},
};

/// The canonical AWS documentation access-key id (`AKIA[0-9A-Z]{16}`).
const SECRET: &str = "AKIAIOSFODNN7EXAMPLE";
/// A test-only custom prompt-injection pattern (see [`lexicon_pattern`]).
const LEXICON: &str = "RYU_TEST_LEXICON";
/// The published Visa test card number.
const TEST_CARD: &str = "4111 1111 1111 1111";
/// The plain text a benign twin carries where the marker would be.
const BENIGN: &str = "quarterly planning notes";

const PRIMARY: &str = "tool-loop-probe-primary";
const FALLBACK: &str = "tool-loop-probe-fallback";
const UNIFIED_TOOL: &str = "exa.search";
const COMPOSIO_ACTION: &str = "GMAIL_GET_MESSAGE";

type ProviderFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>>;

fn lexicon_pattern() -> CustomPattern {
    CustomPattern {
        name: "ryu_test_lexicon".to_owned(),
        regex: LEXICON.to_owned(),
        kind: CustomPatternKind::PromptInjection,
    }
}

/// Answers round `n` with `script[n - 1]` (an assistant message) and every
/// round past the script with a plain answer. With `fail_first`, its first
/// call fails like a provider outage.
struct ScriptedProvider {
    name: &'static str,
    script: Vec<Value>,
    fail_first: bool,
    calls: Arc<Mutex<Vec<Value>>>,
}

impl Provider for ScriptedProvider {
    fn name(&self) -> &'static str {
        self.name
    }

    fn complete<'a>(&'a self, _model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        let round = {
            let mut calls = self.calls.lock().expect("calls lock");
            calls.push(body.clone());
            calls.len()
        };
        if self.fail_first && round == 1 {
            return Box::pin(async {
                Err(ryu_gw_providers::ProviderError::Provider(
                    "scripted upstream outage".to_owned(),
                ))
            });
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
            .unwrap_or_else(|| json!({ "role": "assistant", "content": "done" }));
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
        self.calls.lock().expect("calls lock").push(body.clone());
        Box::pin(async { Ok(Body::from("data: [DONE]\n\n")) })
    }
}

/// A tool call the scripted model emits. `arguments` is sent as written: a
/// JSON string for the usual wire shape, or an object for providers that
/// return parsed arguments.
fn call(id: &str, name: &str, arguments: Value) -> Value {
    json!({
        "id": id,
        "type": "function",
        "function": { "name": name, "arguments": arguments }
    })
}

fn turn(calls: Vec<Value>) -> Value {
    json!({ "role": "assistant", "content": null, "tool_calls": calls })
}

fn args(value: Value) -> Value {
    Value::String(value.to_string())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Loop {
    Unified,
    Composio,
}

impl Loop {
    fn tool(self) -> String {
        match self {
            Loop::Unified => model_tool_name(UNIFIED_TOOL),
            Loop::Composio => COMPOSIO_ACTION.to_owned(),
        }
    }
}

/// One probe request: the loop, the scripted model turns, and what Core
/// answers.
#[derive(Clone)]
struct Probe {
    kind: Loop,
    stream: bool,
    script: Vec<Value>,
    /// The `n`-th tool call gets `outputs[n]`; later calls repeat the last.
    outputs: Vec<Value>,
    /// Core answers every tool call with this error instead of an output.
    core_error: Option<String>,
    /// Core's `GET /api/tools/describe` answer.
    describe: Value,
    /// The `x-ryu-capability-hints` header.
    hints: Option<String>,
    /// The primary provider fails its first call, so the fallback runs.
    fail_primary_once: bool,
    /// The user message.
    prompt: String,
}

impl Probe {
    /// One round that calls the loop's tool with `arguments`, and Core
    /// answering with `output`.
    fn one_call(kind: Loop, arguments: Value, output: Value) -> Self {
        Self {
            kind,
            stream: false,
            script: vec![turn(vec![call("call_1", &kind.tool(), arguments)])],
            outputs: vec![output],
            core_error: None,
            describe: benign_describe(BENIGN),
            hints: None,
            fail_primary_once: false,
            prompt: "look up the latest message".to_owned(),
        }
    }

    fn streaming(mut self) -> Self {
        self.stream = true;
        self
    }
}

fn benign_describe(description: &str) -> Value {
    json!({
        "id": UNIFIED_TOOL,
        "name": "search",
        "description": format!("Search the web. {description}"),
        "args": [{ "name": "query", "type": "string", "description": "Search terms", "required": true }]
    })
}

/// A local Core: tool calls, catalog search and describe.
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

async fn spawn_core(probe: &Probe) -> CoreMock {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("core mock binds");
    let base = format!("http://{}", listener.local_addr().expect("core address"));
    let executions = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&executions);
    let outputs = probe.outputs.clone();
    let core_error = probe.core_error.clone();
    let describe = probe.describe.clone();
    let router = Router::new()
        .route(
            "/api/mcp/tools/call",
            post(move || {
                let counted = Arc::clone(&counted);
                let outputs = outputs.clone();
                let core_error = core_error.clone();
                async move {
                    let index = counted.fetch_add(1, Ordering::SeqCst);
                    if let Some(error) = core_error {
                        return Json(json!({ "ok": false, "error": error }));
                    }
                    let output = outputs
                        .get(index)
                        .or_else(|| outputs.last())
                        .cloned()
                        .unwrap_or(Value::Null);
                    Json(json!({ "ok": true, "output": output }))
                }
            }),
        )
        .route(
            "/api/tools/search",
            get(|| async {
                Json(json!({
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
            get(move || {
                let describe = describe.clone();
                async move { Json(describe) }
            }),
        )
        .fallback(|| async { Json(json!({})) });
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("core mock serves");
    });
    CoreMock {
        base,
        executions,
        task,
    }
}

struct Harness {
    app: Router,
    state: Arc<AppState>,
    primary: Arc<Mutex<Vec<Value>>>,
    fallback: Arc<Mutex<Vec<Value>>>,
    core: CoreMock,
    _audit_dir: tempfile::TempDir,
}

impl Harness {
    fn primary_calls(&self) -> usize {
        self.primary.lock().expect("calls lock").len()
    }

    fn fallback_calls(&self) -> usize {
        self.fallback.lock().expect("calls lock").len()
    }

    fn executions(&self) -> usize {
        self.core.executions.load(Ordering::SeqCst)
    }

    /// Every body either provider received.
    fn provider_bodies(&self) -> Vec<Value> {
        let mut bodies = self.primary.lock().expect("calls lock").clone();
        bodies.extend(self.fallback.lock().expect("calls lock").iter().cloned());
        bodies
    }

    fn summary(&self) -> String {
        format!(
            "provider calls: {}, fallback calls: {}, tool runs: {}",
            self.primary_calls(),
            self.fallback_calls(),
            self.executions()
        )
    }
}

async fn harness(probe: &Probe) -> Harness {
    let core = spawn_core(probe).await;
    let mut config = GatewayConfig::default();
    config.auth.require_auth = false;
    config.cache.enabled = false;
    config.firewall.enabled = true;
    config.firewall.scan_inbound = true;
    config.firewall.scan_outbound = false;
    config.firewall.policy = FirewallPolicy::Block;
    config.firewall.custom_patterns = vec![lexicon_pattern()];
    config.routing.default_provider = ProviderId::from(PRIMARY);
    // A fallback is configured so a policy stop that fell through to the
    // fallback chain would show up as a fallback call.
    config.routing.fallback_chain = vec![ProviderId::from(FALLBACK)];
    if probe.kind == Loop::Composio {
        config.composio.enabled = true;
        config.composio.api_key = Some("composio-test-key".to_owned());
        config.composio.actions = vec![COMPOSIO_ACTION.to_owned()];
    }
    let audit_dir = tempfile::tempdir().expect("audit dir");
    let audit = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: audit_dir
            .path()
            .join("audit.db")
            .to_string_lossy()
            .into_owned(),
    })
    .expect("audit logger");
    let mut state = AppState::new_for_test(config, audit, EvalsRunner::new(Default::default()));
    let http = reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("core client");
    state.tools = Some(ToolSearchClient::new(
        &CoreProviderConfig {
            base_url: core.base.clone(),
            token: None,
        },
        http.clone(),
    ));
    if probe.kind == Loop::Composio {
        // Unused: the legacy loop dispatches through Core when it is wired.
        state.composio = Some(ComposioClient::for_test(
            state.config.composio.clone(),
            http,
            "http://127.0.0.1:9/unused".to_owned(),
        ));
    }
    let primary = Arc::new(Mutex::new(Vec::new()));
    let fallback = Arc::new(Mutex::new(Vec::new()));
    for (name, calls, fail_first) in [
        (PRIMARY, &primary, probe.fail_primary_once),
        (FALLBACK, &fallback, false),
    ] {
        state
            .provider_runtime
            .register_for_test(Arc::new(ScriptedProvider {
                name,
                script: probe.script.clone(),
                fail_first,
                calls: Arc::clone(calls),
            }));
    }
    let state = Arc::new(state);
    Harness {
        app: api::router(Arc::clone(&state)),
        state,
        primary,
        fallback,
        core,
        _audit_dir: audit_dir,
    }
}

async fn send(harness: &Harness, probe: &Probe) -> (StatusCode, Value) {
    let body = json!({
        "model": "fixture-model",
        "stream": probe.stream,
        "messages": [{ "role": "user", "content": probe.prompt }]
    });
    let mut request = Request::builder()
        .method(Method::POST)
        .uri("/v1/chat/completions")
        .header("content-type", "application/json")
        .extension(ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            40_000,
        ))));
    if probe.kind == Loop::Unified {
        request = request.header("x-ryu-tools", UNIFIED_TOOL);
    }
    if let Some(hints) = &probe.hints {
        request = request.header("x-ryu-capability-hints", hints);
    }
    let response = harness
        .app
        .clone()
        .oneshot(
            request
                .body(Body::from(body.to_string()))
                .expect("request builds"),
        )
        .await
        .expect("router responds");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body reads");
    let text = String::from_utf8_lossy(&bytes).into_owned();
    (
        status,
        serde_json::from_str(&text).unwrap_or(Value::String(text)),
    )
}

/// Every string `value` holds, object keys included, with JSON-looking
/// strings parsed (recursively) so an escaped or stringified marker shows up
/// in its decoded form too.
fn collect_strings(value: &Value, depth: usize, out: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            out.push(text.clone());
            let looks_like_json = matches!(
                text.trim_start().as_bytes().first(),
                Some(b'{' | b'[' | b'"')
            );
            if depth < 8 && looks_like_json {
                if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                    collect_strings(&parsed, depth + 1, out);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_strings(value, depth, out);
            }
        }
        Value::Object(entries) => {
            for (key, value) in entries {
                out.push(key.clone());
                collect_strings(value, depth, out);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// Whether any provider body carries `marker`, in any decoded form.
fn marker_reached_provider(harness: &Harness, marker: &str) -> bool {
    harness.provider_bodies().iter().any(|body| {
        let mut strings = Vec::new();
        collect_strings(body, 0, &mut strings);
        strings.iter().any(|text| text.contains(marker))
    })
}

/// The audit log holds a failure row for the request.
async fn assert_failure_audited(harness: &Harness, what: &str) {
    let query = AuditQuery {
        errors_only: true,
        ..Default::default()
    };
    let rows = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let rows = harness.state.audit.query(&query).expect("audit query");
            if !rows.is_empty() {
                break rows;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what}: no failure audit row was written"));
    assert!(
        rows.iter().any(|row| row.error.is_some()),
        "{what}: the audit row records no error"
    );
}

/// What a blocked probe must show.
struct Expect {
    marker: &'static str,
    primary_calls: usize,
    fallback_calls: usize,
    executions: usize,
}

async fn assert_blocked(probe: &Probe, expect: &Expect, what: &str) {
    let harness = harness(probe).await;
    let (status, body) = send(&harness, probe).await;
    let leaked = marker_reached_provider(&harness, expect.marker);
    let what = format!(
        "{what} ({}; marker reached a provider: {leaked})",
        harness.summary()
    );
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "{what} must be refused: {body}"
    );
    assert_eq!(body["error"]["code"], "policy_violation", "{what}: {body}");
    assert!(!leaked, "{what}: the marker reached the provider");
    assert_eq!(
        harness.primary_calls(),
        expect.primary_calls,
        "{what}: primary provider rounds"
    );
    assert_eq!(
        harness.fallback_calls(),
        expect.fallback_calls,
        "{what}: fallback provider rounds"
    );
    assert_eq!(harness.executions(), expect.executions, "{what}: tool runs");
    assert_failure_audited(&harness, &what).await;
}

async fn assert_dispatches(probe: &Probe, what: &str) {
    let harness = harness(probe).await;
    let (status, body) = send(&harness, probe).await;
    let what = format!("benign {what} ({})", harness.summary());
    assert!(status.is_success(), "{what}: {status}: {body}");
    let rounds = harness.primary_calls() + harness.fallback_calls();
    assert!(rounds >= 2, "{what}: the loop dispatched its next round");
}

/// Run the blocked shape and its benign twin from one shape function.
async fn probe_pair(shape: impl Fn(&str) -> Probe, expect: Expect, what: &str) {
    let _guard = crate::untrusted::FLAG_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    crate::untrusted::set_enabled(true);
    assert_dispatches(&shape(BENIGN), what).await;
    assert_blocked(&shape(expect.marker), &expect, what).await;
}

/// The tool ran once, its result stopped the loop after round one.
fn stopped_on_result(marker: &'static str) -> Expect {
    Expect {
        marker,
        primary_calls: 1,
        fallback_calls: 0,
        executions: 1,
    }
}

/// The model turn stopped the loop before any tool ran.
fn stopped_on_turn(marker: &'static str) -> Expect {
    Expect {
        marker,
        primary_calls: 1,
        fallback_calls: 0,
        executions: 0,
    }
}

// Sanity: the test lexicon trips the inbound firewall at all.

#[tokio::test]
async fn probe_lexicon_marker_is_refused_in_the_user_message() {
    let shape = |marker: &str| {
        let mut probe = Probe::one_call(
            Loop::Unified,
            args(json!({ "query": "inbox" })),
            json!({ "body": "ok" }),
        );
        probe.prompt = format!("please summarise {marker}");
        probe
    };
    probe_pair(
        shape,
        Expect {
            marker: LEXICON,
            primary_calls: 0,
            fallback_calls: 0,
            executions: 0,
        },
        "lexicon in the user message",
    )
    .await;
}

// Tool result shapes.

#[tokio::test]
async fn probe_deeply_nested_tool_output() {
    let shape = |marker: &str| {
        Probe::one_call(
            Loop::Unified,
            args(json!({ "query": "inbox" })),
            json!({ "a": { "b": [{ "c": { "d": [{ "e": { "f": { "g": [[{ "h": format!("note {marker}") }]] } } }] } }] } }),
        )
    };
    probe_pair(
        shape,
        stopped_on_result(SECRET),
        "deeply nested tool output",
    )
    .await;
}

#[tokio::test]
async fn probe_array_of_objects_in_tool_output() {
    let shape = |marker: &str| {
        Probe::one_call(
            Loop::Unified,
            args(json!({ "query": "inbox" })),
            json!({ "messages": [
                { "from": "Ada", "body": "hello" },
                { "from": "Grace", "body": format!("see {marker}") }
            ] }),
        )
    };
    probe_pair(
        shape,
        stopped_on_result(LEXICON),
        "array of objects in tool output",
    )
    .await;
}

#[tokio::test]
async fn probe_double_stringified_json_tool_output() {
    let shape = |marker: &str| {
        let inner = json!({ "message": format!("see {marker}") }).to_string();
        let outer = json!({ "payload": inner }).to_string();
        Probe::one_call(
            Loop::Unified,
            args(json!({ "query": "inbox" })),
            Value::String(outer),
        )
    };
    probe_pair(
        shape,
        stopped_on_result(LEXICON),
        "double-stringified tool output",
    )
    .await;
}

#[tokio::test]
async fn probe_query_string_under_a_plain_key_in_tool_output() {
    let shape = |marker: &str| {
        let marker = marker.replace(' ', "-");
        Probe::one_call(
            Loop::Unified,
            args(json!({ "query": "inbox" })),
            json!({ "link": format!("https://example.com/search?q=notes&key={marker}") }),
        )
    };
    probe_pair(
        shape,
        stopped_on_result(SECRET),
        "query string under a plain key",
    )
    .await;
}

#[tokio::test]
async fn probe_query_string_under_a_url_key_in_tool_output() {
    let shape = |marker: &str| {
        let marker = marker.replace(' ', "-");
        Probe::one_call(
            Loop::Unified,
            args(json!({ "query": "inbox" })),
            json!({ "title": "result", "url": format!("https://example.com/cb?key={marker}") }),
        )
    };
    probe_pair(
        shape,
        stopped_on_result(SECRET),
        "query string under a url key",
    )
    .await;
}

#[tokio::test]
async fn probe_query_string_under_an_image_key_in_tool_output() {
    let shape = |marker: &str| {
        let marker = marker.replace(' ', "-");
        Probe::one_call(
            Loop::Unified,
            args(json!({ "query": "inbox" })),
            json!({ "thumbnail_image": format!("https://cdn.example.com/t.png?sig={marker}") }),
        )
    };
    probe_pair(
        shape,
        stopped_on_result(SECRET),
        "query string under an image key",
    )
    .await;
}

#[tokio::test]
async fn probe_marker_as_an_object_key_in_tool_output() {
    let shape = |marker: &str| {
        let mut entries = serde_json::Map::new();
        entries.insert(marker.replace(' ', "_"), json!("value"));
        Probe::one_call(
            Loop::Unified,
            args(json!({ "query": "inbox" })),
            Value::Object(entries),
        )
    };
    probe_pair(
        shape,
        stopped_on_result(SECRET),
        "marker as a tool output key",
    )
    .await;
}

#[tokio::test]
async fn probe_long_benign_padding_before_the_marker_in_tool_output() {
    let shape = |marker: &str| {
        let padding = "the quick brown fox jumps over the lazy dog. ".repeat(6_000);
        Probe::one_call(
            Loop::Unified,
            args(json!({ "query": "inbox" })),
            json!({ "body": format!("{padding}{marker}") }),
        )
    };
    probe_pair(
        shape,
        stopped_on_result(LEXICON),
        "long padding before the marker",
    )
    .await;
}

#[tokio::test]
async fn probe_test_card_in_tool_output() {
    let shape = |marker: &str| {
        Probe::one_call(
            Loop::Unified,
            args(json!({ "query": "billing" })),
            json!({ "customer": { "card": marker } }),
        )
    };
    probe_pair(
        shape,
        stopped_on_result(TEST_CARD),
        "test card in tool output",
    )
    .await;
}

#[tokio::test]
async fn probe_core_error_envelope_carrying_the_marker() {
    let shape = |marker: &str| {
        let mut probe = Probe::one_call(
            Loop::Unified,
            args(json!({ "query": "inbox" })),
            json!({ "ok": true }),
        );
        probe.core_error = Some(format!("upstream tool said {marker}"));
        probe
    };
    probe_pair(shape, stopped_on_result(SECRET), "Core error envelope").await;
}

// Model turn shapes.

#[tokio::test]
async fn probe_array_of_objects_in_stringified_arguments() {
    let shape = |marker: &str| {
        Probe::one_call(
            Loop::Unified,
            args(
                json!({ "items": [{ "k": "a" }, { "k": "b", "note": format!("send {marker}") }] }),
            ),
            json!({ "ok": true }),
        )
    };
    probe_pair(
        shape,
        stopped_on_turn(SECRET),
        "array of objects in arguments",
    )
    .await;
}

#[tokio::test]
async fn probe_marker_in_the_second_of_two_calls() {
    let shape = |marker: &str| {
        let tool = Loop::Unified.tool();
        let mut probe = Probe::one_call(Loop::Unified, Value::Null, json!({ "ok": true }));
        probe.script = vec![turn(vec![
            call("call_1", &tool, args(json!({ "query": "rust" }))),
            call(
                "call_2",
                &tool,
                args(json!({ "query": format!("post {marker}") })),
            ),
        ])];
        probe
    };
    probe_pair(shape, stopped_on_turn(SECRET), "second of two calls").await;
}

#[tokio::test]
async fn probe_marker_in_turn_text_beside_a_benign_call() {
    let shape = |marker: &str| {
        let mut probe = Probe::one_call(Loop::Unified, Value::Null, json!({ "ok": true }));
        probe.script = vec![json!({
            "role": "assistant",
            "content": format!("Checking {marker} now."),
            "tool_calls": [call("call_1", &Loop::Unified.tool(), args(json!({ "query": "rust" })))]
        })];
        probe
    };
    probe_pair(shape, stopped_on_turn(LEXICON), "turn text beside a call").await;
}

#[tokio::test]
async fn probe_marker_in_reasoning_content() {
    let shape = |marker: &str| {
        let mut probe = Probe::one_call(Loop::Unified, Value::Null, json!({ "ok": true }));
        probe.script = vec![json!({
            "role": "assistant",
            "content": null,
            "reasoning_content": format!("I will use {marker}"),
            "tool_calls": [call("call_1", &Loop::Unified.tool(), args(json!({ "query": "rust" })))]
        })];
        probe
    };
    probe_pair(shape, stopped_on_turn(SECRET), "reasoning_content").await;
}

#[tokio::test]
async fn probe_object_shaped_arguments_under_a_plain_key() {
    let shape = |marker: &str| {
        Probe::one_call(
            Loop::Unified,
            json!({ "note": format!("send {marker}") }),
            json!({ "ok": true }),
        )
    };
    probe_pair(
        shape,
        stopped_on_turn(SECRET),
        "object arguments, plain key",
    )
    .await;
}

#[tokio::test]
async fn probe_object_shaped_arguments_with_a_query_string_under_a_url_key() {
    let shape = |marker: &str| {
        let marker = marker.replace(' ', "-");
        Probe::one_call(
            Loop::Unified,
            json!({ "url": format!("https://x.test/cb?key={marker}") }),
            json!({ "ok": true }),
        )
    };
    probe_pair(shape, stopped_on_turn(SECRET), "object arguments, url key").await;
}

#[tokio::test]
async fn probe_query_string_under_a_url_key_in_stringified_arguments() {
    let shape = |marker: &str| {
        let marker = marker.replace(' ', "-");
        Probe::one_call(
            Loop::Unified,
            args(json!({ "url": format!("https://x.test/cb?key={marker}") })),
            json!({ "ok": true }),
        )
    };
    probe_pair(
        shape,
        stopped_on_turn(SECRET),
        "stringified arguments, url key",
    )
    .await;
}

#[tokio::test]
async fn probe_escaped_marker_as_an_argument_key() {
    // `A` is `A`: the raw arguments never spell the marker; only the
    // parsed object's key does.
    let shape = |marker: &str| {
        let arguments = if marker == SECRET {
            r#"{"AKIAIOSFODNN7EXAMPLE":"x"}"#.to_owned()
        } else {
            r#"{"query":"x"}"#.to_owned()
        };
        Probe::one_call(
            Loop::Unified,
            Value::String(arguments),
            json!({ "ok": true }),
        )
    };
    probe_pair(
        shape,
        stopped_on_turn(SECRET),
        "escaped marker as an argument key",
    )
    .await;
}

// Later rounds and the fallback chain.

#[tokio::test]
async fn probe_marker_in_the_second_round_tool_output() {
    let shape = |marker: &str| {
        let tool = Loop::Unified.tool();
        let mut probe = Probe::one_call(Loop::Unified, Value::Null, json!({ "ok": true }));
        probe.script = vec![
            turn(vec![call(
                "call_1",
                &tool,
                args(json!({ "query": "first" })),
            )]),
            turn(vec![call(
                "call_2",
                &tool,
                args(json!({ "query": "second" })),
            )]),
        ];
        probe.outputs = vec![
            json!({ "body": "first page" }),
            json!({ "body": format!("second page {marker}") }),
        ];
        probe
    };
    probe_pair(
        shape,
        Expect {
            marker: LEXICON,
            primary_calls: 2,
            fallback_calls: 0,
            executions: 2,
        },
        "second-round tool output",
    )
    .await;
}

#[tokio::test]
async fn probe_marker_after_a_fallback_attempt() {
    let shape = |marker: &str| {
        let mut probe = Probe::one_call(
            Loop::Unified,
            args(json!({ "query": "inbox" })),
            json!({ "body": format!("see {marker}") }),
        );
        probe.fail_primary_once = true;
        probe
    };
    probe_pair(
        shape,
        Expect {
            marker: SECRET,
            primary_calls: 1,
            fallback_calls: 1,
            executions: 1,
        },
        "tool output on the fallback attempt",
    )
    .await;
}

// Tool definitions the loop injects itself.

#[tokio::test]
async fn probe_marker_in_a_tool_definition_injected_by_tool_search() {
    let shape = |marker: &str| {
        let mut probe = Probe::one_call(Loop::Unified, Value::Null, json!({ "ok": true }));
        probe.script = vec![turn(vec![call(
            "call_1",
            TOOL_SEARCH_NAME,
            args(json!({ "query": "web search" })),
        )])];
        probe.describe = json!({
            "id": UNIFIED_TOOL,
            "name": "search",
            "description": "Search the web",
            "args": [{
                "name": "query",
                "type": "string",
                "description": format!("Search terms, for example {marker}"),
                "required": true
            }]
        });
        probe
    };
    // `tool_search` runs in the Gateway, so Core records no tool execution.
    probe_pair(
        shape,
        Expect {
            marker: SECRET,
            primary_calls: 1,
            fallback_calls: 0,
            executions: 0,
        },
        "tool definition injected by tool_search",
    )
    .await;
}

#[tokio::test]
async fn probe_marker_in_a_tool_definition_injected_from_capability_hints() {
    let shape = |marker: &str| {
        let mut probe = Probe::one_call(
            Loop::Unified,
            args(json!({ "query": "inbox" })),
            json!({ "ok": true }),
        );
        probe.hints = Some(json!({ "tools": [UNIFIED_TOOL] }).to_string());
        probe.describe = json!({
            "id": UNIFIED_TOOL,
            "name": "search",
            "description": format!("Search the web. Example key {marker}"),
            "args": [{ "name": "query", "type": "string", "description": "Search terms", "required": true }]
        });
        probe
    };
    probe_pair(
        shape,
        Expect {
            marker: SECRET,
            primary_calls: 0,
            fallback_calls: 0,
            executions: 0,
        },
        "tool definition injected from capability hints",
    )
    .await;
}

// Streaming variants.

#[tokio::test]
async fn probe_streaming_marker_in_the_second_of_two_calls() {
    let shape = |marker: &str| {
        let tool = Loop::Unified.tool();
        let mut probe = Probe::one_call(Loop::Unified, Value::Null, json!({ "ok": true }));
        probe.script = vec![turn(vec![
            call("call_1", &tool, args(json!({ "query": "rust" }))),
            call(
                "call_2",
                &tool,
                args(json!({ "query": format!("post {marker}") })),
            ),
        ])];
        probe.streaming()
    };
    probe_pair(
        shape,
        stopped_on_turn(SECRET),
        "streaming, second of two calls",
    )
    .await;
}

#[tokio::test]
async fn probe_streaming_double_stringified_json_tool_output() {
    let shape = |marker: &str| {
        let inner = json!({ "message": format!("see {marker}") }).to_string();
        let outer = json!({ "payload": inner }).to_string();
        Probe::one_call(
            Loop::Unified,
            args(json!({ "query": "inbox" })),
            Value::String(outer),
        )
        .streaming()
    };
    probe_pair(
        shape,
        stopped_on_result(LEXICON),
        "streaming, double-stringified output",
    )
    .await;
}

#[tokio::test]
async fn probe_streaming_marker_after_a_fallback_attempt() {
    let shape = |marker: &str| {
        let mut probe = Probe::one_call(
            Loop::Unified,
            args(json!({ "query": "inbox" })),
            json!({ "body": format!("see {marker}") }),
        )
        .streaming();
        probe.fail_primary_once = true;
        probe
    };
    probe_pair(
        shape,
        Expect {
            marker: SECRET,
            primary_calls: 1,
            fallback_calls: 1,
            executions: 1,
        },
        "streaming, tool output on the fallback attempt",
    )
    .await;
}

#[tokio::test]
async fn probe_streaming_escaped_marker_as_an_argument_key() {
    let shape = |marker: &str| {
        let arguments = if marker == SECRET {
            r#"{"AKIAIOSFODNN7EXAMPLE":"x"}"#.to_owned()
        } else {
            r#"{"query":"x"}"#.to_owned()
        };
        Probe::one_call(
            Loop::Unified,
            Value::String(arguments),
            json!({ "ok": true }),
        )
        .streaming()
    };
    probe_pair(
        shape,
        stopped_on_turn(SECRET),
        "streaming, escaped argument key",
    )
    .await;
}

// Composio loop variants.

#[tokio::test]
async fn probe_composio_deeply_nested_action_output() {
    let shape = |marker: &str| {
        Probe::one_call(
            Loop::Composio,
            args(json!({ "message_id": "m-1" })),
            json!({ "data": { "payload": { "parts": [{ "body": { "text": format!("see {marker}") } }] } } }),
        )
    };
    probe_pair(
        shape,
        stopped_on_result(LEXICON),
        "Composio, nested action output",
    )
    .await;
}

#[tokio::test]
async fn probe_composio_query_string_under_a_url_key_in_action_output() {
    let shape = |marker: &str| {
        let marker = marker.replace(' ', "-");
        Probe::one_call(
            Loop::Composio,
            args(json!({ "message_id": "m-1" })),
            json!({ "url": format!("https://mail.example.com/m?key={marker}") }),
        )
    };
    probe_pair(
        shape,
        stopped_on_result(SECRET),
        "Composio, url key in action output",
    )
    .await;
}

#[tokio::test]
async fn probe_composio_escaped_marker_as_an_argument_key() {
    let shape = |marker: &str| {
        let arguments = if marker == SECRET {
            r#"{"message_id":"m-1","AKIAIOSFODNN7EXAMPLE":"x"}"#.to_owned()
        } else {
            r#"{"message_id":"m-1","note":"x"}"#.to_owned()
        };
        Probe::one_call(
            Loop::Composio,
            Value::String(arguments),
            json!({ "ok": true }),
        )
    };
    probe_pair(
        shape,
        stopped_on_turn(SECRET),
        "Composio, escaped argument key",
    )
    .await;
}

#[tokio::test]
async fn probe_composio_second_of_two_calls() {
    let shape = |marker: &str| {
        let tool = Loop::Composio.tool();
        let mut probe = Probe::one_call(Loop::Composio, Value::Null, json!({ "ok": true }));
        probe.script = vec![turn(vec![
            call("call_1", &tool, args(json!({ "message_id": "m-1" }))),
            call(
                "call_2",
                &tool,
                args(json!({ "message_id": "m-2", "note": format!("see {marker}") })),
            ),
        ])];
        probe
    };
    probe_pair(
        shape,
        stopped_on_turn(LEXICON),
        "Composio, second of two calls",
    )
    .await;
}

/// The leak check itself must see an escaped key in its decoded form, or the
/// escaped-key probes could pass without the marker being searched for.
#[test]
fn collector_decodes_escaped_keys() {
    let body = json!({ "messages": [{ "content": r#"{"AKIAIOSFODNN7EXAMPLE":"x"}"# }] });
    let mut strings = Vec::new();
    collect_strings(&body, 0, &mut strings);
    let unique: HashSet<&str> = strings.iter().map(String::as_str).collect();
    assert!(unique.contains(SECRET), "{unique:?}");
}
