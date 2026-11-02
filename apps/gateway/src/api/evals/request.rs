//! Request bodies, model resolution and the eval feature tags.

use super::*;

/// Request body for POST /v1/evals/run.
#[derive(Debug, Deserialize)]
pub struct RunEvalsRequest {
    /// Model to evaluate (forwarded to the gateway pipeline as-is). The router
    /// decides which provider to use — no provider is hardcoded here. When
    /// omitted (and `models` is empty) the Gateway's configured default model
    /// is used (see [`configured_default_model`]); with none configured the
    /// request is rejected with 400 rather than assuming a vendor model.
    #[serde(default)]
    pub model: String,
    /// Optional agent/app id for per-agent budget tracking. When set it is
    /// forwarded as `x-ryu-agent-id` context to the pipeline.
    #[serde(alias = "agentId")]
    pub agent_id: Option<String>,
    /// Dataset to replay. When empty or absent, the built-in dataset is used.
    #[serde(default)]
    pub dataset: Vec<EvalCase>,

    // ── NEW ──
    /// Run-level system prompt. When present, every case's provider request
    /// prepends `{role:"system", content:<rendered system_prompt>}`. `{{vars}}`
    /// in it are substituted per-case using that case's `vars`.
    #[serde(default)]
    #[serde(alias = "systemPrompt")]
    pub system_prompt: Option<String>,
    /// Optional run-level multi-turn prompt variant. Rendered messages are
    /// prepended before each case's messages; `system_prompt` remains the
    /// backward-compatible text form and may be combined with this list.
    #[serde(default)]
    #[serde(alias = "systemMessages")]
    pub system_messages: Vec<crate::evals::EvalMessage>,
    /// Multi-model. When non-empty, the whole dataset runs against each model
    /// and the response gains a per-model `models` breakdown. `model` (singular)
    /// stays the back-compat default and seeds the top-level cases/aggregate.
    #[serde(default)]
    pub models: Vec<String>,
    /// Optional judge model override. When set, this single fixed model judges
    /// EVERY model's output (fair cross-model compare). When unset, the first
    /// model in the run is used as the single fixed judge.
    #[serde(default)]
    #[serde(alias = "judgeModel")]
    pub judge_model: Option<String>,

    // ── NEW (P2) ──
    /// Registry evaluator ids applied to EVERY case (unioned with each case's own
    /// `evaluators`). Empty by default => today's assertion-only behavior.
    #[serde(default)]
    pub evaluators: Vec<String>,
    /// Maximum number of provider calls allowed in parallel. The runner caps
    /// this to protect the local Gateway and budgets.
    #[serde(default)]
    #[serde(alias = "maxConcurrency")]
    pub max_concurrency: Option<usize>,
    /// Per-case provider deadline in milliseconds.
    #[serde(default)]
    #[serde(alias = "timeoutMs")]
    pub timeout_ms: Option<u64>,
    /// Repeat every input case this many times (capped server-side).
    #[serde(default)]
    pub repeat: Option<usize>,
    /// Reuse identical provider inputs during this run.
    #[serde(default)]
    pub cache: bool,
    /// Run-level tags kept in the result envelope.
    #[serde(default)]
    pub tags: std::collections::HashMap<String, String>,
    /// Prompt prefix/suffix applied to single-turn case prompts.
    #[serde(default)]
    pub prefix: Option<String>,
    #[serde(default)]
    pub suffix: Option<String>,
    /// Stable prompt variant id for result matrices.
    #[serde(default)]
    #[serde(alias = "promptId")]
    pub prompt_id: Option<String>,
}

/// The model an eval run or online score uses when the request names none, in
/// precedence order: `[evals].default_model`, then the model pinned for the
/// chat modality (`routing.modality_map.chat.model`, which already replaces the
/// caller's model on every chat request). `None` when neither is configured —
/// callers must then name a model; no vendor model is assumed.
pub(crate) fn configured_default_model(config: &crate::config::GatewayConfig) -> Option<String> {
    let pinned_chat = config
        .routing
        .modality_map
        .get(&crate::config::Modality::Chat)
        .and_then(|mapping| mapping.model.as_deref());
    [config.evals.default_model.as_deref(), pinned_chat]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|model| !model.is_empty())
        .map(str::to_owned)
}

/// The configured judge model (`[evals].judge_model`), trimmed; `None` when
/// unset so callers fall back to the model under test / that answered.
pub(crate) fn configured_judge_model(config: &crate::config::GatewayConfig) -> Option<String> {
    config
        .evals
        .judge_model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_owned)
}

/// `x-ryu-feature` stamped on eval traffic (dataset replays, online-score
/// judges). Online sampling skips it so eval calls are never re-scored.
pub(crate) const EVAL_FEATURE: &str = "eval";
/// Feature stamped on the judge calls the online scorer makes.
pub(crate) const ONLINE_EVAL_FEATURE: &str = "online-eval";

