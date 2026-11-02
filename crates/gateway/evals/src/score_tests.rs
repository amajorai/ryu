use serde_json::{json, Value};

use crate::*;

// ── Dataset runner pure-scoring tests (AC3) ──────────────────────────────
// These verify scores are in [0,1] and the aggregate is correct using canned
// responses — no live provider needed.

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
fn score_case_without_expected_returns_score_in_range() {
    let case = EvalCase {
        prompt: "ping".to_string(),
        expected: None,
        threshold: None,
        messages: Vec::new(),
        vars: std::collections::HashMap::new(),
        assertions: Vec::new(),
        evaluators: Vec::new(),
        ..Default::default()
    };
    let resp = make_response(10, 5, "pong");
    let score = score_case(&case, &resp, 500, true, 10_000);
    assert!(score.overall >= 0.0 && score.overall <= 1.0);
    assert!(score.substring_match.is_none());
    assert!(score.policy_pass);
}

#[test]
fn score_case_with_matching_expected_gives_full_substring_score() {
    let case = EvalCase {
        prompt: "say hello".to_string(),
        expected: Some("hello".to_string()),
        threshold: None,
        messages: Vec::new(),
        vars: std::collections::HashMap::new(),
        assertions: Vec::new(),
        evaluators: Vec::new(),
        ..Default::default()
    };
    let resp = make_response(5, 3, "Hello there!");
    let score = score_case(&case, &resp, 200, true, 10_000);
    assert_eq!(score.substring_match, Some(1.0));
    assert!(score.overall >= 0.0 && score.overall <= 1.0);
}

#[test]
fn score_case_with_non_matching_expected_gives_zero_substring_score() {
    let case = EvalCase {
        prompt: "say hello".to_string(),
        expected: Some("hello".to_string()),
        threshold: None,
        messages: Vec::new(),
        vars: std::collections::HashMap::new(),
        assertions: Vec::new(),
        evaluators: Vec::new(),
        ..Default::default()
    };
    let resp = make_response(5, 3, "Goodbye!");
    let score = score_case(&case, &resp, 200, true, 10_000);
    assert_eq!(score.substring_match, Some(0.0));
}

#[test]
fn unmeasured_policy_is_not_counted_as_a_pass_or_failure() {
    let case = EvalCase {
        prompt: "say hello".to_owned(),
        expected: Some("hello".to_owned()),
        ..Default::default()
    };
    let response = make_response(10, 10, "Hello there!");
    let mut score = score_case(&case, &response, 42_000, true, 10_000);
    set_measurement_availability(&mut score, true, false);

    assert!(score.latency_available);
    assert!(!score.policy_available);
    assert!(!score.policy_pass);
    assert!((score.overall - 0.5).abs() < f32::EPSILON);

    let aggregate = aggregate_scores(&[score]);
    assert_eq!(aggregate.latency_available_cases, 1);
    assert_eq!(aggregate.policy_available_cases, 0);
    assert_eq!(aggregate.policy_pass_rate, 0.0);
}
