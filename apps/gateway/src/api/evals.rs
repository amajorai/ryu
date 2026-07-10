use std::sync::Arc;
use std::time::Instant;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::warn;

use crate::{
    evals::{
        aggregate_scores, build_judge_prompt, builtin_dataset, eval_assertion_deterministic,
        parse_judge_verdict, score_case, substitute_vars, truncate_chars, Assertion,
        AssertionResult, CaseScore, EvalCase, EvalRunAggregate,
    },
    pipeline,
    state::SharedState,
};

/// GET /v1/evals
///
/// Returns the current eval configuration and per-provider rolling scores.
/// When evals are disabled the endpoint returns `enabled: false` and an empty
/// providers map — it never panics and never returns a non-200 for a healthy
/// gateway.
pub async fn get_evals(State(state): State<SharedState>) -> Json<Value> {
    let cfg = &state.config.evals;

    if !cfg.enabled {
        return Json(json!({
            "enabled": false,
            "sample_rate": cfg.sample_rate,
            "max_latency_ms": cfg.max_latency_ms,
            "providers": {},
        }));
    }

    let providers = state.evals.all_provider_scores();

    Json(json!({
        "enabled": true,
        "sample_rate": cfg.sample_rate,
        "max_latency_ms": cfg.max_latency_ms,
        "providers": providers,
    }))
}

// ─── POST /v1/evals/run ───────────────────────────────────────────────────────
//
// Replays a dataset through the gateway pipeline and returns per-case scores
// plus an aggregate. v1 scorers: latency / token_efficiency / policy_pass /
// optional substring_match. LLM-judge and custom dataset scorers are deferred.
//
// The model/provider for each replay flows through the existing router — nothing
// is hardcoded. When `dataset` is empty or absent the built-in 3-case dataset
// is used so the desktop "Run evals" panel has something meaningful on first run.

/// Request body for POST /v1/evals/run.
#[derive(Debug, Deserialize)]
pub struct RunEvalsRequest {
    /// Model to evaluate (forwarded to the gateway pipeline as-is). The router
    /// decides which provider to use — no provider is hardcoded here.
    #[serde(default = "default_model")]
    pub model: String,
    /// Optional agent/app id for per-agent budget tracking. When set it is
    /// forwarded as `x-ryu-agent-id` context to the pipeline.
    pub agent_id: Option<String>,
    /// Dataset to replay. When empty or absent, the built-in dataset is used.
    #[serde(default)]
    pub dataset: Vec<EvalCase>,

    // ── NEW ──
    /// Run-level system prompt. When present, every case's provider request
    /// prepends `{role:"system", content:<rendered system_prompt>}`. `{{vars}}`
    /// in it are substituted per-case using that case's `vars`.
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Multi-model. When non-empty, the whole dataset runs against each model
    /// and the response gains a per-model `models` breakdown. `model` (singular)
    /// stays the back-compat default and seeds the top-level cases/aggregate.
    #[serde(default)]
    pub models: Vec<String>,
    /// Optional judge model override. When set, this single fixed model judges
    /// EVERY model's output (fair cross-model compare). When unset, the first
    /// model in the run is used as the single fixed judge.
    #[serde(default)]
    pub judge_model: Option<String>,
}

fn default_model() -> String {
    "gpt-4o-mini".to_string()
}

/// One model's full result block (multi-model breakdown entry).
#[derive(serde::Serialize)]
struct ModelEvalResult {
    model: String,
    cases: Vec<CaseScore>,
    aggregate: EvalRunAggregate,
}

/// Wire response for POST /v1/evals/run.
#[derive(serde::Serialize)]
struct RunEvalsResponse {
    /// Always the FIRST evaluated model's cases (back-compat).
    cases: Vec<CaseScore>,
    /// Always the FIRST evaluated model's aggregate (back-compat).
    aggregate: EvalRunAggregate,
    /// Per-model breakdown. OMITTED entirely on the single-model path.
    #[serde(skip_serializing_if = "Option::is_none")]
    models: Option<Vec<ModelEvalResult>>,
}

