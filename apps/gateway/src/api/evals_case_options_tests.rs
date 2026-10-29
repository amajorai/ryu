//! `run_evals` per-case options (transform, transform_vars, prefix/suffix,
//! per-case provider, provider_output fixtures), repeat expansion and the
//! in-run response cache, driven through the real handler and pipeline with a
//! recording stub provider so every provider dispatch is counted.

use super::run_evals;
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
use std::sync::{Arc, Mutex};

/// One provider dispatch: the model the pipeline forwarded and the last user
/// message it carried.
#[derive(Debug, Clone)]
struct Dispatch {
    model: String,
    user_content: String,
}

/// Echoes the last user message back as the assistant reply and records every
/// call. A user message containing `FAIL` is answered with a provider error.
struct RecordingStub {
    calls: Arc<Mutex<Vec<Dispatch>>>,
}

impl Provider for RecordingStub {
    fn name(&self) -> &'static str {
        "primary"
    }
    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let user_content = body["messages"]
                .as_array()
                .and_then(|messages| messages.iter().rev().find(|m| m["role"] == "user"))
                .and_then(|message| message["content"].as_str())
                .unwrap_or_default()
                .to_owned();
            self.calls.lock().expect("calls lock").push(Dispatch {
                model: model.to_owned(),
                user_content: user_content.clone(),
            });
            if user_content.contains("FAIL") {
                return Err(ProviderError::Provider("stub refused".into()));
            }
            Ok(json!({
                "choices": [{"index": 0, "message": {"role": "assistant", "content": user_content}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4, "cost_usd": 0.0025}
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

fn recording_state() -> (Arc<AppState>, Arc<Mutex<Vec<Dispatch>>>) {
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
    // The Gateway's own exact-response cache would also dedupe identical
    // requests; turn it off so every dispatch the stub counts is attributable
    // to the eval runner's in-run cache alone.
    config.cache.enabled = false;
    config.evals = EvalsConfig {
        enabled: true,
        max_latency_ms: 5_000,
        sample_rate: 0.0,
        stream_usage: false,
        default_model: None,
        judge_model: None,
        online: Default::default(),
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("audit");
    let mut state = AppState::new_for_test(config, audit, EvalsRunner::new(EvalsConfig::default()));
    let calls = Arc::new(Mutex::new(Vec::new()));
    state
        .provider_runtime
        .register_for_test(Arc::new(RecordingStub {
            calls: Arc::clone(&calls),
        }) as Arc<dyn Provider>);
    (Arc::new(state), calls)
}

async fn run(state: Arc<AppState>, request: Value) -> Value {
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        "Bearer test-evals-administrator".parse().unwrap(),
    );
    let req: super::RunEvalsRequest = serde_json::from_value(request).expect("request parses");
    let response = run_evals(State(state), headers, Json(req)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("drain");
    serde_json::from_slice(&bytes).expect("json")
}

fn dispatches(calls: &Arc<Mutex<Vec<Dispatch>>>) -> Vec<Dispatch> {
    calls.lock().expect("calls lock").clone()
}

#[tokio::test]
async fn output_transforms_rewrite_the_scored_text_and_unknown_ones_error() {
    let (state, calls) = recording_state();
    let fixture = |content: &str| json!({"choices": [{"message": {"content": content}}]});
    let body = run(
        state,
        json!({
            "model": "m1",
            "dataset": [
                {"id": "lower", "prompt": "p", "provider_output": fixture("HeLLo World"), "options": {"transform": "lower"}},
                {"id": "trim", "prompt": "p", "provider_output": fixture("  padded \n"), "options": {"transform": "trim"}},
                {"id": "json", "prompt": "p", "provider_output": fixture("{ \"a\" : [1, 2] }"), "options": {"transform": "json"}},
                {"id": "bad-json", "prompt": "p", "provider_output": fixture("not json"), "options": {"transform": "json"}},
                {"id": "unknown", "prompt": "p", "provider_output": fixture("Keep"), "options": {"transform": "reverse"}}
            ]
        }),
    )
    .await;
    let cases = body["cases"].as_array().expect("cases");
    assert_eq!(cases[0]["response_text"], "hello world");
    assert!(cases[0].get("error").is_none());
    assert_eq!(cases[1]["response_text"], "padded");
    assert_eq!(cases[2]["response_text"], "{\"a\":[1,2]}");
    let bad_json = cases[3]["error"].as_str().expect("json transform error");
    assert!(bad_json.contains("json transform failed"), "{bad_json}");
    assert_eq!(
        cases[4]["response_text"], "Keep",
        "unknown transform leaves output"
    );
    let unknown = cases[4]["error"]
        .as_str()
        .expect("unsupported transform error");
    assert!(
        unknown.contains("unsupported output transform 'reverse'"),
        "{unknown}"
    );
    assert!(
        dispatches(&calls).is_empty(),
        "fixtures never reach the provider"
    );
}

#[tokio::test]
async fn transform_vars_json_parses_string_vars_before_rendering() {
    let (state, calls) = recording_state();
    let body = run(
        state,
        json!({
            "model": "m1",
            "dataset": [
                {"id": "parsed", "prompt": "Hi {{user.name}}", "vars": {"user": "{\"name\":\"Ada\"}"}, "options": {"transform_vars": "json"}},
                {"id": "raw", "prompt": "Hi {{user.name}}", "vars": {"user": "{\"name\":\"Ada\"}"}},
                {"id": "broken", "prompt": "Hi", "vars": {"user": "{oops"}, "options": {"transformVars": "json"}}
            ]
        }),
    )
    .await;
    let cases = body["cases"].as_array().expect("cases");
    assert_eq!(cases[0]["rendered_prompt"], "Hi Ada");
    assert_ne!(
        cases[1]["rendered_prompt"], "Hi Ada",
        "string vars are not parsed by default"
    );
    let error = cases[2]["error"].as_str().expect("vars transform error");
    assert!(error.contains("json variable transform failed"), "{error}");
    let sent: Vec<String> = dispatches(&calls)
        .into_iter()
        .map(|d| d.user_content)
        .collect();
    assert!(sent.contains(&"Hi Ada".to_owned()), "{sent:?}");
}

#[tokio::test]
async fn request_and_case_prefix_suffix_wrap_in_documented_order() {
    let (state, calls) = recording_state();
    let body = run(
        state,
        json!({
            "model": "m1",
            "prefix": "[R-pre]",
            "suffix": "[R-suf]",
            "dataset": [{"prompt": "body", "options": {"prefix": "[C-pre]", "suffix": "[C-suf]"}}]
        }),
    )
    .await;
    let expected = "[C-pre][R-pre]body[C-suf][R-suf]";
    assert_eq!(body["cases"][0]["rendered_prompt"], expected);
    let sent = dispatches(&calls);
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0].user_content, expected,
        "the provider receives the wrapped prompt"
    );
}

#[tokio::test]
async fn case_provider_and_providers_override_the_request_model() {
    let (state, calls) = recording_state();
    let body = run(
        state,
        json!({
            "model": "run-model",
            "dataset": [
                {"prompt": "one", "provider": "case-model"},
                {"prompt": "two", "providers": ["  ", "listed-model", "other"]},
                {"prompt": "three"}
            ]
        }),
    )
    .await;
    let models: Vec<String> = dispatches(&calls).into_iter().map(|d| d.model).collect();
    assert_eq!(models, ["case-model", "listed-model", "run-model"]);
    let scored: Vec<&Value> = body["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|case| &case["model"])
        .collect();
    assert_eq!(
        scored,
        [
            &json!("case-model"),
            &json!("listed-model"),
            &json!("run-model")
        ]
    );
}

#[tokio::test]
async fn provider_output_fixtures_skip_dispatch_and_mark_unmeasured_dimensions() {
    let (state, calls) = recording_state();
    let body = run(
        state,
        json!({
            "model": "m1",
            "dataset": [
                {"prompt": "p", "expected": "ok", "provider_output": "ok then"},
                {"prompt": "p", "provider_output": {"output": "fine"}, "provider_latency_ms": 900, "provider_output_policy_pass": true}
            ]
        }),
    )
    .await;
    assert!(
        dispatches(&calls).is_empty(),
        "fixtures never call the provider"
    );
    let bare = &body["cases"][0];
    assert_eq!(bare["provider"], "precomputed");
    assert_eq!(bare["response_text"], "ok then");
    assert_eq!(bare["latency_available"], false);
    assert_eq!(bare["policy_available"], false);
    assert_eq!(bare["policy_pass"], false);
    let measured = &body["cases"][1];
    assert_eq!(measured["response_text"], "fine");
    assert_eq!(measured["latency_available"], true);
    assert_eq!(measured["latency_ms"], 900);
    assert_eq!(measured["policy_available"], true);
    assert_eq!(measured["policy_pass"], true);
}

#[tokio::test]
async fn usage_cost_usd_is_converted_to_micro_usd() {
    let (state, _calls) = recording_state();
    let body = run(
        state,
        json!({
            "model": "m1",
            "dataset": [
                {"prompt": "live"},
                {"prompt": "p", "provider_output": {"choices": [{"message": {"content": "x"}}], "usage": {"cost": 0.000_042}}}
            ]
        }),
    )
    .await;
    assert_eq!(
        body["cases"][0]["cost_micro_usd"], 2_500,
        "stub reports cost_usd 0.0025"
    );
    assert_eq!(body["cases"][1]["cost_micro_usd"], 42);
}

#[tokio::test]
async fn repeat_expands_cases_with_stable_ids_and_is_clamped() {
    let (state, calls) = recording_state();
    let body = run(
        state,
        json!({
            "model": "m1",
            "repeat": 2,
            "dataset": [{"id": "alpha", "prompt": "a"}, {"prompt": "b"}]
        }),
    )
    .await;
    let ids: Vec<&str> = body["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|case| case["id"].as_str().expect("id"))
        .collect();
    assert_eq!(
        ids,
        [
            "alpha:repeat-1",
            "case-2:repeat-1",
            "alpha:repeat-2",
            "case-2:repeat-2"
        ]
    );
    assert_eq!(
        dispatches(&calls).len(),
        4,
        "without cache every repeat dispatches"
    );

    let (state, calls) = recording_state();
    let body = run(
        state,
        json!({"model": "m1", "repeat": 500, "dataset": [{"prompt": "c", "provider_output": "x"}]}),
    )
    .await;
    let cases = body["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), super::MAX_EVAL_REPEAT);
    assert_eq!(
        cases.last().expect("last")["id"],
        format!("case-1:repeat-{}", super::MAX_EVAL_REPEAT)
    );
    assert!(
        dispatches(&calls).is_empty(),
        "fixture repeats never dispatch"
    );
}

#[tokio::test]
async fn cache_dispatches_identical_requests_once_and_never_caches_errors() {
    let (state, calls) = recording_state();
    let body = run(
        state,
        json!({
            "model": "m1",
            "cache": true,
            "repeat": 3,
            "dataset": [{"id": "ok", "prompt": "same"}, {"id": "bad", "prompt": "FAIL me"}]
        }),
    )
    .await;
    let cases = body["cases"].as_array().expect("cases");
    let sent = dispatches(&calls);
    let ok_calls = sent.iter().filter(|d| d.user_content == "same").count();
    assert_eq!(
        ok_calls, 1,
        "identical successful requests reach the provider once"
    );
    let providers: Vec<&Value> = cases
        .iter()
        .filter(|case| case["id"].as_str().is_some_and(|id| id.starts_with("ok:")))
        .map(|case| &case["provider"])
        .collect();
    assert_eq!(providers.len(), 3);
    assert_ne!(providers[0], &json!("eval-cache"));
    assert_eq!(providers[1], &json!("eval-cache"));
    assert_eq!(providers[2], &json!("eval-cache"));

    let failed: Vec<&Value> = cases
        .iter()
        .filter(|case| case["id"].as_str().is_some_and(|id| id.starts_with("bad:")))
        .collect();
    assert_eq!(failed.len(), 3);
    for case in &failed {
        assert!(
            case["error"].is_string(),
            "every failing repeat reports its own error"
        );
        assert_ne!(
            case["provider"], "eval-cache",
            "a failed call is never served from cache"
        );
        assert_eq!(case["cache_hit"], false);
    }
    let fail_calls = sent.iter().filter(|d| d.user_content == "FAIL me").count();
    assert!(
        fail_calls >= 3,
        "each failing repeat dispatches again ({fail_calls})"
    );
    assert_eq!(
        fail_calls % 3,
        0,
        "every repeat dispatches the same number of attempts"
    );
}

#[tokio::test]
async fn per_case_cache_option_enables_reuse_without_the_run_flag() {
    let (state, calls) = recording_state();
    let body = run(
        state,
        json!({
            "model": "m1",
            "dataset": [
                {"prompt": "same", "options": {"cache": true}},
                {"prompt": "same", "options": {"cache": true}},
                {"prompt": "same"}
            ]
        }),
    )
    .await;
    let providers: Vec<&Value> = body["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|case| &case["provider"])
        .collect();
    assert_eq!(providers[1], &json!("eval-cache"));
    assert_eq!(body["cases"][1]["cache_hit"], true);
    assert_ne!(
        providers[2],
        &json!("eval-cache"),
        "an uncached case still dispatches"
    );
    assert_eq!(dispatches(&calls).len(), 2);
}
