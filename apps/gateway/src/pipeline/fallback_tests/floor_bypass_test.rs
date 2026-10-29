//! Phase 0 floor bypass suite (spec P0-10, sections 00.9 and 02.17).
//!
//! One place that runs every Phase 0 acceptance case the gateway can host
//! today, on `Fleet` custody, against capturing mock upstreams. The only
//! triggering content is a test-only firewall pattern (`RYU_TEST_LEXICON`)
//! and the AWS documentation example key, so nothing here is real attack
//! text.
//!
//! "Blocked" means: the catalogue status, `type` and `code` (403
//! `policy_violation` with code `policy_violation` for a firewall or locked
//! guardrail refusal, or the platform code named by the case), zero calls on
//! every mock upstream, the marker nowhere in a captured body, and one failure
//! audit row. Every blocked case has a benign control that dispatches.
//!
//! | Spec id | Test |
//! |---|---|
//! | B3 | `b03_prompt_only_chat_is_screened` (Phase 0 form: residual scan; no shadow counter, see note) |
//! | B5 | `b05_assistant_tool_call_arguments_are_screened` |
//! | B7 | `b07_prediction_content_is_screened` |
//! | B8 | `b08_replicate_nested_input_is_screened` |
//! | B9 | `b09_fal_nested_input_is_screened` |
//! | B10 | `b10_replicate_negative_prompt_is_screened` |
//! | B11 | `b11_runway_prompt_text_is_screened` |
//! | B12 | `b12_image_route_messages_to_openrouter_are_screened` |
//! | B13 | `b13_speech_instructions_and_text_are_screened` |
//! | B14 | `b14_transcription_prompt_is_screened` |
//! | B17 | `b17_long_speech_voice_is_screened` |
//! | B18 | `b18_provider_call_composio_text_is_screened` |
//! | B19 | `b19_legacy_composio_loop_stops_before_round_two` |
//! | B20 | `b20_unified_tool_loop_stops_before_round_two` |
//! | B21 | `b21_fusion_panel_answer_never_reaches_the_judge` |
//! | B22 | `b22_compression_output_is_screened_before_dispatch` |
//! | B23 | `b23_relay_handoff_is_screened` |
//! | B24 | `b24_batch_creation_is_refused_on_fleet` |
//! | B31 | `b31_replicate_safety_checker_is_forced_on` |
//! | R1a | `r1a_safety_outcomes_never_close_own_supply` |
//! | R2 | `r2_own_supply_policy_violation_never_falls_back` |
//! | AT-1 | `api::route_inventory_test` (walks the constructed router) |
//! | AT-17b | `at17b_unrecognised_own_supply_400_is_not_retried` |
//! | AT-31 | `at31_fleet_has_no_passthrough` |
//! | AT-32 | `at32_posture_flags_f1_and_f3_without_changing_dispatch` |
//! | AT-33 | `at33_gateway_key_in_a_gemini_query_is_refused` |
//!
//! The route inventory cites `sweep_inference_routes_refuse_the_marker`,
//! `sweep_web_search_refuses_the_marker` and `sweep_eval_run_refuses_the_marker`
//! as the proof that every screened route refuses the marker.
//!
//! B3 note: the spec's shadow counter for `messages_required` is not built.
//! There are no users, so no shadow mode: Phase 0 blocks the prompt through
//! the residual scan and the benign prompt-only body still dispatches.
use super::super::own_supply::may_fall_back;
use super::super::{provider_snapshot, run_stream};
use super::*;
use crate::audit::{AuditBackend, AuditRecord, AuditRegistry};
use crate::config::{
    ApiKeyConfig, ApiKeyOperation, CompressionConfig, CoreProviderConfig, CustomPattern,
    CustomPatternKind, FirewallPolicy,
};
use crate::custody::GatewayCustody;
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::ConnectInfo,
    http::{Method, Request, StatusCode, Uri},
    response::IntoResponse,
    routing::{any, post},
    Json, Router,
};
use std::collections::HashMap;
use std::sync::atomic::AtomicU16;
use std::sync::Mutex;
use std::time::Duration;
use tower::ServiceExt;

/// A test-only firewall pattern. Never shipped.
const MARKER: &str = "RYU_TEST_LEXICON";
/// The AWS documentation example access key id. Never a real credential.
const FAKE_AWS_KEY: &str = "AKIAIOSFODNN7EXAMPLE";
const MASTER: &str = "floor-master-key";
const TENANT: &str = "floor-tenant-key";
const CORE_KEY: &str = "floor-core-forwarder";
const WEB_KEY: &str = "floor-web-key";
const ORG: &str = "org-floor";
const FLOOR: &str = "floor-fixture";
const SPARE: &str = "floor-spare";
const RGW_TOKEN: &str = "rgw_test_0000000000000001";

type ProviderFuture<'a, T> =
    Pin<Box<dyn std::future::Future<Output = Result<T, ProviderError>> + Send + 'a>>;

fn marked(text: &str) -> String {
    format!("{text} {MARKER} here")
}

fn lexicon() -> CustomPattern {
    CustomPattern {
        name: "ryu_test_lexicon".into(),
        regex: MARKER.into(),
        kind: CustomPatternKind::PromptInjection,
    }
}

fn api_key(key: &str, name: &str, trusted_forwarder: bool) -> ApiKeyConfig {
    ApiKeyConfig {
        key: key.to_owned(),
        name: name.to_owned(),
        org_id: Some(ORG.to_owned()),
        team_id: None,
        channel_id: None,
        project_id: None,
        requests_per_minute: None,
        tokens_per_minute: None,
        token_budget_total: None,
        downgrade_to: None,
        trusted_forwarder,
        allowed_operations: vec![
            ApiKeyOperation::Inference,
            ApiKeyOperation::WebSearch,
            ApiKeyOperation::WebFetch,
        ],
    }
}

/// The Fleet test configuration: auth on, the inbound firewall blocking the
/// test pattern and detected secrets, no cache and no inbound rate limit.
fn floor_config(default_provider: &str) -> GatewayConfig {
    let mut config = GatewayConfig::default();
    config.auth.require_auth = true;
    config.auth.master_key = Some(MASTER.to_owned());
    config.auth.api_keys = vec![
        api_key(TENANT, "tenant", false),
        api_key(CORE_KEY, "core", true),
    ];
    config.cache.enabled = false;
    config.rate_limit.enabled = false;
    config.firewall = FirewallConfig {
        enabled: true,
        scan_inbound: true,
        scan_outbound: false,
        policy: FirewallPolicy::Block,
        custom_patterns: vec![lexicon()],
        ..FirewallConfig::default()
    };
    config.routing.default_provider = ProviderId::from(default_provider);
    config.routing.fallback_chain = vec![];
    config
}

// ── audit ────────────────────────────────────────────────────────────────────

/// An audit backend that keeps every row in memory.
#[derive(Default)]
struct FloorAudit {
    rows: Mutex<Vec<AuditRecord>>,
}

impl FloorAudit {
    fn failures(&self) -> usize {
        self.rows
            .lock()
            .unwrap()
            .iter()
            .filter(|row| row.error.is_some())
            .count()
    }

    fn text(&self) -> String {
        format!("{:?}", self.rows.lock().unwrap())
    }
}

impl AuditBackend for FloorAudit {
    fn log(&self, record: AuditRecord) {
        self.rows.lock().unwrap().push(record);
    }
    fn log_service(
        &self,
        record: AuditRecord,
        _usage: crate::audit::AuditServiceUsage,
    ) -> Result<(), crate::audit::ServiceAuditError> {
        self.rows.lock().unwrap().push(record);
        Ok(())
    }
    fn is_enabled(&self) -> bool {
        true
    }
    fn token_usage(&self, _api_key: &str) -> u64 {
        0
    }
    fn add_tokens(&self, _api_key: &str, _n: u64) {}
    fn query(
        &self,
        _query: &crate::audit::AuditQuery,
    ) -> anyhow::Result<Vec<crate::audit::AuditEntry>> {
        Ok(Vec::new())
    }
    fn summary(&self) -> anyhow::Result<crate::audit::AuditSummary> {
        Ok(crate::audit::AuditSummary::default())
    }
    fn usage_rollup(
        &self,
        _query: &crate::audit::AuditUsageQuery,
    ) -> anyhow::Result<Vec<crate::audit::AuditUsageEvent>> {
        Ok(Vec::new())
    }
}

/// Build the state for `custody` and register an in-memory audit backend.
fn floor_state(custody: GatewayCustody, config: GatewayConfig) -> (AppState, Arc<FloorAudit>) {
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
    state.custody = custody;
    let recording = Arc::new(FloorAudit::default());
    state.audit.register(
        AuditRegistry::BUILTIN,
        Arc::clone(&recording) as Arc<dyn AuditBackend>,
    );
    (state, recording)
}

