//! Dataset case, per-case score and run aggregate wire types.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::assertion::{Assertion, AssertionResult};

/// Result of scoring one registry `evaluators::Evaluator` (gateway) against a
/// single case's response (P2 offline runner). Distinct from [`AssertionResult`]:
/// this carries the evaluator id + its category and an honesty `executed` flag.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatorScore {
    /// Stable id of the catalog evaluator that produced this score.
    pub id: String,
    /// The evaluator's category (snake_case), e.g. "security", "quality".
    pub category: String,
    /// Score in [0,1]. Higher is better for quality-style evaluators; for
    /// deterministic safety regex, 1.0 = safe/no-match, 0.0 = flagged.
    pub score: f32,
    /// Whether this case passed the evaluator (see `detail` for the criterion).
    pub pass: bool,
    /// Human-readable explanation (match text, judge verdict, or why it was skipped).
    pub detail: String,
    /// Honesty flag: `true` only when a real score was computed. `false` for
    /// evaluators that can't run offline yet (Code — P4), lack the data a text
    /// dataset provides (Image/Audio), or resolve to an unknown/inline-only id.
    pub executed: bool,
}

/// Per-evaluator aggregate across all cases in a run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatorAggregate {
    /// Mean `score` over cases where the evaluator actually executed. 0.0 when
    /// it never executed.
    pub mean_score: f32,
    /// Fraction of executed cases that passed. 0.0 when it never executed.
    pub pass_rate: f32,
    /// Number of cases where the evaluator actually executed (`executed == true`).
    pub executed_count: usize,
}

/// A single case in an eval dataset.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct EvalCase {
    /// Stable case id used by result matrices and exports.
    #[serde(default)]
    pub id: Option<String>,
    /// Human-readable case description.
    #[serde(default)]
    pub description: Option<String>,
    /// The prompt to replay through the gateway pipeline. May contain {{vars}}.
    #[serde(default)]
    pub prompt: String,
    /// Legacy optional expected substring. STILL drives the scalar
    /// `substring_match` (case-insensitive contains) exactly as before, AND is
    /// synthesized as an extra `contains` assertion. Absent => scalar omitted.
    #[serde(default)]
    pub expected: Option<String>,
    /// Optional reference/context payload for factuality and faithfulness
    /// assertions. Model-graded checks report `executed:false` when it is absent.
    #[serde(default)]
    pub context: Option<Value>,
    /// Optional Promptfoo-style pass threshold for the mean assertion score.
    /// Defaults to `1.0`, which requires every assertion to pass.
    #[serde(default)]
    pub threshold: Option<f32>,
    /// Per-case variables. Substituted into {{name}} in the case prompt, the
    /// run-level system_prompt, and every assertion's value/rubric.
    #[serde(default)]
    pub vars: std::collections::HashMap<String, Value>,
    /// Optional Promptfoo chat prompt. When non-empty, messages are replayed in
    /// order and `prompt` remains the backward-compatible single-turn fallback.
    #[serde(default)]
    pub messages: Vec<EvalMessage>,
    /// Assertions to evaluate against this case's response text.
    #[serde(default)]
    pub assertions: Vec<Assertion>,
    /// NEW (P2): registry evaluator ids to score this case against, in addition
    /// to any run-level ids. Empty by default => today's assertion-only behavior.
    #[serde(default)]
    pub evaluators: Vec<String>,
    /// Optional per-case provider/model target. The Gateway treats this as the
    /// selected model for this case and keeps the run-level model as fallback.
    #[serde(default)]
    pub provider: Option<String>,
    /// Optional Promptfoo provider/model alternatives for this case. The first
    /// non-empty entry wins in the single-case replay path.
    #[serde(default)]
    pub providers: Vec<String>,
    /// A precomputed provider response. When present, the provider is not called;
    /// the result is scored as a deterministic replay fixture.
    #[serde(default, alias = "providerOutput")]
    pub provider_output: Option<Value>,
    /// Source label for a precomputed response, such as `openrouter` for a
    /// completed OpenRouter batch row. This is descriptive eval metadata only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_output_provider: Option<String>,
    /// Whether a precomputed provider output is known to have passed Gateway
    /// policy checks. `None` means the source did not measure this dimension.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_output_policy_pass: Option<bool>,
    /// Externally measured operation latency in milliseconds. For batch evals,
    /// callers may provide the batch turnaround shared by its rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_latency_ms: Option<u64>,
    /// Exact provider-reported row cost in micro-USD when the response body
    /// does not carry its own usage cost.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_cost_micro_usd: Option<u64>,
    /// Arbitrary case metadata preserved in results and exports.
    #[serde(default)]
    pub metadata: std::collections::HashMap<String, Value>,
    /// Promptfoo-compatible per-case prompt/output options.
    #[serde(default)]
    pub options: EvalCaseOptions,
}

