//! Content the pipeline adds after `pre_process` is screened (spec P0-4).
//!
//! Each case runs `run` or `run_stream` against a capturing provider. A
//! blocked case asserts the catalogue status and `type`, zero calls on the
//! provider, and one audit row for the request. Every blocked case has a
//! benign control that dispatches, so a passing refusal cannot just mean the
//! path is broken. The only triggering content is the AWS documentation
//! example key, which the built-in secret patterns match, and the test-only
//! `RYU_TEST_LEXICON` pattern.
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
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
const PROVIDER: &str = "primary";
/// A test-only firewall pattern. Outbound DLP redacts built-in secrets in a
/// model answer before the pool keeps it, so the relay cases trip on this
/// inbound-only prompt-injection pattern instead.
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
    /// Keep the body with the model the pipeline dispatched to, which a pool
    /// route passes separately from the alias the caller named.
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
                "id": "chatcmpl-rescan",
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

    /// Error rows for `request_id`, polled because the logger writes off-thread.
    async fn error_rows(&self, request_id: &str) -> Vec<AuditEntry> {
        let mut rows = Vec::new();
        for _ in 0..200 {
            rows = self
                .state
                .audit
                .query(&AuditQuery {
                    limit: Some(100),
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

    async fn assert_one_error_row(&self, request_id: &str, contains: &str) {
        let rows = self.error_rows(request_id).await;
        assert_eq!(rows.len(), 1, "one audit row for {request_id}: {rows:?}");
        let error = rows[0].error.as_deref().unwrap_or_default();
        assert!(error.contains(contains), "row records {contains}: {error}");
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

fn ctx(request_id: &str) -> RequestContext {
    let mut ctx = plain_request_context();
    ctx.request_id = request_id.to_owned();
    ctx
}

fn ping(stream: bool) -> Value {
    json!({
        "model": "fixture-model",
        "stream": stream,
        "messages": [{ "role": "user", "content": "ping" }]
    })
}

fn skill(snippet: &str) -> Skill {
    Skill {
        name: "demo".into(),
        description: "fixture".into(),
        system_prompt_snippet: snippet.into(),
        enabled: true,
    }
}

async fn assert_status(error: GatewayError, status: StatusCode, kind: &str) -> Value {
    let response = error.into_response();
    assert_eq!(response.status(), status);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["error"]["type"], kind, "{body}");
    body
}

// ── Skills injection ─────────────────────────────────────────────────────────

#[tokio::test]
async fn injected_skill_with_a_secret_is_refused_on_both_paths() {
    for streaming in [false, true] {
        let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
            config.skills.skills = vec![skill(&format!("Use the bucket key {SECRET}."))];
        });
        let request_id = format!("skills-secret-{streaming}");
        let error = harness
            .dispatch(ctx(&request_id), ping(streaming), streaming)
            .await
            .expect_err("the injected skill carries a secret");
        assert!(
            matches!(error, GatewayError::FirewallBlocked(..)),
            "{error:?}"
        );
        assert_status(error, StatusCode::FORBIDDEN, "policy_violation").await;
        assert_eq!(harness.calls(), 0, "zero provider calls");
        harness.assert_one_error_row(&request_id, "blocked").await;
    }
}

#[tokio::test]
async fn control_benign_skill_dispatches_byte_identical_injection() {
    for streaming in [false, true] {
        let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
            config.skills.skills = vec![skill("Answer in one short sentence.")];
        });
        harness
            .dispatch(ctx("skills-benign"), ping(streaming), streaming)
            .await
            .expect("a benign skill dispatches");
        assert_eq!(harness.calls(), 1);
        let messages = harness.last_body()["messages"].clone();
        assert_eq!(
            messages[0],
            json!({"role":"system","content":"## demo\nAnswer in one short sentence."}),
            "the screen never rewrites the injected bytes"
        );
        assert_eq!(messages[1], json!({"role":"user","content":"ping"}));
    }
}