// ── upstream capture ─────────────────────────────────────────────────────────

/// Everything any mock upstream in one test received, as text.
#[derive(Clone, Default)]
struct Upstream(Arc<Mutex<Vec<String>>>);

impl Upstream {
    fn push(&self, seen: String) {
        self.0.lock().unwrap().push(seen);
    }

    fn count(&self) -> usize {
        self.0.lock().unwrap().len()
    }

    fn all(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }

    fn carries_a_marker(&self) -> bool {
        self.all()
            .iter()
            .any(|seen| seen.contains(MARKER) || seen.contains(FAKE_AWS_KEY))
    }
}

/// A provider that records every body it is sent, for every modality, and
/// answers with `answers[model]` (or "ok").
struct CaptureProvider {
    name: &'static str,
    upstream: Upstream,
    models: Arc<Mutex<Vec<String>>>,
    answers: HashMap<String, String>,
}

impl CaptureProvider {
    fn record(&self, model: &str, body: &Value) -> String {
        self.upstream.push(body.to_string());
        self.models.lock().unwrap().push(model.to_owned());
        self.answers
            .get(model)
            .or_else(|| {
                body["model"]
                    .as_str()
                    .and_then(|name| self.answers.get(name))
            })
            .cloned()
            .unwrap_or_else(|| "ok".to_owned())
    }
}

impl Provider for CaptureProvider {
    fn name(&self) -> &'static str {
        self.name
    }

    fn complete<'a>(&'a self, model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        let text = self.record(model, body);
        let model = body["model"].as_str().unwrap_or(model).to_owned();
        Box::pin(async move {
            Ok(json!({
                "id": "chatcmpl-floor",
                "object": "chat.completion",
                "model": model,
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": text },
                    "finish_reason": "stop"
                }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
            }))
        })
    }

    fn complete_stream<'a>(&'a self, model: &'a str, body: &'a Value) -> ProviderFuture<'a, Body> {
        let text = self.record(model, body);
        let delta = json!({ "choices": [{ "index": 0, "delta": { "content": text } }] });
        Box::pin(async move {
            Ok(Body::from(format!(
                "data: {delta}\n\ndata: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}}}\n\ndata: [DONE]\n\n"
            )))
        })
    }

    fn embed<'a>(&'a self, model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        self.record(model, body);
        Box::pin(async {
            Ok(json!({
                "object": "list",
                "data": [
                    { "object": "embedding", "index": 0, "embedding": [0.1, 0.2] },
                    { "object": "embedding", "index": 1, "embedding": [0.3, 0.4] }
                ],
                "model": "fixture-embed",
                "usage": { "prompt_tokens": 2, "total_tokens": 2 }
            }))
        })
    }

    fn rerank<'a>(&'a self, model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        self.record(model, body);
        Box::pin(async {
            Ok(json!({
                "results": [{ "index": 0, "relevance_score": 0.9 }],
                "usage": { "total_tokens": 2 }
            }))
        })
    }

    fn generate_image<'a>(&'a self, model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        self.record(model, body);
        Box::pin(async {
            Ok(json!({ "created": 0, "data": [{ "url": "https://x.invalid/i.png" }] }))
        })
    }

    fn synthesize_speech<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> ProviderFuture<'a, Value> {
        self.record(model, body);
        Box::pin(async {
            Ok(json!({ "data": [{ "b64_json": "AAAA", "content_type": "audio/mpeg" }] }))
        })
    }

    fn transcribe_audio<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> ProviderFuture<'a, Value> {
        self.record(model, body);
        Box::pin(async { Ok(json!({ "text": "hello there" })) })
    }
}

/// A Fleet gateway whose default provider is a [`CaptureProvider`] named
/// `name`, with a spare provider in the fallback chain so vendor shopping
/// would show up as a spare call.
struct Floor {
    state: Arc<AppState>,
    upstream: Upstream,
    models: Arc<Mutex<Vec<String>>>,
    audit: Arc<FloorAudit>,
}

impl Floor {
    fn new(configure: impl FnOnce(&mut GatewayConfig)) -> Self {
        Self::named(FLOOR, HashMap::new(), configure)
    }

    fn named(
        name: &'static str,
        answers: HashMap<String, String>,
        configure: impl FnOnce(&mut GatewayConfig),
    ) -> Self {
        let mut config = floor_config(name);
        config.routing.fallback_chain = vec![ProviderId::from(name), ProviderId::from(SPARE)];
        configure(&mut config);
        let (mut state, audit) = floor_state(GatewayCustody::Fleet, config);
        let upstream = Upstream::default();
        let models = Arc::new(Mutex::new(Vec::new()));
        for (provider, answers) in [(name, answers), (SPARE, HashMap::new())] {
            state
                .provider_runtime
                .register_for_test(Arc::new(CaptureProvider {
                    name: provider,
                    upstream: upstream.clone(),
                    models: Arc::clone(&models),
                    answers,
                }) as Arc<dyn Provider>);
        }
        Self {
            state: Arc::new(state),
            upstream,
            models,
            audit,
        }
    }

    fn app(&self) -> Router {
        crate::api::router(Arc::clone(&self.state))
    }

    fn models(&self) -> Vec<String> {
        self.models.lock().unwrap().clone()
    }

    async fn post(&self, uri: &str, body: &Value) -> (StatusCode, Value) {
        send(&self.app(), Method::POST, uri, Some(TENANT), body).await
    }

    fn mark(&self) -> Mark {
        Mark {
            calls: self.upstream.count(),
            failures: self.audit.failures(),
        }
    }
}

/// Counters before one request.
#[derive(Clone, Copy)]
struct Mark {
    calls: usize,
    failures: usize,
}

fn loopback() -> ConnectInfo<std::net::SocketAddr> {
    ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 40_000)))
}

async fn read(response: axum::response::Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned())),
    )
}

async fn send(
    app: &Router,
    method: Method,
    uri: &str,
    bearer: Option<&str>,
    body: &Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .extension(loopback());
    if let Some(key) = bearer {
        request = request.header("authorization", format!("Bearer {key}"));
    }
    read(
        app.clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap(),
    )
    .await
}

