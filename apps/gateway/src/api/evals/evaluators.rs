//! Offline registry-evaluator scoring over one case.

use super::*;

/// Everything `score_evaluators` needs that isn't the case itself: the pipeline
/// state + request context for LLM-judge evaluators, the judge-model precedence
/// inputs, and the run-level evaluator ids unioned into every case.
#[derive(Clone)]
pub(super) struct JudgeCtx {
    pub(super) state: SharedState,
    pub(super) ctx: pipeline::RequestContext,
    /// Run-level `judge_model` override (2nd in precedence).
    pub(super) request_judge_model: Option<String>,
    /// Final fallback judge model (the run's primary model).
    pub(super) fallback_model: String,
    /// Run-level evaluator ids applied to every case (unioned with per-case ids).
    pub(super) request_evaluators: Vec<String>,
    /// Admission check run before each LLM-judge evaluator call (online evals'
    /// per-tenant judge budget). `None` admits every call.
    pub(super) judge_gate: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

/// Score every requested registry evaluator against one case's response.
///
/// The requested set is the union of `case.evaluators` and the run-level
/// `judge_ctx.request_evaluators` (order-preserving, de-duplicated). Each id is
/// resolved against the shared registry and dispatched on its `impl`. Evaluators
/// that cannot run offline yet (Code — P4), lack the data a text dataset provides
/// (Image/Audio), or resolve to an unknown/inline-only id are reported with
/// `executed: false` and an honest `detail` rather than an error — this never
/// panics and never fails the run.
pub(super) async fn score_evaluators(
    case: &EvalCase,
    response_text: &str,
    registry: &EvaluatorRegistry,
    judge_ctx: &JudgeCtx,
) -> Vec<EvaluatorScore> {
    let ids = union_evaluator_ids(&case.evaluators, &judge_ctx.request_evaluators);
    let mut out: Vec<EvaluatorScore> = Vec::with_capacity(ids.len());

    for id in &ids {
        let ev = match registry.get(id) {
            Some(ev) => ev,
            None => {
                out.push(EvaluatorScore {
                    id: id.clone(),
                    category: "unknown".to_string(),
                    score: 0.0,
                    pass: false,
                    detail: "unknown evaluator id".to_string(),
                    executed: false,
                });
                continue;
            }
        };

        let category = ev.category.as_str().to_string();

        // Offline-only gate: never offer an inline-only evaluator here.
        if !ev.capabilities.offline {
            out.push(EvaluatorScore {
                id: id.clone(),
                category,
                score: 0.0,
                pass: false,
                detail: "evaluator is not offline-capable".to_string(),
                executed: false,
            });
            continue;
        }

        let threshold = ev.offline.as_ref().map(|o| o.threshold).unwrap_or(0.5);

        // Every impl except LlmJudge is deterministic + network-free (and unit
        // tested directly). LlmJudge returns None here and takes the async path.
        let score =
            match score_offline_deterministic(id, &category, ev, case, response_text, threshold) {
                Some(s) => s,
                None => {
                    let EvaluatorImpl::LlmJudge { rubric } = &ev.impl_ else {
                        unreachable!("only LlmJudge defers to the async judge path");
                    };
                    score_llm_judge_evaluator(
                        id,
                        &category,
                        ev,
                        rubric,
                        case,
                        response_text,
                        threshold,
                        judge_ctx,
                    )
                    .await
                }
            };

        out.push(score);
    }

    out
}

/// Evaluator rows for a case whose output never materialised (provider error,
/// timeout or failed transform): nothing was scored, so each is `executed:
/// false` and its aggregate stays unmeasured.
pub(super) fn errored_case_evaluators(
    case: &EvalCase,
    registry: &EvaluatorRegistry,
    judge_ctx: &JudgeCtx,
) -> Vec<EvaluatorScore> {
    union_evaluator_ids(&case.evaluators, &judge_ctx.request_evaluators)
        .into_iter()
        .map(|id| {
            let category = registry
                .get(&id)
                .map(|ev| ev.category.as_str().to_string())
                .unwrap_or_else(|| "unknown".to_string());
            EvaluatorScore {
                id,
                category,
                score: 0.0,
                pass: false,
                detail: "case errored before an output was produced".to_string(),
                executed: false,
            }
        })
        .collect()
}

/// Union of per-case and run-level evaluator ids, order-preserving + de-duped
/// (case ids first). Pure so back-compat (both empty ⇒ `[]` ⇒ no scoring) is
/// directly testable.
pub(super) fn union_evaluator_ids(case_ids: &[String], request_ids: &[String]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for id in case_ids.iter().chain(request_ids.iter()) {
        if !ids.iter().any(|existing| existing == id) {
            ids.push(id.clone());
        }
    }
    ids
}

/// Dispatch the deterministic, network-free evaluator impls. Returns `None` only
/// for [`EvaluatorImpl::LlmJudge`], which the async caller handles. Keeping this
/// sync makes Heuristic/Regex/Code/Builtin scoring unit-testable without a live
/// provider or a constructed request context.
pub(super) fn score_offline_deterministic(
    id: &str,
    category: &str,
    ev: &crate::evaluators::Evaluator,
    case: &EvalCase,
    response_text: &str,
    threshold: f32,
) -> Option<EvaluatorScore> {
    match &ev.impl_ {
        EvaluatorImpl::Heuristic => Some(score_heuristic(
            id,
            category,
            case,
            response_text,
            threshold,
        )),
        EvaluatorImpl::Regex { patterns } => Some(score_regex(
            id,
            category,
            ev.target,
            patterns,
            case,
            response_text,
        )),
        EvaluatorImpl::Code { .. } => Some(EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: "sandboxed code evaluator execution is unavailable in Gateway".to_string(),
            executed: false,
        }),
        EvaluatorImpl::Builtin { detector } => Some(score_builtin(
            id,
            category,
            ev.target,
            detector,
            case,
            response_text,
        )),
        EvaluatorImpl::Wasm { .. } => Some(EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: "wasm policy evaluators run inline only (offline scoring not wired)"
                .to_string(),
            executed: false,
        }),
        EvaluatorImpl::LlmJudge { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run-level ids are unioned after the case's own, without duplicates.
    #[test]
    fn evaluator_ids_union_in_order_without_duplicates() {
        let case = vec!["a".to_owned(), "b".to_owned()];
        let run = vec!["b".to_owned(), "c".to_owned()];
        assert_eq!(union_evaluator_ids(&case, &run), vec!["a", "b", "c"]);
        assert!(union_evaluator_ids(&[], &[]).is_empty());
    }

    /// Deterministic catalog evaluators score offline; an LLM-judge one does
    /// not take the deterministic path.
    #[test]
    fn only_deterministic_evaluators_score_offline_without_a_judge() {
        let registry = EvaluatorRegistry::new();
        let case = EvalCase {
            expected: Some("hi".to_owned()),
            ..EvalCase::default()
        };
        let toxicity = registry.get("toxicity").expect("catalog toxicity");
        assert!(
            score_offline_deterministic("toxicity", "safety", toxicity, &case, "hi", 0.5).is_none()
        );
    }
}
