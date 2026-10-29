//! Coverage probes for the P0-4 rescan of content added after `pre_process`.
//!
//! These place a harmless marker in shapes the builder's suite does not reach:
//! strings the compression service moves out of a field the inbound walk
//! skips, decoded forms inside new compression leaves, deep nesting, arrays
//! of objects, long benign padding, locked guardrails on compression and relay
//! output, the streaming relay, fusion and pipeline paths, and refusals that
//! must never count against provider health. Every blocked case asserts the
//! catalogue status, zero upstream calls and one audit row, and has a benign
//! control that dispatches. The only triggering content is the AWS
//! documentation example key and test-only firewall patterns.
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use axum::{
    body::Body,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};

use super::{run, run_stream, test_support::plain_request_context, RequestContext};
use crate::{
    audit::{AuditEntry, AuditLogger, AuditQuery},
    config::{
        AuditConfig, CompressionConfig, CustomPattern, CustomPatternKind, FirewallConfig,
        FirewallPolicy, GatewayConfig, ProviderId, RoutingConfig,
    },
    custody::GatewayCustody,
    error::GatewayError,
    evals::EvalsRunner,
    policy::EffectivePolicy,
    providers::Provider,
    skills::Skill,
    state::AppState,
};

/// The AWS documentation example access-key id. Never a real credential.
const SECRET: &str = "AKIAIOSFODNN7EXAMPLE";
/// The same key with its first letter written as a JSON `\u` escape, so only
/// a decoding screen can find it.
const SECRET_ESCAPED: &str = "\\u0041KIAIOSFODNN7EXAMPLE";
const PROVIDER: &str = "primary";
/// A test-only inbound firewall pattern.
const LEXICON: &str = "RYU_TEST_LEXICON";

fn lexicon_pattern() -> CustomPattern {
    CustomPattern {
        name: "ryu_test_lexicon".into(),
        regex: LEXICON.into(),
        kind: CustomPatternKind::PromptInjection,
    }
}

type ProviderFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>>;

/// Records every body it is sent and answers with a per-model text.
struct CapturingProvider {
    bodies: Arc<Mutex<Vec<Value>>>,
    answers: HashMap<String, String>,
}

impl CapturingProvider {
    fn record(&self, model: &str, body: &Value) {
        let mut body = body.clone();
        body["model"] = json!(model);
        self.bodies.lock().unwrap().push(body);
    }

    fn answer(&self, model: &str) -> String {
        self.answers
            .get(model)
            .cloned()
            .unwrap_or_else(|| "ok".to_owned())
    }
}