/// Failure audit rows are written synchronously on most paths; poll briefly
/// for the ones a spawned task writes.
async fn failures_reach(audit: &FloorAudit, expected: usize) -> usize {
    for _ in 0..100 {
        if audit.failures() >= expected {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    audit.failures()
}

/// Assert a blocked outcome: catalogue status, type and code, no upstream
/// call since `mark`, no marker anywhere upstream, one new failure audit row
/// that does not echo the marker.
async fn assert_blocked(
    what: &str,
    (status, body): (StatusCode, Value),
    code: &str,
    upstream: &Upstream,
    audit: &FloorAudit,
    mark: Mark,
) {
    assert_eq!(status, StatusCode::FORBIDDEN, "{what}: {body}");
    assert_eq!(body["error"]["type"], "policy_violation", "{what}: {body}");
    assert_eq!(body["error"]["code"], code, "{what}: {body}");
    assert_eq!(
        upstream.count(),
        mark.calls,
        "{what}: zero upstream calls: {:?}",
        upstream.all()
    );
    assert!(
        !upstream.carries_a_marker(),
        "{what}: the marker reached upstream"
    );
    let failures = failures_reach(audit, mark.failures + 1).await;
    assert_eq!(failures, mark.failures + 1, "{what}: one failure audit row");
    assert!(
        !body.to_string().contains(MARKER),
        "{what}: the refusal echoes the marker: {body}"
    );
}

fn assert_dispatched(
    what: &str,
    (status, body): (StatusCode, Value),
    upstream: &Upstream,
    mark: Mark,
) {
    assert!(status.is_success(), "{what}: {status} {body}");
    assert!(
        upstream.count() > mark.calls,
        "{what}: the benign request reached the upstream"
    );
}

impl Floor {
    async fn blocked(&self, what: &str, uri: &str, body: &Value) {
        let mark = self.mark();
        let outcome = self.post(uri, body).await;
        assert_blocked(
            what,
            outcome,
            "policy_violation",
            &self.upstream,
            &self.audit,
            mark,
        )
        .await;
    }

    async fn dispatches(&self, what: &str, uri: &str, body: &Value) {
        let mark = self.mark();
        let outcome = self.post(uri, body).await;
        assert_dispatched(what, outcome, &self.upstream, mark);
    }
}

const CHAT: &str = "/v1/chat/completions";

fn chat(messages: Value) -> Value {
    json!({ "model": "fixture-model", "messages": messages })
}

// ── chat leaves (B3, B5, B7) ─────────────────────────────────────────────────

#[tokio::test]
async fn b03_prompt_only_chat_is_screened() {
    let floor = Floor::new(|_| {});
    for stream in [false, true] {
        floor
            .blocked(
                &format!("B3 stream={stream}"),
                CHAT,
                &json!({ "model": "fixture-model", "stream": stream, "prompt": marked("say") }),
            )
            .await;
    }
    floor
        .dispatches(
            "B3 control",
            CHAT,
            &json!({ "model": "fixture-model", "prompt": "say hello" }),
        )
        .await;
}

fn assistant_tool_call(arguments: &str) -> Value {
    chat(json!([
        { "role": "user", "content": "look it up" },
        { "role": "assistant", "content": null, "tool_calls": [{
            "id": "call_1", "type": "function",
            "function": { "name": "lookup", "arguments": arguments }
        }]},
        { "role": "tool", "tool_call_id": "call_1", "content": "done" }
    ]))
}

#[tokio::test]
async fn b05_assistant_tool_call_arguments_are_screened() {
    let floor = Floor::new(|_| {});
    floor
        .blocked(
            "B5",
            CHAT,
            &assistant_tool_call(&json!({ "note": marked("x") }).to_string()),
        )
        .await;
    floor
        .blocked(
            "B5 secret",
            CHAT,
            &assistant_tool_call(&json!({ "key": FAKE_AWS_KEY }).to_string()),
        )
        .await;
    floor
        .dispatches(
            "B5 control",
            CHAT,
            &assistant_tool_call(&json!({ "note": "weather" }).to_string()),
        )
        .await;
}

#[tokio::test]
async fn b07_prediction_content_is_screened() {
    let floor = Floor::new(|_| {});
    let body = |content: String| {
        let mut body = chat(json!([{ "role": "user", "content": "edit the file" }]));
        body["prediction"] = json!({ "type": "content", "content": content });
        body
    };
    floor.blocked("B7", CHAT, &body(marked("fn main"))).await;
    floor
        .dispatches("B7 control", CHAT, &body("fn main() {}".into()))
        .await;
}

// ── every screened inference route ───────────────────────────────────────────

/// Each screened inference route refuses the marker in its natural field and
/// still dispatches the benign twin. Paired with `api::route_inventory_test`.
#[tokio::test]
async fn sweep_inference_routes_refuse_the_marker() {
    let floor = Floor::new(|_| {});
    let cases: Vec<(&str, Box<dyn Fn(&str) -> Value>)> = vec![
        (
            "/v1/cursor/chat/completions",
            Box::new(|text| chat(json!([{ "role": "user", "content": text }]))),
        ),
        (
            "/v1/agents/agent-floor/chat/completions",
            Box::new(|text| chat(json!([{ "role": "user", "content": text }]))),
        ),
        (
            "/v1/responses",
            Box::new(|text| json!({ "model": "fixture-model", "input": text })),
        ),
        (
            "/v1/messages",
            Box::new(|text| {
                json!({
                    "model": "fixture-model",
                    "max_tokens": 16,
                    "messages": [{ "role": "user", "content": text }]
                })
            }),
        ),
        (
            "/v1beta/models/fixture-model:generateContent",
            Box::new(
                |text| json!({ "contents": [{ "role": "user", "parts": [{ "text": text }] }] }),
            ),
        ),
        (
            "/v1/embeddings",
            Box::new(|text| json!({ "model": "fixture-embed", "input": ["ok", text] })),
        ),
        (
            "/v1/rerank",
            Box::new(
                |text| json!({ "model": "fixture-rerank", "query": text, "documents": ["a", "b"] }),
            ),
        ),
    ];
    for (uri, body) in &cases {
        floor.blocked(uri, uri, &body(&marked("hello"))).await;
        floor
            .dispatches(&format!("{uri} control"), uri, &body("hello there"))
            .await;
    }
}

/// Each eval case replays through the pipeline, so a marked case never
/// reaches the provider while a benign case does.
#[tokio::test]
async fn sweep_eval_run_refuses_the_marker() {
    let floor = Floor::new(|_| {});
    let run = |prompt: String| json!({ "model": "fixture-model", "dataset": [{ "prompt": prompt, "expected": "ok" }] });
    let mark = floor.mark();
    let (status, body) = floor.post("/v1/evals/run", &run(marked("say"))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(floor.upstream.count(), mark.calls, "{body}");
    assert!(!floor.upstream.carries_a_marker());
    assert_eq!(
        failures_reach(&floor.audit, mark.failures + 1).await,
        mark.failures + 1,
        "one failure audit row"
    );
    // The run echoes the caller's own dataset back; the refused case carries
    // the refusal instead of a provider answer.
    let case = &body["cases"][0];
    assert_eq!(case["policy_pass"], false, "{body}");
    assert!(
        case["error"]
            .as_str()
            .is_some_and(|error| error.contains("blocked")),
        "{body}"
    );
    floor
        .dispatches("eval control", "/v1/evals/run", &run("say ok".into()))
        .await;
}

// ── web search ───────────────────────────────────────────────────────────────

mod web_fixture {
    use super::*;
    use ryu_gw_credentials::web::WebProviderKind;
    use ryu_gw_providers::web::{
        WebSearchOutput, WebSearchRequest, WebSearchResult, WebServiceUsage,
    };

    pub(super) struct WebCapture {
        pub(super) upstream: Upstream,
    }

    impl Provider for WebCapture {
        fn name(&self) -> &'static str {
            WebProviderKind::Tavily.descriptor().provider_id
        }
        fn web_descriptor(
            &self,
        ) -> Option<&'static ryu_gw_credentials::web::WebProviderDescriptor> {
            Some(WebProviderKind::Tavily.descriptor())
        }
        fn complete<'a>(&'a self, _: &'a str, _: &'a Value) -> ProviderFuture<'a, Value> {
            Box::pin(async { Err(ProviderError::Provider("not chat".into())) })
        }
        fn complete_stream<'a>(&'a self, _: &'a str, _: &'a Value) -> ProviderFuture<'a, Body> {
            Box::pin(async { Err(ProviderError::Provider("not chat".into())) })
        }
        fn web_search_for_session<'a>(
            &'a self,
            request: &'a WebSearchRequest,
            _: Option<&'a str>,
        ) -> ProviderFuture<'a, WebSearchOutput> {
            self.upstream.push(request.query().to_owned());
            Box::pin(async {
                Ok(WebSearchOutput {
                    results: vec![WebSearchResult {
                        title: Some("Result".into()),
                        url: "https://example.com/article".into(),
                        snippet: "readable".into(),
                        score: None,
                    }],
                    usage: WebServiceUsage {
                        requests: 1,
                        ..Default::default()
                    },
                })
            })
        }
    }

    pub(super) fn configure(config: &mut GatewayConfig) {
        config.providers.web = serde_json::from_value(
            json!({ "tavily": { "mode": "accounts", "accounts": [{ "api_key": "fixture-web-key" }] } }),
        )
        .unwrap();
        config.routing.web.search = Some(crate::web_config::WebBinding::Provider {
            provider: WebProviderKind::Tavily,
        });
    }
}