/// POST /v1/evals/run
///
/// Replays each prompt in `dataset` through the full gateway pipeline (firewall,
/// routing, provider call) and returns per-case scores plus an aggregate summary.
///
/// Scoring is independent of whether passive evals are enabled — an explicit
/// eval run always scores. Each case is run sequentially (not concurrently) to
/// keep provider load predictable and budgets observable.
pub async fn run_evals(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(mut req): Json<RunEvalsRequest>,
) -> Response {
    // Fall back to the built-in dataset when none is provided.
    if req.dataset.is_empty() {
        req.dataset = builtin_dataset();
    }

    // Authenticate via the same path as chat — this is a normal metered call.
    // The master key is NOT required; any valid API key (including anonymous
    // when auth is disabled) can run evals.
    let raw_key = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    let ctx = match pipeline::authenticate(
        &state,
        pipeline::AuthInputs {
            raw_api_key: raw_key.as_deref(),
            agent_id: req.agent_id.clone(),
            ..Default::default()
        },
    )
    .await
    {
        Ok(ctx) => ctx,
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": e.to_string()})),
            )
                .into_response();
        }
    };

    let max_latency_ms = state.config.evals.max_latency_ms;

    // The set of models under test. Singular `model` is the back-compat default.
    let model_list: Vec<String> = if req.models.is_empty() {
        vec![req.model.clone()]
    } else {
        req.models.clone()
    };

    // ONE fixed judge for the whole run (fair cross-model compare). Explicit
    // override wins; otherwise the first/primary model judges every column.
    let judge_model = req
        .judge_model
        .clone()
        .unwrap_or_else(|| model_list[0].clone());

    let multi_model = !req.models.is_empty();

    let mut per_model: Vec<ModelEvalResult> = Vec::with_capacity(model_list.len());

    for model in &model_list {
        let mut case_scores: Vec<CaseScore> = Vec::with_capacity(req.dataset.len());

        for case in &req.dataset {
            // Render the case prompt + optional system prompt with this case's vars.
            let rendered_prompt = substitute_vars(&case.prompt, &case.vars);
            let mut messages: Vec<Value> = Vec::with_capacity(2);
            if let Some(sp) = &req.system_prompt {
                let rendered_sp = substitute_vars(sp, &case.vars);
                messages.push(json!({"role": "system", "content": rendered_sp}));
            }
            messages.push(json!({"role": "user", "content": rendered_prompt}));

            let body = json!({
                "model": model,
                "messages": messages
            });

            let start = Instant::now();
            let result = pipeline::run(Arc::clone(&state), ctx.clone(), body).await;
            let latency_ms = start.elapsed().as_millis() as u64;

            let mut score = match result {
                Ok(output) => {
                    let policy_pass = true;
                    score_case(
                        case,
                        &output.response,
                        latency_ms,
                        policy_pass,
                        max_latency_ms,
                    )
                }
                Err(e) => {
                    // Policy / firewall failures count as policy_fail; provider
                    // errors synthesise a neutral response so the case is still
                    // included rather than silently dropped.
                    warn!(prompt = %case.prompt, error = %e, "eval case failed");
                    let synthetic = json!({
                        "choices": [{"message": {"content": format!("[error: {}]", e)}}],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 0}
                    });
                    let policy_pass = !matches!(
                        e,
                        crate::error::GatewayError::FirewallBlocked(_)
                            | crate::error::GatewayError::PolicyViolation(_)
                    );
                    score_case(case, &synthetic, latency_ms, policy_pass, max_latency_ms)
                }
            };

            // Assemble assertions (additive — never folded into `overall`).
            let mut assertion_results: Vec<AssertionResult> = Vec::new();

            // Legacy `expected` synthesized as a contains assertion (the scalar
            // `substring_match` is already set by score_case).
            if let Some(exp) = &case.expected {
                let synth = Assertion::Contains { value: exp.clone() };
                assertion_results.push(eval_assertion_deterministic(&synth, &score.response_text));
            }

            for assertion in &case.assertions {
                match assertion {
                    Assertion::LlmJudge { rubric } => {
                        let rendered_rubric = substitute_vars(rubric, &case.vars);
                        let result = run_llm_judge(
                            &rendered_rubric,
                            &score.response_text,
                            &judge_model,
                            Arc::clone(&state),
                            ctx.clone(),
                        )
                        .await;
                        assertion_results.push(result);
                    }
                    Assertion::Contains { value } => {
                        let a = Assertion::Contains {
                            value: substitute_vars(value, &case.vars),
                        };
                        assertion_results
                            .push(eval_assertion_deterministic(&a, &score.response_text));
                    }
                    Assertion::NotContains { value } => {
                        let a = Assertion::NotContains {
                            value: substitute_vars(value, &case.vars),
                        };
                        assertion_results
                            .push(eval_assertion_deterministic(&a, &score.response_text));
                    }
                    Assertion::Equals { value } => {
                        let a = Assertion::Equals {
                            value: substitute_vars(value, &case.vars),
                        };
                        assertion_results
                            .push(eval_assertion_deterministic(&a, &score.response_text));
                    }
                    Assertion::Regex { value } => {
                        let a = Assertion::Regex {
                            value: substitute_vars(value, &case.vars),
                        };
                        assertion_results
                            .push(eval_assertion_deterministic(&a, &score.response_text));
                    }
                    Assertion::JsonValid => {
                        assertion_results.push(eval_assertion_deterministic(
                            &Assertion::JsonValid,
                            &score.response_text,
                        ));
                    }
                }
            }

            score.assertions_pass = assertion_results.iter().all(|r| r.pass);
            score.assertions = assertion_results;
            case_scores.push(score);
        }

        let aggregate = aggregate_scores(&case_scores);
        per_model.push(ModelEvalResult {
            model: model.clone(),
            cases: case_scores,
            aggregate,
        });
    }

    // Top-level cases/aggregate mirror the FIRST model (back-compat).
    let first = &per_model[0];
    let response = RunEvalsResponse {
        cases: first.cases.clone(),
        aggregate: first.aggregate.clone(),
        models: if multi_model { Some(per_model) } else { None },
    };

    Json(response).into_response()
}

