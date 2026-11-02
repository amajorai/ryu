//! Request limits and validation, applied before any provider or judge call.

use super::*;

pub(super) const MAX_EVAL_CASES: usize = 1_000;
pub(super) const MAX_EVAL_REPEAT: usize = 20;
pub(super) const MAX_EVAL_MODELS: usize = 32;
pub(super) const MAX_EVAL_ASSERTIONS_PER_CASE: usize = 32;
pub(super) const MAX_EVAL_ASSERTION_DEPTH: usize = 8;
pub(super) const MAX_EVAL_ASSERTION_NODES: usize = 128;
pub(super) const MAX_EVAL_EVALUATORS_PER_CASE: usize = 32;
pub(super) const MAX_EVAL_MESSAGES_PER_CASE: usize = 32;
pub(super) const MAX_EVAL_MAP_ENTRIES: usize = 128;
pub(super) const MAX_EVAL_TEXT_CHARS: usize = 64 * 1024;
pub(super) const MAX_EVAL_CASE_BYTES: usize = 256 * 1024;
pub(super) const MAX_ONLINE_RESPONSE_BYTES: usize = 256 * 1024;
pub const MAX_EVAL_REQUEST_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_ONLINE_SCORE_REQUEST_BYTES: usize = 512 * 1024;
pub(super) const MAX_EVAL_PROVIDER_CALLS: usize = 2_000;
pub(super) const DEFAULT_EVAL_TIMEOUT_MS: u64 = 120_000;

pub(super) fn is_model_graded_assertion(assertion: &Assertion) -> bool {
    matches!(
        assertion,
        Assertion::LlmJudge { .. }
            | Assertion::LlmRubric { .. }
            | Assertion::Similar { .. }
            | Assertion::Factuality { .. }
            | Assertion::ContextFaithfulness { .. }
            | Assertion::AnswerRelevance { .. }
    )
}

/// Bound recursive assertion sets before scoring. A top-level count alone is
/// insufficient: nested `AssertSet`s can otherwise multiply deterministic work
/// exponentially and recurse until the process stack is exhausted.
pub(super) fn validate_assertion_tree(
    assertions: &[Assertion],
    depth: usize,
    nodes: &mut usize,
) -> Result<(), String> {
    if depth > MAX_EVAL_ASSERTION_DEPTH {
        return Err(format!(
            "assertion nesting is limited to {MAX_EVAL_ASSERTION_DEPTH} levels"
        ));
    }
    if assertions.len() > MAX_EVAL_ASSERTIONS_PER_CASE {
        return Err(format!(
            "each assertion set may contain at most {MAX_EVAL_ASSERTIONS_PER_CASE} assertions"
        ));
    }
    for assertion in assertions {
        *nodes = nodes.saturating_add(1);
        if *nodes > MAX_EVAL_ASSERTION_NODES {
            return Err(format!(
                "each case may contain at most {MAX_EVAL_ASSERTION_NODES} assertion nodes"
            ));
        }
        if let Assertion::AssertSet { assertions, .. } = assertion {
            validate_assertion_tree(assertions, depth + 1, nodes)?;
        }
        if depth > 0 && is_model_graded_assertion(assertion) {
            return Err(
                "model-graded assertions cannot be nested inside assert_set; move them to the case's top-level assertions"
                    .to_owned(),
            );
        }
    }
    Ok(())
}