impl Provider for CapturingProvider {
    fn name(&self) -> &'static str {
        PROVIDER
    }

    fn complete<'a>(&'a self, model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        self.record(model, body);
        let text = self.answer(model);
        Box::pin(async move {
            Ok(json!({
                "id": "chatcmpl-probe",
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
        self.record(model, body);
        let delta = json!({"choices":[{"index":0,"delta":{"content":self.answer(model)}}]});
        Box::pin(async move { Ok(Body::from(format!("data: {delta}\n\ndata: [DONE]\n\n"))) })
    }
}

struct Harness {
    state: Arc<AppState>,
    bodies: Arc<Mutex<Vec<Value>>>,
    _audit_dir: tempfile::TempDir,
}

impl Harness {
    fn new(custody: GatewayCustody, configure: impl FnOnce(&mut GatewayConfig)) -> Self {
        Self::with_answers(custody, HashMap::new(), configure)
    }

    fn with_answers(
        custody: GatewayCustody,
        answers: HashMap<String, String>,
        configure: impl FnOnce(&mut GatewayConfig),
    ) -> Self {
        let audit_dir = tempfile::tempdir().unwrap();
        let audit_config = AuditConfig {
            enabled: true,
            db_path: audit_dir
                .path()
                .join("audit.db")
                .to_string_lossy()
                .into_owned(),
        };
        let mut config = GatewayConfig {
            routing: RoutingConfig {
                default_provider: ProviderId::from(PROVIDER),
                fallback_chain: vec![ProviderId::from(PROVIDER)],
                ..RoutingConfig::default()
            },
            firewall: FirewallConfig {
                enabled: true,
                scan_inbound: true,
                scan_outbound: false,
                policy: FirewallPolicy::Block,
                ..FirewallConfig::default()
            },
            cache: crate::config::CacheConfig {
                enabled: false,
                ..crate::config::CacheConfig::default()
            },
            audit: audit_config.clone(),
            ..GatewayConfig::default()
        };
        configure(&mut config);
        let audit = AuditLogger::new(&audit_config).unwrap();
        let mut state = AppState::new_for_test(config, audit, EvalsRunner::new(Default::default()));
        state.custody = custody;
        let bodies = Arc::new(Mutex::new(Vec::new()));
        state
            .provider_runtime
            .register_for_test(Arc::new(CapturingProvider {
                bodies: Arc::clone(&bodies),
                answers,
            }) as Arc<dyn Provider>);
        Self {
            state: Arc::new(state),
            bodies,
            _audit_dir: audit_dir,
        }
    }

    fn calls(&self) -> usize {
        self.bodies.lock().unwrap().len()
    }

    fn last_body(&self) -> Value {
        self.bodies.lock().unwrap().last().cloned().unwrap()
    }

    async fn dispatch(
        &self,
        ctx: RequestContext,
        body: Value,
        streaming: bool,
    ) -> Result<(), GatewayError> {
        if streaming {
            let output = run_stream(Arc::clone(&self.state), ctx, body).await?;
            axum::body::to_bytes(output.body, usize::MAX).await.unwrap();
        } else {
            run(Arc::clone(&self.state), ctx, body).await?;
        }
        Ok(())
    }
}

/// Error rows for `request_id`, polled because the logger writes off-thread.
async fn error_rows(state: &AppState, request_id: &str) -> Vec<AuditEntry> {
    let mut rows = Vec::new();
    for _ in 0..200 {
        rows = state
            .audit
            .query(&AuditQuery {
                limit: Some(200),
                ..AuditQuery::default()
            })
            .unwrap()
            .into_iter()
            .filter(|row| row.request_id == request_id && row.error.is_some())
            .collect();
        if !rows.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    rows
}

fn ctx(request_id: &str) -> RequestContext {
    let mut ctx = plain_request_context();
    ctx.request_id = request_id.to_owned();
    ctx
}

fn locked_ctx(request_id: &str, guardrail: &str) -> RequestContext {
    let mut ctx = ctx(request_id);
    ctx.resolved_policy = Some(EffectivePolicy {
        locked_guardrails: vec![guardrail.to_owned()],
        ..EffectivePolicy::default()
    });
    ctx
}

fn chat(messages: Value, stream: bool) -> Value {
    json!({ "model": "fixture-model", "stream": stream, "messages": messages })
}

fn ping(stream: bool) -> Value {
    chat(json!([{ "role": "user", "content": "ping" }]), stream)
}

async fn status_and_type(error: GatewayError) -> (StatusCode, Value) {
    let response = error.into_response();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body["error"]["type"].clone())
}

/// Dispatch `body` and describe every way the outcome differs from a
/// catalogue refusal (403 `policy_violation`, zero calls, one audit row).
async fn refusal_mismatch(
    harness: &Harness,
    request_id: &str,
    body: Value,
    streaming: bool,
) -> Option<String> {
    let calls_before = harness.calls();
    let outcome = harness.dispatch(ctx(request_id), body, streaming).await;
    let mut problems = Vec::new();
    match outcome {
        Ok(()) => {
            let sent = harness
                .bodies
                .lock()
                .unwrap()
                .last()
                .map(Value::to_string)
                .unwrap_or_default();
            problems.push(format!(
                "dispatched (marker reached upstream: {})",
                sent.contains(SECRET) || sent.contains("AKIA") || sent.contains(LEXICON)
            ));
        }
        Err(error) => {
            if !matches!(
                error,
                GatewayError::FirewallBlocked(..) | GatewayError::PolicyViolation(_)
            ) {
                problems.push(format!("unexpected error {error:?}"));
            }
            let (status, kind) = status_and_type(error).await;
            if status != StatusCode::FORBIDDEN || kind != "policy_violation" {
                problems.push(format!("status {status} type {kind}"));
            }
            let rows = error_rows(&harness.state, request_id).await;
            if rows.len() != 1 {
                problems.push(format!("{} audit rows", rows.len()));
            }
        }
    }
    if harness.calls() != calls_before {
        problems.push(format!("{} upstream calls", harness.calls() - calls_before));
    }
    (!problems.is_empty()).then(|| format!("{request_id}: {}", problems.join(", ")))
}

fn skill(name: &str, snippet: &str) -> Skill {
    Skill {
        name: name.into(),
        description: "fixture".into(),
        system_prompt_snippet: snippet.into(),
        enabled: true,
    }
}

// ── Compression service fixture ──────────────────────────────────────────────

type CompressReply = Arc<dyn Fn(&Value) -> (StatusCode, Value) + Send + Sync>;

#[derive(Clone)]
struct CompressionFixture {
    reply: CompressReply,
}

async fn compress_fixture(
    State(fixture): State<CompressionFixture>,
    Json(request): Json<Value>,
) -> Response {
    let (status, body) = (fixture.reply)(&request);
    (status, Json(body)).into_response()
}

struct CompressionService {
    url: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for CompressionService {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn compression_service(
    reply: impl Fn(&Value) -> (StatusCode, Value) + Send + Sync + 'static,
) -> CompressionService {
    let app = Router::new()
        .route("/v1/compress", post(compress_fixture))
        .with_state(CompressionFixture {
            reply: Arc::new(reply),
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    CompressionService { url, task }
}

/// A service that always answers with `messages`.
async fn returning(messages: Value) -> CompressionService {
    compression_service(move |_| {
        (
            StatusCode::OK,
            json!({ "compressed": true, "messages": messages.clone(), "tokens_saved": 1 }),
        )
    })
    .await
}

fn compression(service: &CompressionService) -> CompressionConfig {
    CompressionConfig {
        enabled: true,
        url: service.url.clone(),
        timeout_ms: 10_000,
        min_messages: 1,
        ..CompressionConfig::default()
    }
}

// ── Compression moves a string out of a field the inbound walk skips ────────

fn linked_url() -> String {
    format!("https://example.com/assets/{SECRET}/report")
}

/// A text part carrying a `url` field. `url` is a media key, so the inbound
/// walk skips the URL under it as a fetched input.
fn url_part_messages() -> Value {
    json!([{ "role": "user", "content": [
        { "type": "text", "text": "see the linked report", "url": linked_url() }
    ]}])
}

#[tokio::test]
async fn probe_control_url_under_a_media_key_dispatches_without_compression() {
    let harness = Harness::new(GatewayCustody::SelfHosted, |_| {});
    harness
        .dispatch(ctx("url-plain"), chat(url_part_messages(), false), false)
        .await
        .expect("precondition: the inbound walk skips a URL under a media key");
    assert_eq!(harness.calls(), 1);
    assert!(harness.last_body().to_string().contains(SECRET));
}

#[tokio::test]
async fn probe_control_compression_adding_the_url_as_content_is_refused() {
    let service = returning(json!([{ "role": "user", "content": linked_url() }])).await;
    let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
        config.compression = compression(&service);
    });
    let mismatch = refusal_mismatch(&harness, "url-added", ping(false), false).await;
    assert!(mismatch.is_none(), "{mismatch:?}");
}

/// The service returns, as plain message content, the identical URL string
/// the caller sent under a media key. The provider now reads it as prompt
/// text, a position no inbound screen judged it in.
#[tokio::test]
async fn probe_compression_moving_a_media_url_into_content_is_refused() {
    let mut mismatches = Vec::new();
    for streaming in [false, true] {
        let service = returning(json!([{ "role": "user", "content": linked_url() }])).await;
        let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
            config.compression = compression(&service);
        });
        let mismatch = refusal_mismatch(
            &harness,
            &format!("url-moved-{streaming}"),
            chat(url_part_messages(), streaming),
            streaming,
        )
        .await;
        mismatches.extend(mismatch);
    }
    assert!(mismatches.is_empty(), "{mismatches:#?}");
}

/// The same relocation from a chat `image_url` part.
#[tokio::test]
async fn probe_compression_moving_an_image_url_into_content_is_refused() {
    let messages = json!([{ "role": "user", "content": [
        { "type": "text", "text": "describe this" },
        { "type": "image_url", "image_url": { "url": linked_url() } }
    ]}]);
    let plain = Harness::new(GatewayCustody::SelfHosted, |_| {});
    plain
        .dispatch(ctx("image-plain"), chat(messages.clone(), false), false)
        .await
        .expect("precondition: an image URL is not screened inbound");
    let service = returning(json!([{ "role": "user", "content": linked_url() }])).await;
    let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
        config.compression = compression(&service);
    });
    let mismatch = refusal_mismatch(&harness, "image-moved", chat(messages, false), false).await;
    assert!(mismatch.is_none(), "{mismatch:?}");
}

// ── New compression leaves in unusual shapes ─────────────────────────────────

/// Message shapes a compression service could return, each carrying `payload`
/// in a different place.
fn compression_shapes(payload: &str) -> Vec<(&'static str, Value)> {
    vec![
        (
            "text-part-array",
            json!([{ "role": "user", "content": [
                { "type": "text", "text": "intro" },
                { "type": "text", "text": payload }
            ]}]),
        ),
        (
            "deep-nesting",
            json!([{ "role": "user", "content": [{ "type": "text", "text": "x", "extra":
                { "l1": { "l2": [{ "l3": { "l4": { "l5": [{ "l6": { "l7": { "l8": payload } } }] } } }] } }
            }]}]),
        ),
        (
            "array-of-objects-non-text-key",
            json!([{ "role": "user", "content": "x", "notes": [{ "k": "a" }, { "k": payload }] }]),
        ),
        (
            "tool-message",
            json!([{ "role": "tool", "tool_call_id": "call_1", "content": payload }]),
        ),
        (
            "assistant-tool-call-arguments",
            json!([{ "role": "assistant", "content": null, "tool_calls": [{
                "id": "call_1", "type": "function",
                "function": { "name": "lookup", "arguments": json!({ "note": payload }).to_string() }
            }]}]),
        ),
        (
            "name-field",
            json!([{ "role": "user", "name": payload, "content": "x" }]),
        ),
        (
            "reasoning-field",
            json!([{ "role": "assistant", "content": "x", "reasoning_content": payload }]),
        ),
        (
            "stringified-json-content",
            json!([{ "role": "user", "content": json!({ "summary": { "items": [payload] } }).to_string() }]),
        ),
    ]
}

#[tokio::test]
async fn probe_compression_shapes_with_a_marker_are_refused() {
    let mut mismatches = Vec::new();
    for payload in [
        format!("the key is {SECRET}"),
        format!("marker {LEXICON} here"),
    ] {
        for (shape, messages) in compression_shapes(&payload) {
            for streaming in [false, true] {
                let service = returning(messages.clone()).await;
                let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
                    config.firewall.custom_patterns = vec![lexicon_pattern()];
                    config.compression = compression(&service);
                });
                let id = format!("shape-{shape}-{}-{streaming}", payload.len());
                if let Some(mismatch) =
                    refusal_mismatch(&harness, &id, ping(streaming), streaming).await
                {
                    mismatches.push(mismatch);
                }
            }
        }
    }
    assert!(mismatches.is_empty(), "{mismatches:#?}");
}

