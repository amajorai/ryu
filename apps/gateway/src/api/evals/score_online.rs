//! `POST /v1/evals/score`: score an already-produced response.

use super::*;

/// POST /v1/evals/score
///
/// Scores a production output in place. The provider is never replayed for the
/// submitted response; only model-graded assertions/evaluators that explicitly
/// need a judge make a second, visible Gateway call through the normal pipeline.
pub async fn score_online(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(mut req): Json<OnlineScoreRequest>,
) -> Response {
    let registry = state.evaluator_registry();
    // The response is already given, so a model is only *needed* as the judge for
    // model-graded checks. Deterministic-only scoring must keep working on a
    // Gateway with no default model, so it falls back to a neutral label.
    if online_score_needs_judge(&req.assertions, &req.evaluators, &registry) {
        if let Err(error) = resolve_request_model(&mut req.model, false, &state.config) {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
        }
    } else if req.model.trim().is_empty() {
        req.model = configured_default_model(&state.config)
            .unwrap_or_else(|| UNNAMED_ONLINE_SCORE_MODEL.to_owned());
    }
    if req.response.is_null() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "response is required" })),
        )
            .into_response();
    }
    let response_bytes = match serde_json::to_vec(&req.response) {
        Ok(bytes) => bytes,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("response is not serializable: {error}") })),
            )
                .into_response();
        }
    };
    if response_bytes.len() > MAX_ONLINE_RESPONSE_BYTES {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": format!("response is limited to {MAX_ONLINE_RESPONSE_BYTES} bytes")
            })),
        )
            .into_response();
    }
    if req.assertions.len() > MAX_EVAL_ASSERTIONS_PER_CASE
        || req.evaluators.len() > MAX_EVAL_EVALUATORS_PER_CASE
        || req.vars.len() > MAX_EVAL_MAP_ENTRIES
        || req.metadata.len() > MAX_EVAL_MAP_ENTRIES
        || req.prompt.chars().count() > MAX_EVAL_TEXT_CHARS
        || req
            .expected
            .as_deref()
            .is_some_and(|value| value.chars().count() > MAX_EVAL_TEXT_CHARS)
        || req
            .description
            .as_deref()
            .is_some_and(|value| value.chars().count() > MAX_EVAL_TEXT_CHARS)
        || req.model.chars().count() > 256
        || req.id.as_deref().is_some_and(|id| id.chars().count() > 256)
        || req
            .agent_id
            .as_deref()
            .is_some_and(|agent| agent.chars().count() > 256)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "online score input exceeds one of the bounded limits" })),
        )
            .into_response();
    }
    if req.model.trim().is_empty() || req.evaluators.iter().any(|id| id.chars().count() > 256) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "online score model/evaluator ids are invalid" })),
        )
            .into_response();
    }
    let mut assertion_nodes = 0;
    if let Err(error) = validate_assertion_tree(&req.assertions, 0, &mut assertion_nodes) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
    }
    let registry = state.evaluator_registry();
    if let Err(error) = registry.validate_offline_ids(&req.evaluators) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
    }
    let raw_key = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
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
    let model = req.model.trim().to_owned();
    if model.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "model must not be empty" })),
        )
            .into_response();
    }
    let judge_model = req
        .judge_model
        .as_deref()
        .map(str::trim)
        .filter(|judge| !judge.is_empty())
        .map(str::to_owned)
        .or_else(|| configured_judge_model(&state.config))
        .unwrap_or_else(|| model.clone());
    let judge_ctx = JudgeCtx {
        state: Arc::clone(&state),
        ctx: ctx.clone(),
        request_judge_model: Some(judge_model.clone()),
        fallback_model: model.clone(),
        request_evaluators: req.evaluators.clone(),
        judge_gate: None,
    };
    let case = EvalCase {
        id: req.id,
        description: req.description,
        prompt: req.prompt,
        expected: req.expected,
        context: req.context,
        threshold: req.threshold,
        vars: req.vars,
        assertions: req.assertions,
        evaluators: req.evaluators,
        metadata: req.metadata,
        provider_output: Some(req.response),
        provider_output_policy_pass: req.policy_pass,
        ..Default::default()
    };
    let options = EvalExecutionOptions {
        provided_cost_micro_usd: req.cost_micro_usd,
        provided_latency_ms: req.latency_ms,
        prompt_id: Some("online".to_owned()),
        ..Default::default()
    };
    let (_index, score) = run_eval_case(
        Arc::clone(&state),
        ctx,
        case,
        0,
        model,
        judge_model,
        registry,
        judge_ctx,
        options,
        Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        state.config.evals.max_latency_ms,
    )
    .await;
    Json(json!({
        "kind": "online_score",
        "scored_at": chrono::Utc::now().to_rfc3339(),
        "score": score,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::super::run_evals_tests::{eval_headers, eval_state};
    use super::*;

    /// Scoring a submitted response needs an authenticated caller; a
    /// deterministic check needs no judge and no model.
    #[tokio::test]
    async fn online_scores_need_auth_and_run_deterministic_checks() {
        let request = || -> OnlineScoreRequest {
            serde_json::from_value(json!({
                "prompt": "p",
                "response": "pong",
                "assertions": [{ "kind": "contains", "value": "pong" }]
            }))
            .expect("parses")
        };
        let denied = score_online(State(eval_state()), HeaderMap::new(), Json(request())).await;
        assert!(denied.status().is_client_error(), "{}", denied.status());

        let response = score_online(State(eval_state()), eval_headers(), Json(request())).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("drain");
        let body: Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(body["score"]["assertions_pass"], true);
    }
}
