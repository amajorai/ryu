//! Pure, network-free per-case scoring and the built-in dataset.

use serde_json::Value;

use crate::case::{CaseScore, EvalCase};

/// Score a single case from raw provider output.
///
/// This is the pure, network-free scoring function. It is called both by the
/// production runner (after `pipeline::run`) and by unit tests with canned
/// provider responses — so tests don't need a live provider to verify scoring
/// logic satisfies the v1 acceptance criteria.
///
/// `max_latency_ms` should come from `EvalsConfig::max_latency_ms`. When 0,
/// latency scoring defaults to 1.0 (unconfigured gateway scores full marks).
pub fn score_case(
    case: &EvalCase,
    response: &Value,
    latency_ms: u64,
    policy_pass: bool,
    max_latency_ms: u64,
) -> CaseScore {
    let max = max_latency_ms as f32;
    let latency_score = if max == 0.0 {
        1.0
    } else {
        (1.0 - (latency_ms as f32 / max)).clamp(0.0, 1.0)
    };

    let input_tokens = response["usage"]["prompt_tokens"]
        .as_u64()
        .unwrap_or(1)
        .max(1) as f32;
    let output_tokens = response["usage"]["completion_tokens"].as_u64().unwrap_or(0) as f32;
    let token_efficiency = (output_tokens / input_tokens / 2.0).clamp(0.0, 1.0);

    let policy_score = if policy_pass { 1.0_f32 } else { 0.0 };

    // Extract response text for substring matching.
    let response_text = response["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let substring_match = case.expected.as_ref().map(|expected| {
        if response_text
            .to_lowercase()
            .contains(&expected.to_lowercase())
        {
            1.0_f32
        } else {
            0.0
        }
    });

    let overall = match substring_match {
        Some(sm) => 0.3 * latency_score + 0.2 * token_efficiency + 0.2 * policy_score + 0.3 * sm,
        None => 0.4 * latency_score + 0.3 * token_efficiency + 0.3 * policy_score,
    };

    CaseScore {
        id: case.id.clone(),
        description: case.description.clone(),
        prompt_id: None,
        model: None,
        provider: None,
        rendered_prompt: None,
        vars: Some(case.vars.clone()),
        metadata: case.metadata.clone(),
        context: case.context.clone(),
        input_tokens: response["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
        output_tokens: response["usage"]["completion_tokens"].as_u64().unwrap_or(0),
        total_tokens: response["usage"]["total_tokens"]
            .as_u64()
            .unwrap_or_else(|| {
                response["usage"]["prompt_tokens"].as_u64().unwrap_or(0)
                    + response["usage"]["completion_tokens"].as_u64().unwrap_or(0)
            }),
        cost_micro_usd: response["usage"]["cost_micro_usd"].as_u64(),
        latency_ms,
        latency_available: true,
        cache_hit: false,
        error: None,
        prompt: case.prompt.clone(),
        response_text,
        latency_score,
        token_efficiency,
        policy_pass,
        policy_available: true,
        substring_match,
        overall,
        // NEW — neutral defaults; Implementer B overwrites these via the pub
        // fields after calling score_case (assertions are evaluated in evals.rs,
        // where the pipeline state/ctx for llm_judge is in scope).
        assertions: Vec::new(),
        assertion_score: 1.0,
        assertions_pass: true,
        // NEW (P2) — evaluator scores are attached by the api runner after
        // score_evaluators runs (it needs pipeline state for llm_judge).
        evaluators: Vec::new(),
    }
}

/// Mark operational dimensions that were not measured and renormalize the
/// case score over the remaining dimensions. Batch result scoring uses this for
/// Gateway policy, which the provider's separate asynchronous request did not
/// execute.
pub fn set_measurement_availability(
    score: &mut CaseScore,
    latency_available: bool,
    policy_available: bool,
) {
    score.latency_available = latency_available;
    score.policy_available = policy_available;
    if !policy_available {
        score.policy_pass = false;
    }

    let (latency_weight, token_weight, policy_weight, substring_weight) =
        if score.substring_match.is_some() {
            (0.3, 0.2, 0.2, 0.3)
        } else {
            (0.4, 0.3, 0.3, 0.0)
        };
    let mut weighted_score = 0.0;
    let mut available_weight = 0.0;
    if latency_available {
        weighted_score += latency_weight * score.latency_score;
        available_weight += latency_weight;
    }
    weighted_score += token_weight * score.token_efficiency;
    available_weight += token_weight;
    if policy_available {
        weighted_score += policy_weight * if score.policy_pass { 1.0 } else { 0.0 };
        available_weight += policy_weight;
    }
    if let Some(substring_match) = score.substring_match {
        weighted_score += substring_weight * substring_match;
        available_weight += substring_weight;
    }
    score.overall = if available_weight > 0.0 {
        weighted_score / available_weight
    } else {
        0.0
    };
}

/// Built-in 3-case dataset used when the caller sends an empty `dataset` array.
/// This seeds the desktop "Run evals" panel with something meaningful out of the box.
/// Users can override it by sending their own `dataset` in the request body.
pub fn builtin_dataset() -> Vec<EvalCase> {
    vec![
        EvalCase {
            prompt: "Say hello in one word.".to_string(),
            expected: Some("hello".to_string()),
            threshold: None,
            messages: Vec::new(),
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
            ..Default::default()
        },
        EvalCase {
            prompt: "What is 2 + 2? Answer with just the number.".to_string(),
            expected: Some("4".to_string()),
            threshold: None,
            messages: Vec::new(),
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
            ..Default::default()
        },
        EvalCase {
            prompt: "Name one primary color.".to_string(),
            expected: None,
            threshold: None,
            messages: Vec::new(),
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
            ..Default::default()
        },
    ]
}

#[cfg(test)]
#[path = "score_tests.rs"]
mod tests;
