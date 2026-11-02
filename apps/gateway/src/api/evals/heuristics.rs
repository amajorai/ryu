//! Deterministic heuristic, regex and builtin-detector evaluators.

use super::*;

/// Deterministic heuristic evaluators, dispatched by id. Only marks
/// `executed: true` when a real score was computed.
pub(super) fn score_heuristic(
    id: &str,
    category: &str,
    case: &EvalCase,
    response_text: &str,
    threshold: f32,
) -> EvaluatorScore {
    match id {
        "exact_match" => match &case.expected {
            Some(expected) => {
                let matched = response_text.trim() == expected.trim();
                let score = if matched { 1.0 } else { 0.0 };
                let detail = if matched {
                    "exact match".to_string()
                } else {
                    format!("expected exactly \"{}\"", expected.trim())
                };
                EvaluatorScore {
                    id: id.to_string(),
                    category: category.to_string(),
                    score,
                    // exact_match is higher-is-better (1.0 = the reference matched).
                    pass: judge_pass(score, threshold, true),
                    detail,
                    executed: true,
                }
            }
            None => EvaluatorScore {
                id: id.to_string(),
                category: category.to_string(),
                score: 0.0,
                pass: false,
                detail: "exact_match needs a reference (case.expected); none provided".to_string(),
                executed: false,
            },
        },
        "assertions" => {
            // Deterministic assertions only; llm_judge assertions run via the
            // dedicated assertions field, not here.
            let deterministic: Vec<&Assertion> = case
                .assertions
                .iter()
                .filter(|a| {
                    !matches!(
                        a,
                        Assertion::LlmJudge { .. }
                            | Assertion::LlmRubric { .. }
                            | Assertion::Similar { .. }
                            | Assertion::Factuality { .. }
                            | Assertion::ContextFaithfulness { .. }
                            | Assertion::AnswerRelevance { .. }
                    )
                })
                .collect();
            let judge_count = case.assertions.len() - deterministic.len();

            if deterministic.is_empty() {
                return EvaluatorScore {
                    id: id.to_string(),
                    category: category.to_string(),
                    score: 0.0,
                    pass: false,
                    detail: "no deterministic assertions to evaluate".to_string(),
                    executed: false,
                };
            }

            let mut passed = 0usize;
            for assertion in &deterministic {
                let rendered = render_assertion_vars(assertion, &case.vars);
                if eval_assertion_deterministic(&rendered, response_text).pass {
                    passed += 1;
                }
            }
            let total = deterministic.len();
            let score = passed as f32 / total as f32;
            let mut detail = format!("{passed}/{total} deterministic assertions passed");
            if judge_count > 0 {
                detail.push_str(&format!(
                    "; {judge_count} llm_judge assertion(s) not evaluated here"
                ));
            }
            EvaluatorScore {
                id: id.to_string(),
                category: category.to_string(),
                score,
                pass: passed == total,
                detail,
                executed: true,
            }
        }
        // Voice/quality heuristics with no offline signal in a text dataset.
        "language" | "audio_quality" | "transcription_accuracy" => EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: "requires audio/reference data not present in a text eval dataset".to_string(),
            executed: false,
        },
        _ => EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: "no offline heuristic implemented for this evaluator".to_string(),
            executed: false,
        },
    }
}

/// Deterministic regex evaluators. Runs the patterns over the target text (the
/// request prompt for Input-target evaluators, the response otherwise). A match
/// is a flag: `score = 0.0` (unsafe) if flagged, `1.0` (safe) otherwise; the case
/// passes only when nothing flagged. Invalid patterns are skipped, never fatal.
pub(super) fn score_regex(
    id: &str,
    category: &str,
    target: EvaluatorTarget,
    patterns: &[String],
    case: &EvalCase,
    response_text: &str,
) -> EvaluatorScore {
    let rendered_prompt;
    let target_text: &str = match target {
        EvaluatorTarget::Input => {
            rendered_prompt = render_template(&case.prompt, &case.vars);
            &rendered_prompt
        }
        _ => response_text,
    };

    let matched_pattern = crate::evaluators::exec::custom_regex_match(patterns, target_text);

    let flagged = matched_pattern.is_some();
    let detail = match matched_pattern {
        Some(p) => format!("flagged: matched /{p}/"),
        None => "no pattern matched".to_string(),
    };
    EvaluatorScore {
        id: id.to_string(),
        category: category.to_string(),
        score: if flagged { 0.0 } else { 1.0 },
        pass: !flagged,
        detail,
        executed: true,
    }
}

/// Builtin firewall detectors (`pii`, `secret`, …) scored like regex
/// evaluators: `1.0` clean, `0.0` flagged; unknown detector names are reported
/// unexecuted rather than failing the run.
pub(super) fn score_builtin(
    id: &str,
    category: &str,
    target: EvaluatorTarget,
    detector: &str,
    case: &EvalCase,
    response_text: &str,
) -> EvaluatorScore {
    let rendered_prompt;
    let target_text: &str = match target {
        EvaluatorTarget::Input => {
            rendered_prompt = render_template(&case.prompt, &case.vars);
            &rendered_prompt
        }
        _ => response_text,
    };
    match crate::evaluators::exec::run_builtin_detector(detector, target_text, None) {
        Ok(found) => EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: if found.is_some() { 0.0 } else { 1.0 },
            pass: found.is_none(),
            detail: found.map_or_else(
                || format!("builtin detector '{detector}' found nothing"),
                |reason| format!("flagged: {reason}"),
            ),
            executed: true,
        },
        Err(reason) => EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: reason,
            executed: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heuristic_regex_and_builtin_scores() {
        let case = EvalCase {
            prompt: "q".to_owned(),
            expected: Some("hi".to_owned()),
            ..EvalCase::default()
        };
        let exact = score_heuristic("exact_match", "quality", &case, " hi ", 1.0);
        assert!(exact.executed && exact.pass);
        let unknown = score_heuristic("no_such_heuristic", "quality", &case, "hi", 1.0);
        assert!(!unknown.executed && !unknown.pass);

        let flagged = score_regex(
            "refunds",
            "custom",
            EvaluatorTarget::Output,
            &["(?i)refund".to_owned()],
            &case,
            "Refunds within 30 days",
        );
        assert!(flagged.executed && !flagged.pass && flagged.score == 0.0);

        let builtin = score_builtin(
            "pii",
            "security",
            EvaluatorTarget::Output,
            "nope",
            &case,
            "x",
        );
        assert!(!builtin.executed && !builtin.pass);
    }
}