/// The key written with a JSON `\u` escape: the raw string never spells it,
/// so only the decoded form can match.
#[tokio::test]
async fn probe_compression_shapes_with_an_escaped_marker_are_refused() {
    let escaped_arguments = format!("{{\"note\":\"{SECRET_ESCAPED}\"}}");
    let shapes = vec![
        (
            "escaped-tool-call-arguments",
            json!([{ "role": "assistant", "content": null, "tool_calls": [{
                "id": "call_1", "type": "function",
                "function": { "name": "lookup", "arguments": escaped_arguments }
            }]}]),
        ),
        (
            "escaped-deep-nesting",
            json!([{ "role": "user", "content": [{ "type": "text", "text": "x", "extra":
                { "l1": { "l2": [{ "l3": { "l4": { "l5": [{ "l6": { "l7": SECRET_ESCAPED } }] } } }] } }
            }]}]),
        ),
        (
            "escaped-stringified-json-content",
            json!([{ "role": "user", "content": format!("{{\"summary\":\"{SECRET_ESCAPED}\"}}") }]),
        ),
        (
            "percent-encoded-plain-data-uri",
            json!([{ "role": "user", "content": "data:text/plain,AKIA%49OSFODNN7EXAMPLE" }]),
        ),
    ];
    let mut mismatches = Vec::new();
    for (shape, messages) in shapes {
        let service = returning(messages).await;
        let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
            config.compression = compression(&service);
        });
        if let Some(mismatch) = refusal_mismatch(&harness, shape, ping(false), false).await {
            mismatches.push(mismatch);
        }
    }
    assert!(mismatches.is_empty(), "{mismatches:#?}");
}

