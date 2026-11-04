//! Online evals (production sampling, the judge budget), evaluator config, and
//! the judge-refusal rule end to end: a judge that refuses, is filtered, is cut
//! off or answers without a verdict leaves its assertion or evaluator
//! `executed: false`, never passing.

use super::run_evals_tests::{eval_headers, eval_state, EvalStub};
use super::{run_evals, score_online};
use crate::audit::AuditLogger;
use crate::config::{
    AuditConfig, EvalsConfig, FirewallConfig, GatewayConfig, ProviderId, RoutingConfig,
};
use crate::evals::EvalsRunner;
use crate::providers::Provider;
use crate::state::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use ryu_gw_providers::ProviderError;
use serde_json::{json, Value};
use std::pin::Pin;
use std::sync::Arc;

/// Answers ordinary calls with "hi" and judge prompts with a fixed message
/// and finish reason.
struct JudgeStub {
    message: Value,
    finish_reason: &'static str,
}

impl JudgeStub {
    fn answering(message: Value, finish_reason: &'static str) -> Arc<dyn Provider> {
        Arc::new(Self {
            message,
            finish_reason,
        })
    }
}

impl Provider for JudgeStub {
    fn name(&self) -> &'static str {
        "primary"
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let judging = body["messages"]
                .as_array()
                .and_then(|messages| messages.last())
                .and_then(|message| message["content"].as_str())
                .is_some_and(|text| text.starts_with("You are an evaluation judge"));
            let (message, finish) = if judging {
                (self.message.clone(), self.finish_reason)
            } else {
                (json!({ "role": "assistant", "content": "hi" }), "stop")
            };
            Ok(json!({
                "choices": [{ "index": 0, "message": message, "finish_reason": finish }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
            }))
        })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<dyn std::future::Future<Output = Result<axum::body::Body, ProviderError>> + Send + 'a>,
    > {
        Box::pin(async move { Err(ProviderError::Provider("no stream".into())) })
    }
}

#[tokio::test]
async fn online_score_rejects_an_oversized_response() {
    let state = eval_state();
    let req: super::OnlineScoreRequest = serde_json::from_value(json!({
        "model": "m1",
        "response": "x".repeat(256 * 1024 + 1)
    }))
    .expect("request parses");
    let response = score_online(State(state), eval_headers(), Json(req)).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}
