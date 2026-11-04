//! One dataset case: replay (or fixture), assertions, then registry evaluators.

use super::*;

pub(super) async fn run_eval_case(
    state: SharedState,
    ctx: pipeline::RequestContext,
    case: EvalCase,
    index: usize,
    model: String,
    judge_model: String,
    registry: EvaluatorRegistry,
    judge_ctx: JudgeCtx,
    options: EvalExecutionOptions,
    response_cache: Arc<tokio::sync::Mutex<HashMap<String, Value>>>,
    max_latency_ms: u64,
) -> (usize, CaseScore) {
    let mut case = case;
    let var_transform_error =
        apply_builtin_vars_transform(&mut case.vars, case.options.transform_vars.as_deref()).err();
    let selected_model = case_model(&case, &model);
    let rendered_prompt =
        render_case_prompt(&case, options.prefix.as_deref(), options.suffix.as_deref());
    let mut messages: Vec<Value> = Vec::with_capacity(case.messages.len() + 2);
    if let Some(system_prompt) = &options.system_prompt {
        messages.push(json!({
            "role": "system",
            "content": render_template(system_prompt, &case.vars)
        }));
    }
    if !options.system_messages.is_empty() {
        messages.extend(options.system_messages.iter().map(|message| {
            json!({
                "role": message.role,
                "content": render_template(&message.content, &case.vars)
            })
        }));
    }
    if case.messages.is_empty() {
        messages.push(json!({ "role": "user", "content": rendered_prompt }));
    } else {
        let mut has_user = false;
        for message in &case.messages {
            has_user |= message.role == "user";
            messages.push(json!({
                "role": message.role,
                "content": render_template(&message.content, &case.vars)
            }));
        }
        if !has_user {
            messages.push(json!({ "role": "user", "content": rendered_prompt }));
        }
    }

    let body = json!({
        "model": selected_model.clone(),
        "messages": messages
    });
    let cache_key = serde_json::to_string(&body).unwrap_or_else(|_| format!("case-{index}"));
    let use_cache = options.cache || case.options.cache == Some(true);
    let cached = if use_cache {
        response_cache.lock().await.get(&cache_key).cloned()
    } else {
        None
    };
    let start = Instant::now();
    let mut cache_hit = false;
    let mut provider_used = None;
    let mut model_used = selected_model;
    let mut output_error = var_transform_error;
    let mut response = if let Some(fixture) = case.provider_output.as_ref() {
        provider_used = Some(
            case.provider_output_provider
                .clone()
                .unwrap_or_else(|| "precomputed".to_owned()),
        );
        precomputed_response(fixture)
    } else if let Some(cached) = cached {
        cache_hit = true;
        provider_used = Some("eval-cache".to_owned());
        cached
    } else {
        let timeout_ms = case
            .options
            .timeout_ms
            .or(options.timeout_ms)
            .unwrap_or(DEFAULT_EVAL_TIMEOUT_MS)
            .clamp(100, DEFAULT_EVAL_TIMEOUT_MS);
        // Boxed like the judge's run (`judge_call`): held inline, this ~56 KB
        // future widens the case's poll frame under every evaluator it runs.
        match tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            Box::pin(pipeline::run(Arc::clone(&state), ctx.clone(), body)),
        )
        .await
        {
            Ok(Ok(output)) => {
                provider_used = Some(output.provider_used.to_owned());
                model_used = output.model_used.clone();
                output.response
            }
            Ok(Err(error)) => {
                output_error = Some(error.to_string());
                json!({
                    "choices": [{"message": {"content": format!("[error: {error}]")}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 0}
                })
            }
            Err(_) => {
                let error = format!("eval case timed out after {timeout_ms}ms");
                output_error = Some(error.clone());
                json!({
                    "choices": [{"message": {"content": format!("[error: {error}]")}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 0}
                })
            }
        }
    };
    let is_precomputed = case.provider_output.is_some();
    let latency_available = !is_precomputed
        || case.provider_latency_ms.is_some()
        || options.provided_latency_ms.is_some();
    let policy_available = !is_precomputed || case.provider_output_policy_pass.is_some();
    let latency_ms = case
        .provider_latency_ms
        .or(options.provided_latency_ms)
        .unwrap_or_else(|| start.elapsed().as_millis() as u64);

    if use_cache && !cache_hit && output_error.is_none() {
        response_cache
            .lock()
            .await
            .insert(cache_key, response.clone());
    }
    if let Err(error) =
        apply_builtin_output_transform(&mut response, case.options.transform.as_deref())
    {
        output_error = Some(error);
    }
    if let Some(cost_micro_usd) = options.provided_cost_micro_usd {
        response["usage"]["cost_micro_usd"] = Value::from(cost_micro_usd);
    }
    if let Some(cost_micro_usd) = response_cost_micro_usd(&response) {
        response["usage"]["cost_micro_usd"] = Value::from(cost_micro_usd);
    } else if let Some(cost_micro_usd) = case.provider_cost_micro_usd {
        response["usage"]["cost_micro_usd"] = Value::from(cost_micro_usd);
    }
    let policy_pass = case
        .provider_output_policy_pass
        .unwrap_or_else(|| !is_precomputed && output_error.is_none());
    let mut score = score_case(&case, &response, latency_ms, policy_pass, max_latency_ms);
    set_measurement_availability(&mut score, latency_available, policy_available);
    score.prompt_id = options.prompt_id;
    score.model = Some(model_used);
    score.provider = provider_used;
    score.rendered_prompt = Some(rendered_prompt);
    score.cache_hit = cache_hit;
    score.error = output_error;

    let assertion_metrics = AssertionMetrics {
        latency_ms: latency_available.then_some(latency_ms),
        cost_micro_usd: score.cost_micro_usd,
    };
    let mut assertion_results = Vec::new();
    let mut assertion_weights = Vec::new();
    if let Some(expected) = &case.expected {
        let assertion = Assertion::Contains {
            value: expected.clone(),
            options: AssertionOptions::default(),
        };
        assertion_results.push(eval_assertion_deterministic_with_metrics(
            &assertion,
            &score.response_text,
            assertion_metrics,
        ));
        assertion_weights.push(1.0);
    }
    for assertion in &case.assertions {
        let result = match assertion {
            Assertion::ContextFaithfulness { .. } if !has_reference_context(&case) => {
                skipped_assertion_result(
                    "context_faithfulness",
                    "context faithfulness requires a non-empty case context",
                )
            }
            Assertion::Factuality { .. }
                if case.expected.is_none() && !has_reference_context(&case) =>
            {
                skipped_assertion_result(
                    "factuality",
                    "factuality requires case.expected or a non-empty case context",
                )
            }
            Assertion::Similar { value, .. } if value.trim().is_empty() => {
                skipped_assertion_result(
                    "similar",
                    "similarity requires a non-empty reference value",
                )
            }
            Assertion::LlmJudge { rubric, .. }
            | Assertion::LlmRubric { rubric, .. }
            | Assertion::Factuality { rubric, .. }
            | Assertion::ContextFaithfulness { rubric, .. }
            | Assertion::AnswerRelevance { rubric, .. } => {
                let rubric_source = assertion_options(assertion)
                    .rubric_prompt
                    .as_deref()
                    .unwrap_or(rubric);
                let rubric = if matches!(
                    assertion,
                    Assertion::Factuality { .. } | Assertion::ContextFaithfulness { .. }
                ) {
                    let reference = case
                        .context
                        .as_ref()
                        .filter(|value| !value.is_null())
                        .map(|value| value.to_string())
                        .or_else(|| case.expected.clone())
                        .unwrap_or_default();
                    format!(
                        "Reference context:\n{}\n\n{}",
                        truncate_chars(&reference, 16_384),
                        rubric_source
                    )
                } else {
                    rubric_source.to_owned()
                };
                let assertion_model = assertion_options(assertion)
                    .provider
                    .as_deref()
                    .unwrap_or(&judge_model);
                run_llm_judge(
                    assertion_kind(assertion),
                    &render_template(&rubric, &case.vars),
                    &score.response_text,
                    assertion_model,
                    Arc::clone(&state),
                    ctx.clone(),
                )
                .await
            }
            Assertion::Similar { value, .. } => {
                let rubric = format!(
                    "Score semantic similarity between the output and this reference from 0 to 1: {value}"
                );
                run_llm_judge(
                    "similar",
                    &rubric,
                    &score.response_text,
                    assertion_options(assertion)
                        .provider
                        .as_deref()
                        .unwrap_or(&judge_model),
                    Arc::clone(&state),
                    ctx.clone(),
                )
                .await
            }
            _ => {
                let rendered = render_assertion_vars(assertion, &case.vars);
                eval_assertion_deterministic_with_metrics(
                    &rendered,
                    &score.response_text,
                    assertion_metrics,
                )
            }
        };
        let result = if matches!(
            assertion,
            Assertion::LlmJudge { .. }
                | Assertion::LlmRubric { .. }
                | Assertion::Similar { .. }
                | Assertion::Factuality { .. }
                | Assertion::ContextFaithfulness { .. }
                | Assertion::AnswerRelevance { .. }
        ) {
            apply_eval_assertion_options(result, assertion_options(assertion))
        } else {
            result
        };
        assertion_results.push(result);
        assertion_weights.push(assertion_options(assertion).weight.unwrap_or(1.0).max(0.0));
    }
    let assertion_score = if assertion_results.is_empty() {
        1.0
    } else {
        let total_weight = assertion_weights.iter().sum::<f32>();
        if total_weight <= f32::EPSILON {
            0.0
        } else {
            assertion_results
                .iter()
                .zip(assertion_weights.iter())
                .map(|(result, weight)| result.score * weight)
                .sum::<f32>()
                / total_weight
        }
    };
    score.assertion_score = assertion_score;
    score.assertions_pass = assertion_results.iter().all(|result| result.executed)
        && assertion_score >= case.threshold.unwrap_or(1.0).clamp(0.0, 1.0);
    score.assertions = assertion_results;
    // A provider error or timeout leaves only an `[error: ...]` placeholder as
    // the response. Scoring that text would let regex/builtin evaluators rate
    // it clean, so every evaluator reports `executed: false` instead.
    score.evaluators = if score.error.is_some() {
        errored_case_evaluators(&case, &registry, &judge_ctx)
    } else {
        score_evaluators(&case, &score.response_text, &registry, &judge_ctx).await
    };
    (index, score)
}

#[cfg(test)]
mod tests {
    use super::super::run_evals_tests::{eval_headers, eval_state};
    use super::*;

    /// A model-graded check that cannot run (factuality with no reference) is
    /// reported unexecuted and fails the case: it never passes by default.
    #[tokio::test]
    async fn an_unrunnable_model_graded_check_fails_the_case() {
        let request: RunEvalsRequest = serde_json::from_value(json!({
            "model": "m1",
            "dataset": [{
                "prompt": "p",
                "provider_output": "pong",
                "assertions": [
                    { "kind": "contains", "value": "pong" },
                    { "kind": "factuality", "rubric": "is it true?" }
                ]
            }]
        }))
        .expect("parses");
        let response = run_evals(State(eval_state()), eval_headers(), Json(request)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("drain");
        let body: Value = serde_json::from_slice(&bytes).expect("json");
        let case = &body["cases"][0];
        assert_eq!(case["assertions"][0]["pass"], true);
        assert_eq!(case["assertions"][1]["executed"], false, "{case}");
        assert_eq!(case["assertions_pass"], false);
    }
}
