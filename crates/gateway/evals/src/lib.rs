//! Ryu Gateway evals stage (decomposition W6).
//!
//! Extracted from `apps/gateway/src/evals`: the live [`EvalsRunner`]
//! (per-request sampling + provider-score EMA) exposed as a swappable
//! [`EvalsBackend`] trait + [`EvalsRegistry`], plus the pure, network-free
//! dataset scorers ([`score_case`], [`aggregate_scores`], [`Assertion`],
//! judge helpers). Gateway re-exports the whole crate via `crate::evals` so
//! every call site is unchanged; [`EvalsConfig`] is re-exported from
//! `crate::config` so `GatewayConfig` still embeds `evals`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use dashmap::DashMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::debug;

pub mod online;
pub use online::OnlineEvalsConfig;

// ─── Evals config (moved verbatim from gateway `config.rs`) ──────────────────
//
// The serde-shaped config the runner consumes. It lives here (not in gateway
// `config.rs`) so this stage crate is self-contained; gateway `config.rs`
// re-exports it so `crate::config::EvalsConfig` is unchanged and
// `GatewayConfig` still embeds `evals`.

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EvalsConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Latency (ms) at which the latency score drops to 0. Default: 10 000 ms.
    #[serde(default = "default_max_latency_ms")]
    pub max_latency_ms: u64,
    /// Fraction of completed requests to score, in `[0.0, 1.0]`.
    /// `1.0` scores every request; `0.0` disables scoring entirely.
    /// Sampling keeps eval overhead bounded under load. Default: 1.0.
    #[serde(default = "default_sample_rate")]
    pub sample_rate: f32,
    /// Inject `stream_options.include_usage=true` into streamed requests so
    /// the provider emits a terminal usage frame that the gateway can parse
    /// to record non-zero token counts and run eval scoring at stream end.
    ///
    /// Only conforming providers (OpenAI and OpenAI-compatible) honour this
    /// flag. Non-conforming providers fall back to `estimate_prompt_tokens`.
    /// Default: true (on by default for all OpenAI-compatible providers).
    #[serde(default = "default_true")]
    pub stream_usage: bool,
    /// Model that `POST /v1/evals/run` and `POST /v1/evals/score` use when a
    /// request names no `model`/`models`. `None` (the default) means callers
    /// must name a model: the Gateway never assumes a vendor model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    /// Model that judges LLM-judge assertions/evaluators when neither the
    /// evaluator (`offline.judgeModel`) nor the request names one. `None`
    /// keeps the previous behavior: the run's first model (dataset runs) or
    /// the model that produced the response (online scoring) judges.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judge_model: Option<String>,
    /// `[evals.online]`: score a sampled fraction of production traffic with
    /// catalog evaluators off the request path (opt-in; see [`online`]).
    #[serde(default)]
    pub online: OnlineEvalsConfig,
}

fn default_true() -> bool {
    true
}

fn default_max_latency_ms() -> u64 {
    10_000
}

fn default_sample_rate() -> f32 {
    1.0
}

impl Default for EvalsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_latency_ms: default_max_latency_ms(),
            sample_rate: default_sample_rate(),
            stream_usage: true,
            default_model: None,
            judge_model: None,
            online: OnlineEvalsConfig::default(),
        }
    }
}

/// Scores for a single completed request.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct EvalResult {
    /// 1.0 = instant, 0.0 = at or beyond `max_latency_ms`.
    pub latency_score: f32,
    /// Ratio of output tokens to input tokens, clamped to [0, 1].
    /// Higher means the model produced proportionally more output (loosely useful).
    pub token_efficiency: f32,
    /// Whether the request passed all firewall/policy checks.
    pub policy_pass: bool,
    /// Weighted overall score: 0.4·latency + 0.3·token_eff + 0.3·policy.
    pub overall: f32,
}

/// Rolling exponential-moving-average score for a single provider.
///
/// Stored as a fixed-point `u64` (score × `SCALE`) so it can live in a lock-free
/// `DashMap` and be read on the (hot) routing path without taking a mutex.
struct ProviderScore {
    /// EMA of `overall`, fixed-point (× `SCALE`).
    ema: AtomicU64,
    /// Number of scored samples that have fed this average.
    samples: AtomicU64,
}

const SCALE: f32 = 1_000_000.0;
/// Weight given to each new sample in the EMA. Smaller = smoother/slower.
const EMA_ALPHA: f32 = 0.2;

pub struct EvalsRunner {
    config: EvalsConfig,
    /// Provider name → rolling eval score. Feeds eval-driven routing.
    provider_scores: DashMap<String, ProviderScore>,
    /// Monotonic counter used for deterministic sampling without an RNG dep.
    sample_counter: AtomicU64,
}

impl EvalsRunner {
    pub fn new(config: EvalsConfig) -> Self {
        Self {
            config,
            provider_scores: DashMap::new(),
            sample_counter: AtomicU64::new(0),
        }
    }

    /// Decide whether the current request should be scored.
    ///
    /// Returns `false` when evals are disabled or the configured `sample_rate`
    /// excludes this request. Sampling is deterministic and evenly spaced so a
    /// rate of `0.25` scores roughly one request in four.
    pub fn should_sample(&self) -> bool {
        if !self.config.enabled {
            return false;
        }
        let rate = self.config.sample_rate.clamp(0.0, 1.0);
        if rate >= 1.0 {
            return true;
        }
        if rate <= 0.0 {
            return false;
        }

        // Evenly-spaced deterministic sampling: increment a counter and keep the
        // request whenever crossing a 1/rate boundary.
        let n = self.sample_counter.fetch_add(1, Ordering::Relaxed);
        let period = (1.0 / rate).round().max(1.0) as u64;
        n % period == 0
    }

    /// Score a completed (non-streaming) response.
    ///
    /// Returns `None` when evals are disabled. Callers gate this with
    /// [`should_sample`](Self::should_sample); it does not re-check the rate.
    pub fn score(
        &self,
        latency_ms: u64,
        response: &Value,
        policy_pass: bool,
    ) -> Option<EvalResult> {
        if !self.config.enabled {
            return None;
        }

        let max = self.config.max_latency_ms as f32;
        let latency_score = if max == 0.0 {
            1.0
        } else {
            (1.0 - (latency_ms as f32 / max)).clamp(0.0, 1.0)
        };

        let input_tokens = response["usage"]["prompt_tokens"]
            .as_u64()
            .unwrap_or(1)
            .max(1) as f32;
        let output_tokens = response["usage"]["completion_tokens"].as_u64().unwrap_or(0) as f32;
        // Normalise to [0, 1]: clamp ratio at 2× (very verbose) = 1.0.
        let token_efficiency = (output_tokens / input_tokens / 2.0).clamp(0.0, 1.0);

        let policy_score = if policy_pass { 1.0_f32 } else { 0.0 };

        let overall = 0.4 * latency_score + 0.3 * token_efficiency + 0.3 * policy_score;

        debug!(
            latency_ms,
            latency_score, token_efficiency, policy_pass, overall, "eval scores"
        );

        Some(EvalResult {
            latency_score,
            token_efficiency,
            policy_pass,
            overall,
        })
    }

