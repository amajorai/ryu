use serde_json::{json, Value};

use crate::*;

fn make_response(prompt_tokens: u64, completion_tokens: u64, content: &str) -> Value {
    json!({
        "choices": [{"message": {"content": content}}],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens
        }
    })
}

#[test]
fn aggregate_three_cases_produces_valid_summary() {
    let cases = vec![
        EvalCase {
            prompt: "Say hello".to_string(),
            expected: Some("hello".to_string()),
            threshold: None,
            messages: Vec::new(),
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
            ..Default::default()
        },
        EvalCase {
            prompt: "What is 2+2?".to_string(),
            expected: Some("4".to_string()),
            threshold: None,
            messages: Vec::new(),
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
            ..Default::default()
        },
        EvalCase {
            prompt: "Name a color.".to_string(),
            expected: None,
            threshold: None,
            messages: Vec::new(),
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
            ..Default::default()
        },
    ];
    let responses = vec![
        make_response(5, 3, "Hello!"),
        make_response(8, 2, "4"),
        make_response(6, 4, "red"),
    ];
    let scored: Vec<CaseScore> = cases
        .iter()
        .zip(responses.iter())
        .map(|(c, r)| score_case(c, r, 300, true, 10_000))
        .collect();

    let agg = aggregate_scores(&scored);
    assert_eq!(agg.total_cases, 3);
    assert!(agg.mean_overall >= 0.0 && agg.mean_overall <= 1.0);
    assert!(agg.mean_latency >= 0.0 && agg.mean_latency <= 1.0);
    assert!(agg.mean_token_efficiency >= 0.0 && agg.mean_token_efficiency <= 1.0);
    assert!((agg.policy_pass_rate - 1.0).abs() < 1e-3);
    // Two cases had `expected`, so mean_substring_match should be Some.
    assert!(agg.mean_substring_match.is_some());
}

#[test]
fn aggregate_no_expected_cases_returns_none_substring() {
    let cases = vec![EvalCase {
        prompt: "ping".to_string(),
        expected: None,
        threshold: None,
        messages: Vec::new(),
        vars: std::collections::HashMap::new(),
        assertions: Vec::new(),
        evaluators: Vec::new(),
        ..Default::default()
    }];
    let responses = vec![make_response(5, 3, "pong")];
    let scored: Vec<CaseScore> = cases
        .iter()
        .zip(responses.iter())
        .map(|(c, r)| score_case(c, r, 100, true, 10_000))
        .collect();
    let agg = aggregate_scores(&scored);
    assert!(agg.mean_substring_match.is_none());
}

#[test]
fn aggregate_empty_slice_returns_zero_totals() {
    let agg = aggregate_scores(&[]);
    assert_eq!(agg.total_cases, 0);
    assert!((agg.mean_overall).abs() < 1e-6);
}