#[tokio::test]
async fn probe_control_benign_compression_shapes_dispatch() {
    let mut failures = Vec::new();
    for (shape, messages) in compression_shapes("a benign compressed summary") {
        let service = returning(messages.clone()).await;
        let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
            config.firewall.custom_patterns = vec![lexicon_pattern()];
            config.compression = compression(&service);
        });
        match harness.dispatch(ctx(shape), ping(false), false).await {
            Ok(()) if harness.calls() == 1 && harness.last_body()["messages"] == messages => {}
            outcome => failures.push(format!("{shape}: {outcome:?}, calls {}", harness.calls())),
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

// ── Long benign padding ──────────────────────────────────────────────────────

fn padding() -> String {
    "lorem ipsum ".repeat(90_000)
}

#[tokio::test]
async fn probe_compression_marker_after_long_padding_is_refused() {
    let content = format!("{}{SECRET}", padding());
    let service = returning(json!([{ "role": "user", "content": content }])).await;
    let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
        config.compression = compression(&service);
    });
    let mismatch = refusal_mismatch(&harness, "padded-compression", ping(false), false).await;
    assert!(mismatch.is_none(), "{mismatch:?}");
}

#[tokio::test]
async fn probe_control_long_benign_padding_dispatches() {
    let service = returning(json!([{ "role": "user", "content": padding() }])).await;
    let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
        config.compression = compression(&service);
        config.skills.skills = vec![skill("long", &padding())];
    });
    harness
        .dispatch(ctx("padded-benign"), ping(false), false)
        .await
        .expect("long benign padding dispatches");
    assert_eq!(harness.calls(), 1);
}

#[tokio::test]
async fn probe_skill_marker_after_long_padding_is_refused() {
    let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
        config.skills.skills = vec![skill("long", &format!("{}{SECRET}", padding()))];
    });
    let mismatch = refusal_mismatch(&harness, "padded-skill", ping(true), true).await;
    assert!(mismatch.is_none(), "{mismatch:?}");
}

/// Compressed text past the residual ceiling cannot be screened in full, so
/// it must not be sent.
#[tokio::test]
async fn probe_compression_output_past_the_screening_ceiling_is_not_sent() {
    let huge = "lorem ipsum ".repeat(400_000);
    let service = returning(json!([{ "role": "user", "content": huge }])).await;
    let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
        config.compression = compression(&service);
    });
    let error = harness
        .dispatch(ctx("huge-compression"), ping(false), false)
        .await
        .expect_err("unscreenable compressed text is refused");
    assert!(
        matches!(error, GatewayError::PolicyViolation(_)),
        "{error:?}"
    );
    assert_eq!(harness.calls(), 0);
    assert_eq!(
        error_rows(&harness.state, "huge-compression").await.len(),
        1
    );
}

// ── Skills ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_skill_marker_in_a_later_skill_or_its_name_is_refused() {
    let cases = vec![
        (
            "second-skill",
            vec![
                skill("first", "Answer briefly."),
                skill("second", &format!("Use {SECRET}.")),
            ],
        ),
        (
            "skill-name",
            vec![skill(&format!("key {SECRET}"), "Answer briefly.")],
        ),
        (
            "escaped-json-snippet",
            vec![skill(
                "json",
                &format!("Settings follow.\n{{\"key\":\"{SECRET_ESCAPED}\"}}"),
            )],
        ),
    ];
    let mut mismatches = Vec::new();
    for (case, skills) in cases {
        let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
            config.skills.skills = skills.clone();
        });
        let body = chat(
            json!([
                { "role": "system", "content": "Existing system prompt." },
                { "role": "user", "content": "ping" }
            ]),
            false,
        );
        if let Some(mismatch) = refusal_mismatch(&harness, case, body, false).await {
            mismatches.push(mismatch);
        }
    }
    assert!(mismatches.is_empty(), "{mismatches:#?}");
}