    /// Fold a fresh `overall` score into the rolling average for `provider`.
    /// This is what closes the loop: routing later reads these averages.
    pub fn record_provider_score(&self, provider: &str, overall: f32) {
        let entry = self
            .provider_scores
            .entry(provider.to_string())
            .or_insert_with(|| ProviderScore {
                ema: AtomicU64::new((overall * SCALE) as u64),
                samples: AtomicU64::new(0),
            });

        let prev_samples = entry.samples.fetch_add(1, Ordering::Relaxed);
        if prev_samples == 0 {
            // First sample seeds the EMA directly (already done above when newly
            // inserted, but an existing zero-sample entry needs the seed too).
            entry.ema.store((overall * SCALE) as u64, Ordering::Relaxed);
            return;
        }

        let prev = entry.ema.load(Ordering::Relaxed) as f32 / SCALE;
        let next = (1.0 - EMA_ALPHA) * prev + EMA_ALPHA * overall;
        entry.ema.store((next * SCALE) as u64, Ordering::Relaxed);
    }

    /// Snapshot every provider's current rolling eval score (those scored at
    /// least once). Used by the control-plane reporter to push eval data up.
    pub fn all_provider_scores(&self) -> std::collections::HashMap<String, f32> {
        self.provider_scores
            .iter()
            .filter(|e| e.value().samples.load(Ordering::Relaxed) > 0)
            .map(|e| {
                let score = e.value().ema.load(Ordering::Relaxed) as f32 / SCALE;
                (e.key().clone(), score)
            })
            .collect()
    }

    /// Total number of requests that have been considered for sampling (regardless
    /// of whether they were actually scored). Used by metrics consumers to report
    /// sampling throughput.
    pub fn sampled_count(&self) -> u64 {
        self.sample_counter.load(Ordering::Relaxed)
    }

    /// Current rolling eval score for `provider`, if it has been scored at least
    /// once. Used by eval-driven routing to pick the leader.
    pub fn provider_score(&self, provider: &str) -> Option<f32> {
        self.provider_scores.get(provider).and_then(|s| {
            if s.samples.load(Ordering::Relaxed) == 0 {
                None
            } else {
                Some(s.ema.load(Ordering::Relaxed) as f32 / SCALE)
            }
        })
    }
}

// ─── Swappable evals backend (Lg decomposition) ──────────────────────────────

/// The live eval runner (per-request sampling + provider-score EMA) as a
/// swappable capability. The built-in [`EvalsRunner`] is the default; an
/// alternative scorer can register without touching the pipeline, mirroring the
/// gateway `providers::ProviderRegistry` inversion. The pure dataset scorers
/// (`score_case`, `aggregate_scores`, `builtin_dataset`, …) stay free module
/// functions — they are backend-independent and their call sites name them
/// directly.
pub trait EvalsBackend: Send + Sync {
    /// Whether the current request should be scored.
    fn should_sample(&self) -> bool;
    /// Score a completed non-streaming response (`None` when disabled).
    fn score(&self, latency_ms: u64, response: &Value, policy_pass: bool) -> Option<EvalResult>;
    /// Fold a fresh `overall` score into `provider`'s rolling average.
    fn record_provider_score(&self, provider: &str, overall: f32);
    /// Snapshot every scored provider's rolling eval score.
    fn all_provider_scores(&self) -> std::collections::HashMap<String, f32>;
    /// Total requests considered for sampling.
    fn sampled_count(&self) -> u64;
    /// Current rolling eval score for `provider`, if scored at least once.
    fn provider_score(&self, provider: &str) -> Option<f32>;
}

impl EvalsBackend for EvalsRunner {
    fn should_sample(&self) -> bool {
        EvalsRunner::should_sample(self)
    }
    fn score(&self, latency_ms: u64, response: &Value, policy_pass: bool) -> Option<EvalResult> {
        EvalsRunner::score(self, latency_ms, response, policy_pass)
    }
    fn record_provider_score(&self, provider: &str, overall: f32) {
        EvalsRunner::record_provider_score(self, provider, overall);
    }
    fn all_provider_scores(&self) -> std::collections::HashMap<String, f32> {
        EvalsRunner::all_provider_scores(self)
    }
    fn sampled_count(&self) -> u64 {
        EvalsRunner::sampled_count(self)
    }
    fn provider_score(&self, provider: &str) -> Option<f32> {
        EvalsRunner::provider_score(self, provider)
    }
}

/// Id-keyed registry over [`EvalsBackend`] implementations. The built-in
/// [`EvalsRunner`] is registered first under [`EvalsRegistry::BUILTIN`] and
/// active by default, so behavior is byte-identical with no config change.
/// Delegating verbs forward to the active backend, keeping every call site
/// unchanged.
pub struct EvalsRegistry {
    backends: std::collections::HashMap<String, std::sync::Arc<dyn EvalsBackend>>,
    order: Vec<String>,
    active_id: String,
    active: std::sync::Arc<dyn EvalsBackend>,
}

impl EvalsRegistry {
    /// Stable id of the built-in eval runner.
    pub const BUILTIN: &'static str = "builtin";

    /// Build the registry from config, registering a fresh built-in
    /// [`EvalsRunner`] as the default active backend.
    pub fn new(config: EvalsConfig) -> Self {
        Self::from_runner(EvalsRunner::new(config))
    }

    /// Build the registry around an already-constructed [`EvalsRunner`],
    /// registering it as the built-in active backend. Lets a caller (e.g. a test)
    /// keep a handle to the exact runner the pipeline will use.
    pub fn from_runner(runner: EvalsRunner) -> Self {
        let builtin: std::sync::Arc<dyn EvalsBackend> = std::sync::Arc::new(runner);
        let mut registry = Self {
            backends: std::collections::HashMap::new(),
            order: Vec::new(),
            active_id: Self::BUILTIN.to_string(),
            active: std::sync::Arc::clone(&builtin),
        };
        registry.register(Self::BUILTIN, builtin);
        registry
    }

    /// Register a backend under a stable id (open extension point). Re-registering
    /// replaces in place; refreshes the live handle if it is the active id.
    pub fn register(&mut self, id: impl Into<String>, backend: std::sync::Arc<dyn EvalsBackend>) {
        let id = id.into();
        if !self.backends.contains_key(&id) {
            self.order.push(id.clone());
        }
        let is_active = id == self.active_id;
        self.backends.insert(id, std::sync::Arc::clone(&backend));
        if is_active {
            self.active = backend;
        }
    }

    /// Select the active backend by id. `false` (unchanged) if `id` is unknown.

    pub fn set_active(&mut self, id: &str) -> bool {
        match self.backends.get(id) {
            Some(backend) => {
                self.active = std::sync::Arc::clone(backend);
                self.active_id = id.to_string();
                true
            }
            None => false,
        }
    }

    /// The id of the currently active backend.

    #[allow(dead_code)]
    pub fn active_id(&self) -> &str {
        &self.active_id
    }

    /// The registered backend ids in registration order.

    pub fn available(&self) -> Vec<String> {
        self.order.clone()
    }

    // ─── Delegating verbs (byte-identical call sites) ────────────────────────

