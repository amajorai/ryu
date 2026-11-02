//! `POST /v1/evals/run`: replay a dataset across models and aggregate the scores.

use super::*;

// ─── POST /v1/evals/run ───────────────────────────────────────────────────────
//
// Replays a dataset through the gateway pipeline and returns per-case scores
// plus an aggregate. Every case is scored on latency / token_efficiency /
// policy_pass / optional substring_match, plus any per-case `assertions`
// (including `llm_judge`, which judges through this same pipeline) and any
// registry evaluators requested per-case or run-level in `evaluators`
// (evaluators that cannot run over a text dataset report `executed: false`).
//
// The model/provider for each replay flows through the existing router — nothing
// is hardcoded. When `dataset` is empty or absent the built-in 3-case dataset
// is used so the desktop "Run evals" panel has something meaningful on first run.

#[derive(Debug, Clone, Default)]
pub(super) struct EvalExecutionOptions {
    pub(super) cache: bool,
    pub(super) prefix: Option<String>,
    pub(super) suffix: Option<String>,
    pub(super) system_messages: Vec<crate::evals::EvalMessage>,
    pub(super) system_prompt: Option<String>,
    pub(super) timeout_ms: Option<u64>,
    pub(super) prompt_id: Option<String>,
    pub(super) provided_cost_micro_usd: Option<u64>,
    pub(super) provided_latency_ms: Option<u64>,
}

/// One model's full result block (multi-model breakdown entry).
#[derive(serde::Serialize)]
pub(super) struct ModelEvalResult {
    pub(super) model: String,
    pub(super) cases: Vec<CaseScore>,
    pub(super) aggregate: EvalRunAggregate,
}

/// Wire response for POST /v1/evals/run.
#[derive(serde::Serialize)]
pub(super) struct RunEvalsResponse {
    /// Always the FIRST evaluated model's cases (back-compat).
    pub(super) cases: Vec<CaseScore>,
    /// Always the FIRST evaluated model's aggregate (back-compat).
    pub(super) aggregate: EvalRunAggregate,
    /// Per-model breakdown. OMITTED entirely on the single-model path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) models: Option<Vec<ModelEvalResult>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) finished_at: Option<String>,
    #[serde(skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub(super) tags: std::collections::HashMap<String, String>,
}

