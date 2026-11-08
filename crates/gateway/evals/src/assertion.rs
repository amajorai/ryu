//! Assertion wire types and their per-assertion result.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ─── Dataset eval runner ─────────────────────────────────────────────────────
//
// v1 scorers: latency, token_efficiency, policy_pass, substring_match (optional).
// LLM-judge has since shipped, split across this crate's boundary: both pure
// halves live here — `build_judge_prompt` renders the rubric into a prompt and
// `parse_judge_reply` reads the reply back into a verdict, or `None` (not
// executed) for a refusal, prose or a self-contradicting reply — but the
// provider round-trip between them cannot, because judging means another async
// pass through the gateway pipeline this crate has no handle on. So the caller
// owns that leg, and `eval_assertion_deterministic` hard-fails
// `Assertion::LlmJudge` rather than let a judge misrouted onto the sync path
// score as anything at all.
// Richer scoring strategies or provider-pinning are NOT in scope for v1.

// ─── Assertions ──────────────────────────────────────────────────────────────

/// One assertion to evaluate against a case's response text.
///
/// Internally tagged on `kind`. Wire forms (rename_all = snake_case):
///   {"kind":"contains","value":"foo"}
///   {"kind":"not_contains","value":"foo"}
///   {"kind":"equals","value":"foo"}
///   {"kind":"regex","value":"^foo.*"}
///   {"kind":"json_valid"}
///   {"kind":"llm_judge","rubric":"The answer must be polite and correct."}
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct AssertionOptions {
    /// Per-assertion pass threshold. When absent, the case threshold applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f32>,
    /// Relative weight in the case assertion score.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f32>,
    /// Optional provider/model override for model-graded assertions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Promptfoo-compatible custom rubric prompt.
    #[serde(
        default,
        alias = "rubricPrompt",
        skip_serializing_if = "Option::is_none"
    )]
    pub rubric_prompt: Option<String>,
    /// Promptfoo-compatible output transform. Execution is deliberately
    /// sandbox-owned; this field is retained in the wire contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<String>,
    /// Optional metric name retained for result/export parity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
    /// Provider-specific assertion configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
    /// Negate the assertion verdict. The score is inverted as well so exports
    /// remain meaningful for thresholded and weighted assertions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Assertion {
    Contains {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    NotContains {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    Equals {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    Regex {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    Icontains {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    StartsWith {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    ContainsAny {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    ContainsAll {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    IcontainsAny {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    IcontainsAll {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    ContainsJson {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    ContainsHtml {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    ContainsXml {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    ContainsSql {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    Levenshtein {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    Latency {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    Cost {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    AssertSet {
        assertions: Vec<Assertion>,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    IsHtml {
        #[serde(flatten)]
        options: AssertionOptions,
    },
    IsXml {
        #[serde(flatten)]
        options: AssertionOptions,
    },
    IsSql {
        #[serde(flatten)]
        options: AssertionOptions,
    },
    IsRefusal {
        #[serde(flatten)]
        options: AssertionOptions,
    },
    Moderation {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    Javascript {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    Python {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    Ruby {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    Webhook {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    IsJson {
        #[serde(flatten)]
        options: AssertionOptions,
    },
    JsonValid {
        #[serde(flatten)]
        options: AssertionOptions,
    },
    LlmJudge {
        rubric: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    LlmRubric {
        rubric: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    Similar {
        value: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    Factuality {
        rubric: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    ContextFaithfulness {
        rubric: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
    AnswerRelevance {
        rubric: String,
        #[serde(flatten)]
        options: AssertionOptions,
    },
}

/// Result of evaluating a single assertion against a response.
#[derive(Debug, Clone, Default, Serialize)]
pub struct AssertionResult {
    /// The assertion kind as the snake_case wire tag ("contains", "llm_judge", …).
    pub kind: String,
    /// Whether this assertion passed.
    pub pass: bool,
    /// Confidence/quality in [0,1]. Deterministic kinds emit 1.0/0.0;
    /// llm_judge emits the parsed judge score (0.0 on a defensive fail).
    pub score: f32,
    /// Human-readable explanation (matched text, regex error, judge verdict, …).
    pub detail: String,
    /// Whether the assertion actually executed. Deterministic assertions are
    /// true; missing judge/runtime prerequisites are false and never look like
    /// a passing score.
    #[serde(default)]
    pub executed: bool,
    /// Stable detail code (`"contains.found"`, `"regex.invalid"`, …) a client
    /// renders as a localized message; `detail` stays the English fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Arguments for `code`'s message (`value`, `pattern`, `score`, …).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub values: BTreeMap<String, Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Assertions are tagged on `kind` with options flattened beside the
    /// payload, so Promptfoo-shaped JSON round-trips.
    #[test]
    fn assertions_use_the_kind_tag_with_flattened_options() {
        let parsed: Assertion = serde_json::from_value(serde_json::json!({
            "kind": "llm_judge",
            "rubric": "polite",
            "threshold": 0.7,
            "rubricPrompt": "custom",
        }))
        .expect("parses");
        let Assertion::LlmJudge { rubric, options } = &parsed else {
            panic!("wrong variant: {parsed:?}");
        };
        assert_eq!(rubric, "polite");
        assert_eq!(options.threshold, Some(0.7));
        assert_eq!(options.rubric_prompt.as_deref(), Some("custom"));
        let back = serde_json::to_value(&parsed).expect("serializes");
        assert_eq!(back["kind"], "llm_judge");
        assert_eq!(back["rubric_prompt"], "custom");
        assert!(
            serde_json::from_value::<Assertion>(serde_json::json!({ "kind": "nope" })).is_err()
        );
    }
}