/// A locked `secrets` guardrail refuses the injected skill even when the
/// local firewall only warns.
#[tokio::test]
async fn injected_skill_violating_a_locked_guardrail_is_refused_under_warn() {
    let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
        config.firewall.policy = FirewallPolicy::WarnAndContinue;
        config.skills.skills = vec![skill(&format!("Use the bucket key {SECRET}."))];
    });
    let mut locked = ctx("skills-locked");
    locked.resolved_policy = Some(EffectivePolicy {
        locked_guardrails: vec!["secrets".into()],
        ..EffectivePolicy::default()
    });
    let error = harness
        .dispatch(locked, ping(false), false)
        .await
        .expect_err("the locked guardrail refuses the skill");
    assert!(
        matches!(error, GatewayError::PolicyViolation(_)),
        "{error:?}"
    );
    assert_status(error, StatusCode::FORBIDDEN, "policy_violation").await;
    assert_eq!(harness.calls(), 0, "zero provider calls");
    harness
        .assert_one_error_row("skills-locked", "locked guardrail")
        .await;

    // Control: the same skill with no locked guardrail is forwarded with a warning.
    harness
        .dispatch(ctx("skills-warn"), ping(false), false)
        .await
        .expect("warn-and-continue forwards the skill");
    assert_eq!(harness.calls(), 1);
}

/// Under Sanitize an injection-kind match in the caller's system message is
/// forwarded, since it cannot be redacted. Merging a benign skill into that
/// message must not turn the accepted request into a refusal.
#[tokio::test]
async fn control_benign_skill_merged_into_accepted_system_text_dispatches_under_sanitize() {
    let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
        config.firewall.policy = FirewallPolicy::Sanitize;
        config.firewall.custom_patterns = vec![lexicon_pattern()];
        config.skills.skills = vec![skill("Answer in one short sentence.")];
    });
    let system = format!("marker {LEXICON} here");
    let body = json!({
        "model": "fixture-model",
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": "ping" }
        ]
    });
    harness
        .dispatch(ctx("skills-merged-sanitize"), body, false)
        .await
        .expect("text pre_process accepted is not refused once merged");
    assert_eq!(harness.calls(), 1);
    assert_eq!(
        harness.last_body()["messages"][0]["content"],
        format!("## demo\nAnswer in one short sentence.\n\n---\n\n{system}")
    );
}

// ── Context compression ──────────────────────────────────────────────────────

#[derive(Clone)]
struct CompressionFixture {
    mode: &'static str,
}