#[tokio::test]
async fn sweep_web_search_refuses_the_marker() {
    let mut config = floor_config(FLOOR);
    web_fixture::configure(&mut config);
    // A web key with no org: an org key would need the hosted credit ledger,
    // which this suite does not run.
    let mut web_key = api_key(WEB_KEY, "web", false);
    web_key.org_id = None;
    config.auth.api_keys.push(web_key);
    let (mut state, audit) = floor_state(GatewayCustody::Fleet, config);
    let upstream = Upstream::default();
    state
        .provider_runtime
        .register_for_test(Arc::new(web_fixture::WebCapture {
            upstream: upstream.clone(),
        }));
    let app = crate::api::router(Arc::new(state));
    let (status, body) = send(
        &app,
        Method::POST,
        "/v1/web/search",
        Some(WEB_KEY),
        &json!({ "query": marked("find") }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "web search: {body}");
    assert_eq!(body["error"]["type"], "policy_violation", "{body}");
    assert_eq!(body["error"]["code"], "policy_violation", "{body}");
    assert_eq!(upstream.count(), 0, "web search: zero upstream calls");
    // GAP tripwire (web search is Phase 2, B26): an inbound web refusal
    // returns before any audit row is written. When that row is added, this
    // assertion fails on purpose: change it to require exactly one row.
    assert_eq!(audit.failures(), 0, "GAP: web refusals write no audit row");
    let mark = Mark {
        calls: upstream.count(),
        failures: audit.failures(),
    };
    let outcome = send(
        &app,
        Method::POST,
        "/v1/web/search",
        Some(WEB_KEY),
        &json!({ "query": "rust release notes" }),
    )
    .await;
    assert_dispatched("web search control", outcome, &upstream, mark);
}

// ── media vendors (B8 to B11, B31) ───────────────────────────────────────────

/// A local media vendor: records every request body and answers like a
/// finished Replicate prediction, a completed Fal queue request or an
/// accepted Runway task.
struct MediaVendor {
    base: String,
    upstream: Upstream,
    bodies: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MediaVendor {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A fixed version 4 task id the Runway adapter accepts.
const RUNWAY_TASK: &str = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

async fn spawn_media_vendor() -> MediaVendor {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let upstream = Upstream::default();
    let bodies: Arc<Mutex<Vec<Value>>> = Arc::default();
    let (seen, recorded) = (upstream.clone(), Arc::clone(&bodies));
    let result_url = format!("{base}/result");
    let handler = move |method: Method, uri: Uri, body: Bytes| {
        let (seen, recorded, result_url) =
            (seen.clone(), Arc::clone(&recorded), result_url.clone());
        async move {
            let path = uri.path().to_owned();
            if method == Method::POST {
                seen.push(format!("{path} {}", String::from_utf8_lossy(&body)));
                recorded
                    .lock()
                    .unwrap()
                    .push(serde_json::from_slice(&body).unwrap_or(Value::Null));
            }
            if path == "/result" {
                return Json(json!({ "images": [{ "url": "https://x.invalid/i.png" }] }));
            }
            if path.ends_with("/predictions") || path.starts_with("/predictions/") {
                return Json(json!({
                    "id": "pred-1",
                    "status": "succeeded",
                    "output": ["https://x.invalid/o.png"]
                }));
            }
            if path.ends_with("_to_video") {
                return Json(json!({ "id": RUNWAY_TASK }));
            }
            if path.starts_with("/v1/tasks/") {
                return Json(json!({ "id": RUNWAY_TASK, "status": "PENDING" }));
            }
            Json(
                json!({ "status": "COMPLETED", "request_id": "req-1", "response_url": result_url }),
            )
        }
    };
    let router = Router::new().fallback(any(handler));
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    MediaVendor {
        base,
        upstream,
        bodies,
        task,
    }
}

fn vendor_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

#[derive(Clone, Copy)]
enum Vendor {
    Replicate,
    Fal,
    Runway,
}

struct MediaFloor {
    app: Router,
    vendor: MediaVendor,
    audit: Arc<FloorAudit>,
}

impl MediaFloor {
    async fn new(kind: Vendor) -> Self {
        let vendor = spawn_media_vendor().await;
        let name = match kind {
            Vendor::Replicate => "replicate",
            Vendor::Fal => "fal",
            Vendor::Runway => "runway",
        };
        let (mut state, audit) = floor_state(GatewayCustody::Fleet, floor_config(name));
        let provider: Arc<dyn Provider> = match kind {
            Vendor::Replicate => Arc::new(ryu_gw_providers::ReplicateProvider::new(
                vendor_client(),
                "vendor-secret".into(),
                vendor.base.clone(),
                1,
                2,
            )),
            Vendor::Fal => Arc::new(ryu_gw_providers::FalProvider::new(
                vendor_client(),
                "vendor-secret".into(),
                vendor.base.clone(),
                1,
                2,
            )),
            Vendor::Runway => Arc::new(ryu_gw_providers::runway::RunwayProvider::new(
                vendor_client(),
                None,
                vec!["vendor-secret".into()],
                format!("{}/v1", vendor.base),
                Arc::new(ryu_gw_providers::quota::ProviderQuotas::new()),
            )),
        };
        state.provider_runtime.register_for_test(provider);
        Self {
            app: crate::api::router(Arc::new(state)),
            vendor,
            audit,
        }
    }

    fn mark(&self) -> Mark {
        Mark {
            calls: self.vendor.upstream.count(),
            failures: self.audit.failures(),
        }
    }

    async fn blocked(&self, what: &str, uri: &str, body: &Value) {
        let mark = self.mark();
        let outcome = send(&self.app, Method::POST, uri, Some(TENANT), body).await;
        assert_blocked(
            what,
            outcome,
            "policy_violation",
            &self.vendor.upstream,
            &self.audit,
            mark,
        )
        .await;
    }

    async fn dispatches(&self, what: &str, uri: &str, body: &Value) {
        let mark = self.mark();
        let outcome = send(&self.app, Method::POST, uri, Some(TENANT), body).await;
        assert_dispatched(what, outcome, &self.vendor.upstream, mark);
    }
}

const IMAGES: &str = "/v1/images/generations";
const VIDEOS: &str = "/v1/videos/generations";

#[tokio::test]
async fn b08_replicate_nested_input_is_screened() {
    let floor = MediaFloor::new(Vendor::Replicate).await;
    let body = |prompt: String| json!({ "model": "owner/name", "input": { "prompt": prompt } });
    floor.blocked("B8", IMAGES, &body(marked("a cat"))).await;
    floor
        .dispatches("B8 control", IMAGES, &body("a cat".into()))
        .await;
}

#[tokio::test]
async fn b09_fal_nested_input_is_screened() {
    let floor = MediaFloor::new(Vendor::Fal).await;
    let body = |prompt: String| json!({ "model": "fal-ai/flux", "input": { "prompt": prompt } });
    floor.blocked("B9", IMAGES, &body(marked("a cat"))).await;
    floor
        .dispatches("B9 control", IMAGES, &body("a cat".into()))
        .await;
}

#[tokio::test]
async fn b10_replicate_negative_prompt_is_screened() {
    let floor = MediaFloor::new(Vendor::Replicate).await;
    let body = |negative: String| json!({ "model": "owner/name", "prompt": "cat", "negative_prompt": negative });
    floor.blocked("B10", IMAGES, &body(marked("blurry"))).await;
    floor
        .dispatches("B10 control", IMAGES, &body("blurry".into()))
        .await;
}

#[tokio::test]
async fn b11_runway_prompt_text_is_screened() {
    let floor = MediaFloor::new(Vendor::Runway).await;
    let body = |prompt: String| json!({ "model": "gen4.5", "promptText": prompt, "ratio": "1280:720", "duration": 5 });
    floor.blocked("B11", VIDEOS, &body(marked("waves"))).await;
    floor
        .dispatches("B11 control", VIDEOS, &body("waves at sunset".into()))
        .await;
}

#[tokio::test]
async fn b31_replicate_safety_checker_is_forced_on() {
    let floor = MediaFloor::new(Vendor::Replicate).await;
    let mark = floor.mark();
    let outcome = send(
        &floor.app,
        Method::POST,
        IMAGES,
        Some(TENANT),
        &json!({ "model": "owner/name", "input": { "prompt": "a cat", "disable_safety_checker": true } }),
    )
    .await;
    assert_dispatched("B31", outcome, &floor.vendor.upstream, mark);
    let sent = floor.vendor.bodies.lock().unwrap().clone();
    let sent = sent.last().expect("one submission");
    assert_eq!(
        sent["input"]["disable_safety_checker"], false,
        "the vendor receives the checker on: {sent}"
    );
}

// ── image route to OpenRouter, speech, transcription (B12 to B14, B17) ───────

#[tokio::test]
async fn b12_image_route_messages_to_openrouter_are_screened() {
    let floor = Floor::named("openrouter", HashMap::new(), |_| {});
    let body = |text: String| {
        json!({
            "model": "fixture-image",
            "prompt": "a cat",
            "messages": [{ "role": "user", "content": text }]
        })
    };
    floor.blocked("B12", IMAGES, &body(marked("draw"))).await;
    floor
        .dispatches("B12 control", IMAGES, &body("draw a cat".into()))
        .await;
}

const SPEECH: &str = "/v1/audio/speech";

#[tokio::test]
async fn b13_speech_instructions_and_text_are_screened() {
    let floor = Floor::new(|_| {});
    let speech = |field: &str, text: String| {
        let mut body = json!({ "model": "fixture-tts", "input": "Hello", "voice": "alloy" });
        body[field] = json!(text);
        body
    };
    for field in ["instructions", "text"] {
        floor
            .blocked(
                &format!("B13 {field}"),
                SPEECH,
                &speech(field, marked("calm")),
            )
            .await;
        floor
            .dispatches(
                &format!("B13 {field} control"),
                SPEECH,
                &speech(field, "calm and warm".into()),
            )
            .await;
    }
}

#[tokio::test]
async fn b17_long_speech_voice_is_screened() {
    let floor = Floor::new(|_| {});
    let voice = |tail: &str| format!("{}{tail}", "v".repeat(200 - tail.len()));
    let body = |voice: String| json!({ "model": "fixture-tts", "input": "Hello", "voice": voice });
    floor
        .blocked("B17", SPEECH, &body(voice(&format!(" {MARKER}"))))
        .await;
    floor
        .dispatches("B17 control", SPEECH, &body(voice(" alloy")))
        .await;
}

async fn post_transcription(floor: &Floor, prompt: &str) -> (StatusCode, Value) {
    let boundary = "floor-boundary";
    let mut body = Vec::new();
    for (name, value) in [("model", "fixture-stt"), ("prompt", prompt)] {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(b"RIFF0000WAVEfmt ");
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    read(
        floor
            .app()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/audio/transcriptions")
                    .header(
                        "content-type",
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .header("authorization", format!("Bearer {TENANT}"))
                    .extension(loopback())
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await
}

#[tokio::test]
async fn b14_transcription_prompt_is_screened() {
    let floor = Floor::new(|_| {});
    let mark = floor.mark();
    let outcome = post_transcription(&floor, &marked("names")).await;
    assert_blocked(
        "B14",
        outcome,
        "policy_violation",
        &floor.upstream,
        &floor.audit,
        mark,
    )
    .await;
    let mark = floor.mark();
    let outcome = post_transcription(&floor, "names: Ada, Grace").await;
    assert_dispatched("B14 control", outcome, &floor.upstream, mark);
}

// ── /v1/providers/call (B18) ─────────────────────────────────────────────────

/// A Composio stand-in that records every request and answers an execution.
async fn spawn_composio(upstream: Upstream) -> (String, tokio::task::JoinHandle<()>) {
    let executed_as = std::sync::Arc::new(std::sync::Mutex::new(Value::Null));
    let handler = move |method: Method, uri: Uri, body: Bytes| {
        let upstream = upstream.clone();
        let executed_as = std::sync::Arc::clone(&executed_as);
        async move {
            upstream.push(format!("{method} {uri} {}", String::from_utf8_lossy(&body)));
            if uri.path().starts_with("/api/v3.1/logs/tool_execution/") {
                // The billing log records the caller entity the execution
                // named; the Gateway verifies it before it prices the receipt.
                let caller = executed_as.lock().unwrap().clone();
                return Json(json!({ "id": "log_floor_1", "metadata": { "user_id": caller } }))
                    .into_response();
            }
            if let Ok(execution) = serde_json::from_slice::<Value>(&body) {
                *executed_as.lock().unwrap() = execution["user_id"].clone();
            }
            Json(json!({ "data": { "executed": true }, "log_id": "log_floor_1" })).into_response()
        }
    };
    serve(Router::new().fallback(any(handler))).await
}

async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (base, task)
}

#[tokio::test]
async fn b18_provider_call_composio_text_is_screened() {
    let upstream = Upstream::default();
    let (composio_url, composio) = spawn_composio(upstream.clone()).await;
    let (control_url, control) = serve(Router::new().route(
        "/api/credits/debit",
        post(|| async { Json(json!({ "balanceMicroUsd": 900_000, "wentNonPositive": false })) }),
    ))
    .await;
    let mut config = floor_config(FLOOR);
    config.composio.enabled = true;
    config.composio.api_key = Some("composio-project-test-key".to_owned());
    config.credits.enabled = true;
    config.credits.base_url = control_url.clone();
    config.credits.internal_secret = Some("internal-test-secret".to_owned());
    let (mut state, audit) = floor_state(GatewayCustody::Fleet, config);
    state.composio = Some(crate::composio::ComposioClient::for_test(
        state.config.composio.clone(),
        vendor_client(),
        format!("{composio_url}/api/v3.1"),
    ));
    state.resolve_cache = Some(crate::policy::ResolveCache::for_test(
        control_url,
        reqwest::Client::new(),
    ));
    let app = crate::api::router(Arc::new(state));
    let call = |text: &str| {
        json!({
            "provider": "composio",
            "toolId": "GMAIL_SEND_EMAIL",
            "operation": "execute",
            "method": "POST",
            "body": { "arguments": { "text": text } },
            "requestId": "req-floor-composio",
        })
    };
    let mark = Mark {
        calls: upstream.count(),
        failures: audit.failures(),
    };
    let outcome = send(
        &app,
        Method::POST,
        "/v1/providers/call",
        Some(CORE_KEY),
        &call(&marked("hello")),
    )
    .await;
    assert_blocked("B18", outcome, "policy_violation", &upstream, &audit, mark).await;
    let mark = Mark {
        calls: upstream.count(),
        failures: audit.failures(),
    };
    let outcome = send(
        &app,
        Method::POST,
        "/v1/providers/call",
        Some(CORE_KEY),
        &call("hello there"),
    )
    .await;
    assert_dispatched("B18 control", outcome, &upstream, mark);
    composio.abort();
    control.abort();
}

// ── tool loops (B19, B20) ────────────────────────────────────────────────────

const UNIFIED_TOOL: &str = "exa.search";
const COMPOSIO_ACTION: &str = "GMAIL_GET_MESSAGE";

/// Round one calls `tool`; every later round answers.
struct LoopProvider {
    name: &'static str,
    tool: String,
    upstream: Upstream,
    rounds: Arc<AtomicUsize>,
}

impl Provider for LoopProvider {
    fn name(&self) -> &'static str {
        self.name
    }

    fn complete<'a>(&'a self, _model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        self.upstream.push(body.to_string());
        let round = self.rounds.fetch_add(1, Ordering::SeqCst) + 1;
        let message = if round == 1 {
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": { "name": self.tool, "arguments": "{\"query\":\"latest\"}" }
                }]
            })
        } else {
            json!({ "role": "assistant", "content": "done" })
        };
        Box::pin(async move {
            Ok(json!({
                "id": format!("chatcmpl-round-{round}"),
                "object": "chat.completion",
                "model": "fixture-model",
                "choices": [{ "index": 0, "message": message, "finish_reason": "stop" }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
            }))
        })
    }

    fn complete_stream<'a>(&'a self, _model: &'a str, body: &'a Value) -> ProviderFuture<'a, Body> {
        self.upstream.push(body.to_string());
        Box::pin(async { Ok(Body::from("data: [DONE]\n\n")) })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Loop {
    Unified,
    Composio,
}

