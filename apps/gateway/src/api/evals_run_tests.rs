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

struct EvalStub;
impl Provider for EvalStub {
    fn name(&self) -> &'static str {
        "primary"
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(json!({
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}
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

fn eval_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        "Bearer test-evals-administrator".parse().unwrap(),
    );
    headers
}

fn eval_state() -> Arc<AppState> {
    eval_state_with_default_model(None)
}

fn eval_state_with_default_model(default_model: Option<&str>) -> Arc<AppState> {
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
    config.evals = EvalsConfig {
        enabled: true,
        max_latency_ms: 5_000,
        sample_rate: 0.0,
        stream_usage: false,
        default_model: default_model.map(str::to_owned),
        judge_model: None,
        online: Default::default(),
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("audit");
    let mut state = AppState::new_for_test(config, audit, EvalsRunner::new(EvalsConfig::default()));
    state
        .provider_runtime
        .register_for_test(Arc::new(EvalStub) as Arc<dyn Provider>);
    Arc::new(state)
}

/// Driving `run_evals` with a custom dataset replays each case through the real
/// pipeline against a stub provider and scores it with the local v1 scorers
/// (latency / token-efficiency / policy-pass / substring-match) — no network.
#[tokio::test]
async fn run_evals_replays_dataset_and_returns_scored_cases() {
    let state = eval_state();
    // A two-case dataset; one expects "hi" (the stub returns "hi" ⇒ substring
    // match passes), one expects "zzz" (fails), exercising both scorer arms.
    let req: super::RunEvalsRequest = serde_json::from_value(json!({
        "model": "test-model",
        "dataset": [
            {"prompt": "say hi", "expected": "hi"},
            {"prompt": "say hi", "expected": "zzz"}
        ]
    }))
    .expect("request parses");

    let resp = run_evals(State(state), eval_headers(), Json(req)).await;
    assert_eq!(resp.status(), StatusCode::OK);

    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("drain response body");
    let body: Value = serde_json::from_slice(&bytes).expect("json body");
    let cases = body["cases"].as_array().expect("cases array");
    assert_eq!(cases.len(), 2, "both cases were replayed and scored");
    assert!(body.get("aggregate").is_some(), "an aggregate is emitted");
}

#[tokio::test]
async fn run_evals_scores_batch_outputs_with_provider_cost_and_turnaround() {
    let state = eval_state();
    let req: super::RunEvalsRequest = serde_json::from_value(json!({
        "model": "openai/gpt-4o-mini",
        "dataset": [{
            "id": "batch-case",
            "prompt": "Summarize the refund policy.",
            "expected": "30 days",
            "provider_output_provider": "openrouter",
            "provider_latency_ms": 42_000,
            "provider_cost_micro_usd": 777,
            "provider_output": {
                "choices": [{ "message": { "content": "Refunds are available within 30 days." } }],
                "usage": { "prompt_tokens": 12, "completion_tokens": 7 }
            }
        }]
    }))
    .expect("batch eval request parses");

    let response = run_evals(State(state), eval_headers(), Json(req)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("drain response body");
    let body: Value = serde_json::from_slice(&bytes).expect("json body");
    let score = &body["cases"][0];
    assert_eq!(score["provider"], "openrouter");
    assert_eq!(score["latency_ms"], 42_000);
    assert_eq!(score["latency_available"], true);
    assert_eq!(score["cost_micro_usd"], 777);
    assert_eq!(score["substring_match"], 1.0);
    assert_eq!(score["policy_available"], false);
    assert_eq!(score["policy_pass"], false);
    assert_eq!(body["aggregate"]["latency_available_cases"], 1);
    assert_eq!(body["aggregate"]["policy_available_cases"], 0);
}

#[tokio::test]
async fn score_online_scores_submitted_output_without_provider_replay() {
    let state = eval_state();
    let req: super::OnlineScoreRequest = serde_json::from_value(json!({
        "id": "production-1",
        "model": "test-model",
        "prompt": "say hi",
        "response": "hi",
        "expected": "hi",
        "latency_ms": 42,
        "cost_micro_usd": 1250,
        "metadata": {"source": "production"}
    }))
    .expect("request parses");
    let response = score_online(State(state), eval_headers(), Json(req)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("drain");
    let body: Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(body["kind"], "online_score");
    assert_eq!(body["score"]["id"], "production-1");
    assert_eq!(body["score"]["response_text"], "hi");
    assert_eq!(body["score"]["cost_micro_usd"], 1250);
    assert_eq!(body["score"]["latency_available"], true);
    assert_eq!(body["score"]["policy_available"], false);
    assert_eq!(body["score"]["policy_pass"], false);
    assert_eq!(body["score"]["metadata"]["source"], "production");
}

#[tokio::test]
async fn score_online_preserves_an_explicit_external_policy_measurement() {
    let state = eval_state();
    let req: super::OnlineScoreRequest = serde_json::from_value(json!({
        "model": "test-model",
        "prompt": "say hi",
        "response": "hi",
        "policy_pass": true
    }))
    .expect("request parses");
    let response = score_online(State(state), eval_headers(), Json(req)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("drain");
    let body: Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(body["score"]["policy_available"], true);
    assert_eq!(body["score"]["policy_pass"], true);
}

async fn error_body(response: axum::response::Response) -> String {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("drain");
    let body: Value = serde_json::from_slice(&bytes).expect("json");
    body["error"].as_str().unwrap_or_default().to_owned()
}

/// No vendor model is assumed: a run without `model`/`models` on a Gateway
/// with no configured default is a 400 that asks for `model`.
#[tokio::test]
async fn run_evals_without_model_or_configured_default_is_rejected() {
    let req: super::RunEvalsRequest =
        serde_json::from_value(json!({ "dataset": [{"prompt": "say hi"}] }))
            .expect("request parses");
    let resp = run_evals(State(eval_state()), eval_headers(), Json(req)).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let error = error_body(resp).await;
    assert!(error.contains("model is required"), "{error}");
    assert!(!error.contains("gpt-4o-mini"));
}

#[tokio::test]
async fn run_evals_without_model_uses_the_configured_default() {
    let req: super::RunEvalsRequest =
        serde_json::from_value(json!({ "dataset": [{"prompt": "say hi", "expected": "hi"}] }))
            .expect("request parses");
    let state = eval_state_with_default_model(Some("node-default"));
    let resp = run_evals(State(state), eval_headers(), Json(req)).await;
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn score_online_needs_a_model_only_when_a_judge_does() {
    async fn score_model(resp: axum::response::Response) -> Value {
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("drain");
        let body: Value = serde_json::from_slice(&bytes).expect("json");
        body["score"]["model"].clone()
    }
    let deterministic = json!({ "prompt": "say hi", "response": "hi", "expected": "hi" });

    // No judge needed: scoring works on a Gateway with no default model.
    let req: super::OnlineScoreRequest =
        serde_json::from_value(deterministic.clone()).expect("request parses");
    let resp = score_online(State(eval_state()), eval_headers(), Json(req)).await;
    assert_eq!(score_model(resp).await, super::UNNAMED_ONLINE_SCORE_MODEL);

    // A configured default still labels the score.
    let req: super::OnlineScoreRequest =
        serde_json::from_value(deterministic).expect("request parses");
    let state = eval_state_with_default_model(Some("node-default"));
    let resp = score_online(State(state), eval_headers(), Json(req)).await;
    assert_eq!(score_model(resp).await, "node-default");

    // A model-graded check needs a judge: no model and no default is a 400.
    let judged = json!({
        "prompt": "say hi",
        "response": "hi",
        "assertions": [{ "kind": "llm_judge", "rubric": "Is it a greeting?" }],
    });
    let req: super::OnlineScoreRequest = serde_json::from_value(judged).expect("request parses");
    let resp = score_online(State(eval_state()), eval_headers(), Json(req)).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert!(error_body(resp).await.contains("model is required"));
}

#[test]
fn configured_default_model_prefers_evals_then_pinned_chat_model() {
    use crate::config::{Modality, ModalityMapping};
    let mut config = GatewayConfig::default();
    assert_eq!(super::configured_default_model(&config), None);
    config.routing.modality_map.insert(
        Modality::Chat,
        ModalityMapping {
            provider: ProviderId::from("primary"),
            model: Some("pinned-chat".to_owned()),
        },
    );
    assert_eq!(
        super::configured_default_model(&config).as_deref(),
        Some("pinned-chat")
    );
    config.evals.default_model = Some("  evals-default ".to_owned());
    assert_eq!(
        super::configured_default_model(&config).as_deref(),
        Some("evals-default")
    );
    config.evals.default_model = Some("   ".to_owned());
    assert_eq!(
        super::configured_default_model(&config).as_deref(),
        Some("pinned-chat"),
        "a blank evals default does not mask the pinned chat model"
    );
}

/// An empty dataset falls back to the built-in 3-case dataset.
#[tokio::test]
async fn run_evals_uses_builtin_dataset_when_empty() {
    let state = eval_state();
    let req: super::RunEvalsRequest =
        serde_json::from_value(json!({ "model": "test-model" })).expect("request parses");
    let resp = run_evals(State(state), eval_headers(), Json(req)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("drain");
    let body: Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(
        body["cases"].as_array().expect("cases").len(),
        3,
        "the built-in dataset has three cases"
    );
}

/// A multi-model run with a registry evaluator produces a per-model `models`
/// breakdown and runs the offline detector scoring path (the judge, if any, is
/// routed to the same stub — still no network).
#[tokio::test]
async fn run_evals_multi_model_with_evaluator_emits_breakdown() {
    let state = eval_state();
    let req: super::RunEvalsRequest = serde_json::from_value(json!({
        "model": "m1",
        "models": ["m1", "m2"],
        "dataset": [{"prompt": "say hi", "expected": "hi"}],
        "evaluators": ["prompt_injection"]
    }))
    .expect("request parses");
    let resp = run_evals(State(state), eval_headers(), Json(req)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("drain");
    let body: Value = serde_json::from_slice(&bytes).expect("json");
    // Multi-model runs carry a per-model breakdown.
    let models = body["models"].as_array().expect("models breakdown present");
    assert_eq!(models.len(), 2);
}

/// `GET /v1/evals` reports the enabled flag, config knobs, and recorded
/// provider scores.
#[tokio::test]
async fn get_evals_reports_scores_when_enabled() {
    use super::get_evals;
    let state = eval_state();
    state.evals.record_provider_score("primary", 0.8);
    let Json(body) = get_evals(State(Arc::clone(&state))).await;
    assert_eq!(body["enabled"], true);
    assert!((body["providers"]["primary"].as_f64().unwrap() - 0.8).abs() < 1e-3);
}

/// A case carrying deterministic assertions exercises the assertion scorers
/// (contains / not_contains / regex / json_valid) against the stub's response.
#[tokio::test]
async fn run_evals_scores_deterministic_assertions() {
    let state = eval_state();
    let req: super::RunEvalsRequest = serde_json::from_value(json!({
        "model": "m1",
        "dataset": [{
            "prompt": "say hi",
            "assertions": [
                {"kind": "contains", "value": "hi"},
                {"kind": "not_contains", "value": "zzz"},
                {"kind": "regex", "value": "^hi$"},
                {"kind": "json_valid"}
            ]
        }]
    }))
    .expect("request parses");
    let resp = run_evals(State(state), eval_headers(), Json(req)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("drain");
    let body: Value = serde_json::from_slice(&bytes).expect("json");
    let case0 = &body["cases"][0];
    // The per-assertion results are surfaced; contains/regex pass, json_valid
    // fails (the stub returns plain text, not JSON).
    let assertions = case0["assertions"].as_array().expect("assertion results");
    assert_eq!(assertions.len(), 4);
    let json_valid = assertions
        .iter()
        .find(|a| a["kind"] == "json_valid")
        .expect("json_valid result present");
    assert_eq!(json_valid["pass"], false, "plain text is not valid JSON");
}

/// A run-level `system_prompt` with `{{vars}}` exercises the per-case variable
/// substitution + system-message prepend path.
#[tokio::test]
async fn run_evals_renders_system_prompt_vars() {
    let state = eval_state();
    let req: super::RunEvalsRequest = serde_json::from_value(json!({
        "model": "m1",
        "system_prompt": "You are {{persona}}.",
        "dataset": [{"prompt": "hello {{name}}", "expected": "hi", "vars": {"persona": "helpful", "name": "Ada"}}]
    }))
    .expect("request parses");
    let resp = run_evals(State(state), eval_headers(), Json(req)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("drain");
    let body: Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(body["cases"].as_array().expect("cases").len(), 1);
}

#[tokio::test]
async fn run_evals_rejects_provider_call_amplification_before_dispatch() {
    let state = eval_state();
    let req: super::RunEvalsRequest = serde_json::from_value(json!({
        "model": "m1",
        "models": ["m1", "m2"],
        "repeat": 20,
        "dataset": (0..100).map(|index| json!({"id": format!("case-{index}"), "prompt": "hi"})).collect::<Vec<_>>()
    }))
    .expect("request parses");
    let response = run_evals(State(state), eval_headers(), Json(req)).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn run_evals_rejects_deep_recursive_assertion_sets() {
    let state = eval_state();
    let mut assertion = json!({ "kind": "contains", "value": "hi" });
    for _ in 0..10 {
        assertion = json!({ "kind": "assert_set", "assertions": [assertion] });
    }
    let req: super::RunEvalsRequest = serde_json::from_value(json!({
        "model": "m1",
        "dataset": [{"prompt": "say hi", "assertions": [assertion]}]
    }))
    .expect("request parses");
    let response = run_evals(State(state), eval_headers(), Json(req)).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn run_evals_rejects_nested_model_graded_assertions_explicitly() {
    let state = eval_state();
    let req: super::RunEvalsRequest = serde_json::from_value(json!({
        "model": "m1",
        "dataset": [{
            "prompt": "say hi",
            "assertions": [{
                "kind": "assert_set",
                "assertions": [{"kind": "llm_judge", "rubric": "be helpful"}]
            }]
        }]
    }))
    .expect("request parses");
    let response = run_evals(State(state), eval_headers(), Json(req)).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("drain");
    let payload: Value = serde_json::from_slice(&body).expect("json");
    assert!(payload["error"]
        .as_str()
        .is_some_and(|message| message.contains("cannot be nested")));
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
    state
        .provider_runtime
        .register_for_test(Arc::new(EvalStub) as Arc<dyn Provider>);
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
    let state = online_state(crate::evals::OnlineEvalsConfig {
        enabled: true,
        sample_rate: 1.0,
        evaluators: vec!["pii_leakage".to_owned(), "toxicity".to_owned()],
        judge_model: Some("judge-model".to_owned()),
        ..Default::default()
    });
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
    assert!(toxicity.executed, "{}", toxicity.detail);
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

#[test]
fn online_config_rejects_unknown_or_unavailable_evaluators() {
    let mut config = GatewayConfig::default();
    config.evals.online.enabled = true;
    config.evals.online.evaluators = vec!["does_not_exist".to_owned()];
    assert!(crate::state::validate_online_evals(&config)
        .unwrap_err()
        .contains("unknown evaluator"));
    config.evals.online.evaluators = vec!["code_checker".to_owned()];
    assert!(crate::state::validate_online_evals(&config).is_err());
    config.evals.online.evaluators = vec!["pii_leakage".to_owned()];
    assert!(crate::state::validate_online_evals(&config).is_ok());
}

/// Custom evaluators saved through `PUT /v1/config` apply to the live
/// registry without a restart.
#[test]
fn custom_evaluators_swap_live() {
    use crate::evaluators::{
        Capabilities, Evaluator, EvaluatorCategory, EvaluatorImpl, EvaluatorTarget, OfflineConfig,
    };
    let state = eval_state();
    assert!(state.evaluator_registry().get("no_refunds").is_none());
    state.update_custom_evaluators(vec![Evaluator {
        id: "no_refunds".to_owned(),
        name: "No refunds".to_owned(),
        description: "Flags refund promises".to_owned(),
        category: EvaluatorCategory::Custom,
        target: EvaluatorTarget::Output,
        capabilities: Capabilities {
            inline: true,
            offline: true,
        },
        impl_: EvaluatorImpl::Builtin {
            detector: "secret".to_owned(),
        },
        inline: None,
        offline: Some(OfflineConfig {
            threshold: 0.5,
            judge_model: None,
        }),
        builtin: false,
        enforced: true,
        higher_is_better: true,
    }]);
    let registry = state.evaluator_registry();
    let evaluator = registry.get("no_refunds").expect("live custom evaluator");
    assert!(!evaluator.builtin);
    assert!(evaluator.unavailable_offline_reason().is_none());
    assert!(evaluator.unavailable_inline_reason().is_none());
}

#[test]
fn builtin_evaluator_scores_offline_with_firewall_detectors() {
    let case = crate::evals::EvalCase {
        prompt: "q".to_owned(),
        ..Default::default()
    };
    let flagged = super::score_builtin(
        "secrets",
        "custom",
        crate::evaluators::EvaluatorTarget::Output,
        "secret",
        &case,
        "the key is sk-abcdefghijklmnopqrstuvwxyz0123",
    );
    assert!(flagged.executed && !flagged.pass);
    assert_eq!(flagged.score, 0.0);
    let clean = super::score_builtin(
        "secrets",
        "custom",
        crate::evaluators::EvaluatorTarget::Output,
        "secret",
        &case,
        "nothing sensitive",
    );
    assert!(clean.executed && clean.pass);
    let unknown = super::score_builtin(
        "x",
        "custom",
        crate::evaluators::EvaluatorTarget::Output,
        "nope",
        &case,
        "text",
    );
    assert!(!unknown.executed);
}

#[test]
fn configured_judge_model_is_trimmed_and_optional() {
    let mut config = GatewayConfig::default();
    assert_eq!(super::configured_judge_model(&config), None);
    config.evals.judge_model = Some("  ".to_owned());
    assert_eq!(super::configured_judge_model(&config), None);
    config.evals.judge_model = Some(" judge ".to_owned());
    assert_eq!(
        super::configured_judge_model(&config).as_deref(),
        Some("judge")
    );
}