/// POST /v1/evals/run
///
/// Replays each prompt in `dataset` through the full gateway pipeline (firewall,
/// routing, provider call) and returns per-case scores plus an aggregate summary.
///
/// Scoring is independent of whether passive evals are enabled — an explicit
/// eval run always scores. Cases may run concurrently up to the request's
/// bounded `max_concurrency`, while results are restored to input order.
pub async fn run_evals(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(mut req): Json<RunEvalsRequest>,
) -> Response {
    // Fall back to the built-in dataset when none is provided, then expand
    // Promptfoo's repeat option into stable, separately addressable cases.
    if req.dataset.is_empty() {
        req.dataset = builtin_dataset();
    }
    if let Err(error) = resolve_request_model(&mut req.model, !req.models.is_empty(), &state.config)
    {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
    }
    let registry = state.evaluator_registry();
    if let Err(error) = validate_eval_request(&req, &registry) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
    }
    let dataset = expanded_dataset(&req.dataset, req.repeat);
    if dataset.len() > MAX_EVAL_CASES {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": format!("eval dataset is limited to {MAX_EVAL_CASES} cases")
            })),
        )
            .into_response();
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
        Ok(ctx) => tag_eval_context(ctx),
        // Every refusal keeps its own status, catalogue code and Retry-After,
        // the same as on chat (a fleet with no platform floor answers 503
        // `screening_unavailable`, not 401).
        Err(error) => return error.into_response(),
    };

    let max_latency_ms = state.config.evals.max_latency_ms;

    // The set of models under test. Singular `model` is the back-compat default.
    let model_list: Vec<String> = if req.models.is_empty() {
        vec![req.model.trim().to_owned()]
    } else {
        req.models
            .iter()
            .map(|model| model.trim().to_owned())
            .filter(|model| !model.is_empty())
            .take(32)
            .collect()
    };
    if model_list.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "at least one model is required" })),
        )
            .into_response();
    }

    // ONE fixed judge for the whole run (fair cross-model compare). Explicit
    // override wins; otherwise the first/primary model judges every column.
    let judge_model = req
        .judge_model
        .clone()
        .unwrap_or_else(|| model_list[0].clone());

    let multi_model = !req.models.is_empty();
    let run_id = format!("eval_{}", uuid::Uuid::new_v4().simple());
    let started_at = chrono::Utc::now().to_rfc3339();

    // Shared catalog + per-run judge context for offline registry-evaluator
    // scoring (P2). Built from config so user-authored custom evaluators are
    // resolvable by id alongside the built-ins. Cheap to build once; reused for
    // every case/model.
    let judge_ctx = JudgeCtx {
        state: Arc::clone(&state),
        ctx: ctx.clone(),
        request_judge_model: req
            .judge_model
            .clone()
            .or_else(|| configured_judge_model(&state.config)),
        fallback_model: model_list[0].clone(),
        request_evaluators: req.evaluators.clone(),
        judge_gate: None,
    };

    let execution_options = EvalExecutionOptions {
        cache: req.cache,
        prefix: req.prefix.clone(),
        suffix: req.suffix.clone(),
        system_messages: req.system_messages.clone(),
        system_prompt: req.system_prompt.clone(),
        timeout_ms: req.timeout_ms,
        prompt_id: req.prompt_id.clone(),
        provided_cost_micro_usd: None,
        provided_latency_ms: None,
    };
    // Cache is explicitly a single-run de-duplication contract. Serializing a
    // cache-enabled run prevents two identical cases from racing through the
    // miss check and both charging a provider before either stores its result.
    let cache_requested = req.cache || dataset.iter().any(|case| case.options.cache == Some(true));
    let concurrency = if cache_requested {
        1
    } else {
        req.max_concurrency.unwrap_or(1).clamp(1, 32)
    };
    let mut per_model: Vec<ModelEvalResult> = Vec::with_capacity(model_list.len());

    for model in &model_list {
        let cache = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let futures = dataset.iter().cloned().enumerate().map(|(index, case)| {
            run_eval_case(
                Arc::clone(&state),
                ctx.clone(),
                case,
                index,
                model.clone(),
                judge_model.clone(),
                registry.clone(),
                judge_ctx.clone(),
                execution_options.clone(),
                Arc::clone(&cache),
                max_latency_ms,
            )
        });
        let mut stream = stream::iter(futures).buffer_unordered(concurrency);
        let mut ordered: Vec<Option<CaseScore>> = vec![None; dataset.len()];
        while let Some((index, score)) = stream.next().await {
            ordered[index] = Some(score);
        }
        let case_scores: Vec<CaseScore> = ordered.into_iter().flatten().collect();
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
        run_id: Some(run_id),
        started_at: Some(started_at),
        finished_at: Some(chrono::Utc::now().to_rfc3339()),
        tags: req.tags,
    };

    Json(response).into_response()
}

#[cfg(test)]
mod tests {
    use super::super::run_evals_tests::{eval_headers, eval_state};
    use super::*;

    async fn body_of(response: Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("drain");
        serde_json::from_slice(&bytes).expect("json")
    }

    /// A run needs an authenticated caller, and a fixture case is scored
    /// without a provider call.
    #[tokio::test]
    async fn runs_need_auth_and_score_fixture_cases() {
        let request = || -> RunEvalsRequest {
            serde_json::from_value(json!({
                "model": "m1",
                "dataset": [{ "prompt": "p", "expected": "pong", "provider_output": "pong" }]
            }))
            .expect("parses")
        };
        let denied = run_evals(State(eval_state()), HeaderMap::new(), Json(request())).await;
        assert!(denied.status().is_client_error(), "{}", denied.status());

        let response = run_evals(State(eval_state()), eval_headers(), Json(request())).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_of(response).await;
        assert_eq!(body["cases"][0]["response_text"], "pong");
        assert_eq!(body["cases"][0]["substring_match"], 1.0);
    }
}
