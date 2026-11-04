//! LLM-judge calls through the governed pipeline. A refusal, a filtered,
//! cut-off or blank reply, or a reply without one anchored verdict is
//! `executed: false`: never a pass, never a clean score.

use super::*;

/// A judge call's assertion result, plus whether the judge stated its own
/// `SCORE:` (a lower-is-better evaluator must not read a bare FAIL's derived
/// 0.0 as "clean").
#[derive(Debug, Clone)]
pub(super) struct JudgeOutcome {
    pub(super) result: AssertionResult,
    pub(super) explicit_score: bool,
}

/// Run a single LLM-judge assertion as a second `pipeline::run` (same provider/
/// router/firewall path — nothing hardcoded). Defensive: a judge error is a
/// FAIL, never a panic.
///
/// NOTE (timeout): multi-model × llm_judge fans out `models × cases ×
/// (1 + judge_calls)` SEQUENTIAL provider calls, all under Core's 120s reqwest
/// proxy timeout. Large matrices can time out at the Core proxy even though no
/// field is dropped here — the desktop warns when the matrix is large.
pub(super) async fn run_llm_judge(
    kind: &str,
    rubric: &str,
    output: &str,
    judge_model: &str,
    state: SharedState,
    ctx: pipeline::RequestContext,
) -> AssertionResult {
    judge_call(kind, rubric, output, judge_model, state, ctx)
        .await
        .result
}

/// [`run_llm_judge`] keeping whether the reply stated a score.
pub(super) async fn judge_call(
    kind: &str,
    rubric: &str,
    output: &str,
    judge_model: &str,
    state: SharedState,
    ctx: pipeline::RequestContext,
) -> JudgeOutcome {
    let judge_prompt = build_judge_prompt(rubric, output);
    let body = json!({
        "model": judge_model,
        "messages": [{"role": "user", "content": judge_prompt}]
    });

    // Box the judge's pipeline future. An LLM-judge evaluator runs it nested
    // under the case's own pipeline run; held inline, every enclosing async fn
    // (judge, evaluator, case, run) carries its ~56 KB state, and in a debug
    // build their poll frames overflowed a default 2 MiB Tokio worker stack.
    match Box::pin(pipeline::run(state, ctx, body)).await {
        Ok(out) => judge_outcome(kind, &out.response),
        Err(e) => unexecuted(kind, &format!("judge error: {e}")),
    }
}

/// Read one judge response. A refusal (`message.refusal`), a reply stopped by
/// `content_filter`, `length` or `refusal`, blank content, or a reply without
/// exactly one anchored `VERDICT: PASS|FAIL` is not executed: the judge never
/// judged, so the assertion cannot pass and an evaluator cannot read a score.
pub(super) fn judge_outcome(kind: &str, response: &Value) -> JudgeOutcome {
    let text = match judge_reply_text(response) {
        Ok(text) => text,
        Err(reason) => return unexecuted(kind, &reason),
    };
    match parse_judge_reply(text) {
        Some(verdict) => JudgeOutcome {
            result: AssertionResult {
                kind: kind.to_string(),
                pass: verdict.pass,
                score: verdict.score,
                detail: truncate_chars(text, 500),
                executed: true,
            },
            explicit_score: verdict.explicit_score,
        },
        None => unexecuted(
            kind,
            &format!(
                "judge reply carried no single VERDICT: PASS or FAIL; not scored: {}",
                truncate_chars(text, 300)
            ),
        ),
    }
}

fn unexecuted(kind: &str, detail: &str) -> JudgeOutcome {
    JudgeOutcome {
        result: skipped_assertion_result(kind, detail),
        explicit_score: false,
    }
}

pub(super) fn assertion_kind(assertion: &Assertion) -> &'static str {
    match assertion {
        Assertion::LlmJudge { .. } => "llm_judge",
        Assertion::LlmRubric { .. } => "llm_rubric",
        Assertion::Factuality { .. } => "factuality",
        Assertion::ContextFaithfulness { .. } => "context_faithfulness",
        Assertion::AnswerRelevance { .. } => "answer_relevance",
        Assertion::Similar { .. } => "similar",
        _ => "assertion",
    }
}

pub(super) fn has_reference_context(case: &EvalCase) -> bool {
    case.context.as_ref().is_some_and(|value| match value {
        Value::Null => false,
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(items) => !items.is_empty(),
        Value::Bool(_) | Value::Number(_) => true,
    })
}

pub(super) fn skipped_assertion_result(kind: &str, detail: &str) -> AssertionResult {
    AssertionResult {
        detail: detail.to_owned(),
        executed: false,
        kind: kind.to_owned(),
        pass: false,
        score: 0.0,
    }
}

// ─── P2: offline registry-evaluator scoring ─────────────────────────────────
//
// The active dataset runner can score any OFFLINE evaluator from the shared
// catalog over each case (in addition to the existing assertions). This is
// strictly additive: when no evaluator ids are requested, `score_evaluators`
// returns `[]` and behavior is byte-for-byte what it was before.

#[cfg(test)]
#[path = "judge_tests.rs"]
mod tests;