/// Runs one tool loop whose tool returns `output`, and returns the outcome,
/// the provider rounds and the tool runs.
async fn run_loop(
    kind: Loop,
    output: Value,
) -> (
    (StatusCode, Value),
    Upstream,
    usize,
    usize,
    Arc<FloorAudit>,
    Mark,
) {
    let executions = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&executions);
    let (core_url, core) = serve(
        Router::new()
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
            .fallback(|| async { Json(json!({})) }),
    )
    .await;
    let mut config = floor_config(FLOOR);
    config.routing.fallback_chain = vec![ProviderId::from(SPARE)];
    if kind == Loop::Composio {
        config.composio.enabled = true;
        config.composio.api_key = Some("composio-test-key".to_owned());
        config.composio.actions = vec![COMPOSIO_ACTION.to_owned()];
    }
    let (mut state, audit) = floor_state(GatewayCustody::Fleet, config);
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    state.tools = Some(crate::tools::ToolSearchClient::new(
        &CoreProviderConfig {
            base_url: core_url,
            token: None,
        },
        http.clone(),
    ));
    if kind == Loop::Composio {
        state.composio = Some(crate::composio::ComposioClient::for_test(
            state.config.composio.clone(),
            http,
            "http://127.0.0.1:9/unused".to_owned(),
        ));
    }
    let tool = match kind {
        Loop::Unified => crate::tools::catalog_client::model_tool_name(UNIFIED_TOOL),
        Loop::Composio => COMPOSIO_ACTION.to_owned(),
    };
    let upstream = Upstream::default();
    let rounds = Arc::new(AtomicUsize::new(0));
    for name in [FLOOR, SPARE] {
        state
            .provider_runtime
            .register_for_test(Arc::new(LoopProvider {
                name,
                tool: tool.clone(),
                upstream: upstream.clone(),
                rounds: Arc::clone(&rounds),
            }));
    }
    let app = crate::api::router(Arc::new(state));
    let mark = Mark {
        calls: 0,
        failures: audit.failures(),
    };
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(CHAT)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {TENANT}"))
        .extension(loopback());
    if kind == Loop::Unified {
        request = request.header("x-ryu-tools", UNIFIED_TOOL);
    }
    let body = chat(json!([{ "role": "user", "content": "look up the latest message" }]));
    let outcome = read(
        app.oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap(),
    )
    .await;
    core.abort();
    let runs = executions.load(Ordering::SeqCst);
    let rounds = rounds.load(Ordering::SeqCst);
    (outcome, upstream, rounds, runs, audit, mark)
}

async fn assert_loop_stops(kind: Loop, what: &str) {
    let ((status, body), upstream, rounds, runs, audit, mark) =
        run_loop(kind, json!({ "title": marked("result") })).await;
    assert_eq!(runs, 1, "{what}: the tool ran once");
    assert_eq!(rounds, 1, "{what}: round two never reached the chat mock");
    assert_eq!(status, StatusCode::FORBIDDEN, "{what}: {body}");
    assert_eq!(body["error"]["type"], "policy_violation", "{what}");
    assert_eq!(body["error"]["code"], "policy_violation", "{what}");
    assert!(
        !upstream.carries_a_marker(),
        "{what}: the marker reached the chat mock"
    );
    assert!(
        failures_reach(&audit, mark.failures + 1).await > mark.failures,
        "{what}: a failure audit row"
    );

    let ((status, body), _, rounds, runs, _, _) =
        run_loop(kind, json!({ "title": "Rust 1.90 released" })).await;
    assert!(status.is_success(), "{what} control: {body}");
    assert_eq!((rounds, runs), (2, 1), "{what} control: both rounds ran");
}