pub(super) fn tag_eval_context(mut ctx: pipeline::RequestContext) -> pipeline::RequestContext {
    ctx.feature = Some(EVAL_FEATURE.to_owned());
    ctx
}

pub(super) const NO_DEFAULT_MODEL_ERROR: &str = "model is required: this Gateway has no default model configured. Send `model` (or `models`), or set `[evals] default_model` in the Gateway config";

/// Fill an omitted `model` from the Gateway default. `Err` carries the 400
/// message when the request names no model and none is configured.
pub(super) fn resolve_request_model(
    model: &mut String,
    has_other_models: bool,
    config: &crate::config::GatewayConfig,
) -> Result<(), &'static str> {
    if has_other_models || !model.trim().is_empty() {
        return Ok(());
    }
    *model = configured_default_model(config).ok_or(NO_DEFAULT_MODEL_ERROR)?;
    Ok(())
}

/// Model label recorded on an online score that named no model, needed no judge,
/// and ran on a Gateway with no default model.
pub(super) const UNNAMED_ONLINE_SCORE_MODEL: &str = "unspecified";

/// Whether scoring this already-produced response calls a judge model: any
/// model-graded assertion (at any `AssertSet` depth) or an LLM-judge evaluator.
pub(super) fn online_score_needs_judge(
    assertions: &[Assertion],
    evaluators: &[String],
    registry: &EvaluatorRegistry,
) -> bool {
    assertions
        .iter()
        .any(|assertion| model_graded_assertion_count(assertion) > 0)
        || evaluators.iter().any(|id| {
            registry
                .get(id)
                .is_some_and(|evaluator| matches!(evaluator.impl_, EvaluatorImpl::LlmJudge { .. }))
        })
}

/// Request body for POST /v1/evals/score. This is the online-scoring seam:
/// callers submit an already-completed production output and receive the same
/// deterministic/assertion/evaluator result as a dataset run without replaying
/// the provider call. Optional latency and cost measurements are preserved so
/// operational assertions remain meaningful for externally observed traces.
#[derive(Debug, Deserialize)]
pub struct OnlineScoreRequest {
    #[serde(default)]
    #[serde(alias = "agentId")]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub assertions: Vec<Assertion>,
    #[serde(default)]
    #[serde(alias = "costMicroUsd")]
    pub cost_micro_usd: Option<u64>,
    #[serde(default)]
    pub context: Option<Value>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub evaluators: Vec<String>,
    #[serde(default)]
    pub expected: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    #[serde(alias = "latencyMs")]
    pub latency_ms: Option<u64>,
    /// Optional policy result supplied with an external trace. When omitted,
    /// the policy dimension is marked unmeasured rather than assumed to pass.
    #[serde(default, alias = "policyPass")]
    pub policy_pass: Option<bool>,
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
    /// Model that produced `response`. When omitted the Gateway's configured
    /// default model is used; with none configured the request is rejected.
    #[serde(default)]
    pub model: String,
    /// Judge for model-graded checks. Defaults to `[evals].judge_model`, then
    /// the model that produced `response`.
    #[serde(default, alias = "judgeModel")]
    pub judge_model: Option<String>,
    #[serde(default)]
    pub prompt: String,
    pub response: Value,
    #[serde(default)]
    pub threshold: Option<f32>,
    #[serde(default)]
    pub vars: HashMap<String, Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A request that names no model takes the configured default, and is
    /// refused when there is none; naming any model leaves it alone.
    #[test]
    fn a_missing_model_resolves_to_the_configured_default_or_is_refused() {
        let mut config = crate::config::GatewayConfig::default();
        let mut model = String::new();
        assert_eq!(
            resolve_request_model(&mut model, false, &config),
            Err(NO_DEFAULT_MODEL_ERROR)
        );
        assert!(resolve_request_model(&mut model, true, &config).is_ok());
        config.evals.default_model = Some("node-default".to_owned());
        resolve_request_model(&mut model, false, &config).expect("resolves");
        assert_eq!(model, "node-default");
    }

    #[test]
    fn online_scoring_needs_a_judge_only_for_model_graded_checks() {
        let registry = EvaluatorRegistry::new();
        let judged = Assertion::LlmJudge {
            rubric: "r".to_owned(),
            options: AssertionOptions::default(),
        };
        let plain = Assertion::Contains {
            value: "hi".to_owned(),
            options: AssertionOptions::default(),
        };
        assert!(online_score_needs_judge(&[judged], &[], &registry));
        assert!(!online_score_needs_judge(&[plain], &[], &registry));
        assert!(online_score_needs_judge(
            &[],
            &["toxicity".to_owned()],
            &registry
        ));
        assert!(!online_score_needs_judge(
            &[],
            &["pii_leakage".to_owned()],
            &registry
        ));
    }
}
