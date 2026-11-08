//! Per-assertion options: threshold, negation and runtime metrics.

use crate::assertion::{Assertion, AssertionOptions, AssertionResult};

/// Runtime measurements available to operational assertions. Missing values
/// stay explicit: a latency/cost assertion cannot pass when its provider did
/// not return the corresponding measurement.
#[derive(Debug, Clone, Copy, Default)]
pub struct AssertionMetrics {
    pub latency_ms: Option<u64>,
    pub cost_micro_usd: Option<u64>,
}

pub(crate) fn assertion_options(assertion: &Assertion) -> &AssertionOptions {
    match assertion {
        Assertion::Contains { options, .. }
        | Assertion::NotContains { options, .. }
        | Assertion::Equals { options, .. }
        | Assertion::Regex { options, .. }
        | Assertion::Icontains { options, .. }
        | Assertion::StartsWith { options, .. }
        | Assertion::ContainsAny { options, .. }
        | Assertion::ContainsAll { options, .. }
        | Assertion::IcontainsAny { options, .. }
        | Assertion::IcontainsAll { options, .. }
        | Assertion::ContainsJson { options, .. }
        | Assertion::ContainsHtml { options, .. }
        | Assertion::ContainsXml { options, .. }
        | Assertion::ContainsSql { options, .. }
        | Assertion::Levenshtein { options, .. }
        | Assertion::Latency { options, .. }
        | Assertion::Cost { options, .. }
        | Assertion::AssertSet { options, .. }
        | Assertion::IsHtml { options }
        | Assertion::IsXml { options }
        | Assertion::IsSql { options }
        | Assertion::IsRefusal { options }
        | Assertion::Moderation { options, .. }
        | Assertion::Javascript { options, .. }
        | Assertion::Python { options, .. }
        | Assertion::Ruby { options, .. }
        | Assertion::Webhook { options, .. }
        | Assertion::IsJson { options }
        | Assertion::JsonValid { options }
        | Assertion::LlmJudge { options, .. }
        | Assertion::LlmRubric { options, .. }
        | Assertion::Similar { options, .. }
        | Assertion::Factuality { options, .. }
        | Assertion::ContextFaithfulness { options, .. }
        | Assertion::AnswerRelevance { options, .. } => options,
    }
}

/// Apply the threshold and optional negation controls to an assertion result.
/// Unexecuted results stay failed even when a caller asks for negation: missing
/// prerequisites must never become a passing result by inversion.
pub fn apply_assertion_options(
    mut result: AssertionResult,
    options: &AssertionOptions,
) -> AssertionResult {
    if result.executed {
        if let Some(threshold) = options.threshold {
            result.pass = result.score >= threshold.clamp(0.0, 1.0);
        }
        if options.not == Some(true) {
            result.pass = !result.pass;
            result.score = 1.0 - result.score;
            result.detail = format!("negated: {}", result.detail);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(executed: bool, pass: bool, score: f32) -> AssertionResult {
        AssertionResult {
            kind: "llm_judge".to_owned(),
            pass,
            score,
            detail: "d".to_owned(),
            executed,
            ..Default::default()
        }
    }

    /// Negation and thresholds apply only to executed results: a judge that
    /// never answered cannot become a pass by inversion.
    #[test]
    fn negation_and_threshold_never_turn_an_unexecuted_result_into_a_pass() {
        let negate = AssertionOptions {
            not: Some(true),
            threshold: Some(0.0),
            ..AssertionOptions::default()
        };
        let skipped = apply_assertion_options(result(false, false, 0.0), &negate);
        assert!(!skipped.pass);
        assert!(!skipped.executed);
        assert_eq!(skipped.score, 0.0);

        let negate_only = AssertionOptions {
            not: Some(true),
            ..AssertionOptions::default()
        };
        let negated = apply_assertion_options(result(true, false, 0.2), &negate_only);
        assert!(negated.pass);
        assert!((negated.score - 0.8).abs() < 1e-6);
        assert!(negated.detail.starts_with("negated: "));

        let threshold = AssertionOptions {
            threshold: Some(0.5),
            ..AssertionOptions::default()
        };
        assert!(!apply_assertion_options(result(true, true, 0.4), &threshold).pass);
        assert!(apply_assertion_options(result(true, false, 0.6), &threshold).pass);
    }

    #[test]
    fn assertion_options_reads_every_variant_options() {
        let options = AssertionOptions {
            weight: Some(2.0),
            ..AssertionOptions::default()
        };
        let judge = Assertion::LlmJudge {
            rubric: "r".to_owned(),
            options: options.clone(),
        };
        let json = Assertion::IsJson { options };
        assert_eq!(assertion_options(&judge).weight, Some(2.0));
        assert_eq!(assertion_options(&json).weight, Some(2.0));
    }
}
