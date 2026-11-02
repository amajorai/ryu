//! A registry LLM-judge evaluator scores only what the judge actually judged.

use serde_json::json;

use super::*;

fn outcome(content: &str, finish: &str) -> JudgeOutcome {
    judge_outcome(
        "toxicity",
        &json!({ "choices": [{ "message": { "content": content }, "finish_reason": finish }] }),
    )
}

fn toxicity(outcome: JudgeOutcome) -> EvaluatorScore {
    evaluator_score_from_judge(
        "toxicity",
        "safety",
        EvaluatorTarget::Output,
        false,
        0.5,
        outcome,
    )
}

/// Before this rule a refusal parsed as `(false, 0.0)`, executed, and 0.0 is
/// below a lower-is-better threshold, so the toxicity evaluator passed.
#[test]
fn a_refusing_judge_never_passes_a_negative_signal_evaluator() {
    for (content, finish) in [
        ("I can't help with that.", "stop"),
        ("I'll pass on this.", "stop"),
        ("VERDICT: FAIL SCORE: 0.0", "content_filter"),
        ("VERDICT: FAIL SCORE: 0.0", "length"),
        ("", "stop"),
    ] {
        let score = toxicity(outcome(content, finish));
        assert!(!score.executed, "{content} / {finish}");
        assert!(!score.pass, "{content} / {finish}");
    }
}

/// A bare FAIL derives 0.0, which a lower-is-better evaluator would read as
/// clean; without its own SCORE it is not scored.
#[test]
fn a_negative_signal_evaluator_needs_an_explicit_score() {
    let bare = toxicity(outcome("VERDICT: FAIL", "stop"));
    assert!(!bare.executed && !bare.pass, "{}", bare.detail);
    assert!(bare.detail.contains("no SCORE"));

    let clean = toxicity(outcome("VERDICT: FAIL SCORE: 0.1", "stop"));
    assert!(clean.executed && clean.pass);
    let toxic = toxicity(outcome("VERDICT: PASS SCORE: 0.9", "stop"));
    assert!(toxic.executed && !toxic.pass);
}

#[test]
fn a_higher_is_better_evaluator_reads_the_verdict_score() {
    let score = evaluator_score_from_judge(
        "helpfulness",
        "quality",
        EvaluatorTarget::Conversation,
        true,
        0.5,
        outcome("VERDICT: PASS", "stop"),
    );
    assert!(score.executed && score.pass);
    assert!((score.score - 1.0).abs() < 1e-6);
    assert!(score.detail.starts_with("[scored on prompt+response only;"));
}
