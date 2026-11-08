//! Deterministic (non-model-graded) assertion evaluation.

use regex::Regex;
use serde_json::Value;

use crate::assertion::{Assertion, AssertionResult};
use crate::deterministic_codes::with_detail_code;
use crate::options::{apply_assertion_options, assertion_options, AssertionMetrics};
use crate::text_shape::{
    comma_values, is_html_like, is_sql_like, is_xml_like, normalized_levenshtein,
};

/// Evaluate one deterministic assertion (everything except model-graded
/// assertions) against `response_text`.
pub fn eval_assertion_deterministic(assertion: &Assertion, response_text: &str) -> AssertionResult {
    eval_assertion_deterministic_with_metrics(assertion, response_text, AssertionMetrics::default())
}

/// Metrics-aware deterministic assertion evaluator used by the Gateway runner.
/// The result carries a localizable detail `code` where one is defined.
pub fn eval_assertion_deterministic_with_metrics(
    assertion: &Assertion,
    response_text: &str,
    metrics: AssertionMetrics,
) -> AssertionResult {
    with_detail_code(assertion, evaluate(assertion, response_text, metrics))
}

fn evaluate(
    assertion: &Assertion,
    response_text: &str,
    metrics: AssertionMetrics,
) -> AssertionResult {
    let (kind, pass, detail): (&str, bool, String) = match assertion {
        Assertion::Contains { value, .. } => {
            let pass = response_text.to_lowercase().contains(&value.to_lowercase());
            let detail = if pass {
                format!("found \"{value}\"")
            } else {
                format!("missing \"{value}\"")
            };
            ("contains", pass, detail)
        }
        Assertion::NotContains { value, .. } => {
            let present = response_text.to_lowercase().contains(&value.to_lowercase());
            let pass = !present;
            let detail = if pass {
                format!("absent \"{value}\"")
            } else {
                format!("unexpectedly found \"{value}\"")
            };
            ("not_contains", pass, detail)
        }
        Assertion::Equals { value, .. } => {
            let pass = response_text.trim() == value.trim();
            let detail = if pass {
                "exact match".to_string()
            } else {
                format!("expected exactly \"{}\"", value.trim())
            };
            ("equals", pass, detail)
        }
        Assertion::Regex { value, .. } => match Regex::new(value) {
            Ok(re) => {
                let pass = re.is_match(response_text);
                let detail = if pass {
                    format!("matched /{value}/")
                } else {
                    format!("no match /{value}/")
                };
                ("regex", pass, detail)
            }
            Err(e) => ("regex", false, format!("invalid regex: {e}")),
        },
        Assertion::Icontains { value, .. } => {
            let pass = response_text.to_lowercase().contains(&value.to_lowercase());
            let detail = if pass {
                format!("found \"{value}\" (case insensitive)")
            } else {
                format!("missing \"{value}\" (case insensitive)")
            };
            ("icontains", pass, detail)
        }
        Assertion::StartsWith { value, .. } => {
            let pass = response_text.trim_start().starts_with(value.trim());
            let detail = if pass {
                format!("starts with \"{}\"", value.trim())
            } else {
                format!("does not start with \"{}\"", value.trim())
            };
            ("starts_with", pass, detail)
        }
        Assertion::ContainsAny { value, .. } => {
            let values = comma_values(value);
            let matched = values
                .iter()
                .find(|candidate| response_text.contains(*candidate));
            let pass = matched.is_some();
            let detail = match matched {
                Some(candidate) => format!("found one of the values: \"{candidate}\""),
                None => format!("none of the values were found: {value}"),
            };
            ("contains_any", pass, detail)
        }
        Assertion::ContainsAll { value, .. } => {
            let values = comma_values(value);
            let missing: Vec<&str> = values
                .iter()
                .filter(|candidate| !response_text.contains(*candidate))
                .copied()
                .collect();
            let pass = missing.is_empty();
            let detail = if pass {
                "found all expected values".to_string()
            } else {
                format!("missing values: {}", missing.join(", "))
            };
            ("contains_all", pass, detail)
        }
        Assertion::IcontainsAny { value, .. } => {
            let lower = response_text.to_lowercase();
            let matched = comma_values(value)
                .into_iter()
                .find(|candidate| lower.contains(&candidate.to_lowercase()));
            let pass = matched.is_some();
            let detail = match matched {
                Some(candidate) => format!("found one of the values: \"{candidate}\""),
                None => format!("none of the values were found: {value}"),
            };
            ("icontains_any", pass, detail)
        }
        Assertion::IcontainsAll { value, .. } => {
            let lower = response_text.to_lowercase();
            let values = comma_values(value);
            let missing: Vec<&str> = values
                .iter()
                .filter(|candidate| !lower.contains(&candidate.to_lowercase()))
                .copied()
                .collect();
            let pass = missing.is_empty();
            let detail = if pass {
                "found all expected values (case insensitive)".to_string()
            } else {
                format!("missing values: {}", missing.join(", "))
            };
            ("icontains_all", pass, detail)
        }
        Assertion::ContainsJson { value, .. } => {
            let expected = value.trim();
            let pass = !expected.is_empty()
                && serde_json::from_str::<Value>(expected).is_ok()
                && response_text.contains(expected);
            let detail = if pass {
                "found the expected JSON value".to_string()
            } else {
                "expected JSON value was not found".to_string()
            };
            ("contains_json", pass, detail)
        }
        Assertion::ContainsHtml { value, .. } => {
            let pass = is_html_like(response_text) && response_text.contains(value);
            let detail = if pass {
                "found the expected HTML fragment"
            } else {
                "expected HTML fragment was not found"
            };
            ("contains_html", pass, detail.to_owned())
        }
        Assertion::ContainsXml { value, .. } => {
            let pass = is_xml_like(response_text) && response_text.contains(value);
            let detail = if pass {
                "found the expected XML fragment"
            } else {
                "expected XML fragment was not found"
            };
            ("contains_xml", pass, detail.to_owned())
        }
        Assertion::ContainsSql { value, .. } => {
            let pass = is_sql_like(response_text)
                && response_text.to_lowercase().contains(&value.to_lowercase());
            let detail = if pass {
                "found the expected SQL fragment"
            } else {
                "expected SQL fragment was not found"
            };
            ("contains_sql", pass, detail.to_owned())
        }
        Assertion::Levenshtein { value, options } => {
            // Levenshtein is intentionally quadratic. A caller can submit
            // eval input over the network, so do not let two very large strings
            // turn an otherwise bounded scoring endpoint into a CPU/memory DoS.
            const MAX_LEVENSHTEIN_CHARS: usize = 2_048;
            if response_text.chars().count() > MAX_LEVENSHTEIN_CHARS
                || value.chars().count() > MAX_LEVENSHTEIN_CHARS
            {
                return apply_assertion_options(
                    AssertionResult {
                        kind: "levenshtein".to_owned(),
                        pass: false,
                        score: 0.0,
                        detail: format!(
                            "levenshtein inputs are limited to {MAX_LEVENSHTEIN_CHARS} characters"
                        ),
                        executed: false,
                        ..Default::default()
                    },
                    options,
                );
            }
            let score = normalized_levenshtein(response_text.trim(), value.trim());
            let threshold = options.threshold.unwrap_or(0.8).clamp(0.0, 1.0);
            let pass = score >= threshold;
            let detail = format!("similarity {score:.3}; threshold {threshold:.3}");
            return apply_assertion_options(
                AssertionResult {
                    kind: "levenshtein".to_owned(),
                    pass,
                    score,
                    detail,
                    executed: true,
                    ..Default::default()
                },
                options,
            );
        }
        Assertion::Latency { value, options } => {
            let expected = value.trim().parse::<u64>().ok();
            let pass = expected
                .zip(metrics.latency_ms)
                .is_some_and(|(limit, actual)| actual <= limit);
            let detail = match (expected, metrics.latency_ms) {
                (Some(limit), Some(actual)) => format!("latency {actual}ms; limit {limit}ms"),
                (None, _) => format!("invalid latency limit: {value}"),
                (_, None) => "latency measurement unavailable".to_owned(),
            };
            let score = match (expected, metrics.latency_ms) {
                (Some(limit), Some(actual)) if limit > 0 => {
                    (1.0 - actual as f32 / limit as f32).clamp(0.0, 1.0)
                }
                (Some(_), Some(_)) => f32::from(pass),
                _ => 0.0,
            };
            let _ = options;
            return apply_assertion_options(
                AssertionResult {
                    kind: "latency".to_owned(),
                    pass,
                    score,
                    detail,
                    executed: expected.is_some() && metrics.latency_ms.is_some(),
                    ..Default::default()
                },
                options,
            );
        }
        Assertion::Cost { value, options } => {
            let expected = value.trim().parse::<f64>().ok();
            let actual = metrics
                .cost_micro_usd
                .map(|micro| micro as f64 / 1_000_000.0);
            let pass = expected
                .zip(actual)
                .is_some_and(|(limit, observed)| observed <= limit);
            let detail = match (expected, actual) {
                (Some(limit), Some(observed)) => format!("cost ${observed:.6}; limit ${limit:.6}"),
                (None, _) => format!("invalid cost limit: {value}"),
                (_, None) => "cost measurement unavailable".to_owned(),
            };
            let score = match (expected, actual) {
                (Some(limit), Some(observed)) if limit > 0.0 => {
                    (1.0 - observed as f32 / limit as f32).clamp(0.0, 1.0)
                }
                (Some(_), Some(_)) => f32::from(pass),
                _ => 0.0,
            };
            let _ = options;
            return apply_assertion_options(
                AssertionResult {
                    kind: "cost".to_owned(),
                    pass,
                    score,
                    detail,
                    executed: expected.is_some() && metrics.cost_micro_usd.is_some(),
                    ..Default::default()
                },
                options,
            );
        }
        Assertion::AssertSet {
            assertions,
            options,
        } => {
            if assertions.is_empty() {
                return apply_assertion_options(
                    AssertionResult {
                        kind: "assert_set".to_owned(),
                        pass: true,
                        score: 1.0,
                        detail: "empty assertion set".to_owned(),
                        executed: true,
                        ..Default::default()
                    },
                    options,
                );
            }
            let results: Vec<AssertionResult> = assertions
                .iter()
                .map(|nested| {
                    eval_assertion_deterministic_with_metrics(nested, response_text, metrics)
                })
                .collect();
            let weight_sum: f32 = results.len() as f32;
            let score = results.iter().map(|result| result.score).sum::<f32>() / weight_sum;
            let threshold = options.threshold.unwrap_or(1.0).clamp(0.0, 1.0);
            let pass = score >= threshold;
            let detail = format!(
                "{}/{} nested assertions passed; threshold {threshold:.3}",
                results.iter().filter(|result| result.pass).count(),
                results.len()
            );
            return apply_assertion_options(
                AssertionResult {
                    kind: "assert_set".to_owned(),
                    pass,
                    score,
                    detail,
                    executed: results.iter().all(|result| result.executed),
                    ..Default::default()
                },
                options,
            );
        }
        Assertion::IsHtml { .. } => {
            let trimmed = response_text.trim();
            let pass = is_html_like(trimmed);
            let detail = if pass {
                "HTML-like document"
            } else {
                "not HTML-like"
            };
            ("is_html", pass, detail.to_owned())
        }
        Assertion::IsXml { .. } => {
            let trimmed = response_text.trim();
            let pass = is_xml_like(trimmed);
            let detail = if pass {
                "XML-like document"
            } else {
                "not XML-like"
            };
            ("is_xml", pass, detail.to_owned())
        }
        Assertion::IsSql { .. } => {
            let pass = is_sql_like(response_text);
            let detail = if pass {
                "SQL-like statement"
            } else {
                "not SQL-like"
            };
            ("is_sql", pass, detail.to_owned())
        }
        Assertion::IsRefusal { .. } => {
            let lower = response_text.to_lowercase();
            let pass = [
                "i can't",
                "i cannot",
                "i’m unable",
                "i'm unable",
                "i refuse",
                "not able to",
                "cannot help",
            ]
            .iter()
            .any(|phrase| lower.contains(phrase));
            let detail = if pass {
                "refusal detected"
            } else {
                "no refusal detected"
            };
            ("is_refusal", pass, detail.to_owned())
        }
        Assertion::Moderation { value, .. } => {
            let lower = response_text.to_lowercase();
            let values = comma_values(value);
            let flagged = values
                .iter()
                .find(|term| lower.contains(&term.to_lowercase()));
            let pass = flagged.is_none();
            let detail = match flagged {
                Some(term) => format!("moderation term found: {term}"),
                None => "no configured moderation term found".to_owned(),
            };
            ("moderation", pass, detail)
        }
        Assertion::Javascript { .. }
        | Assertion::Python { .. }
        | Assertion::Ruby { .. }
        | Assertion::Webhook { .. } => {
            let kind = match assertion {
                Assertion::Javascript { .. } => "javascript",
                Assertion::Python { .. } => "python",
                Assertion::Ruby { .. } => "ruby",
                Assertion::Webhook { .. } => "webhook",
                _ => unreachable!(),
            };
            (
                kind,
                false,
                format!("{kind} assertion requires its sandbox/runtime adapter"),
            )
        }
        Assertion::IsJson { .. } | Assertion::JsonValid { .. } => {
            let pass = serde_json::from_str::<Value>(response_text.trim()).is_ok();
            let detail = if pass {
                "valid JSON".to_string()
            } else {
                "not valid JSON".to_string()
            };
            let kind = if matches!(assertion, Assertion::IsJson { .. }) {
                "is_json"
            } else {
                "json_valid"
            };
            (kind, pass, detail)
        }
        Assertion::LlmJudge { .. }
        | Assertion::LlmRubric { .. }
        | Assertion::Similar { .. }
        | Assertion::Factuality { .. }
        | Assertion::ContextFaithfulness { .. }
        | Assertion::AnswerRelevance { .. } => {
            // Caller must route model-graded checks through the async judge path;
            // this defensive guard must never silently pass.
            let kind = if matches!(assertion, Assertion::LlmRubric { .. }) {
                "llm_rubric"
            } else if matches!(assertion, Assertion::Similar { .. }) {
                "similar"
            } else if matches!(assertion, Assertion::Factuality { .. }) {
                "factuality"
            } else if matches!(assertion, Assertion::ContextFaithfulness { .. }) {
                "context_faithfulness"
            } else if matches!(assertion, Assertion::AnswerRelevance { .. }) {
                "answer_relevance"
            } else {
                "llm_judge"
            };
            (
                kind,
                false,
                "model-graded assertion must use the judge path".to_string(),
            )
        }
    };

    let score = if pass { 1.0 } else { 0.0 };
    apply_assertion_options(
        AssertionResult {
            kind: kind.to_string(),
            pass,
            score,
            detail,
            executed: !matches!(
                assertion,
                Assertion::Javascript { .. }
                    | Assertion::Python { .. }
                    | Assertion::Ruby { .. }
                    | Assertion::Webhook { .. }
                    | Assertion::LlmJudge { .. }
                    | Assertion::LlmRubric { .. }
                    | Assertion::Similar { .. }
                    | Assertion::Factuality { .. }
                    | Assertion::ContextFaithfulness { .. }
                    | Assertion::AnswerRelevance { .. }
            ),
            ..Default::default()
        },
        assertion_options(assertion),
    )
}

#[cfg(test)]
#[path = "deterministic_tests.rs"]
mod tests;