/// Run a single LLM-judge assertion as a second `pipeline::run` (same provider/
/// router/firewall path — nothing hardcoded). Defensive: a judge error is a
/// FAIL, never a panic.
///
/// NOTE (timeout): multi-model × llm_judge fans out `models × cases ×
/// (1 + judge_calls)` SEQUENTIAL provider calls, all under Core's 120s reqwest
/// proxy timeout. Large matrices can time out at the Core proxy even though no
/// field is dropped here — the desktop warns when the matrix is large.
async fn run_llm_judge(
    rubric: &str,
    output: &str,
    judge_model: &str,
    state: SharedState,
    ctx: pipeline::RequestContext,
) -> AssertionResult {
    let judge_prompt = build_judge_prompt(rubric, output);
    let body = json!({
        "model": judge_model,
        "messages": [{"role": "user", "content": judge_prompt}]
    });

    match pipeline::run(state, ctx, body).await {
        Ok(out) => {
            // Extract judge text inline (keep pipeline::response_to_text private).
            let text = out.response["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("");
            let (pass, score) = parse_judge_verdict(text);
            AssertionResult {
                kind: "llm_judge".to_string(),
                pass,
                score,
                detail: truncate_chars(text, 500),
            }
        }
        Err(e) => AssertionResult {
            kind: "llm_judge".to_string(),
            pass: false,
            score: 0.0,
            detail: format!("judge error: {e}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::Value;

    use super::{RunEvalsRequest, RunEvalsResponse};
    use crate::{
        config::{EvalsConfig, GatewayConfig},
        evals::{aggregate_scores, EvalsRunner},
        state::AppState,
    };

    /// Verification gate: a legacy request `{model, dataset:[{prompt, expected}]}`
    /// must deserialize with empty `vars`/`assertions`/`models`, `None`
    /// `system_prompt`/`judge_model`; and a legacy single-model response must
    /// serialize WITHOUT a top-level `models` key.
    #[test]
    fn legacy_request_and_response_round_trip() {
        // (a) Legacy request deserializes with empty new fields.
        let raw = r#"{"model":"gpt-4o-mini","dataset":[{"prompt":"Say hi","expected":"hi"}]}"#;
        let req: RunEvalsRequest = serde_json::from_str(raw).expect("legacy request deserializes");
        assert_eq!(req.model, "gpt-4o-mini");
        assert_eq!(req.dataset.len(), 1);
        assert_eq!(req.dataset[0].prompt, "Say hi");
        assert_eq!(req.dataset[0].expected.as_deref(), Some("hi"));
        assert!(req.dataset[0].vars.is_empty());
        assert!(req.dataset[0].assertions.is_empty());
        assert!(req.models.is_empty());
        assert!(req.system_prompt.is_none());
        assert!(req.judge_model.is_none());

        // (b) Legacy single-model response serializes with NO `models` key.
        let response = RunEvalsResponse {
            cases: Vec::new(),
            aggregate: aggregate_scores(&[]),
            models: None,
        };
        let serialized = serde_json::to_value(&response).expect("response serializes");
        let obj = serialized.as_object().expect("response is object");
        assert!(obj.contains_key("cases"));
        assert!(obj.contains_key("aggregate"));
        assert!(
            !obj.contains_key("models"),
            "single-model response must omit the `models` key"
        );
    }

    fn make_state_with_evals(enabled: bool) -> Arc<AppState> {
        let mut config = GatewayConfig::default();
        config.evals = EvalsConfig {
            enabled,
            max_latency_ms: 5_000,
            sample_rate: 0.5,
            stream_usage: true,
        };
        Arc::new(AppState::new(config))
    }

    #[test]
    fn disabled_evals_returns_empty_providers() {
        let state = make_state_with_evals(false);
        let response = build_evals_response(&state);

        assert_eq!(response["enabled"], false);
        assert_eq!(
            response["providers"]
                .as_object()
                .expect("providers is object")
                .len(),
            0
        );
    }

    #[test]
    fn enabled_evals_returns_scored_providers() {
        let state = make_state_with_evals(true);

        // Record scores to populate the runner.
        state.evals.record_provider_score("openai", 0.9);
        state.evals.record_provider_score("anthropic", 0.7);

        let response = build_evals_response(&state);

        assert_eq!(response["enabled"], true);
        let providers = response["providers"]
            .as_object()
            .expect("providers is object");
        assert_eq!(providers.len(), 2);

        let openai_score = providers["openai"].as_f64().expect("openai score");
        assert!((openai_score - 0.9).abs() < 1e-3);

        let anthropic_score = providers["anthropic"].as_f64().expect("anthropic score");
        assert!((anthropic_score - 0.7).abs() < 1e-3);
    }

    #[test]
    fn enabled_evals_with_no_scores_returns_empty_providers() {
        let state = make_state_with_evals(true);
        let response = build_evals_response(&state);

        assert_eq!(response["enabled"], true);
        assert_eq!(
            response["providers"]
                .as_object()
                .expect("providers is object")
                .len(),
            0
        );
    }

    #[test]
    fn response_includes_config_fields() {
        let state = make_state_with_evals(true);
        let response = build_evals_response(&state);

        assert_eq!(response["sample_rate"].as_f64().expect("sample_rate"), 0.5);
        assert_eq!(
            response["max_latency_ms"].as_u64().expect("max_latency_ms"),
            5_000
        );
    }

    /// Build the evals response JSON synchronously by calling the same logic as
    /// the handler, without spinning up an actual HTTP server.
    fn build_evals_response(state: &Arc<AppState>) -> Value {
        let cfg = &state.config.evals;

        if !cfg.enabled {
            return serde_json::json!({
                "enabled": false,
                "sample_rate": cfg.sample_rate,
                "max_latency_ms": cfg.max_latency_ms,
                "providers": {},
            });
        }

        let providers = state.evals.all_provider_scores();

        serde_json::json!({
            "enabled": true,
            "sample_rate": cfg.sample_rate,
            "max_latency_ms": cfg.max_latency_ms,
            "providers": providers,
        })
    }
}