#[tokio::test]
async fn b19_legacy_composio_loop_stops_before_round_two() {
    assert_loop_stops(Loop::Composio, "B19").await;
}

#[tokio::test]
async fn b20_unified_tool_loop_stops_before_round_two() {
    assert_loop_stops(Loop::Unified, "B20").await;
}

// ── pipeline edits (B21 to B23) ──────────────────────────────────────────────

fn floor_ctx(request_id: &str) -> RequestContext {
    let mut ctx = plain_ctx();
    ctx.request_id = request_id.to_owned();
    ctx.org_id = Some(ORG.to_owned());
    ctx
}

/// Run `body` through the pipeline and assert the blocked outcome for the
/// buffered and streamed paths.
async fn assert_run_blocked(floor: &Floor, what: &str, body: &Value) {
    for streaming in [false, true] {
        let mark = floor.mark();
        let mut body = body.clone();
        body["stream"] = json!(streaming);
        let ctx = floor_ctx(&format!("{what}-{streaming}"));
        let error = if streaming {
            run_stream(Arc::clone(&floor.state), ctx, body).await.err()
        } else {
            run(Arc::clone(&floor.state), ctx, body).await.err()
        }
        .unwrap_or_else(|| panic!("{what} stream={streaming}: dispatched"));
        assert!(
            matches!(
                error,
                GatewayError::FirewallBlocked(..) | GatewayError::PolicyViolation(_)
            ),
            "{what}: {error:?}"
        );
        let outcome = read(error.into_response()).await;
        assert_blocked(
            &format!("{what} stream={streaming}"),
            outcome,
            "policy_violation",
            &floor.upstream,
            &floor.audit,
            mark,
        )
        .await;
    }
}

const ENSEMBLE: &str = "ensemble";

fn fusion_floor(answer_a: &str) -> Floor {
    let answers = HashMap::from([("a".to_owned(), answer_a.to_owned())]);
    Floor::named(FLOOR, answers, |config| {
        config.routing.model_map.insert(
            ENSEMBLE.into(),
            serde_json::from_value(json!({ "provider": "pool:flow" })).unwrap(),
        );
        config.routing.provider_pools.insert(
            "flow".into(),
            serde_json::from_value(json!({
                "strategy": "fusion",
                "execution": { "quorum": 3, "grace_ms": 1, "leg_timeout_ms": 2000,
                    "total_timeout_ms": 4000, "max_output_bytes": 262_144 },
                "members": [
                    { "provider": FLOOR, "model": "a" },
                    { "provider": FLOOR, "model": "b" },
                    { "provider": FLOOR, "model": "c" }
                ],
                "judge": { "provider": FLOOR, "model": "judge" }
            }))
            .unwrap(),
        );
    })
}

fn ensemble_body() -> Value {
    json!({ "model": ENSEMBLE, "messages": [{ "role": "user", "content": "Answer the task" }] })
}

#[tokio::test]
async fn b21_fusion_panel_answer_never_reaches_the_judge() {
    let floor = fusion_floor(&marked("panel"));
    let mark = floor.mark();
    let error = run(Arc::clone(&floor.state), floor_ctx("b21"), ensemble_body())
        .await
        .err()
        .expect("B21: the judge must not run");
    let outcome = read(error.into_response()).await;
    assert_eq!(outcome.0, StatusCode::FORBIDDEN, "{}", outcome.1);
    assert_eq!(outcome.1["error"]["code"], "policy_violation");
    let mut models = floor.models();
    models.sort();
    assert_eq!(models, ["a", "b", "c"], "B21: zero calls to the judge");
    assert!(floor.upstream.count() == mark.calls + 3);
    assert_eq!(
        failures_reach(&floor.audit, mark.failures + 1).await,
        mark.failures + 1,
        "B21: one failure audit row"
    );

    let control = fusion_floor("a benign panel answer");
    run(
        Arc::clone(&control.state),
        floor_ctx("b21-control"),
        ensemble_body(),
    )
    .await
    .expect("B21 control: the judge runs");
    assert!(control.models().contains(&"judge".to_owned()));
}

/// A compression service that always answers with `messages`.
async fn compression_service(messages: Value) -> (String, tokio::task::JoinHandle<()>) {
    serve(
        Router::new().route(
            "/v1/compress",
            post(move || {
                let messages = messages.clone();
                async move {
                    Json(json!({ "compressed": true, "messages": messages, "tokens_saved": 1 }))
                }
            }),
        ),
    )
    .await
}

fn compressing_floor(url: String) -> Floor {
    Floor::new(|config| {
        config.compression = CompressionConfig {
            enabled: true,
            url,
            timeout_ms: 10_000,
            min_messages: 1,
            ..CompressionConfig::default()
        };
    })
}

#[tokio::test]
async fn b22_compression_output_is_screened_before_dispatch() {
    let (url, service) =
        compression_service(json!([{ "role": "user", "content": marked("summary") }])).await;
    let floor = compressing_floor(url);
    assert_run_blocked(
        &floor,
        "B22",
        &chat(json!([{ "role": "user", "content": "ping" }])),
    )
    .await;
    service.abort();

    let (url, service) =
        compression_service(json!([{ "role": "user", "content": "a short summary" }])).await;
    let control = compressing_floor(url);
    run(
        Arc::clone(&control.state),
        floor_ctx("b22-control"),
        chat(json!([{ "role": "user", "content": "ping" }])),
    )
    .await
    .expect("B22 control: the compressed body dispatches");
    assert!(control
        .upstream
        .all()
        .iter()
        .any(|body| body.contains("a short summary")));
    service.abort();
}

const RELAY_MODEL: &str = "relay-model";

fn relay_floor(first_answer: &str) -> Floor {
    let answers = HashMap::from([("one".to_owned(), first_answer.to_owned())]);
    Floor::named(FLOOR, answers, |config| {
        config.routing.model_map.insert(
            RELAY_MODEL.into(),
            serde_json::from_value(json!({ "provider": "pool:relay" })).unwrap(),
        );
        config.routing.provider_pools.insert(
            "relay".into(),
            serde_json::from_value(json!({
                "strategy": "context_relay",
                "members": [
                    { "provider": FLOOR, "model": "one" },
                    { "provider": FLOOR, "model": "two" }
                ]
            }))
            .unwrap(),
        );
    })
}

fn relay_ctx(request_id: &str) -> RequestContext {
    let mut ctx = floor_ctx(request_id);
    ctx.session_id = Some("relay-session".into());
    ctx
}

fn relay_body(text: &str) -> Value {
    json!({ "model": RELAY_MODEL, "messages": [{ "role": "user", "content": text }] })
}

/// Serve one turn on member `one`, then cool it so the next turn moves to
/// member `two` and carries the relay handoff.
async fn serve_first_then_cool(floor: &Floor) {
    let first = relay_ctx("relay-first");
    run(
        Arc::clone(&floor.state),
        first.clone(),
        relay_body("first question"),
    )
    .await
    .expect("the first turn is served");
    assert_eq!(floor.models().last().map(String::as_str), Some("one"));
    provider_snapshot(&floor.state, &first)
        .provider_pools
        .record_rate_limit(
            &crate::provider_pools::SelectedPoolRoute {
                pool_name: "relay".into(),
                member_index: 0,
                provider: ProviderId::from(FLOOR),
                model: "one".into(),
                fallback_candidates: Vec::new(),
                execution: None,
            },
            Some(60),
        );
}

#[tokio::test]
async fn b23_relay_handoff_is_screened() {
    let floor = relay_floor(&marked("earlier answer"));
    serve_first_then_cool(&floor).await;
    // The first turn's answer is the marker, so the captured history now
    // holds it; check only that nothing new reaches the upstream.
    let mark = floor.mark();
    let error = run(
        Arc::clone(&floor.state),
        relay_ctx("b23"),
        relay_body("second question"),
    )
    .await
    .err()
    .unwrap_or_else(|| {
        panic!(
            "B23: the handoff carries the marker; models {:?}, upstream {:?}",
            floor.models(),
            floor.upstream.all()
        )
    });
    assert!(
        matches!(error, GatewayError::FirewallBlocked(..)),
        "{error:?}"
    );
    let (status, body) = read(error.into_response()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "policy_violation");
    assert_eq!(floor.upstream.count(), mark.calls, "B23: zero calls");
    assert_eq!(
        failures_reach(&floor.audit, mark.failures + 1).await,
        mark.failures + 1,
        "B23: one failure audit row"
    );

    let control = relay_floor("a benign earlier answer");
    serve_first_then_cool(&control).await;
    run(
        Arc::clone(&control.state),
        relay_ctx("b23-control"),
        relay_body("second question"),
    )
    .await
    .expect("B23 control: a benign handoff dispatches");
    assert_eq!(control.models().last().map(String::as_str), Some("two"));
}