    /// See [`EvalsBackend::should_sample`].
    pub fn should_sample(&self) -> bool {
        self.active.should_sample()
    }

    /// See [`EvalsBackend::score`].
    pub fn score(
        &self,
        latency_ms: u64,
        response: &Value,
        policy_pass: bool,
    ) -> Option<EvalResult> {
        self.active.score(latency_ms, response, policy_pass)
    }

    /// See [`EvalsBackend::record_provider_score`].
    pub fn record_provider_score(&self, provider: &str, overall: f32) {
        self.active.record_provider_score(provider, overall);
    }

    /// See [`EvalsBackend::all_provider_scores`].
    pub fn all_provider_scores(&self) -> std::collections::HashMap<String, f32> {
        self.active.all_provider_scores()
    }

    /// See [`EvalsBackend::sampled_count`].
    pub fn sampled_count(&self) -> u64 {
        self.active.sampled_count()
    }

    /// See [`EvalsBackend::provider_score`].
    pub fn provider_score(&self, provider: &str) -> Option<f32> {
        self.active.provider_score(provider)
    }
}

// ─── Dataset eval runner ─────────────────────────────────────────────────────
//
// v1 scorers: latency, token_efficiency, policy_pass, substring_match (optional).
// LLM-judge has since shipped, split across this crate's boundary: both pure
// halves live here — `build_judge_prompt` renders the rubric into a prompt and
// `parse_judge_verdict` reads the reply back into `(pass, score)` — but the
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
#[derive(Debug, Clone, Serialize)]
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
}

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

/// Score a single case from raw provider output.
///
/// This is the pure, network-free scoring function. It is called both by the
/// production runner (after `pipeline::run`) and by unit tests with canned
/// provider responses — so tests don't need a live provider to verify scoring
/// logic satisfies the v1 acceptance criteria.
///
/// `max_latency_ms` should come from `EvalsConfig::max_latency_ms`. When 0,
/// latency scoring defaults to 1.0 (unconfigured gateway scores full marks).
pub fn score_case(
    case: &EvalCase,
    response: &Value,
    latency_ms: u64,
    policy_pass: bool,
    max_latency_ms: u64,
) -> CaseScore {
    let max = max_latency_ms as f32;
    let latency_score = if max == 0.0 {
        1.0
    } else {
        (1.0 - (latency_ms as f32 / max)).clamp(0.0, 1.0)
    };

    let input_tokens = response["usage"]["prompt_tokens"]
        .as_u64()
        .unwrap_or(1)
        .max(1) as f32;
    let output_tokens = response["usage"]["completion_tokens"].as_u64().unwrap_or(0) as f32;
    let token_efficiency = (output_tokens / input_tokens / 2.0).clamp(0.0, 1.0);

    let policy_score = if policy_pass { 1.0_f32 } else { 0.0 };

    // Extract response text for substring matching.
    let response_text = response["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let substring_match = case.expected.as_ref().map(|expected| {
        if response_text
            .to_lowercase()
            .contains(&expected.to_lowercase())
        {
            1.0_f32
        } else {
            0.0
        }
    });

    let overall = match substring_match {
        Some(sm) => 0.3 * latency_score + 0.2 * token_efficiency + 0.2 * policy_score + 0.3 * sm,
        None => 0.4 * latency_score + 0.3 * token_efficiency + 0.3 * policy_score,
    };

    CaseScore {
        id: case.id.clone(),
        description: case.description.clone(),
        prompt_id: None,
        model: None,
        provider: None,
        rendered_prompt: None,
        vars: Some(case.vars.clone()),
        metadata: case.metadata.clone(),
        context: case.context.clone(),
        input_tokens: response["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
        output_tokens: response["usage"]["completion_tokens"].as_u64().unwrap_or(0),
        total_tokens: response["usage"]["total_tokens"]
            .as_u64()
            .unwrap_or_else(|| {
                response["usage"]["prompt_tokens"].as_u64().unwrap_or(0)
                    + response["usage"]["completion_tokens"].as_u64().unwrap_or(0)
            }),
        cost_micro_usd: response["usage"]["cost_micro_usd"].as_u64(),
        latency_ms,
        latency_available: true,
        cache_hit: false,
        error: None,
        prompt: case.prompt.clone(),
        response_text,
        latency_score,
        token_efficiency,
        policy_pass,
        policy_available: true,
        substring_match,
        overall,
        // NEW — neutral defaults; Implementer B overwrites these via the pub
        // fields after calling score_case (assertions are evaluated in evals.rs,
        // where the pipeline state/ctx for llm_judge is in scope).
        assertions: Vec::new(),
        assertion_score: 1.0,
        assertions_pass: true,
        // NEW (P2) — evaluator scores are attached by the api runner after
        // score_evaluators runs (it needs pipeline state for llm_judge).
        evaluators: Vec::new(),
    }
}

/// Mark operational dimensions that were not measured and renormalize the
/// case score over the remaining dimensions. Batch result scoring uses this for
/// Gateway policy, which the provider's separate asynchronous request did not
/// execute.
pub fn set_measurement_availability(
    score: &mut CaseScore,
    latency_available: bool,
    policy_available: bool,
) {
    score.latency_available = latency_available;
    score.policy_available = policy_available;
    if !policy_available {
        score.policy_pass = false;
    }

    let (latency_weight, token_weight, policy_weight, substring_weight) =
        if score.substring_match.is_some() {
            (0.3, 0.2, 0.2, 0.3)
        } else {
            (0.4, 0.3, 0.3, 0.0)
        };
    let mut weighted_score = 0.0;
    let mut available_weight = 0.0;
    if latency_available {
        weighted_score += latency_weight * score.latency_score;
        available_weight += latency_weight;
    }
    weighted_score += token_weight * score.token_efficiency;
    available_weight += token_weight;
    if policy_available {
        weighted_score += policy_weight * if score.policy_pass { 1.0 } else { 0.0 };
        available_weight += policy_weight;
    }
    if let Some(substring_match) = score.substring_match {
        weighted_score += substring_weight * substring_match;
        available_weight += substring_weight;
    }
    score.overall = if available_weight > 0.0 {
        weighted_score / available_weight
    } else {
        0.0
    };
}

// ─── Assertion + variable-substitution helpers ───────────────────────────────

/// Render Promptfoo-compatible prompt expressions using typed variables.
///
/// The renderer intentionally stays deterministic and bounded. It supports the
/// editor's portable subset of Nunjucks: dotted lookup, `upper`, `lower`,
/// `default`, `join`, `length`, `if/else`, and `for` blocks. Unknown expressions
/// remain literal so a typo cannot silently erase prompt text.
pub fn render_template(template: &str, vars: &std::collections::HashMap<String, Value>) -> String {
    render_template_scope(template, vars, 0)
}

/// Backward-compatible name used by existing Gateway call sites.
pub fn substitute_vars(template: &str, vars: &std::collections::HashMap<String, Value>) -> String {
    render_template(template, vars)
}

const MAX_RENDERED_TEMPLATE_CHARS: usize = 262_144;