async fn compress_fixture(
    State(fixture): State<CompressionFixture>,
    Json(request): Json<Value>,
) -> Response {
    match fixture.mode {
        "echo" => Json(json!({
            "compressed": true,
            "messages": request["messages"],
            "tokens_saved": 0
        }))
        .into_response(),
        "added" => {
            let mut messages = request["messages"].as_array().cloned().unwrap_or_default();
            messages
                .push(json!({"role":"user","content":format!("Summary: marker {LEXICON} here")}));
            Json(json!({"compressed": true, "messages": messages})).into_response()
        }
        "secret" => Json(json!({
            "compressed": true,
            "messages": [{"role":"user","content":format!("Summary: the key is {SECRET}")}],
            "tokens_saved": 5
        }))
        .into_response(),
        "benign" => Json(json!({
            "compressed": true,
            "messages": [{"role":"user","content":"Compressed context"}],
            "tokens_saved": 5
        }))
        .into_response(),
        "declined" => Json(json!({
            "compressed": false,
            "messages": [{"role":"user","content":"Do not apply"}]
        }))
        .into_response(),
        "unavailable" => (StatusCode::SERVICE_UNAVAILABLE, "down").into_response(),
        "invalid-json" => (StatusCode::OK, "not-json").into_response(),
        "missing-role" => Json(json!({
            "compressed": true,
            "messages": [{"content":"broken"}]
        }))
        .into_response(),
        _ => {
            tokio::time::sleep(Duration::from_millis(200)).await;
            Json(json!({"compressed":true,"messages":[{"role":"user","content":"late"}]}))
                .into_response()
        }
    }
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

async fn compression_service(mode: &'static str) -> CompressionService {
    let app = Router::new()
        .route("/v1/compress", post(compress_fixture))
        .with_state(CompressionFixture { mode });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    CompressionService { url, task }
}

fn compression(service: &CompressionService) -> CompressionConfig {
    CompressionConfig {
        enabled: true,
        url: service.url.clone(),
        timeout_ms: 50,
        min_messages: 1,
        ..CompressionConfig::default()
    }
}

#[tokio::test]
async fn compressed_messages_with_a_secret_are_refused_on_both_paths() {
    let service = compression_service("secret").await;
    for streaming in [false, true] {
        let harness = Harness::new(GatewayCustody::SelfHosted, |config| {
            config.compression = compression(&service);
        });
        let request_id = format!("compression-secret-{streaming}");
        let error = harness
            .dispatch(ctx(&request_id), ping(streaming), streaming)
            .await
            .expect_err("the compressed messages carry a secret");
        assert!(
            matches!(error, GatewayError::FirewallBlocked(..)),
            "{error:?}"
        );
        assert_status(error, StatusCode::FORBIDDEN, "policy_violation").await;
        assert_eq!(harness.calls(), 0, "zero provider calls");
        harness.assert_one_error_row(&request_id, "blocked").await;
    }
}

#[tokio::test]
async fn control_benign_compression_dispatches_the_compressed_messages() {
    let service = compression_service("benign").await;
    for streaming in [false, true] {
        let harness = Harness::new(GatewayCustody::Fleet, |config| {
            config.compression = compression(&service);
        });
        harness
            .dispatch(ctx("compression-benign"), ping(streaming), streaming)
            .await
            .expect("benign compression dispatches");
        assert_eq!(harness.calls(), 1);
        assert_eq!(
            harness.last_body()["messages"],
            json!([{"role":"user","content":"Compressed context"}])
        );
    }
}

#[tokio::test]
async fn fleet_refuses_when_compression_fails() {
    for mode in ["unavailable", "invalid-json", "missing-role", "timeout"] {
        let service = compression_service(mode).await;
        for streaming in [false, true] {
            let harness = Harness::new(GatewayCustody::Fleet, |config| {
                config.compression = compression(&service);
            });
            let request_id = format!("compression-{mode}-{streaming}");
            let error = harness
                .dispatch(ctx(&request_id), ping(streaming), streaming)
                .await
                .expect_err("a failed compression fails closed on the fleet");
            assert!(
                matches!(error, GatewayError::ScreeningUnavailable { .. }),
                "{mode}: {error:?}"
            );
            let response = error.into_response();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE, "{mode}");
            assert_eq!(
                response
                    .headers()
                    .get(axum::http::header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok()),
                Some("5"),
                "{mode}"
            );
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body["error"]["type"], "service_unavailable", "{body}");
            assert_eq!(body["error"]["code"], "screening_unavailable", "{body}");
            assert_eq!(body["error"]["layer"], "platform", "{body}");
            assert_eq!(harness.calls(), 0, "{mode}: zero provider calls");
            harness
                .assert_one_error_row(&request_id, "compression service failed")
                .await;
        }
    }
}

#[tokio::test]
async fn control_compression_failure_fails_open_off_fleet() {
    let service = compression_service("unavailable").await;
    for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
        for streaming in [false, true] {
            let harness = Harness::new(custody, |config| {
                config.compression = compression(&service);
            });
            harness
                .dispatch(ctx("compression-open"), ping(streaming), streaming)
                .await
                .expect("off the fleet a failed compression sends the original");
            assert_eq!(harness.calls(), 1, "{custody:?}");
            assert_eq!(
                harness.last_body()["messages"],
                json!([{"role":"user","content":"ping"}]),
                "{custody:?}"
            );
        }
    }
}

/// Under Sanitize an injection-kind match in a message is forwarded, since it
/// cannot be redacted. A compression that keeps that message byte for byte
/// must not turn the accepted request into a refusal.
fn sanitize_lexicon(config: &mut GatewayConfig, service: &CompressionService) {
    config.firewall.policy = FirewallPolicy::Sanitize;
    config.firewall.custom_patterns = vec![lexicon_pattern()];
    config.compression = compression(service);
}

fn lexicon_body() -> Value {
    json!({
        "model": "fixture-model",
        "messages": [{ "role": "user", "content": format!("marker {LEXICON} here") }]
    })
}

