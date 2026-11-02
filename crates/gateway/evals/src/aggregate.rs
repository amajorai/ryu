//! Run-level aggregation of per-case and per-evaluator scores.

use crate::case::{CaseScore, EvalRunAggregate, EvaluatorAggregate};

/// Aggregate a slice of per-case scores into a summary.
pub fn aggregate_scores(cases: &[CaseScore]) -> EvalRunAggregate {
    let n = cases.len();
    if n == 0 {
        return EvalRunAggregate {
            mean_overall: 0.0,
            mean_latency: 0.0,
            latency_available_cases: 0,
            mean_token_efficiency: 0.0,
            policy_pass_rate: 0.0,
            policy_available_cases: 0,
            mean_substring_match: None,
            total_cases: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cost_micro_usd: Some(0),
            assertion_pass_rate: 0.0,
            evaluators: std::collections::HashMap::new(),
        };
    }

    let nf = n as f32;
    let mean_overall = cases.iter().map(|c| c.overall).sum::<f32>() / nf;
    let latency_scores: Vec<f32> = cases
        .iter()
        .filter(|case| case.latency_available)
        .map(|case| case.latency_score)
        .collect();
    let latency_available_cases = latency_scores.len();
    let mean_latency = if latency_available_cases == 0 {
        0.0
    } else {
        latency_scores.iter().sum::<f32>() / latency_available_cases as f32
    };
    let mean_token_efficiency = cases.iter().map(|c| c.token_efficiency).sum::<f32>() / nf;
    let policy_cases: Vec<&CaseScore> = cases.iter().filter(|case| case.policy_available).collect();
    let policy_available_cases = policy_cases.len();
    let policy_pass_rate = if policy_available_cases == 0 {
        0.0
    } else {
        policy_cases.iter().filter(|case| case.policy_pass).count() as f32
            / policy_available_cases as f32
    };

    let substring_cases: Vec<f32> = cases.iter().filter_map(|c| c.substring_match).collect();
    let mean_substring_match = if substring_cases.is_empty() {
        None
    } else {
        Some(substring_cases.iter().sum::<f32>() / substring_cases.len() as f32)
    };

    let total_input_tokens = cases.iter().map(|case| case.input_tokens).sum();
    let total_output_tokens = cases.iter().map(|case| case.output_tokens).sum();
    let priced_cases: Vec<u64> = cases
        .iter()
        .filter_map(|case| case.cost_micro_usd)
        .collect();
    let total_cost_micro_usd =
        (priced_cases.len() == cases.len()).then(|| priced_cases.iter().sum());
    let assertion_pass_rate = cases.iter().filter(|case| case.assertions_pass).count() as f32 / nf;

    let evaluators = aggregate_evaluators(cases);

    EvalRunAggregate {
        mean_overall,
        mean_latency,
        latency_available_cases,
        mean_token_efficiency,
        policy_pass_rate,
        policy_available_cases,
        mean_substring_match,
        total_cases: n,
        total_input_tokens,
        total_output_tokens,
        total_cost_micro_usd,
        assertion_pass_rate,
        evaluators,
    }
}

/// Roll per-case [`EvaluatorScore`]s up into one [`EvaluatorAggregate`] per
/// evaluator id. Means and pass rates are computed over cases where the
/// evaluator actually executed (`executed == true`); an evaluator that was
/// requested but never executed still appears with a zeroed aggregate + a
/// truthful `executed_count` of 0, so the UI can show it was skipped rather than
/// hiding it.
fn aggregate_evaluators(
    cases: &[CaseScore],
) -> std::collections::HashMap<String, EvaluatorAggregate> {
    // id -> (sum_score_executed, pass_executed, executed_count, seen)
    let mut acc: std::collections::HashMap<String, (f32, usize, usize, bool)> =
        std::collections::HashMap::new();

    for case in cases {
        for es in &case.evaluators {
            let entry = acc.entry(es.id.clone()).or_insert((0.0, 0, 0, false));
            entry.3 = true;
            if es.executed {
                entry.0 += es.score;
                if es.pass {
                    entry.1 += 1;
                }
                entry.2 += 1;
            }
        }
    }

    acc.into_iter()
        .map(|(id, (sum_score, pass_count, executed_count, _seen))| {
            let (mean_score, pass_rate) = if executed_count > 0 {
                (
                    sum_score / executed_count as f32,
                    pass_count as f32 / executed_count as f32,
                )
            } else {
                (0.0, 0.0)
            };
            (
                id,
                EvaluatorAggregate {
                    mean_score,
                    pass_rate,
                    executed_count,
                },
            )
        })
        .collect()
}

#[cfg(test)]
#[path = "aggregate_tests.rs"]
mod tests;