fn render_template_scope(
    template: &str,
    vars: &std::collections::HashMap<String, Value>,
    depth: usize,
) -> String {
    if depth > 12 {
        return template.to_owned();
    }
    let mut body = template.to_owned();
    body = render_for_blocks(&body, vars, depth);
    body = render_if_blocks(&body, vars, depth);
    let mut rendered = String::with_capacity(body.len());
    let mut cursor = 0;
    while let Some(relative_start) = body[cursor..].find("{{") {
        let start = cursor + relative_start;
        rendered.push_str(&body[cursor..start]);
        let Some(relative_end) = body[start + 2..].find("}}") else {
            rendered.push_str(&body[start..]);
            cursor = body.len();
            break;
        };
        let end = start + 2 + relative_end;
        let expression = body[start + 2..end].trim();
        rendered.push_str(
            &render_expression(expression, vars).unwrap_or_else(|| body[start..end + 2].to_owned()),
        );
        cursor = end + 2;
        if rendered.chars().count() >= MAX_RENDERED_TEMPLATE_CHARS {
            return rendered.chars().take(MAX_RENDERED_TEMPLATE_CHARS).collect();
        }
    }
    if cursor < body.len() {
        rendered.push_str(&body[cursor..]);
    }
    rendered.chars().take(MAX_RENDERED_TEMPLATE_CHARS).collect()
}

fn render_for_blocks(
    template: &str,
    vars: &std::collections::HashMap<String, Value>,
    depth: usize,
) -> String {
    let Some(start) = template.find("{% for ") else {
        return template.to_owned();
    };
    let Some(open_end_relative) = template[start..].find("%}") else {
        return template.to_owned();
    };
    let open_end = start + open_end_relative + 2;
    let header = template[start + 7..open_end - 2].trim();
    let Some((item, collection)) = header.split_once(" in ") else {
        return template.to_owned();
    };
    let Some(close_relative) = template[open_end..].find("{% endfor %}") else {
        return template.to_owned();
    };
    let close_start = open_end + close_relative;
    let inner = &template[open_end..close_start];
    let mut replacement = String::new();
    if let Some(Value::Array(values)) = lookup_value(vars, collection.trim()) {
        for value in values {
            let mut scoped = vars.clone();
            scoped.insert(item.trim().to_owned(), value.clone());
            replacement.push_str(&render_template_scope(inner, &scoped, depth + 1));
        }
    }
    let suffix_start = close_start + "{% endfor %}".len();
    let mut result = String::with_capacity(template.len());
    result.push_str(&template[..start]);
    result.push_str(&replacement);
    result.push_str(&render_for_blocks(&template[suffix_start..], vars, depth));
    result
}

fn render_if_blocks(
    template: &str,
    vars: &std::collections::HashMap<String, Value>,
    depth: usize,
) -> String {
    let Some(start) = template.find("{% if ") else {
        return template.to_owned();
    };
    let Some(open_end_relative) = template[start..].find("%}") else {
        return template.to_owned();
    };
    let open_end = start + open_end_relative + 2;
    let condition = template[start + 6..open_end - 2].trim();
    let Some(close_relative) = template[open_end..].find("{% endif %}") else {
        return template.to_owned();
    };
    let close_start = open_end + close_relative;
    let inner = &template[open_end..close_start];
    let (when_true, when_false) = inner
        .split_once("{% else %}")
        .map_or((inner, ""), |parts| parts);
    let chosen = if eval_condition(condition, vars) {
        when_true
    } else {
        when_false
    };
    let replacement = render_template_scope(chosen, vars, depth + 1);
    let suffix_start = close_start + "{% endif %}".len();
    let mut result = String::with_capacity(template.len());
    result.push_str(&template[..start]);
    result.push_str(&replacement);
    result.push_str(&render_if_blocks(&template[suffix_start..], vars, depth));
    result
}

fn eval_condition(expression: &str, vars: &std::collections::HashMap<String, Value>) -> bool {
    let expression = expression.trim();
    if let Some(negated) = expression.strip_prefix("not ") {
        return !eval_condition(negated, vars);
    }
    for operator in ["==", "!="] {
        if let Some((left, right)) = expression.split_once(operator) {
            let left = lookup_value(vars, left.trim());
            let right = parse_literal(right.trim()).or_else(|| lookup_value(vars, right.trim()));
            let equal = left.is_some() && left == right;
            return if operator == "==" { equal } else { !equal };
        }
    }
    lookup_value(vars, expression).is_some_and(|value| is_truthy(&value))
}

fn render_expression(
    expression: &str,
    vars: &std::collections::HashMap<String, Value>,
) -> Option<String> {
    let mut parts = expression.split('|').map(str::trim);
    let first = parts.next()?.trim();
    let mut value = lookup_value(vars, first)?;
    for filter in parts {
        let (name, argument) = filter
            .split_once('(')
            .map_or((filter, None), |(name, rest)| {
                (name.trim(), Some(rest.trim_end_matches(')').trim()))
            });
        value = match name {
            "upper" => Value::String(stringify_value(&value).to_uppercase()),
            "lower" => Value::String(stringify_value(&value).to_lowercase()),
            "default" => {
                if is_truthy(&value) {
                    value
                } else {
                    Value::String(argument.unwrap_or("").trim_matches(['\"', '\'']).to_owned())
                }
            }
            "join" => {
                let separator = argument.unwrap_or(", ").trim_matches(['\"', '\'']);
                let Value::Array(items) = value else {
                    return None;
                };
                Value::String(
                    items
                        .iter()
                        .map(stringify_value)
                        .collect::<Vec<_>>()
                        .join(separator),
                )
            }
            "length" => match value {
                Value::Array(items) => Value::Number((items.len() as u64).into()),
                Value::Object(items) => Value::Number((items.len() as u64).into()),
                Value::String(text) => Value::Number((text.chars().count() as u64).into()),
                _ => return None,
            },
            _ => return None,
        };
    }
    Some(stringify_value(&value))
}

fn lookup_value(vars: &std::collections::HashMap<String, Value>, path: &str) -> Option<Value> {
    let mut segments = path.trim().split('.');
    let mut value = vars.get(segments.next()?)?.clone();
    for segment in segments {
        value = value.get(segment)?.clone();
    }
    Some(value)
}

fn parse_literal(value: &str) -> Option<Value> {
    let value = value.trim();
    if value.starts_with(['\"', '\'']) && value.ends_with(['\"', '\'']) {
        return Some(Value::String(value[1..value.len() - 1].to_owned()));
    }
    serde_json::from_str(value).ok()
}

fn stringify_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(items) => !items.is_empty(),
    }
}
/// Runtime measurements available to operational assertions. Missing values
/// stay explicit: a latency/cost assertion cannot pass when its provider did
/// not return the corresponding measurement.
#[derive(Debug, Clone, Copy, Default)]
pub struct AssertionMetrics {
    pub latency_ms: Option<u64>,
    pub cost_micro_usd: Option<u64>,
}