/// A test-only pattern that spans a line break. The skill header ends with its
/// first half and the caller's system prompt starts with the second, so only
/// the merged system message the provider receives matches.
#[tokio::test]
async fn probe_skill_header_merged_with_the_system_prompt_is_screened_as_sent() {
    let spanning = CustomPattern {
        name: "ryu_test_span".into(),
        regex: r"RYU_TEST_SPAN[\s\S]{0,16}LEXICON".into(),
        kind: CustomPatternKind::PromptInjection,
    };
    let body = || {
        chat(
            json!([
                { "role": "system", "content": "LEXICON closes the fixture." },
                { "role": "user", "content": "ping" }
            ]),
            false,
        )
    };
    // Control: neither half matches alone.
    let plain = Harness::new(GatewayCustody::SelfHosted, |config| {
        config.firewall.custom_patterns = vec![spanning.clone()];
        config.skills.skills = vec![skill("span", "The fixture opens with RYU_TEST_SPAN")];
    });
    let control = plain
        .dispatch(ctx("span-control"), ping(false), false)
        .await;
    assert!(control.is_ok(), "the skill alone dispatches: {control:?}");
    let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
        config.firewall.custom_patterns = vec![spanning.clone()];
        config.skills.skills = vec![skill("span", "The fixture opens with RYU_TEST_SPAN")];
    });
    let mismatch = refusal_mismatch(&harness, "span-merged", body(), false).await;
    assert!(mismatch.is_none(), "{mismatch:?}");
}

// ── Locked guardrails on compression output ─────────────────────────────────

#[tokio::test]
async fn probe_compression_output_violating_a_locked_guardrail_is_refused_under_warn() {
    let service = returning(json!([{ "role": "user", "content": format!("key {SECRET}") }])).await;
    let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
        config.firewall.policy = FirewallPolicy::WarnAndContinue;
        config.compression = compression(&service);
    });
    let error = harness
        .dispatch(
            locked_ctx("compression-locked", "secrets"),
            ping(false),
            false,
        )
        .await
        .expect_err("the locked guardrail refuses the compressed text");
    assert!(
        matches!(error, GatewayError::PolicyViolation(_)),
        "{error:?}"
    );
    assert_eq!(harness.calls(), 0);
    assert_eq!(
        error_rows(&harness.state, "compression-locked").await.len(),
        1
    );
    // Control: without the lock, warn-and-continue forwards it.
    harness
        .dispatch(ctx("compression-warn"), ping(false), false)
        .await
        .expect("warn forwards");
    assert_eq!(harness.calls(), 1);
}

#[tokio::test]
async fn probe_fleet_compression_returning_unusable_messages_fails_closed() {
    for (case, reply) in [
        ("empty", json!({ "compressed": true, "messages": [] })),
        (
            "string",
            json!({ "compressed": true, "messages": "summary" }),
        ),
        (
            "non-object",
            json!({ "compressed": true, "messages": ["summary"] }),
        ),
        (
            "empty-role",
            json!({ "compressed": true, "messages": [{ "role": "", "content": "x" }] }),
        ),
    ] {
        let service = compression_service(move |_| (StatusCode::OK, reply.clone())).await;
        let harness = Harness::new(GatewayCustody::Fleet, |config| {
            config.compression = compression(&service);
        });
        let error = harness
            .dispatch(ctx(case), ping(false), false)
            .await
            .expect_err("an unusable compression fails closed on the fleet");
        assert!(
            matches!(error, GatewayError::ScreeningUnavailable { .. }),
            "{case}: {error:?}"
        );
        assert_eq!(harness.calls(), 0, "{case}");
    }
}

// ── Refusals are never a health signal ──────────────────────────────────────

fn mentions(request: &Value, needle: &str) -> bool {
    request["messages"].to_string().contains(needle)
}

#[tokio::test]
async fn probe_repeated_compression_refusals_never_open_the_circuit() {
    let service = compression_service(|request| {
        if mentions(request, "trigger-secret") {
            (
                StatusCode::OK,
                json!({ "compressed": true, "messages": [{ "role": "user", "content": format!("key {SECRET}") }] }),
            )
        } else if mentions(request, "trigger-fail") {
            (StatusCode::SERVICE_UNAVAILABLE, json!({}))
        } else {
            (
                StatusCode::OK,
                json!({ "compressed": true, "messages": [{ "role": "user", "content": "benign" }] }),
            )
        }
    })
    .await;
    let harness = Harness::new(GatewayCustody::Fleet, |config| {
        config.compression = compression(&service);
        // The per-key burst limit is not under test here.
        config.rate_limit.enabled = false;
    });
    for index in 0..8 {
        let body = chat(
            json!([{ "role": "user", "content": "trigger-secret" }]),
            false,
        );
        let error = harness
            .dispatch(ctx(&format!("health-secret-{index}")), body, false)
            .await
            .expect_err("refused");
        assert!(
            matches!(error, GatewayError::FirewallBlocked(..)),
            "{error:?}"
        );
        let body = chat(json!([{ "role": "user", "content": "trigger-fail" }]), true);
        let error = harness
            .dispatch(ctx(&format!("health-fail-{index}")), body, true)
            .await
            .expect_err("fails closed");
        assert!(
            matches!(error, GatewayError::ScreeningUnavailable { .. }),
            "{error:?}"
        );
    }
    assert_eq!(harness.calls(), 0);
    for streaming in [false, true] {
        harness
            .dispatch(ctx("health-benign"), ping(streaming), streaming)
            .await
            .expect("refusals never trip the provider circuit");
    }
    assert_eq!(harness.calls(), 2);
}

