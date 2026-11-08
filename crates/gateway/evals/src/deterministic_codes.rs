//! Stable detail codes for deterministic assertion results.
//!
//! Gateway API text stays English by policy, so `detail` remains the English
//! fallback. A client renders `code` plus `values` as one whole localized
//! message instead, and falls back to `detail` for a result without a code
//! (older saved runs, model-graded verdicts, kinds that have no code yet).

use std::collections::BTreeMap;

use regex::Regex;
use serde_json::Value;

use crate::assertion::{Assertion, AssertionResult};
use crate::options::assertion_options;

/// Mirrors the Levenshtein input cap in `deterministic.rs`; the too-long
/// detail code reports it as `limit`.
const MAX_SIMILARITY_CHARS: u64 = 2_048;

/// Attach the detail code for `assertion` to an already evaluated `result`.
/// Negation is reported as `values.negated` so the client can wrap the
/// un-negated message, as the English `negated: …` detail does.
pub(crate) fn with_detail_code(
    assertion: &Assertion,
    mut result: AssertionResult,
) -> AssertionResult {
    let negated = result.executed && assertion_options(assertion).not == Some(true);
    // The verdict before negation. Negation inverts the score, and the binary
    // deterministic kinds score exactly 1.0 or 0.0 before it.
    let raw_score = if negated {
        1.0 - result.score
    } else {
        result.score
    };
    let Some((code, mut values)) = detail_code(assertion, raw_score, result.executed) else {
        return result;
    };
    if negated {
        values.insert("negated".to_owned(), Value::Bool(true));
    }
    result.code = Some(code.to_owned());
    result.values = values;
    result
}

fn detail_code(
    assertion: &Assertion,
    raw_score: f32,
    executed: bool,
) -> Option<(&'static str, BTreeMap<String, Value>)> {
    let raw_pass = raw_score >= 0.5;
    let pick = |yes: &'static str, no: &'static str| if raw_pass { yes } else { no };
    match assertion {
        Assertion::Contains { value, .. } | Assertion::Icontains { value, .. } => Some((
            pick("contains.found", "contains.missing"),
            text_values([("value", value.as_str())]),
        )),
        Assertion::NotContains { value, .. } => Some((
            pick("not_contains.absent", "not_contains.found"),
            text_values([("value", value.as_str())]),
        )),
        Assertion::Equals { value, .. } => Some((
            pick("equals.match", "equals.mismatch"),
            text_values([("value", value.trim())]),
        )),
        Assertion::StartsWith { value, .. } => Some((
            pick("starts_with.match", "starts_with.mismatch"),
            text_values([("value", value.trim())]),
        )),
        Assertion::Regex { value, .. } => Some(regex_code(value, raw_pass)),
        Assertion::Levenshtein { options, .. } => Some(if executed {
            let threshold = options.threshold.unwrap_or(0.8).clamp(0.0, 1.0);
            let mut values = BTreeMap::new();
            values.insert("score".to_owned(), rounded(raw_score));
            values.insert("threshold".to_owned(), rounded(threshold));
            ("similarity.score", values)
        } else {
            let mut values = BTreeMap::new();
            values.insert("limit".to_owned(), Value::from(MAX_SIMILARITY_CHARS));
            ("similarity.too_long", values)
        }),
        Assertion::IsJson { .. } | Assertion::JsonValid { .. } => {
            Some((pick("json.valid", "json.invalid"), BTreeMap::new()))
        }
        _ => None,
    }
}

fn regex_code(pattern: &str, raw_pass: bool) -> (&'static str, BTreeMap<String, Value>) {
    if raw_pass {
        return ("regex.matched", text_values([("pattern", pattern)]));
    }
    match Regex::new(pattern) {
        Ok(_) => ("regex.no_match", text_values([("pattern", pattern)])),
        // The compiler's own text stays raw: the client shows it as a detail.
        Err(error) => (
            "regex.invalid",
            text_values([("pattern", pattern), ("error", error.to_string().as_str())]),
        ),
    }
}

fn text_values<const N: usize>(pairs: [(&str, &str); N]) -> BTreeMap<String, Value> {
    pairs
        .into_iter()
        .map(|(key, value)| (key.to_owned(), Value::String(value.to_owned())))
        .collect()
}

/// Three decimals, as the English detail prints them, without the f32 noise
/// (`0.857` rather than `0.8569999933242798`).
fn rounded(value: f32) -> Value {
    Value::from((f64::from(value) * 1000.0).round() / 1000.0)
}

#[cfg(test)]
#[path = "deterministic_codes_tests.rs"]
mod tests;
