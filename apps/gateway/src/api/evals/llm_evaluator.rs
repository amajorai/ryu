//! LLM-judge registry evaluators, scored on threshold and polarity.

use super::*;

/// LLM-judge evaluators. Runs the rubric through the same provider path as the
/// eval assertions (`run_llm_judge`), resolving the judge model by precedence:
/// evaluator's own `offline.judge_model` → run-level `judge_model` → primary
/// model. `pass = score >= threshold`. Image/Audio targets need media a text
/// dataset can't provide, so they are honestly skipped (`executed: false`).
pub(super) async fn score_llm_judge_evaluator(
    id: &str,
    category: &str,
    ev: &crate::evaluators::Evaluator,
    rubric: &str,
    case: &EvalCase,
    response_text: &str,
    threshold: f32,
    judge_ctx: &JudgeCtx,
) -> EvaluatorScore {
    if matches!(ev.target, EvaluatorTarget::Image | EvaluatorTarget::Audio) {
        return EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: "requires image/audio input not present in a text eval dataset".to_string(),
            executed: false,
        };
    }
    if matches!(ev.target, EvaluatorTarget::Trajectory)
        || (matches!(ev.target, EvaluatorTarget::Conversation) && case.messages.is_empty())
    {
        return EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: format!(
                "requires {} context not present in this text dataset",
                ev.target.as_str()
            ),
            executed: false,
        };
    }

    if judge_ctx.judge_gate.as_ref().is_some_and(|admit| !admit()) {
        return EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: "judge budget exhausted for this tenant; not scored".to_string(),
            executed: false,
        };
    }
    let judge_model = resolve_judge_model(
        ev.offline.as_ref().and_then(|o| o.judge_model.as_deref()),
        judge_ctx.request_judge_model.as_deref(),
        &judge_ctx.fallback_model,
    );
    let rendered_rubric = render_template(rubric, &case.vars);

    let outcome = judge_call(
        id,
        &rendered_rubric,
        response_text,
        &judge_model,
        Arc::clone(&judge_ctx.state),
        judge_ctx.ctx.clone(),
    )
    .await;
    evaluator_score_from_judge(
        id,
        category,
        ev.target,
        ev.higher_is_better,
        threshold,
        outcome,
    )
}

/// Turn one judge outcome into an evaluator score. The judge's own PASS/FAIL
/// is ignored: an evaluator passes on the threshold + polarity, not the
/// judge's binary verdict. For a negative-signal evaluator (toxicity, bias,
/// hallucination) a high judge score is BAD, so `higher_is_better = false`
/// inverts the threshold comparison, and a reply without its own `SCORE:` is
/// not scored at all: the 0.0 a bare (or derailed) FAIL derives would read as
/// clean. A judge that did not answer is `executed: false`, never a pass.
pub(super) fn evaluator_score_from_judge(
    id: &str,
    category: &str,
    target: EvaluatorTarget,
    higher_is_better: bool,
    threshold: f32,
    outcome: JudgeOutcome,
) -> EvaluatorScore {
    let JudgeOutcome {
        result,
        explicit_score,
    } = outcome;
    let unscored = |detail: String| EvaluatorScore {
        id: id.to_string(),
        category: category.to_string(),
        score: 0.0,
        pass: false,
        detail,
        executed: false,
    };
    if !result.executed {
        return unscored(result.detail);
    }
    if !higher_is_better && !explicit_score {
        return unscored(format!(
            "judge stated no SCORE, so this lower-is-better evaluator is not scored: {}",
            result.detail
        ));
    }
    let score = result.score;
    let pass = judge_pass(score, threshold, higher_is_better);
    let mut detail = result.detail;
    if matches!(
        target,
        EvaluatorTarget::Conversation | EvaluatorTarget::Trajectory
    ) {
        detail = format!(
            "[scored on prompt+response only; full {} not available] {detail}",
            target.as_str()
        );
    }

    EvaluatorScore {
        id: id.to_string(),
        category: category.to_string(),
        score,
        pass,
        detail,
        executed: true,
    }
}

#[cfg(test)]
#[path = "llm_evaluator_tests.rs"]
mod tests;