/// Promptfoo-compatible case options that can be applied without executing
/// arbitrary renderer code. Unknown/dynamic options remain in the imported
/// suite configuration, while these portable fields are honored by Gateway.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct EvalCaseOptions {
    /// Text prepended to the rendered user prompt.
    #[serde(default)]
    pub prefix: Option<String>,
    /// Text appended to the rendered user prompt.
    #[serde(default)]
    pub suffix: Option<String>,
    /// A bounded built-in output transform (`trim`, `lower`, `upper`, `json`).
    #[serde(default)]
    pub transform: Option<String>,
    /// A bounded built-in variable transform (`json` or `identity`).
    #[serde(default, alias = "transformVars")]
    pub transform_vars: Option<String>,
    /// Per-case provider timeout override in milliseconds.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// Whether a provider response may be reused within one run.
    #[serde(default)]
    pub cache: Option<bool>,
}

/// One ordered chat turn in a Promptfoo-style prompt.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EvalMessage {
    pub content: String,
    pub role: String,
}

/// Per-case scores returned by the dataset runner.
#[derive(Debug, Clone, Serialize)]
pub struct CaseScore {
    /// Stable case id when supplied by the dataset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Human-readable case description when supplied by the dataset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Prompt variant id/name supplied by the caller, when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
    /// Model selected for this case.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Gateway provider selected for this case.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Rendered prompt sent to the provider, or the fixture prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rendered_prompt: Option<String>,
    /// Typed variables used for this case.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vars: Option<std::collections::HashMap<String, Value>>,
    /// Case metadata preserved for filtering and export.
    #[serde(default)]
    pub metadata: std::collections::HashMap<String, Value>,
    /// Optional reference/context payload used by model-graded assertions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Value>,
    /// Input tokens observed or estimated for this case.
    #[serde(default)]
    pub input_tokens: u64,
    /// Output tokens observed or estimated for this case.
    #[serde(default)]
    pub output_tokens: u64,
    /// Total provider tokens for this case.
    #[serde(default)]
    pub total_tokens: u64,
    /// Provider-reported cost in micro-USD, when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_micro_usd: Option<u64>,
    /// Raw provider/replay latency in milliseconds.
    #[serde(default)]
    pub latency_ms: u64,
    /// Whether `latency_ms` is an observed measurement rather than scorer time.
    #[serde(default = "default_true")]
    pub latency_available: bool,
    /// Whether this result reused a precomputed or in-run cached output.
    #[serde(default)]
    pub cache_hit: bool,
    /// Safe error detail when the provider or transform failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The original prompt.
    pub prompt: String,
    /// The response text the provider returned (or an error message).
    pub response_text: String,
    /// 1.0 = instant, 0.0 = at/beyond `max_latency_ms`. Always present.
    pub latency_score: f32,
    /// Ratio of output tokens to input tokens, clamped to [0, 1]. Always present.
    pub token_efficiency: f32,
    /// Whether the request passed all firewall/policy checks. Always present.
    pub policy_pass: bool,
    /// Whether Gateway actually measured this request's policy outcome.
    #[serde(default = "default_true")]
    pub policy_available: bool,
    /// Present only when the case had an `expected` value. 1.0 = match, 0.0 = no match.
    pub substring_match: Option<f32>,
    /// Weighted aggregate for this case. Weights vary based on which scorers
    /// and measurements are available; missing operational dimensions are
    /// excluded and the remaining weights are renormalized.
    pub overall: f32,
    /// NEW: per-assertion results (always present; [] when no assertions).
    pub assertions: Vec<AssertionResult>,
    /// Mean assertion score in [0, 1].
    pub assertion_score: f32,
    /// NEW: true iff every assertion in `assertions` passed (vacuously true for []).
    pub assertions_pass: bool,
    /// NEW (P2): per-evaluator scores for the registry evaluators requested for
    /// this case. Always present ([] when none requested). Additive to `overall`;
    /// never folded into it.
    #[serde(default)]
    pub evaluators: Vec<EvaluatorScore>,
}