fn assertion_options(assertion: &Assertion) -> &AssertionOptions {
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

/// Evaluate one deterministic assertion (everything except model-graded
/// assertions) against `response_text`.
pub fn eval_assertion_deterministic(assertion: &Assertion, response_text: &str) -> AssertionResult {
    eval_assertion_deterministic_with_metrics(assertion, response_text, AssertionMetrics::default())
}

/// Metrics-aware deterministic assertion evaluator used by the Gateway runner.
pub fn eval_assertion_deterministic_with_metrics(
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
        },
        assertion_options(assertion),
    )
}

fn is_html_like(value: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)<[a-z][^>]*>.*</[a-z][^>]*>").expect("valid html regex"))
        .is_match(value.trim())
}

fn is_xml_like(value: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?s)^<[A-Za-z_][\w:.-]*(?:\s[^>]*)?>.*</[A-Za-z_][\w:.-]*>$")
            .expect("valid xml regex")
    })
    .is_match(value.trim())
}

fn is_sql_like(value: &str) -> bool {
    let upper = value.trim_start().to_uppercase();
    [
        "SELECT ", "INSERT ", "UPDATE ", "DELETE ", "WITH ", "CREATE ", "ALTER ", "DROP ",
    ]
    .iter()
    .any(|prefix| upper.starts_with(prefix))
}

fn normalized_levenshtein(left: &str, right: &str) -> f32 {
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    if left.is_empty() && right.is_empty() {
        return 1.0;
    }
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for (left_index, left_char) in left.iter().enumerate() {
        let mut current = vec![left_index + 1; right.len() + 1];
        for (right_index, right_char) in right.iter().enumerate() {
            current[right_index + 1] = if left_char == right_char {
                previous[right_index]
            } else {
                1 + previous[right_index]
                    .min(previous[right_index + 1])
                    .min(current[right_index])
            };
        }
        previous = current;
    }
    1.0 - previous[right.len()] as f32 / left.len().max(right.len()) as f32
}

fn comma_values(value: &str) -> Vec<&str> {
    value
        .split(',')
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .collect()
}
/// Build the judge prompt embedding the rubric + the model output under test.
pub fn build_judge_prompt(rubric: &str, output: &str) -> String {
    const MAX_JUDGE_TEXT_CHARS: usize = 16_384;
    let rubric = truncate_chars(rubric, MAX_JUDGE_TEXT_CHARS);
    let output = truncate_chars(output, MAX_JUDGE_TEXT_CHARS);
    format!(
        "You are an evaluation judge. Rubric:\n{rubric}\n\nOutput under test:\n\"\"\"\n{output}\n\"\"\"\n\nReply on one line: VERDICT: PASS or FAIL, then SCORE: <0..1>. Example: 'VERDICT: PASS SCORE: 0.9'."
    )
}

/// Parse a judge model's raw text into `(pass, score)`. Defensive,
/// fail-safe = fail (mirrors the `/goal` "MET: yes/no — reason" judge primitive).
pub fn parse_judge_verdict(judge_text: &str) -> (bool, f32) {
    let lower = judge_text.to_lowercase();
    let has_pass = lower.contains("pass");
    let has_fail = lower.contains("fail");

    // Neither verdict present => defensive fail.
    if !has_pass && !has_fail {
        return (false, 0.0);
    }

    let pass = has_pass && !has_fail;

    // First float in the text, clamped to [0,1]; else derive from pass.
    let score = first_float(judge_text)
        .map(|f| f.clamp(0.0, 1.0))
        .unwrap_or(if pass { 1.0 } else { 0.0 });

    (pass, score)
}

/// Extract the first float-like token from a string.
fn first_float(text: &str) -> Option<f32> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"[0-9]*\.?[0-9]+").expect("valid float regex"));
    re.find(text).and_then(|m| m.as_str().parse::<f32>().ok())
}

/// Char-safe truncation helper for judge detail text (never panics, never
/// splits a UTF-8 boundary). Returns at most `max_chars` characters.
pub fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// Aggregate a slice of per-case scores into a summary.
pub fn aggregate_scores(cases: &[CaseScore]) -> EvalRunAggregate {
    let n = cases.len();
    if n == 0 {
        return EvalRunAggregate {
            mean_overall: 0.0,
            mean_latency: 0.0,
            latency_available_cases: 0,
            mean_token_efficiency: 0.0,
            policy_pass_rate: 0.0,
            policy_available_cases: 0,
            mean_substring_match: None,
            total_cases: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cost_micro_usd: Some(0),
            assertion_pass_rate: 0.0,
            evaluators: std::collections::HashMap::new(),
        };
    }

    let nf = n as f32;
    let mean_overall = cases.iter().map(|c| c.overall).sum::<f32>() / nf;
    let latency_scores: Vec<f32> = cases
        .iter()
        .filter(|case| case.latency_available)
        .map(|case| case.latency_score)
        .collect();
    let latency_available_cases = latency_scores.len();
    let mean_latency = if latency_available_cases == 0 {
        0.0
    } else {
        latency_scores.iter().sum::<f32>() / latency_available_cases as f32
    };
    let mean_token_efficiency = cases.iter().map(|c| c.token_efficiency).sum::<f32>() / nf;
    let policy_cases: Vec<&CaseScore> = cases.iter().filter(|case| case.policy_available).collect();
    let policy_available_cases = policy_cases.len();
    let policy_pass_rate = if policy_available_cases == 0 {
        0.0
    } else {
        policy_cases.iter().filter(|case| case.policy_pass).count() as f32
            / policy_available_cases as f32
    };

    let substring_cases: Vec<f32> = cases.iter().filter_map(|c| c.substring_match).collect();
    let mean_substring_match = if substring_cases.is_empty() {
        None
    } else {
        Some(substring_cases.iter().sum::<f32>() / substring_cases.len() as f32)
    };

    let total_input_tokens = cases.iter().map(|case| case.input_tokens).sum();
    let total_output_tokens = cases.iter().map(|case| case.output_tokens).sum();
    let priced_cases: Vec<u64> = cases
        .iter()
        .filter_map(|case| case.cost_micro_usd)
        .collect();
    let total_cost_micro_usd =
        (priced_cases.len() == cases.len()).then(|| priced_cases.iter().sum());
    let assertion_pass_rate = cases.iter().filter(|case| case.assertions_pass).count() as f32 / nf;

    let evaluators = aggregate_evaluators(cases);

    EvalRunAggregate {
        mean_overall,
        mean_latency,
        latency_available_cases,
        mean_token_efficiency,
        policy_pass_rate,
        policy_available_cases,
        mean_substring_match,
        total_cases: n,
        total_input_tokens,
        total_output_tokens,
        total_cost_micro_usd,
        assertion_pass_rate,
        evaluators,
    }
}