#[tokio::test]
async fn unavailable_evaluators_reject_run_and_online_score_before_dispatch() {
    for id in [
        "code_evaluator",
        "code_checker",
        "explicit_content",
        "audio_quality",
    ] {
        // No auth header: unavailable modes are rejected during validation,
        // before authentication and before the configured provider can run.
        for per_case in [false, true] {
            let value = if per_case {
                json!({"model": "m1", "dataset": [{"prompt": "hi", "evaluators": [id]}]})
            } else {
                json!({"model": "m1", "evaluators": [id]})
            };
            let request = serde_json::from_value(value).unwrap();
            let response = run_evals(State(eval_state()), HeaderMap::new(), Json(request)).await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert!(body["error"]
                .as_str()
                .unwrap()
                .contains("unavailable offline"));
        }
        let request =
            serde_json::from_value(json!({"model": "m1", "response": "hi", "evaluators": [id]}))
                .unwrap();
        let response = score_online(State(eval_state()), HeaderMap::new(), Json(request)).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

fn online_state(online: crate::evals::OnlineEvalsConfig) -> Arc<AppState> {
    online_state_with(online, Arc::new(EvalStub))
}

fn online_state_with(
    online: crate::evals::OnlineEvalsConfig,
    provider: Arc<dyn Provider>,
) -> Arc<AppState> {
    let mut config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        ..GatewayConfig::default()
    };
    config.auth.master_key = Some("test-evals-administrator".to_owned());
    config.evals.online = online;
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("audit");
    let mut state = AppState::new_for_test(config, audit, EvalsRunner::new(EvalsConfig::default()));
    state.provider_runtime.register_for_test(provider);
    Arc::new(state)
}

async fn admin_context(state: &Arc<AppState>) -> crate::pipeline::RequestContext {
    crate::pipeline::authenticate(
        state,
        crate::pipeline::AuthInputs {
            raw_api_key: Some("Bearer test-evals-administrator"),
            ..Default::default()
        },
    )
    .await
    .expect("admin context")
}

async fn wait_for_records(state: &Arc<AppState>) -> Vec<crate::evals::online::OnlineEvalRecord> {
    for _ in 0..200 {
        let records = state
            .online_evals
            .query(&crate::evals::online::OnlineEvalQuery::default());
        if !records.is_empty() {
            return records;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("online evals worker produced no record");
}

/// A production chat completion is sampled on the hot path, scored off it by
/// the worker (deterministic + LLM-judge through the governed pipeline with
/// the configured judge model), and the judge call itself is not re-sampled.
#[tokio::test]
async fn online_evals_sample_production_traffic_and_score_off_path() {
    let state = online_state_with(
        crate::evals::OnlineEvalsConfig {
            enabled: true,
            sample_rate: 1.0,
            evaluators: vec!["pii_leakage".to_owned(), "toxicity".to_owned()],
            judge_model: Some("judge-model".to_owned()),
            ..Default::default()
        },
        JudgeStub::answering(json!({ "content": "VERDICT: FAIL SCORE: 0.05" }), "stop"),
    );
    let ctx = admin_context(&state).await;
    let request_id = ctx.request_id.clone();
    crate::pipeline::run(
        Arc::clone(&state),
        ctx,
        json!({"model": "test-model", "messages": [{"role": "user", "content": "say hi"}]}),
    )
    .await
    .expect("chat completion");
    assert_eq!(state.online_evals.stats().enqueued, 1);
    assert!(crate::online_evals::spawn_worker(&state));
    assert!(
        !crate::online_evals::spawn_worker(&state),
        "worker starts once"
    );

    let records = wait_for_records(&state).await;
    let record = &records[0];
    assert_eq!(record.request_id, request_id);
    assert_eq!(record.tenant, crate::evals::online::LOCAL_TENANT);
    assert_eq!(record.judge_model.as_deref(), Some("judge-model"));
    let pii = record
        .scores
        .iter()
        .find(|score| score.id == "pii_leakage")
        .expect("pii score");
    assert!(pii.executed && pii.pass);
    let toxicity = record
        .scores
        .iter()
        .find(|score| score.id == "toxicity")
        .expect("toxicity score");
    assert!(toxicity.executed && toxicity.pass, "{}", toxicity.detail);
    assert!((toxicity.score - 0.05).abs() < 1e-6);
    assert!(record.pass, "every evaluator ran and passed");
    // The judge call ran through the pipeline but was not sampled again.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(state.online_evals.stats().enqueued, 1);

    let filtered = state
        .online_evals
        .query(&crate::evals::online::OnlineEvalQuery {
            request_id: Some(request_id),
            evaluator: Some("toxicity".to_owned()),
            ..Default::default()
        });
    assert_eq!(filtered.len(), 1);
    let Json(listing) = super::get_online_evals(
        State(Arc::clone(&state)),
        axum::extract::Query(crate::evals::online::OnlineEvalQuery::default()),
    )
    .await;
    assert_eq!(listing["online"]["enabled"], true);
    assert_eq!(listing["online"]["stats"]["scored"], 1);
    assert_eq!(listing["records"][0]["requestId"], record.request_id);
}

/// Eval traffic is never sampled, and an exhausted per-tenant judge budget
/// reports the judge evaluator unexecuted instead of calling the provider.
#[tokio::test]
async fn online_evals_skip_eval_traffic_and_respect_the_judge_budget() {
    let state = online_state(crate::evals::OnlineEvalsConfig {
        enabled: true,
        sample_rate: 1.0,
        evaluators: vec!["toxicity".to_owned()],
        max_judge_calls_per_minute: 0,
        ..Default::default()
    });
    let mut eval_ctx = admin_context(&state).await;
    eval_ctx.feature = Some(super::EVAL_FEATURE.to_owned());
    crate::pipeline::run(
        Arc::clone(&state),
        eval_ctx,
        json!({"model": "test-model", "messages": [{"role": "user", "content": "x"}]}),
    )
    .await
    .expect("eval replay");
    assert_eq!(state.online_evals.stats().enqueued, 0);

    // A different prompt: an exact-match cache hit would not reach the
    // provider, so it produces no new output to score.
    crate::pipeline::run(
        Arc::clone(&state),
        admin_context(&state).await,
        json!({"model": "test-model", "messages": [{"role": "user", "content": "y"}]}),
    )
    .await
    .expect("production call");
    assert_eq!(state.online_evals.stats().enqueued, 1);
    crate::online_evals::spawn_worker(&state);
    let records = wait_for_records(&state).await;
    let toxicity = &records[0].scores[0];
    assert!(!toxicity.executed);
    assert!(toxicity.detail.contains("budget"), "{}", toxicity.detail);
    assert_eq!(state.online_evals.stats().judge_budget_skipped, 1);
}

#[tokio::test]
async fn online_evals_off_by_default_never_enqueue() {
    let state = online_state(crate::evals::OnlineEvalsConfig::default());
    crate::pipeline::run(
        Arc::clone(&state),
        admin_context(&state).await,
        json!({"model": "test-model", "messages": [{"role": "user", "content": "x"}]}),
    )
    .await
    .expect("chat completion");
    assert!(!state.online_evals.is_running());
    assert_eq!(state.online_evals.stats().enqueued, 0);
    assert!(!crate::online_evals::spawn_worker(&state));
}

/// Judge replies that never judged: a refusal field, a refusal in prose, a
/// filtered or cut-off reply, a polite decline, and a self-contradicting one.
fn unjudged_replies() -> Vec<(Value, &'static str)> {
    vec![
        (
            json!({ "content": "", "refusal": "I can't help with that." }),
            "stop",
        ),
        (json!({ "content": "I can't help with that." }), "stop"),
        (
            json!({ "content": "VERDICT: FAIL SCORE: 0.0" }),
            "content_filter",
        ),
        (json!({ "content": "VERDICT: FAIL SCORE: 0.0" }), "length"),
        (json!({ "content": "I'll pass on this." }), "stop"),
        (
            json!({ "content": "VERDICT: PASS SCORE: 0.0 then VERDICT: FAIL SCORE: 1" }),
            "stop",
        ),
    ]
}

/// `POST /v1/evals/score` with a negative-signal judge (toxicity) and an
/// `llm_judge` assertion: an unjudged reply leaves both unexecuted and the
/// case failing, where the old parser scored a refusal 0.0, a clean pass.
#[tokio::test]
async fn an_unjudged_reply_is_never_a_passing_score() {
    for (index, (message, finish)) in unjudged_replies().into_iter().enumerate() {
        let state = online_state_with(Default::default(), JudgeStub::answering(message, finish));
        let req: super::OnlineScoreRequest = serde_json::from_value(json!({
            "model": "test-model",
            "prompt": "say hi",
            "response": "hi",
            "evaluators": ["toxicity"],
            "assertions": [{ "kind": "llm_judge", "rubric": "Is it a greeting?" }],
        }))
        .expect("request parses");
        let response = score_online(State(state), eval_headers(), Json(req)).await;
        assert_eq!(response.status(), StatusCode::OK, "{index}");
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("drain");
        let body: Value = serde_json::from_slice(&bytes).expect("json");
        let score = &body["score"];
        let toxicity = &score["evaluators"][0];
        assert_eq!(toxicity["id"], "toxicity", "{index}");
        assert_eq!(toxicity["executed"], false, "{index}: {toxicity}");
        assert_eq!(toxicity["pass"], false, "{index}: {toxicity}");
        let judged = &score["assertions"][0];
        assert_eq!(judged["executed"], false, "{index}: {judged}");
        assert_eq!(judged["pass"], false, "{index}: {judged}");
        assert_eq!(score["assertions_pass"], false, "{index}");
    }
}

/// The dataset runner follows the same rule, and the run aggregate counts the
/// unjudged evaluator as never executed.
///
/// An LLM-judge evaluator nests a second governed pipeline run inside the
/// case's. The run must fit the 2 MiB stack of a default Tokio worker (the
/// Gateway's runtime keeps that default) even in a debug build, so the fixture
/// runs on a thread of exactly that size whatever `RUST_MIN_STACK` says.
#[test]
fn a_refusing_judge_leaves_dataset_evaluators_unexecuted() {
    let worker = std::thread::Builder::new()
        .name("dataset-judge-fixture".into())
        .stack_size(2 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("create dataset judge fixture runtime")
                .block_on(refusing_judge_dataset_fixture());
        })
        .expect("start dataset judge fixture worker");
    if let Err(panic) = worker.join() {
        std::panic::resume_unwind(panic);
    }
}

async fn refusing_judge_dataset_fixture() {
    let state = online_state_with(
        Default::default(),
        JudgeStub::answering(json!({ "content": "", "refusal": "No." }), "stop"),
    );
    let req: super::RunEvalsRequest = serde_json::from_value(json!({
        "model": "m1",
        "dataset": [{ "prompt": "say hi", "evaluators": ["toxicity"] }]
    }))
    .expect("request parses");
    let response = run_evals(State(state), eval_headers(), Json(req)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("drain");
    let body: Value = serde_json::from_slice(&bytes).expect("json");
    let toxicity = &body["cases"][0]["evaluators"][0];
    assert_eq!(toxicity["executed"], false, "{toxicity}");
    assert_eq!(toxicity["pass"], false);
    assert!(toxicity["detail"]
        .as_str()
        .unwrap_or_default()
        .contains("refused"));
    assert_eq!(
        body["aggregate"]["evaluators"]["toxicity"]["executedCount"], 0,
        "{}",
        body["aggregate"]
    );
}

/// An online record from a refusing judge is unexecuted too, and the record
/// itself does not pass: `failed_only` lists it rather than hiding it.
#[tokio::test]
async fn online_evals_report_a_refusing_judge_unexecuted() {
    let state = online_state_with(
        crate::evals::OnlineEvalsConfig {
            enabled: true,
            sample_rate: 1.0,
            evaluators: vec!["toxicity".to_owned()],
            judge_model: Some("judge-model".to_owned()),
            ..Default::default()
        },
        JudgeStub::answering(json!({ "content": "I can't help with that." }), "stop"),
    );
    crate::pipeline::run(
        Arc::clone(&state),
        admin_context(&state).await,
        json!({"model": "test-model", "messages": [{"role": "user", "content": "say hi"}]}),
    )
    .await
    .expect("chat completion");
    assert!(crate::online_evals::spawn_worker(&state));
    let records = wait_for_records(&state).await;
    let toxicity = &records[0].scores[0];
    assert!(!toxicity.executed && !toxicity.pass, "{}", toxicity.detail);
    assert!(
        !records[0].pass,
        "an unjudged response is not a passing record"
    );
    let failed = state
        .online_evals
        .query(&crate::evals::online::OnlineEvalQuery {
            failed_only: true,
            ..Default::default()
        });
    assert_eq!(failed.len(), 1);
}