// ── route gates (B24, AT-31, AT-33) ──────────────────────────────────────────

async fn spawn_batch_upstream(upstream: Upstream) -> (String, tokio::task::JoinHandle<()>) {
    serve(Router::new().route(
        "/api/v1/batches",
        post(move |body: Bytes| {
            let upstream = upstream.clone();
            async move {
                upstream.push(String::from_utf8_lossy(&body).into_owned());
                (
                    StatusCode::ACCEPTED,
                    Json(json!({ "id": "batch_floor_1", "status": "validating" })),
                )
            }
        }),
    ))
    .await
}

fn batch_app(custody: GatewayCustody, base: &str) -> (Router, Arc<FloorAudit>) {
    let mut config = floor_config(FLOOR);
    config.providers.openrouter = Some(crate::config::OpenRouterProviderConfig {
        api_key: "sk-or-mock".to_owned(),
        api_keys: Vec::new(),
        base_url: format!("{base}/api/v1"),
        site_url: "https://ryu.example".to_owned(),
        site_name: "Ryu".to_owned(),
        data_collection: String::new(),
        zdr: false,
        sort: String::new(),
        response_healing: false,
        usage_accounting: true,
        org_api_keys: Default::default(),
    });
    let (state, audit) = floor_state(custody, config);
    (crate::api::router(Arc::new(state)), audit)
}

#[tokio::test]
async fn b24_batch_creation_is_refused_on_fleet() {
    let batch = json!({
        "endpoint": "/v1/chat/completions",
        "model": "openai/gpt-4o-mini",
        "completion_window": "24h",
        "requests": [{ "custom_id": "item-1", "body": { "messages": [{ "role": "user", "content": "Hi" }] } }]
    });
    let upstream = Upstream::default();
    let (base, task) = spawn_batch_upstream(upstream.clone()).await;
    let (app, audit) = batch_app(GatewayCustody::Fleet, &base);
    let mark = Mark {
        calls: 0,
        failures: 0,
    };
    let outcome = send(&app, Method::POST, "/v1/batches", Some(MASTER), &batch).await;
    assert_eq!(outcome.1["error"]["layer"], "platform");
    assert_blocked(
        "B24",
        outcome,
        "feature_not_permitted",
        &upstream,
        &audit,
        mark,
    )
    .await;

    // Control: off the fleet the same batch is created upstream.
    let (app, _) = batch_app(GatewayCustody::SelfHosted, &base);
    let outcome = send(&app, Method::POST, "/v1/batches", Some(MASTER), &batch).await;
    assert_dispatched("B24 control", outcome, &upstream, mark);
    task.abort();
}

#[tokio::test]
async fn at31_fleet_has_no_passthrough() {
    let floor = Floor::new(|_| {});
    let (status, _) = send(
        &floor.app(),
        Method::GET,
        "/passthrough/anthropic/v1/models",
        None,
        &json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "AT-31");
    assert_eq!(floor.upstream.count(), 0);

    // Control: off the fleet the route is mounted. A remote peer is refused by
    // the handler's own loopback check, before any upstream request.
    let (state, _) = floor_state(GatewayCustody::SelfHosted, floor_config(FLOOR));
    let (status, body) = read(
        crate::api::router(Arc::new(state))
            .oneshot(
                Request::builder()
                    .uri("/passthrough/anthropic/v1/models")
                    .extension(ConnectInfo(std::net::SocketAddr::from((
                        [203, 0, 113, 7],
                        40_000,
                    ))))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "AT-31 control: {body}");
}

#[tokio::test]
async fn at33_gateway_key_in_a_gemini_query_is_refused() {
    let floor = Floor::new(|_| {});
    let gemini =
        |text: &str| json!({ "contents": [{ "role": "user", "parts": [{ "text": text }] }] });
    let uri = format!("/v1beta/models/fixture-model:generateContent?key={RGW_TOKEN}");
    let mark = floor.mark();
    let (status, body) = send(&floor.app(), Method::POST, &uri, None, &gemini("Hi")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "AT-33: {body}");
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("header")),
        "AT-33: the refusal says to use a header: {body}"
    );
    assert_eq!(floor.upstream.count(), mark.calls);
    assert!(
        !floor.audit.text().contains(RGW_TOKEN),
        "the token is never audited"
    );
    assert_eq!(
        failures_reach(&floor.audit, mark.failures + 1).await,
        mark.failures + 1
    );

    floor
        .dispatches(
            "AT-33 control",
            "/v1beta/models/fixture-model:generateContent",
            &gemini("Hi"),
        )
        .await;
}

// ── own supply and health signals (R1a, R2, AT-17b) ─────────────────────────

const OWN_SLOT: &str = "anthropic-credits";

/// Ryu's own `anthropic-credits` slot. `refuse_with` 0 serves; any other
/// value answers that upstream status with a message that says "forbidden".
struct OwnSlot {
    refuse_with: Arc<AtomicU16>,
    calls: Arc<AtomicUsize>,
}

impl OwnSlot {
    fn reply(&self) -> Result<(), ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.refuse_with.load(Ordering::SeqCst) {
            0 => Ok(()),
            status if status >= 500 => Err(ProviderError::Provider(format!(
                "{OWN_SLOT} error {status}"
            ))),
            status => Err(ProviderError::Rejected {
                status,
                message: format!("{status} Forbidden: forbidden by upstream policy"),
            }),
        }
    }
}

impl Provider for OwnSlot {
    fn name(&self) -> &'static str {
        OWN_SLOT
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        let reply = self.reply();
        Box::pin(async move {
            reply.map(|()| {
                json!({
                    "id": "chatcmpl-own",
                    "object": "chat.completion",
                    "model": "own-1",
                    "choices": [{
                        "index": 0,
                        "message": { "role": "assistant", "content": "pong" },
                        "finish_reason": "stop"
                    }],
                    "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 }
                })
            })
        })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> ProviderFuture<'a, Body> {
        let reply = self.reply();
        Box::pin(async move {
            reply.map(|()| {
                Body::from(concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"pong\"}}]}\n\n",
                    "data: [DONE]\n\n",
                ))
            })
        })
    }
}

struct OwnFloor {
    state: Arc<AppState>,
    refuse_with: Arc<AtomicU16>,
    slot: Arc<AtomicUsize>,
    router: Arc<AtomicUsize>,
    audit: Arc<FloorAudit>,
}

impl OwnFloor {
    fn slot_quarantined(&self) -> bool {
        !self
            .state
            .own_supply
            .take_quarantine_counts(OWN_SLOT)
            .is_empty()
    }

    fn circuit_open(&self, provider: &str) -> bool {
        self.state
            .circuit_breaker
            .is_open(&current_circuit_key(&self.state, provider))
    }
}

/// A fleet gateway whose default route is the Ryu Router (`openrouter`) and
/// that also holds Ryu's own `anthropic-credits` slot, circuit threshold 1.
fn own_floor(refuse_with: u16) -> OwnFloor {
    own_floor_with(refuse_with, true)
}

/// [`own_floor`] with the local firewall on or off. With it off, only a
/// locked guardrail can refuse, so a detected secret is a `PolicyViolation`.
fn own_floor_with(refuse_with: u16, firewall: bool) -> OwnFloor {
    let mut config = floor_config("openrouter");
    config.firewall.enabled = firewall;
    config.circuit_breaker = CircuitBreakerConfig {
        enabled: true,
        failure_threshold: 1,
        reset_timeout_secs: 30,
    };
    let (mut state, audit) = floor_state(GatewayCustody::Fleet, config);
    if !firewall {
        // The compiled baseline floor would turn the firewall back on.
        state.platform_floor = crate::platform_floor::FloorStore::with(
            crate::platform_floor::PlatformFloor::setting_nothing(),
        );
    }
    let (router, router_calls) = StubProvider::new("openrouter", Mode::Ok);
    let refuse = Arc::new(AtomicU16::new(refuse_with));
    let slot_calls = Arc::new(AtomicUsize::new(0));
    state
        .provider_runtime
        .register_for_test(router as Arc<dyn Provider>);
    state.provider_runtime.register_for_test(Arc::new(OwnSlot {
        refuse_with: Arc::clone(&refuse),
        calls: Arc::clone(&slot_calls),
    }) as Arc<dyn Provider>);
    OwnFloor {
        state: Arc::new(state),
        refuse_with: refuse,
        slot: slot_calls,
        router: router_calls,
        audit,
    }
}