// ── Context-relay pool, streaming and locked ────────────────────────────────

const RELAY_MODEL: &str = "relay-model";

fn relay_harness(first_answer: &str, configure: impl FnOnce(&mut GatewayConfig)) -> Harness {
    let answers = HashMap::from([("one".to_owned(), first_answer.to_owned())]);
    Harness::with_answers(GatewayCustody::SelfHosted, answers, |config| {
        config.firewall.custom_patterns = vec![lexicon_pattern()];
        config.routing.model_map.insert(
            RELAY_MODEL.into(),
            serde_json::from_value(json!({ "provider": "pool:relay" })).unwrap(),
        );
        config.routing.provider_pools.insert(
            "relay".into(),
            serde_json::from_value(json!({
                "strategy": "context_relay",
                "members": [
                    { "provider": PROVIDER, "model": "one" },
                    { "provider": PROVIDER, "model": "two" }
                ]
            }))
            .unwrap(),
        );
        configure(config);
    })
}

fn relay_ctx(request_id: &str, session: &str) -> RequestContext {
    let mut ctx = ctx(request_id);
    ctx.session_id = Some(session.into());
    ctx
}

fn relay_body(text: &str, stream: bool) -> Value {
    json!({ "model": RELAY_MODEL, "stream": stream, "messages": [{ "role": "user", "content": text }] })
}

/// Serve one request on member `one`, then cool it so the next request moves
/// to member `two` and carries the relay handoff.
async fn serve_first_then_cool(harness: &Harness, session: &str, streaming: bool) {
    let first = relay_ctx("relay-first", session);
    harness
        .dispatch(
            first.clone(),
            relay_body("first question", streaming),
            streaming,
        )
        .await
        .expect("the first request is served");
    assert_eq!(harness.last_body()["model"], "one");
    super::provider_snapshot(&harness.state, &first)
        .provider_pools
        .record_rate_limit(
            &crate::provider_pools::SelectedPoolRoute {
                pool_name: "relay".into(),
                member_index: 0,
                provider: ProviderId::from(PROVIDER),
                model: "one".into(),
                fallback_candidates: Vec::new(),
                execution: None,
            },
            Some(60),
        );
}

#[tokio::test]
async fn probe_streamed_relay_handoff_matching_the_firewall_is_refused() {
    for (first_streams, second_streams) in [(true, true), (true, false), (false, true)] {
        let harness = relay_harness(&format!("marker {LEXICON} here"), |_| {});
        serve_first_then_cool(&harness, "relay-session", first_streams).await;
        let id = format!("relay-stream-{first_streams}-{second_streams}");
        let calls = harness.calls();
        let error = harness
            .dispatch(
                relay_ctx(&id, "relay-session"),
                relay_body("second question", second_streams),
                second_streams,
            )
            .await
            .expect_err("the handoff carries the previous answer's match");
        assert!(
            matches!(error, GatewayError::FirewallBlocked(..)),
            "{id}: {error:?}"
        );
        let (status, kind) = status_and_type(error).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{id}");
        assert_eq!(kind, "policy_violation", "{id}");
        assert_eq!(harness.calls(), calls, "{id}: zero calls");
        assert_eq!(error_rows(&harness.state, &id).await.len(), 1, "{id}");
    }
}

#[tokio::test]
async fn probe_control_streamed_benign_relay_handoff_reaches_the_next_member() {
    let harness = relay_harness("a benign earlier answer", |_| {});
    serve_first_then_cool(&harness, "relay-session", true).await;
    harness
        .dispatch(
            relay_ctx("relay-stream-benign", "relay-session"),
            relay_body("second question", true),
            true,
        )
        .await
        .expect("a benign handoff dispatches");
    let body = harness.last_body();
    assert_eq!(body["model"], "two");
    assert!(body["messages"]
        .to_string()
        .contains("a benign earlier answer"));
}

/// The relay store is scoped by the resolved policy, so both turns carry the
/// same locked `prompt_injection` guardrail while the local firewall only warns.
#[tokio::test]
async fn probe_relay_handoff_violating_a_locked_guardrail_is_refused_under_warn() {
    let harness = relay_harness(&format!("marker {LEXICON} here"), |config| {
        config.firewall.policy = FirewallPolicy::WarnAndContinue;
    });
    let locked = |request_id: &str| {
        let mut ctx = locked_ctx(request_id, "prompt_injection");
        ctx.session_id = Some("relay-session".into());
        ctx
    };
    harness
        .dispatch(
            locked("relay-locked-first"),
            relay_body("first question", false),
            false,
        )
        .await
        .expect("precondition: the first turn is served");
    assert_eq!(harness.last_body()["model"], "one");
    super::provider_snapshot(&harness.state, &locked("relay-locked-first"))
        .provider_pools
        .record_rate_limit(
            &crate::provider_pools::SelectedPoolRoute {
                pool_name: "relay".into(),
                member_index: 0,
                provider: ProviderId::from(PROVIDER),
                model: "one".into(),
                fallback_candidates: Vec::new(),
                execution: None,
            },
            Some(60),
        );
    let calls = harness.calls();
    let error = harness
        .dispatch(
            locked("relay-locked"),
            relay_body("second question", false),
            false,
        )
        .await
        .expect_err("the locked guardrail refuses the handoff");
    assert!(
        matches!(error, GatewayError::PolicyViolation(_)),
        "{error:?}"
    );
    assert_eq!(harness.calls(), calls, "zero calls");
    assert_eq!(error_rows(&harness.state, "relay-locked").await.len(), 1);
}

