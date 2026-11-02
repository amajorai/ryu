//! Reading a judge response: only a complete reply with one anchored verdict
//! is executed; everything else is `executed: false` and failing.

use serde_json::{json, Value};

use super::*;

fn response(message: Value, finish_reason: &str) -> Value {
    json!({ "choices": [{ "index": 0, "message": message, "finish_reason": finish_reason }] })
}

#[test]
fn a_complete_verdict_is_executed() {
    let outcome = judge_outcome(
        "llm_judge",
        &response(json!({ "content": "VERDICT: PASS SCORE: 0.9" }), "stop"),
    );
    assert!(outcome.result.executed && outcome.result.pass);
    assert!((outcome.result.score - 0.9).abs() < 1e-6);
    assert!(outcome.explicit_score);
    assert_eq!(outcome.result.kind, "llm_judge");

    let bare = judge_outcome(
        "llm_judge",
        &response(json!({ "content": "VERDICT: FAIL" }), "stop"),
    );
    assert!(bare.result.executed && !bare.result.pass);
    assert!(!bare.explicit_score);
}

/// The GuardBreaker shapes: a refusal field, refusal prose, a filtered or
/// truncated stop, blank content, a polite decline, and a reply that states
/// both verdicts. None is a verdict, so none can pass.
#[test]
fn refusals_filters_cutoffs_and_prose_are_not_executed() {
    let cases = [
        (
            json!({ "content": "", "refusal": "I can't help with that." }),
            "stop",
            "refused",
        ),
        (
            json!({ "content": "VERDICT: PASS SCORE: 1", "refusal": "No." }),
            "stop",
            "refused",
        ),
        (
            json!({ "content": "I can't help with that." }),
            "stop",
            "no single VERDICT",
        ),
        (
            json!({ "content": "I'll pass on this." }),
            "stop",
            "no single VERDICT",
        ),
        (
            json!({ "content": "VERDICT: PASS SCORE: 1" }),
            "content_filter",
            "content_filter",
        ),
        (
            json!({ "content": "VERDICT: PASS SCORE: 1" }),
            "length",
            "length",
        ),
        (
            json!({ "content": "VERDICT: PASS SCORE: 1" }),
            "refusal",
            "refusal",
        ),
        (json!({ "content": "  " }), "stop", "no content"),
        (
            json!({ "content": "VERDICT: PASS SCORE: 0.9 VERDICT: FAIL SCORE: 0.1" }),
            "stop",
            "no single VERDICT",
        ),
    ];
    for (message, finish, why) in cases {
        let outcome = judge_outcome("toxicity", &response(message.clone(), finish));
        assert!(!outcome.result.executed, "{message} / {finish}");
        assert!(!outcome.result.pass, "{message} / {finish}");
        assert_eq!(outcome.result.score, 0.0);
        assert!(
            outcome.result.detail.contains(why),
            "{}",
            outcome.result.detail
        );
    }
}

#[test]
fn assertion_helpers_name_kinds_and_skip_honestly() {
    let judge = Assertion::Factuality {
        rubric: "r".to_owned(),
        options: AssertionOptions::default(),
    };
    assert_eq!(assertion_kind(&judge), "factuality");
    let skipped = skipped_assertion_result("similar", "no reference");
    assert!(!skipped.executed && !skipped.pass);
    let mut case = EvalCase::default();
    assert!(!has_reference_context(&case));
    case.context = Some(json!("  "));
    assert!(!has_reference_context(&case));
    case.context = Some(json!({ "doc": "x" }));
    assert!(has_reference_context(&case));
}