/// Roll per-case [`EvaluatorScore`]s up into one [`EvaluatorAggregate`] per
/// evaluator id. Means and pass rates are computed over cases where the
/// evaluator actually executed (`executed == true`); an evaluator that was
/// requested but never executed still appears with a zeroed aggregate + a
/// truthful `executed_count` of 0, so the UI can show it was skipped rather than
/// hiding it.
fn aggregate_evaluators(
    cases: &[CaseScore],
) -> std::collections::HashMap<String, EvaluatorAggregate> {
    // id -> (sum_score_executed, pass_executed, executed_count, seen)
    let mut acc: std::collections::HashMap<String, (f32, usize, usize, bool)> =
        std::collections::HashMap::new();

    for case in cases {
        for es in &case.evaluators {
            let entry = acc.entry(es.id.clone()).or_insert((0.0, 0, 0, false));
            entry.3 = true;
            if es.executed {
                entry.0 += es.score;
                if es.pass {
                    entry.1 += 1;
                }
                entry.2 += 1;
            }
        }
    }

    acc.into_iter()
        .map(|(id, (sum_score, pass_count, executed_count, _seen))| {
            let (mean_score, pass_rate) = if executed_count > 0 {
                (
                    sum_score / executed_count as f32,
                    pass_count as f32 / executed_count as f32,
                )
            } else {
                (0.0, 0.0)
            };
            (
                id,
                EvaluatorAggregate {
                    mean_score,
                    pass_rate,
                    executed_count,
                },
            )
        })
        .collect()
}

/// Pure score→pass mapping for offline evaluators, **polarity-aware** so "pass"
/// always means GOOD regardless of which direction the raw score runs:
///   * `higher_is_better == true` (quality/correctness; and the security regex
///     detectors whose 1.0 means "clean") — pass when `score >= threshold`.
///   * `higher_is_better == false` (negative-signal judges: toxicity, bias,
///     hallucination, …) — a HIGH score is BAD, so pass when `score < threshold`
///     (a toxic output scoring 1.0 must NOT pass).
///
/// Extracted so the threshold logic is unit-testable without a live provider.
pub fn judge_pass(score: f32, threshold: f32, higher_is_better: bool) -> bool {
    if higher_is_better {
        score >= threshold
    } else {
        score < threshold
    }
}

/// Resolve which model judges an LLM-judge evaluator offline, in precedence
/// order: the evaluator's own `offline.judge_model`, else the run-level
/// `judge_model`, else the provided default. Pure + unit-testable.
pub fn resolve_judge_model(
    evaluator_judge_model: Option<&str>,
    request_judge_model: Option<&str>,
    default_model: &str,
) -> String {
    evaluator_judge_model
        .or(request_judge_model)
        .unwrap_or(default_model)
        .to_string()
}