#[tokio::test]
async fn probe_control_relay_handoff_under_warn_without_a_lock_is_forwarded() {
    let harness = relay_harness(&format!("marker {LEXICON} here"), |config| {
        config.firewall.policy = FirewallPolicy::WarnAndContinue;
    });
    serve_first_then_cool(&harness, "relay-session", false).await;
    harness
        .dispatch(
            relay_ctx("relay-warn", "relay-session"),
            relay_body("second question", false),
            false,
        )
        .await
        .expect("warn forwards the handoff");
    let body = harness.last_body();
    assert_eq!(body["model"], "two");
    assert!(body["messages"].to_string().contains(LEXICON));
}

#[tokio::test]
async fn probe_repeated_relay_refusals_never_cool_the_provider_or_member() {
    let harness = relay_harness(&format!("marker {LEXICON} here"), |config| {
        // The per-key burst limit is not under test here.
        config.rate_limit.enabled = false;
    });
    serve_first_then_cool(&harness, "relay-session", false).await;
    let calls = harness.calls();
    for index in 0..8 {
        harness
            .dispatch(
                relay_ctx(&format!("relay-repeat-{index}"), "relay-session"),
                relay_body("second question", index % 2 == 0),
                index % 2 == 0,
            )
            .await
            .expect_err("refused");
    }
    assert_eq!(harness.calls(), calls);
    harness
        .dispatch(ctx("relay-health-plain"), ping(false), false)
        .await
        .expect("the provider circuit stays closed");
    harness
        .dispatch(
            relay_ctx("relay-health-member", "other-session"),
            relay_body("other question", false),
            false,
        )
        .await
        .expect("member two is still eligible");
    assert_eq!(harness.last_body()["model"], "two");
}

// ── Fusion and pipeline pools over a loopback wire ──────────────────────────

fn serial() -> &'static tokio::sync::Mutex<()> {
    static SERIAL: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    SERIAL.get_or_init(|| tokio::sync::Mutex::new(()))
}

struct Wire {
    replies: HashMap<String, String>,
    models: Mutex<Vec<String>>,
}

struct PoolFixture {
    state: Arc<AppState>,
    wire: Arc<Wire>,
    server: tokio::task::JoinHandle<()>,
    _audit_dir: tempfile::TempDir,
}

