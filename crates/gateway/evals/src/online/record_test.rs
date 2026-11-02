use super::*;

fn job() -> OnlineEvalJob {
    OnlineEvalJob {
        request_id: "r1".to_owned(),
        trace_id: None,
        tenant: "local".to_owned(),
        agent_id: None,
        model: "m".to_owned(),
        provider: "p".to_owned(),
        prompt: "hi".to_owned(),
        response: "hello".to_owned(),
        evaluators: vec!["pii_leakage".to_owned(), "toxicity".to_owned()],
        judge_model: None,
        max_judge_calls_per_minute: 1,
        enqueued_at_ms: 1,
        context: (),
    }
}

fn score(id: &str, pass: bool, executed: bool) -> EvaluatorScore {
    EvaluatorScore {
        id: id.to_owned(),
        category: "security".to_owned(),
        score: if pass { 1.0 } else { 0.0 },
        pass,
        detail: String::new(),
        executed,
    }
}

fn record(scores: Vec<EvaluatorScore>) -> OnlineEvalRecord {
    OnlineEvalRecord::from_job(&job(), scores, 2)
}

#[test]
fn a_record_passes_when_every_evaluator_ran_and_passed() {
    let passed = record(vec![
        score("pii_leakage", true, true),
        score("toxicity", true, true),
    ]);
    assert!(passed.pass);
    assert!(!OnlineEvalQuery {
        failed_only: true,
        ..OnlineEvalQuery::default()
    }
    .matches(&passed));
    assert!(!record(vec![score("pii_leakage", false, true)]).pass);
}

/// A judge that refused (or was filtered, cut off, or out of budget) leaves
/// its evaluator unexecuted. The record used to count only executed scores,
/// so a toxic response whose judge refused, beside a passing regex
/// evaluator, was recorded as a pass and hidden from `failed_only`.
#[test]
fn an_unexecuted_evaluator_never_leaves_a_passing_record() {
    let refused = record(vec![
        score("pii_leakage", true, true),
        score("toxicity", false, false),
    ]);
    assert!(!refused.pass);
    assert!(OnlineEvalQuery {
        failed_only: true,
        ..OnlineEvalQuery::default()
    }
    .matches(&refused));
    assert!(!record(vec![score("toxicity", false, false)]).pass);
    assert!(!record(Vec::new()).pass, "nothing scored is not a pass");
}