pub(super) fn validate_eval_request(
    req: &RunEvalsRequest,
    registry: &EvaluatorRegistry,
) -> Result<(), String> {
    if req.dataset.len() > MAX_EVAL_CASES {
        return Err(format!("eval dataset is limited to {MAX_EVAL_CASES} cases"));
    }
    let repeat = req.repeat.unwrap_or(1).clamp(1, MAX_EVAL_REPEAT);
    if req.dataset.len().max(1).saturating_mul(repeat) > MAX_EVAL_CASES {
        return Err(format!(
            "expanded eval dataset is limited to {MAX_EVAL_CASES} cases"
        ));
    }
    if req.models.len() > MAX_EVAL_MODELS {
        return Err(format!(
            "at most {MAX_EVAL_MODELS} models may be evaluated per request"
        ));
    }
    if req.evaluators.len() > MAX_EVAL_EVALUATORS_PER_CASE {
        return Err(format!(
            "at most {MAX_EVAL_EVALUATORS_PER_CASE} run-level evaluators are allowed"
        ));
    }
    if req.system_messages.len() > MAX_EVAL_MESSAGES_PER_CASE {
        return Err(format!(
            "at most {MAX_EVAL_MESSAGES_PER_CASE} system messages are allowed"
        ));
    }
    if req.tags.len() > MAX_EVAL_MAP_ENTRIES {
        return Err(format!(
            "at most {MAX_EVAL_MAP_ENTRIES} run tags are allowed"
        ));
    }
    for (label, value) in [
        ("model", req.model.as_str()),
        (
            "judge_model",
            req.judge_model.as_deref().unwrap_or_default(),
        ),
        (
            "system_prompt",
            req.system_prompt.as_deref().unwrap_or_default(),
        ),
        ("prefix", req.prefix.as_deref().unwrap_or_default()),
        ("suffix", req.suffix.as_deref().unwrap_or_default()),
    ] {
        let limit = if matches!(label, "model" | "judge_model") {
            256
        } else {
            MAX_EVAL_TEXT_CHARS
        };
        if value.chars().count() > limit {
            return Err(format!("{label} is limited to {limit} characters"));
        }
    }
    if req.models.is_empty() && req.model.trim().is_empty() {
        return Err("at least one model is required".to_owned());
    }
    if req
        .judge_model
        .as_deref()
        .is_some_and(|model| model.trim().is_empty())
    {
        return Err("judge_model must not be empty".to_owned());
    }
    if req
        .agent_id
        .as_deref()
        .is_some_and(|agent| agent.chars().count() > 256)
    {
        return Err("agent_id is limited to 256 characters".to_owned());
    }
    if req
        .prompt_id
        .as_deref()
        .is_some_and(|prompt_id| prompt_id.chars().count() > 256)
    {
        return Err("prompt_id is limited to 256 characters".to_owned());
    }
    if req.tags.iter().any(|(key, value)| {
        key.chars().count() > 256 || value.chars().count() > MAX_EVAL_TEXT_CHARS
    }) {
        return Err("eval tag keys are limited to 256 and values to 65536 characters".to_owned());
    }
    for message in &req.system_messages {
        if message.role.chars().count() > 64
            || message.content.chars().count() > MAX_EVAL_TEXT_CHARS
        {
            return Err(format!(
                "system message fields are limited to {MAX_EVAL_TEXT_CHARS} characters"
            ));
        }
    }
    for (index, model) in req.models.iter().enumerate() {
        if model.chars().count() > 256 {
            return Err(format!("models[{index}] is limited to 256 characters"));
        }
    }
    for (index, evaluator) in req.evaluators.iter().enumerate() {
        if evaluator.chars().count() > 256 {
            return Err(format!("evaluators[{index}] is limited to 256 characters"));
        }
    }
    for (index, case) in req.dataset.iter().enumerate() {
        if case
            .id
            .as_deref()
            .is_some_and(|id| id.chars().count() > 256)
            || case
                .provider_output_provider
                .as_deref()
                .is_some_and(|provider| provider.chars().count() > 256)
            || case
                .provider
                .as_deref()
                .is_some_and(|provider| provider.chars().count() > 256)
            || case
                .providers
                .iter()
                .any(|provider| provider.chars().count() > 256)
            || case
                .evaluators
                .iter()
                .any(|evaluator| evaluator.chars().count() > 256)
        {
            return Err(format!(
                "dataset case {index} ids are limited to 256 characters"
            ));
        }
        if case.provider_output.is_none()
            && (case.provider_output_provider.is_some()
                || case.provider_output_policy_pass.is_some()
                || case.provider_latency_ms.is_some()
                || case.provider_cost_micro_usd.is_some())
        {
            return Err(format!(
                "dataset case {index} provider output measurements require provider_output"
            ));
        }
        if case.prompt.chars().count() > MAX_EVAL_TEXT_CHARS
            || case
                .expected
                .as_deref()
                .is_some_and(|value| value.chars().count() > MAX_EVAL_TEXT_CHARS)
            || case
                .description
                .as_deref()
                .is_some_and(|value| value.chars().count() > MAX_EVAL_TEXT_CHARS)
        {
            return Err(format!(
                "dataset case {index} text is limited to {MAX_EVAL_TEXT_CHARS} characters"
            ));
        }
        if case.assertions.len() > MAX_EVAL_ASSERTIONS_PER_CASE {
            return Err(format!(
                "each case may contain at most {MAX_EVAL_ASSERTIONS_PER_CASE} assertions"
            ));
        }
        if case.evaluators.len() > MAX_EVAL_EVALUATORS_PER_CASE {
            return Err(format!(
                "each case may contain at most {MAX_EVAL_EVALUATORS_PER_CASE} evaluators"
            ));
        }
        if case.messages.len() > MAX_EVAL_MESSAGES_PER_CASE {
            return Err(format!(
                "each case may contain at most {MAX_EVAL_MESSAGES_PER_CASE} messages"
            ));
        }
        if case.vars.len() > MAX_EVAL_MAP_ENTRIES || case.metadata.len() > MAX_EVAL_MAP_ENTRIES {
            return Err(format!(
                "each case may contain at most {MAX_EVAL_MAP_ENTRIES} vars and metadata entries"
            ));
        }
        let case_bytes = serde_json::to_vec(case)
            .map_err(|error| format!("dataset case {index} could not be encoded: {error}"))?;
        if case_bytes.len() > MAX_EVAL_CASE_BYTES {
            return Err(format!(
                "dataset case {index} is limited to {MAX_EVAL_CASE_BYTES} bytes"
            ));
        }
        for message in &case.messages {
            if message.role.chars().count() > 64
                || message.content.chars().count() > MAX_EVAL_TEXT_CHARS
            {
                return Err(format!(
                    "dataset case {index} message fields are limited to {MAX_EVAL_TEXT_CHARS} characters"
                ));
            }
        }
        let mut assertion_nodes = 0;
        validate_assertion_tree(&case.assertions, 0, &mut assertion_nodes)?;
    }

    // Reject unsupported modes before scheduling inference or judge calls.
    registry.validate_offline_ids(&req.evaluators)?;
    for case in &req.dataset {
        registry.validate_offline_ids(&case.evaluators)?;
    }

    let model_count = if req.models.is_empty() {
        1
    } else {
        req.models
            .iter()
            .filter(|model| !model.trim().is_empty())
            .count()
    };
    if model_count == 0 {
        return Err("at least one non-empty model is required".to_owned());
    }
    let calls_per_dataset = req
        .dataset
        .iter()
        .map(|case| {
            let ids = union_evaluator_ids(&case.evaluators, &req.evaluators);
            let judge_evaluators = ids
                .iter()
                .filter(|id| {
                    registry.get(id).is_some_and(|evaluator| {
                        matches!(evaluator.impl_, EvaluatorImpl::LlmJudge { .. })
                    })
                })
                .count();
            1usize
                .saturating_add(
                    case.assertions
                        .iter()
                        .map(model_graded_assertion_count)
                        .sum::<usize>(),
                )
                .saturating_add(judge_evaluators)
        })
        .sum::<usize>()
        .max(1);
    let total_calls = calls_per_dataset
        .saturating_mul(repeat)
        .saturating_mul(model_count);
    if total_calls > MAX_EVAL_PROVIDER_CALLS {
        return Err(format!(
            "evaluation request may execute at most {MAX_EVAL_PROVIDER_CALLS} provider calls (requested upper bound: {total_calls})"
        ));
    }
    Ok(())
}