impl Drop for PoolFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl PoolFixture {
    async fn new(strategy: &str, replies: &[(&str, &str)]) -> Self {
        let wire = Arc::new(Wire {
            replies: replies
                .iter()
                .map(|(model, text)| ((*model).to_owned(), (*text).to_owned()))
                .collect(),
            models: Mutex::new(Vec::new()),
        });
        let handler = Arc::clone(&wire);
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |Json(body): Json<Value>| {
                let wire = Arc::clone(&handler);
                async move {
                    let model = body["model"].as_str().unwrap_or_default().to_owned();
                    wire.models.lock().unwrap().push(model.clone());
                    let text = wire
                        .replies
                        .get(&model)
                        .cloned()
                        .unwrap_or_else(|| format!("answer from {model}"));
                    if body["stream"].as_bool() == Some(true) {
                        let delta = json!({"choices":[{"index":0,"delta":{"content":text}}]});
                        let usage = json!({"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":1,"total_tokens":21}});
                        Response::builder()
                            .header("content-type", "text/event-stream")
                            .body(Body::from(format!(
                                "data: {delta}\n\ndata: {usage}\n\ndata: [DONE]\n\n"
                            )))
                            .unwrap()
                            .into_response()
                    } else {
                        Json(json!({
                            "id":format!("wire-{model}"),"object":"chat.completion","model":model,
                            "choices":[{"index":0,"message":{"role":"assistant","content":text},"finish_reason":"stop"}],
                            "usage":{"prompt_tokens":20,"completion_tokens":1,"total_tokens":21}
                        }))
                        .into_response()
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut config = GatewayConfig::default();
        config.routing.default_provider = ProviderId::from("openai");
        config.routing.fallback_chain = vec![ProviderId::from("openai")];
        config.routing.model_map.insert(
            "ensemble".into(),
            serde_json::from_value(json!({"provider":"pool:flow"})).unwrap(),
        );
        let mut pool = json!({
            "strategy":strategy,
            "execution":{"quorum":3,"grace_ms":1,"leg_timeout_ms":2000,"total_timeout_ms":4000,"max_output_bytes":262144},
            "members":[
                {"provider":"openai","model":"a"},
                {"provider":"openai","model":"b"},
                {"provider":"openai","model":"c"}
            ]
        });
        if strategy == "fusion" {
            pool["judge"] = json!({"provider":"openai","model":"judge"});
        }
        config
            .routing
            .provider_pools
            .insert("flow".into(), serde_json::from_value(pool).unwrap());
        config.providers.openai = Some(
            serde_json::from_value(json!({"api_key":"fixture-upstream-key","base_url":base}))
                .unwrap(),
        );
        config.firewall = FirewallConfig {
            enabled: true,
            scan_inbound: true,
            scan_outbound: false,
            policy: FirewallPolicy::Block,
            custom_patterns: vec![lexicon_pattern()],
            ..Default::default()
        };
        config.budgets.users.insert(
            "pool-user".into(),
            serde_json::from_value(json!({"limit":1_000_000})).unwrap(),
        );
        config.budgets.session.limit = 1_000_000;
        let audit_dir = tempfile::tempdir().unwrap();
        let audit_config = AuditConfig {
            enabled: true,
            db_path: audit_dir
                .path()
                .join("audit.db")
                .to_string_lossy()
                .into_owned(),
        };
        config.audit = audit_config.clone();
        let audit = AuditLogger::new(&audit_config).unwrap();
        let state = Arc::new(AppState::new_for_test(
            config,
            audit,
            EvalsRunner::new(Default::default()),
        ));
        Self {
            state,
            wire,
            server,
            _audit_dir: audit_dir,
        }
    }

    fn models(&self) -> Vec<String> {
        let mut models = self.wire.models.lock().unwrap().clone();
        models.sort();
        models
    }
}

fn pool_context(request_id: &str) -> RequestContext {
    let mut context = plain_request_context();
    context.user_id = Some("pool-user".into());
    context.session_id = Some("pool-session".into());
    context.request_id = request_id.into();
    context
}

fn pool_request(stream: bool) -> Value {
    json!({"model":"ensemble","max_tokens":128,"stream":stream,"messages":[
        {"role":"system","content":"Preserve the original system authority"},
        {"role":"user","content":"Answer the original task"}
    ]})
}

async fn run_pool(
    fixture: &PoolFixture,
    request_id: &str,
    stream: bool,
) -> Result<(), GatewayError> {
    if stream {
        let output = run_stream(
            Arc::clone(&fixture.state),
            pool_context(request_id),
            pool_request(true),
        )
        .await?;
        axum::body::to_bytes(output.body, usize::MAX).await.unwrap();
    } else {
        run(
            Arc::clone(&fixture.state),
            pool_context(request_id),
            pool_request(false),
        )
        .await?;
    }
    Ok(())
}

async fn assert_pool_refusal(fixture: &PoolFixture, request_id: &str, error: GatewayError) {
    assert!(
        matches!(error, GatewayError::FirewallBlocked(..)),
        "{request_id}: {error:?}"
    );
    let (status, kind) = status_and_type(error).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{request_id}");
    assert_eq!(kind, "policy_violation", "{request_id}");
    assert_eq!(
        error_rows(&fixture.state, request_id).await.len(),
        1,
        "{request_id}: one audit row"
    );
}

#[tokio::test]
async fn probe_streamed_fusion_panel_answer_never_reaches_the_judge() {
    let _serial = serial().lock().await;
    let answer = format!("marker {LEXICON} here");
    let fixture = PoolFixture::new("fusion", &[("b", answer.as_str())]).await;
    let error = run_pool(&fixture, "fusion-stream", true)
        .await
        .expect_err("the judge body matches the firewall");
    assert_pool_refusal(&fixture, "fusion-stream", error).await;
    assert_eq!(fixture.models(), ["a", "b", "c"], "zero calls to the judge");
}

#[tokio::test]
async fn probe_control_streamed_benign_fusion_reaches_the_judge() {
    let _serial = serial().lock().await;
    let fixture = PoolFixture::new("fusion", &[]).await;
    run_pool(&fixture, "fusion-stream-benign", true)
        .await
        .expect("benign panels reach the judge");
    assert_eq!(fixture.models(), ["a", "b", "c", "judge"]);
}

/// The first stage's answer joins the second stage's body, a governed leg,
/// which the builder's pipeline test does not reach.
#[tokio::test]
async fn probe_pipeline_first_stage_answer_never_reaches_the_second_stage() {
    let _serial = serial().lock().await;
    let answer = format!("marker {LEXICON} here");
    for stream in [false, true] {
        let fixture = PoolFixture::new("pipeline", &[("a", answer.as_str())]).await;
        let id = format!("pipeline-first-{stream}");
        let error = run_pool(&fixture, &id, stream)
            .await
            .expect_err("the second stage body matches the firewall");
        assert_pool_refusal(&fixture, &id, error).await;
        assert_eq!(fixture.models(), ["a"], "{id}: zero calls after stage a");
    }
}

#[tokio::test]
async fn probe_streamed_pipeline_stage_answer_never_reaches_the_final_stage() {
    let _serial = serial().lock().await;
    let answer = format!("marker {LEXICON} here");
    let fixture = PoolFixture::new("pipeline", &[("b", answer.as_str())]).await;
    let error = run_pool(&fixture, "pipeline-stream", true)
        .await
        .expect_err("the final stage body matches the firewall");
    assert_pool_refusal(&fixture, "pipeline-stream", error).await;
    assert_eq!(
        fixture.models(),
        ["a", "b"],
        "zero calls to the final stage"
    );
}

#[tokio::test]
async fn probe_control_streamed_benign_pipeline_reaches_the_final_stage() {
    let _serial = serial().lock().await;
    let fixture = PoolFixture::new("pipeline", &[]).await;
    run_pool(&fixture, "pipeline-stream-benign", true)
        .await
        .expect("benign stages reach the final stage");
    assert_eq!(fixture.models(), ["a", "b", "c"]);
}