#[tokio::test]
async fn control_compression_that_keeps_accepted_text_dispatches_under_sanitize() {
    let service = compression_service("echo").await;
    let harness = Harness::new(GatewayCustody::Fleet, |config| {
        sanitize_lexicon(config, &service);
    });
    harness
        .dispatch(ctx("compression-echo"), lexicon_body(), false)
        .await
        .expect("text pre_process accepted is not screened again");
    assert_eq!(harness.calls(), 1);
    assert_eq!(harness.last_body()["messages"], lexicon_body()["messages"]);
}

#[tokio::test]
async fn compression_that_adds_matching_text_is_refused_under_sanitize() {
    let service = compression_service("added").await;
    let harness = Harness::new(GatewayCustody::Fleet, |config| {
        sanitize_lexicon(config, &service);
    });
    let error = harness
        .dispatch(ctx("compression-added"), lexicon_body(), false)
        .await
        .expect_err("text the service added cannot be redacted");
    assert!(
        matches!(error, GatewayError::FirewallBlocked(..)),
        "{error:?}"
    );
    assert_status(error, StatusCode::FORBIDDEN, "policy_violation").await;
    assert_eq!(harness.calls(), 0, "zero provider calls");
    harness
        .assert_one_error_row("compression-added", "blocked")
        .await;
}

#[tokio::test]
async fn control_declined_compression_dispatches_on_fleet() {
    let service = compression_service("declined").await;
    let harness = Harness::new(GatewayCustody::Fleet, |config| {
        config.compression = compression(&service);
    });
    harness
        .dispatch(ctx("compression-declined"), ping(false), false)
        .await
        .expect("a service that declines to compress is not a failure");
    assert_eq!(harness.calls(), 1);
    assert_eq!(
        harness.last_body()["messages"],
        json!([{"role":"user","content":"ping"}])
    );
}

// ── Context-relay pool handoff ───────────────────────────────────────────────

const RELAY_MODEL: &str = "relay-model";

fn relay_harness(first_answer: &str) -> Harness {
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
    })
}

fn relay_ctx(request_id: &str) -> RequestContext {
    let mut ctx = ctx(request_id);
    ctx.session_id = Some("relay-session".into());
    ctx
}

fn relay_body(text: &str) -> Value {
    json!({ "model": RELAY_MODEL, "messages": [{ "role": "user", "content": text }] })
}

/// Serve one request on member `one`, then cool it so the next request moves
/// to member `two` and carries the relay handoff.
async fn serve_first_then_cool(harness: &Harness) {
    let first = relay_ctx("relay-first");
    run(
        Arc::clone(&harness.state),
        first.clone(),
        relay_body("first question"),
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
async fn relay_handoff_matching_the_firewall_is_refused_before_the_next_member() {
    let harness = relay_harness(&format!("marker {LEXICON} here"));
    serve_first_then_cool(&harness).await;
    assert_eq!(harness.calls(), 1);
    let error = run(
        Arc::clone(&harness.state),
        relay_ctx("relay-second"),
        relay_body("second question"),
    )
    .await
    .err()
    .expect("the handoff carries the previous answer's match");
    assert!(
        matches!(error, GatewayError::FirewallBlocked(..)),
        "{error:?}"
    );
    assert_status(error, StatusCode::FORBIDDEN, "policy_violation").await;
    assert_eq!(harness.calls(), 1, "zero calls for the refused request");
    harness
        .assert_one_error_row("relay-second", "blocked")
        .await;
}

#[tokio::test]
async fn control_benign_relay_handoff_reaches_the_next_member() {
    let harness = relay_harness("a benign earlier answer");
    serve_first_then_cool(&harness).await;
    run(
        Arc::clone(&harness.state),
        relay_ctx("relay-second"),
        relay_body("second question"),
    )
    .await
    .expect("a benign handoff dispatches");
    assert_eq!(harness.calls(), 2);
    let body = harness.last_body();
    assert_eq!(body["model"], "two");
    let handoff = body["messages"].as_array().unwrap().last().unwrap().clone();
    let content = handoff["content"].as_str().unwrap();
    assert!(
        content.contains("Untrusted context") && content.contains("a benign earlier answer"),
        "{content}"
    );
}