pub(super) fn model_graded_assertion_count(assertion: &Assertion) -> usize {
    match assertion {
        Assertion::AssertSet { assertions, .. } => {
            assertions.iter().map(model_graded_assertion_count).sum()
        }
        assertion if is_model_graded_assertion(assertion) => 1,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn judge() -> Assertion {
        Assertion::LlmJudge {
            rubric: "r".to_owned(),
            options: AssertionOptions::default(),
        }
    }

    /// Model-graded checks are counted through nested sets (each is a judge
    /// call), and nesting deeper than the limit is refused before any call.
    #[test]
    fn nested_judges_are_counted_and_deep_trees_are_refused() {
        let set = Assertion::AssertSet {
            assertions: vec![judge(), judge()],
            options: AssertionOptions::default(),
        };
        assert!(is_model_graded_assertion(&judge()));
        assert!(!is_model_graded_assertion(&set));
        assert_eq!(model_graded_assertion_count(&set), 2);

        let mut deep = judge();
        for _ in 0..=MAX_EVAL_ASSERTION_DEPTH {
            deep = Assertion::AssertSet {
                assertions: vec![deep],
                options: AssertionOptions::default(),
            };
        }
        let mut nodes = 0;
        let error = validate_assertion_tree(&[deep], 0, &mut nodes).expect_err("too deep");
        assert!(error.contains("nesting"), "{error}");
    }

    #[test]
    fn an_oversized_dataset_is_refused() {
        let request: RunEvalsRequest = serde_json::from_value(json!({
            "model": "m1",
            "dataset": vec![json!({ "prompt": "p" }); MAX_EVAL_CASES + 1],
        }))
        .expect("parses");
        let error = validate_eval_request(&request, &EvaluatorRegistry::new()).expect_err("big");
        assert!(error.contains("cases"), "{error}");
    }
}