/// Built-in 3-case dataset used when the caller sends an empty `dataset` array.
/// This seeds the desktop "Run evals" panel with something meaningful out of the box.
/// Users can override it by sending their own `dataset` in the request body.
pub fn builtin_dataset() -> Vec<EvalCase> {
    vec![
        EvalCase {
            prompt: "Say hello in one word.".to_string(),
            expected: Some("hello".to_string()),
            threshold: None,
            messages: Vec::new(),
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
            ..Default::default()
        },
        EvalCase {
            prompt: "What is 2 + 2? Answer with just the number.".to_string(),
            expected: Some("4".to_string()),
            threshold: None,
            messages: Vec::new(),
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
            ..Default::default()
        },
        EvalCase {
            prompt: "Name one primary color.".to_string(),
            expected: None,
            threshold: None,
            messages: Vec::new(),
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
            ..Default::default()
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(rate: f32) -> EvalsConfig {
        EvalsConfig {
            enabled: true,
            max_latency_ms: 10_000,
            sample_rate: rate,
            stream_usage: true,
            default_model: None,
            judge_model: None,
            online: Default::default(),
        }
    }

    #[test]
    fn sample_rate_one_always_samples() {
        let runner = EvalsRunner::new(config(1.0));
        for _ in 0..10 {
            assert!(runner.should_sample());
        }
    }

    #[test]
    fn sample_rate_zero_never_samples() {
        let runner = EvalsRunner::new(config(0.0));
        for _ in 0..10 {
            assert!(!runner.should_sample());
        }
    }

    #[test]
    fn sample_rate_quarter_keeps_roughly_one_in_four() {
        let runner = EvalsRunner::new(config(0.25));
        let kept = (0..100).filter(|_| runner.should_sample()).count();
        // Deterministic 1-in-4 spacing => exactly 25 of the first 100.
        assert_eq!(kept, 25);
    }

    #[test]
    fn disabled_runner_never_samples() {
        let mut cfg = config(1.0);
        cfg.enabled = false;
        let runner = EvalsRunner::new(cfg);
        assert!(!runner.should_sample());
    }

    #[test]
    fn provider_score_tracks_recorded_scores() {
        let runner = EvalsRunner::new(config(1.0));
        assert!(runner.provider_score("openai").is_none());

        runner.record_provider_score("openai", 0.9);
        let first = runner.provider_score("openai").expect("scored once");
        assert!((first - 0.9).abs() < 1e-3);

        // A lower follow-up pulls the EMA down but stays above the new sample.
        runner.record_provider_score("openai", 0.1);
        let second = runner.provider_score("openai").expect("scored twice");
        assert!(second < first);
        assert!(second > 0.1);
    }

    #[test]
    fn all_provider_scores_snapshots_scored_providers() {
        let runner = EvalsRunner::new(config(1.0));
        assert!(runner.all_provider_scores().is_empty());

        runner.record_provider_score("openai", 0.8);
        runner.record_provider_score("anthropic", 0.6);
        let scores = runner.all_provider_scores();
        assert_eq!(scores.len(), 2);
        assert!((scores["openai"] - 0.8).abs() < 1e-3);
        assert!((scores["anthropic"] - 0.6).abs() < 1e-3);
    }

    #[test]
    fn score_attaches_overall_in_range() {
        let runner = EvalsRunner::new(config(1.0));
        let response = json!({
            "usage": { "prompt_tokens": 100, "completion_tokens": 100 }
        });
        let result = runner.score(1000, &response, true).expect("scored");
        assert!(result.overall >= 0.0 && result.overall <= 1.0);
        assert!(result.policy_pass);
    }

    // ── Dataset runner pure-scoring tests (AC3) ──────────────────────────────
    // These verify scores are in [0,1] and the aggregate is correct using canned
    // responses — no live provider needed.

    fn make_response(prompt_tokens: u64, completion_tokens: u64, content: &str) -> Value {
        json!({
            "choices": [{"message": {"content": content}}],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens
            }
        })
    }

    #[test]
    fn score_case_without_expected_returns_score_in_range() {
        let case = EvalCase {
            prompt: "ping".to_string(),
            expected: None,
            threshold: None,
            messages: Vec::new(),
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
            ..Default::default()
        };
        let resp = make_response(10, 5, "pong");
        let score = score_case(&case, &resp, 500, true, 10_000);
        assert!(score.overall >= 0.0 && score.overall <= 1.0);
        assert!(score.substring_match.is_none());
        assert!(score.policy_pass);
    }

    #[test]
    fn score_case_with_matching_expected_gives_full_substring_score() {
        let case = EvalCase {
            prompt: "say hello".to_string(),
            expected: Some("hello".to_string()),
            threshold: None,
            messages: Vec::new(),
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
            ..Default::default()
        };
        let resp = make_response(5, 3, "Hello there!");
        let score = score_case(&case, &resp, 200, true, 10_000);
        assert_eq!(score.substring_match, Some(1.0));
        assert!(score.overall >= 0.0 && score.overall <= 1.0);
    }

    #[test]
    fn score_case_with_non_matching_expected_gives_zero_substring_score() {
        let case = EvalCase {
            prompt: "say hello".to_string(),
            expected: Some("hello".to_string()),
            threshold: None,
            messages: Vec::new(),
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
            ..Default::default()
        };
        let resp = make_response(5, 3, "Goodbye!");
        let score = score_case(&case, &resp, 200, true, 10_000);
        assert_eq!(score.substring_match, Some(0.0));
    }

    #[test]
    fn unmeasured_policy_is_not_counted_as_a_pass_or_failure() {
        let case = EvalCase {
            prompt: "say hello".to_owned(),
            expected: Some("hello".to_owned()),
            ..Default::default()
        };
        let response = make_response(10, 10, "Hello there!");
        let mut score = score_case(&case, &response, 42_000, true, 10_000);
        set_measurement_availability(&mut score, true, false);

        assert!(score.latency_available);
        assert!(!score.policy_available);
        assert!(!score.policy_pass);
        assert!((score.overall - 0.5).abs() < f32::EPSILON);

        let aggregate = aggregate_scores(&[score]);
        assert_eq!(aggregate.latency_available_cases, 1);
        assert_eq!(aggregate.policy_available_cases, 0);
        assert_eq!(aggregate.policy_pass_rate, 0.0);
    }

    #[test]
    fn aggregate_three_cases_produces_valid_summary() {
        let cases = vec![
            EvalCase {
                prompt: "Say hello".to_string(),
                expected: Some("hello".to_string()),
                threshold: None,
                messages: Vec::new(),
                vars: std::collections::HashMap::new(),
                assertions: Vec::new(),
                evaluators: Vec::new(),
                ..Default::default()
            },
            EvalCase {
                prompt: "What is 2+2?".to_string(),
                expected: Some("4".to_string()),
                threshold: None,
                messages: Vec::new(),
                vars: std::collections::HashMap::new(),
                assertions: Vec::new(),
                evaluators: Vec::new(),
                ..Default::default()
            },
            EvalCase {
                prompt: "Name a color.".to_string(),
                expected: None,
                threshold: None,
                messages: Vec::new(),
                vars: std::collections::HashMap::new(),
                assertions: Vec::new(),
                evaluators: Vec::new(),
                ..Default::default()
            },
        ];
        let responses = vec![
            make_response(5, 3, "Hello!"),
            make_response(8, 2, "4"),
            make_response(6, 4, "red"),
        ];
        let scored: Vec<CaseScore> = cases
            .iter()
            .zip(responses.iter())
            .map(|(c, r)| score_case(c, r, 300, true, 10_000))
            .collect();

        let agg = aggregate_scores(&scored);
        assert_eq!(agg.total_cases, 3);
        assert!(agg.mean_overall >= 0.0 && agg.mean_overall <= 1.0);
        assert!(agg.mean_latency >= 0.0 && agg.mean_latency <= 1.0);
        assert!(agg.mean_token_efficiency >= 0.0 && agg.mean_token_efficiency <= 1.0);
        assert!((agg.policy_pass_rate - 1.0).abs() < 1e-3);
        // Two cases had `expected`, so mean_substring_match should be Some.
        assert!(agg.mean_substring_match.is_some());
    }

    #[test]
    fn extended_promptfoo_assertions_use_safe_metrics_and_nested_sets() {
        let metrics = AssertionMetrics {
            latency_ms: Some(120),
            cost_micro_usd: Some(2500),
        };
        let html = Assertion::ContainsHtml {
            value: "<p>hello</p>".to_owned(),
            options: AssertionOptions::default(),
        };
        assert!(
            eval_assertion_deterministic_with_metrics(&html, "<main><p>hello</p></main>", metrics)
                .pass
        );
        let similarity = Assertion::Levenshtein {
            value: "hello".to_owned(),
            options: AssertionOptions {
                threshold: Some(0.8),
                ..Default::default()
            },
        };
        assert!(eval_assertion_deterministic(&similarity, "hello").pass);
        let latency = Assertion::Latency {
            value: "200".to_owned(),
            options: AssertionOptions::default(),
        };
        assert!(eval_assertion_deterministic_with_metrics(&latency, "ignored", metrics).pass);
        let cost = Assertion::Cost {
            value: "0.003".to_owned(),
            options: AssertionOptions::default(),
        };
        assert!(eval_assertion_deterministic_with_metrics(&cost, "ignored", metrics).pass);
        let nested = Assertion::AssertSet {
            assertions: vec![
                Assertion::Contains {
                    value: "hello".to_owned(),
                    options: AssertionOptions::default(),
                },
                Assertion::NotContains {
                    value: "goodbye".to_owned(),
                    options: AssertionOptions::default(),
                },
            ],
            options: AssertionOptions::default(),
        };
        assert!(eval_assertion_deterministic(&nested, "hello").pass);
        let negated = Assertion::Contains {
            value: "hello".to_owned(),
            options: AssertionOptions {
                not: Some(true),
                ..Default::default()
            },
        };
        let negated_result = eval_assertion_deterministic(&negated, "hello");
        assert!(!negated_result.pass);
        assert_eq!(negated_result.score, 0.0);
        assert!(negated_result.executed);
        let missing_latency = Assertion::Latency {
            value: "200".to_owned(),
            options: AssertionOptions::default(),
        };
        let missing_latency_result = eval_assertion_deterministic(&missing_latency, "ignored");
        assert!(!missing_latency_result.executed);
    }

    #[test]
    fn oversized_levenshtein_inputs_are_skipped_before_quadratic_work() {
        let assertion = Assertion::Levenshtein {
            value: "x".repeat(2_049),
            options: AssertionOptions::default(),
        };
        let result = eval_assertion_deterministic(&assertion, "x");
        assert!(!result.executed);
        assert!(result.detail.contains("limited to 2048"));
    }

    #[test]
    fn judge_prompt_truncates_untrusted_text() {
        let prompt = build_judge_prompt(&"r".repeat(20_000), &"o".repeat(20_000));
        assert!(prompt.contains(&"r".repeat(16_384)));
        assert!(!prompt.contains(&"r".repeat(16_385)));
        assert!(prompt.contains(&"o".repeat(16_384)));
        assert!(!prompt.contains(&"o".repeat(16_385)));
    }

    #[test]
    fn aggregate_no_expected_cases_returns_none_substring() {
        let cases = vec![EvalCase {
            prompt: "ping".to_string(),
            expected: None,
            threshold: None,
            messages: Vec::new(),
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
            ..Default::default()
        }];
        let responses = vec![make_response(5, 3, "pong")];
        let scored: Vec<CaseScore> = cases
            .iter()
            .zip(responses.iter())
            .map(|(c, r)| score_case(c, r, 100, true, 10_000))
            .collect();
        let agg = aggregate_scores(&scored);
        assert!(agg.mean_substring_match.is_none());
    }

    #[test]
    fn aggregate_empty_slice_returns_zero_totals() {
        let agg = aggregate_scores(&[]);
        assert_eq!(agg.total_cases, 0);
        assert!((agg.mean_overall).abs() < 1e-6);
    }

    // ── Variable substitution ────────────────────────────────────────────────

    #[test]
    fn substitute_vars_replaces_known_and_leaves_unknown() {
        let mut vars = std::collections::HashMap::new();
        vars.insert("name".to_string(), Value::String("Sam".to_string()));
        let out = substitute_vars("Hi {{name}}, meet {{other}}", &vars);
        assert_eq!(out, "Hi Sam, meet {{other}}");
    }

    #[test]
    fn substitute_vars_no_placeholders_is_identity() {
        let vars = std::collections::HashMap::new();
        assert_eq!(substitute_vars("plain text", &vars), "plain text");
    }

    #[test]
    fn render_template_supports_typed_values_and_common_filters() {
        let vars = serde_json::from_value::<std::collections::HashMap<String, Value>>(json!({
            "name": "Sam",
            "premium": true,
            "items": ["one", "two"],
            "profile": {"team": "Ryu"}
        }))
        .unwrap();
        assert_eq!(
            render_template(
                "Hello {{name | upper}} from {{profile.team}} ({{items | join(' / ')}})",
                &vars
            ),
            "Hello SAM from Ryu (one / two)"
        );
        assert_eq!(
            render_template(
                "{% if premium %}Priority{% else %}Standard{% endif %}",
                &vars
            ),
            "Priority"
        );
        assert_eq!(
            render_template("{% for item in items %}[{{item}}]{% endfor %}", &vars),
            "[one][two]"
        );
    }

    // ── Deterministic assertion evaluation ───────────────────────────────────

    #[test]
    fn assertion_contains_case_insensitive() {
        let a = Assertion::Contains {
            value: "Hello".to_string(),
            options: AssertionOptions::default(),
        };
        let r = eval_assertion_deterministic(&a, "well, hello there");
        assert!(r.pass);
        assert_eq!(r.kind, "contains");
        assert!((r.score - 1.0).abs() < 1e-6);
    }

    #[test]
    fn assertion_not_contains() {
        let a = Assertion::NotContains {
            value: "error".to_string(),
            options: AssertionOptions::default(),
        };
        assert!(eval_assertion_deterministic(&a, "all good").pass);
        assert!(!eval_assertion_deterministic(&a, "an error occurred").pass);
    }

    #[test]
    fn assertion_equals_trims_and_is_case_sensitive() {
        let a = Assertion::Equals {
            value: "42".to_string(),
            options: AssertionOptions::default(),
        };
        assert!(eval_assertion_deterministic(&a, "  42 ").pass);
        assert!(!eval_assertion_deterministic(&a, "forty-two").pass);
    }

    #[test]
    fn assertion_regex_valid_and_invalid() {
        let ok = Assertion::Regex {
            value: "^foo".to_string(),
            options: AssertionOptions::default(),
        };
        assert!(eval_assertion_deterministic(&ok, "foobar").pass);
        assert!(!eval_assertion_deterministic(&ok, "barfoo").pass);

        let bad = Assertion::Regex {
            value: "(".to_string(),
            options: AssertionOptions::default(),
        };
        let r = eval_assertion_deterministic(&bad, "anything");
        assert!(!r.pass);
        assert!(r.detail.contains("invalid regex"));
    }

    #[test]
    fn assertion_json_valid() {
        let a = Assertion::JsonValid {
            options: AssertionOptions::default(),
        };
        assert!(eval_assertion_deterministic(&a, "{\"k\": 1}").pass);
        assert!(!eval_assertion_deterministic(&a, "not json").pass);
    }

    #[test]
    fn promptfoo_common_deterministic_assertions() {
        assert!(
            eval_assertion_deterministic(
                &Assertion::Icontains {
                    value: "hello".into(),
                    options: AssertionOptions::default(),
                },
                "Hello there"
            )
            .pass
        );
        assert!(
            eval_assertion_deterministic(
                &Assertion::StartsWith {
                    value: "Hello".into(),
                    options: AssertionOptions::default(),
                },
                "  Hello there"
            )
            .pass
        );
        assert!(
            eval_assertion_deterministic(
                &Assertion::ContainsAny {
                    value: "Paris,London".into(),
                    options: AssertionOptions::default(),
                },
                "The answer is London"
            )
            .pass
        );
        assert!(
            !eval_assertion_deterministic(
                &Assertion::ContainsAll {
                    value: "Paris,France".into(),
                    options: AssertionOptions::default(),
                },
                "The answer is Paris"
            )
            .pass
        );
        assert!(
            eval_assertion_deterministic(
                &Assertion::IcontainsAll {
                    value: "paris,france".into(),
                    options: AssertionOptions::default(),
                },
                "Paris is in France"
            )
            .pass
        );
        assert!(
            eval_assertion_deterministic(
                &Assertion::ContainsJson {
                    value: "{\"ok\":true}".into(),
                    options: AssertionOptions::default(),
                },
                "Result: {\"ok\":true}"
            )
            .pass
        );
    }

    #[test]
    fn promptfoo_assertion_options_round_trip_and_format_checks() {
        let parsed: Assertion = serde_json::from_value(json!({
            "kind": "contains",
            "value": "safe",
            "threshold": 0.8,
            "weight": 2.0,
            "metric": "quality"
        }))
        .unwrap();
        match &parsed {
            Assertion::Contains { options, .. } => {
                assert_eq!(options.threshold, Some(0.8));
                assert_eq!(options.weight, Some(2.0));
                assert_eq!(options.metric.as_deref(), Some("quality"));
            }
            _ => panic!("expected contains assertion"),
        }
        let wire = serde_json::to_value(&parsed).unwrap();
        assert!((wire["threshold"].as_f64().unwrap() - 0.8).abs() < 1e-6);
        assert!(
            eval_assertion_deterministic(
                &Assertion::IsHtml {
                    options: AssertionOptions::default()
                },
                "<p>ok</p>"
            )
            .pass
        );
        assert!(
            eval_assertion_deterministic(
                &Assertion::IsSql {
                    options: AssertionOptions::default()
                },
                "SELECT 1"
            )
            .pass
        );
    }

    // ── Judge verdict parsing ────────────────────────────────────────────────

    #[test]
    fn parse_judge_verdict_pass_with_score() {
        let (pass, score) = parse_judge_verdict("VERDICT: PASS SCORE: 0.9");
        assert!(pass);
        assert!((score - 0.9).abs() < 1e-6);
    }

    #[test]
    fn parse_judge_verdict_fail() {
        let (pass, score) = parse_judge_verdict("VERDICT: FAIL SCORE: 0.2");
        assert!(!pass);
        assert!((score - 0.2).abs() < 1e-6);
    }

    #[test]
    fn parse_judge_verdict_garbage_fails_safe() {
        let (pass, score) = parse_judge_verdict("no verdict here");
        assert!(!pass);
        assert!((score).abs() < 1e-6);
    }

    #[test]
    fn truncate_chars_is_char_safe() {
        // Multibyte chars must not panic and must be counted as chars.
        let s = "héllo wörld";
        assert_eq!(truncate_chars(s, 5), "héllo");
        assert_eq!(truncate_chars(s, 100), s);
    }
}