fn own_body(content: &str) -> Value {
    json!({
        "model": "anthropic/claude-sonnet-4.5",
        "messages": [{ "role": "user", "content": content }]
    })
}

/// A paying caller whose org locks the secrets guardrail, so a detected
/// secret is a `PolicyViolation` whatever the local firewall says.
fn locked_ctx() -> RequestContext {
    let mut ctx = free_credit_ctx(5_000_000);
    ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
        locked_guardrails: vec!["secrets".to_owned()],
        ..crate::policy::EffectivePolicy::default()
    });
    ctx
}

#[tokio::test]
async fn r1a_safety_outcomes_never_close_own_supply() {
    let own = own_floor(0);
    // 25 inbound firewall blocks on the test pattern, then 25 locked-guardrail
    // policy refusals on the example key on a twin whose local firewall is
    // off, so those are `PolicyViolation`s and not firewall blocks.
    let own_policy = own_floor_with(0, false);
    for round in 0..25 {
        let error = run(
            Arc::clone(&own.state),
            free_credit_ctx(5_000_000),
            own_body(&marked("ping")),
        )
        .await
        .err()
        .expect("the firewall blocks");
        assert!(
            matches!(error, GatewayError::FirewallBlocked(..)),
            "{round}: {error:?}"
        );
        let error = run(
            Arc::clone(&own_policy.state),
            locked_ctx(),
            own_body(&format!("deploy with {FAKE_AWS_KEY}")),
        )
        .await
        .err()
        .expect("the locked guardrail refuses");
        assert!(
            matches!(error, GatewayError::PolicyViolation(_)),
            "{round}: {error:?}"
        );
    }
    for floor in [&own, &own_policy] {
        assert_eq!(
            floor.slot.load(Ordering::SeqCst),
            0,
            "no safety outcome reached the slot"
        );
        assert_eq!(floor.router.load(Ordering::SeqCst), 0);
        assert_eq!(floor.audit.failures(), 25, "one failure row per refusal");
        assert!(!floor.circuit_open(OWN_SLOT));
        assert!(!floor.slot_quarantined());
    }

    // 50 raw upstream 403s whose message says "forbidden".
    own.refuse_with.store(403, Ordering::SeqCst);
    for round in 0..50 {
        let error = run(
            Arc::clone(&own.state),
            free_credit_ctx(5_000_000),
            own_body(&format!("ping {round}")),
        )
        .await
        .err()
        .expect("the upstream refuses");
        assert!(
            matches!(error, GatewayError::ProviderRejected { status: 403, .. }),
            "{round}: {error:?}"
        );
    }
    assert_eq!(own.slot.load(Ordering::SeqCst), 50);
    assert_eq!(
        own.router.load(Ordering::SeqCst),
        0,
        "no refusal moved vendors"
    );
    assert!(!own.circuit_open(OWN_SLOT), "the circuit stays closed");
    assert!(!own.slot_quarantined(), "the slot stays in the table");

    // Control: the next benign request from another org is served on own
    // supply.
    own.refuse_with.store(0, Ordering::SeqCst);
    let mut other = free_credit_ctx(5_000_000);
    other.org_id = Some("another-org".to_owned());
    run(Arc::clone(&own.state), other, own_body("ping"))
        .await
        .expect("own supply serves");
    assert_eq!(own.slot.load(Ordering::SeqCst), 51);
    assert_eq!(own.router.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn r2_own_supply_policy_violation_never_falls_back() {
    let ctx = locked_ctx();
    assert!(!may_fall_back(
        &GatewayError::PolicyViolation("locked guardrail".into()),
        &ctx
    ));
    assert!(!may_fall_back(
        &GatewayError::FirewallBlocked("blocked".into(), None),
        &ctx
    ));

    // The local firewall is off, so only the locked guardrail can refuse.
    let own = own_floor_with(0, false);
    let mark_failures = own.audit.failures();
    let error = run(
        Arc::clone(&own.state),
        locked_ctx(),
        own_body(&format!("deploy with {FAKE_AWS_KEY}")),
    )
    .await
    .err()
    .expect("the locked guardrail refuses");
    assert!(
        matches!(error, GatewayError::PolicyViolation(_)),
        "{error:?}"
    );
    let (status, body) = read(error.into_response()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["type"], "policy_violation");
    assert_eq!(own.slot.load(Ordering::SeqCst), 0);
    assert_eq!(
        own.router.load(Ordering::SeqCst),
        0,
        "zero OpenRouter calls"
    );
    assert_eq!(own.audit.failures(), mark_failures + 1);

    // Control: the same caller with a clean body is served on own supply.
    run(Arc::clone(&own.state), locked_ctx(), own_body("ping"))
        .await
        .expect("own supply serves");
    assert_eq!(own.slot.load(Ordering::SeqCst), 1);
    assert_eq!(own.router.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn at17b_unrecognised_own_supply_400_is_not_retried() {
    let own = own_floor(400);
    for streaming in [false, true] {
        let ctx = free_credit_ctx(5_000_000);
        let error = if streaming {
            run_stream(Arc::clone(&own.state), ctx, own_body("ping"))
                .await
                .err()
        } else {
            run(Arc::clone(&own.state), ctx, own_body("ping"))
                .await
                .err()
        }
        .expect("the own-supply 400 is returned");
        assert!(
            matches!(error, GatewayError::ProviderRejected { status: 400, .. }),
            "stream={streaming}: {error:?}"
        );
    }
    assert_eq!(own.slot.load(Ordering::SeqCst), 2);
    assert_eq!(own.router.load(Ordering::SeqCst), 0, "no OpenRouter retry");
    assert!(!own.slot_quarantined());
    assert!(!own.circuit_open(OWN_SLOT));

    // Control: an upstream outage (a 503) still falls back to the router.
    let outage = own_floor(503);
    run(
        Arc::clone(&outage.state),
        free_credit_ctx(5_000_000),
        own_body("ping"),
    )
    .await
    .expect("the router rescues an outage");
    assert_eq!(outage.router.load(Ordering::SeqCst), 1);
}

// ── posture (AT-32) ──────────────────────────────────────────────────────────

#[tokio::test]
async fn at32_posture_flags_f1_and_f3_without_changing_dispatch() {
    let floor = Floor::new(|config| {
        config.providers.openai = Some(crate::config::OpenAiProviderConfig {
            api_key: "sk-test-floor-openai-a".to_owned(),
            api_keys: vec![
                "sk-test-floor-openai-a".to_owned(),
                "sk-test-floor-openai-b".to_owned(),
            ],
            base_url: "https://openai.invalid/v1".to_owned(),
        });
        config.providers.openrouter = Some(crate::config::OpenRouterProviderConfig {
            api_key: "sk-or-test-floor".to_owned(),
            api_keys: Vec::new(),
            base_url: "https://openrouter.invalid/api/v1".to_owned(),
            site_url: "https://ryu.example".to_owned(),
            site_name: "Ryu".to_owned(),
            data_collection: String::new(),
            zdr: false,
            sort: String::new(),
            response_healing: false,
            usage_accounting: true,
            org_api_keys: Default::default(),
        });
        config.egress.pools.insert(
            "rotating".to_owned(),
            crate::config::EgressProxyPoolConfig {
                include_direct: false,
                direct_fallback_only: false,
                endpoints: vec![crate::config::EgressProxyEndpointConfig {
                    id: "proxy-a".to_owned(),
                    url: "http://127.0.0.1:9".to_owned(),
                    enabled: true,
                    priority: 0,
                    username_env: None,
                    password_env: None,
                }],
            },
        );
        config
            .egress
            .assignments
            .insert("openrouter".to_owned(), "rotating".to_owned());
    });
    let report = crate::api::egress_posture::report_for(&floor.state);
    assert_eq!(report.active_ids(), vec!["F1", "F3"]);
    let flagged: Vec<&str> = report.flags.iter().map(|flag| flag.id).collect();
    assert_eq!(flagged, ["F1", "F3"], "two egress.posture_flag events");
    assert!(report
        .flags
        .iter()
        .all(|flag| flag.event == "egress.posture_flag"));
    // Behaviour unchanged: the screen still blocks and a benign body still
    // dispatches.
    floor
        .blocked(
            "AT-32 screen",
            CHAT,
            &chat(json!([{ "role": "user", "content": marked("x") }])),
        )
        .await;
    floor
        .dispatches(
            "AT-32 control",
            CHAT,
            &chat(json!([{ "role": "user", "content": "hello" }])),
        )
        .await;
}

/// Coverage probe: input shapes the suite above does not exercise.
#[path = "floor_bypass_probe_test.rs"]
mod probe;

/// Coverage probe: the platform floor (spec 02.3) as the only screening layer.
#[path = "platform_floor_probe_test.rs"]
mod platform_floor_probe;