/// Aggregate summary across all eval cases.
#[derive(Debug, Clone, Serialize)]
pub struct EvalRunAggregate {
    /// Mean `overall` score across all cases. Range [0, 1].
    pub mean_overall: f32,
    /// Mean latency score.
    pub mean_latency: f32,
    /// Number of cases with a measured latency value.
    #[serde(default)]
    pub latency_available_cases: usize,
    /// Mean token efficiency.
    pub mean_token_efficiency: f32,
    /// Fraction of cases where `policy_pass == true`. Range [0, 1].
    pub policy_pass_rate: f32,
    /// Number of cases whose policy outcome was measured by Gateway.
    #[serde(default)]
    pub policy_available_cases: usize,
    /// Mean substring match score across cases that had an `expected` value.
    /// `None` when no cases had `expected`.
    pub mean_substring_match: Option<f32>,
    /// Total number of cases run.
    pub total_cases: usize,
    /// Aggregate input token count.
    #[serde(default)]
    pub total_input_tokens: u64,
    /// Aggregate output token count.
    #[serde(default)]
    pub total_output_tokens: u64,
    /// Aggregate cost in micro-USD when every priced case reported a cost;
    /// otherwise `None` keeps the unknown-cost distinction visible.
    #[serde(default)]
    pub total_cost_micro_usd: Option<u64>,
    /// Fraction of cases whose assertion threshold passed.
    #[serde(default)]
    pub assertion_pass_rate: f32,
    /// NEW (P2): per-evaluator aggregate keyed by evaluator id. Empty when no
    /// registry evaluators were requested. Lets the UI render one row per
    /// evaluator (mean score, pass rate, executed count).
    #[serde(default)]
    pub evaluators: std::collections::HashMap<String, EvaluatorAggregate>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal case takes empty defaults, and `providerOutput` is accepted
    /// as the camelCase alias of a precomputed response.
    #[test]
    fn a_minimal_case_takes_defaults_and_accepts_the_camel_case_alias() {
        let case: EvalCase = serde_json::from_value(serde_json::json!({
            "prompt": "hi",
            "providerOutput": { "choices": [] },
            "options": { "transformVars": "json" },
        }))
        .expect("parses");
        assert_eq!(case.prompt, "hi");
        assert!(case.assertions.is_empty() && case.evaluators.is_empty());
        assert_eq!(case.threshold, None);
        assert!(case.provider_output.is_some());
        assert_eq!(case.options.transform_vars.as_deref(), Some("json"));
    }

    #[test]
    fn evaluator_scores_serialize_their_honesty_flag() {
        let score = EvaluatorScore {
            id: "toxicity".to_owned(),
            category: "safety".to_owned(),
            score: 0.0,
            pass: false,
            detail: "judge refused".to_owned(),
            executed: false,
        };
        let value = serde_json::to_value(&score).expect("serializes");
        assert_eq!(value["executed"], false);
        assert_eq!(value["pass"], false);
    }
}
