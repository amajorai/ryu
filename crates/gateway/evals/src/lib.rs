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
// LLM-judge and custom dataset scorers are explicitly deferred to a follow-up.
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
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Assertion {
    Contains { value: String },
    NotContains { value: String },
    Equals { value: String },
    Regex { value: String },
    JsonValid,
    LlmJudge { rubric: String },
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
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EvalCase {
    /// The prompt to replay through the gateway pipeline. May contain {{vars}}.
    pub prompt: String,
    /// Legacy optional expected substring. STILL drives the scalar
    /// `substring_match` (case-insensitive contains) exactly as before, AND is
    /// synthesized as an extra `contains` assertion. Absent => scalar omitted.
    #[serde(default)]
    pub expected: Option<String>,
    /// Per-case variables. Substituted into {{name}} in the case prompt, the
    /// run-level system_prompt, and every assertion's value/rubric.
    #[serde(default)]
    pub vars: std::collections::HashMap<String, String>,
    /// Assertions to evaluate against this case's response text.
    #[serde(default)]
    pub assertions: Vec<Assertion>,
    /// NEW (P2): registry evaluator ids to score this case against, in addition
    /// to any run-level ids. Empty by default => today's assertion-only behavior.
    #[serde(default)]
    pub evaluators: Vec<String>,
}

/// Per-case scores returned by the dataset runner.
#[derive(Debug, Clone, Serialize)]
pub struct CaseScore {
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
    /// Present only when the case had an `expected` value. 1.0 = match, 0.0 = no match.
    pub substring_match: Option<f32>,
    /// Weighted aggregate for this case. Weights vary based on which scorers are active:
    /// - with substring: 0.3·latency + 0.2·token + 0.2·policy + 0.3·substring
    /// - without: 0.4·latency + 0.3·token + 0.3·policy
    pub overall: f32,
    /// NEW: per-assertion results (always present; [] when no assertions).
    pub assertions: Vec<AssertionResult>,
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
    /// Mean token efficiency.
    pub mean_token_efficiency: f32,
    /// Fraction of cases where `policy_pass == true`. Range [0, 1].
    pub policy_pass_rate: f32,
    /// Mean substring match score across cases that had an `expected` value.
    /// `None` when no cases had `expected`.
    pub mean_substring_match: Option<f32>,
    /// Total number of cases run.
    pub total_cases: usize,
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
        prompt: case.prompt.clone(),
        response_text,
        latency_score,
        token_efficiency,
        policy_pass,
        substring_match,
        overall,
        // NEW — neutral defaults; Implementer B overwrites these via the pub
        // fields after calling score_case (assertions are evaluated in evals.rs,
        // where the pipeline state/ctx for llm_judge is in scope).
        assertions: Vec::new(),
        assertions_pass: true,
        // NEW (P2) — evaluator scores are attached by the api runner after
        // score_evaluators runs (it needs pipeline state for llm_judge).
        evaluators: Vec::new(),
    }
}

// ─── Assertion + variable-substitution helpers ───────────────────────────────

/// Compiled `{{name}}` placeholder regex, built once.
fn placeholder_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}").expect("valid placeholder regex")
    })
}

/// Substitute `{{name}}` occurrences in `template` using `vars`.
/// Unfilled placeholders are left literal (`{{name}}`), matching the desktop
/// renderPrompt semantics. Uses a top-level compiled regex — no per-call compile.
pub fn substitute_vars(template: &str, vars: &std::collections::HashMap<String, String>) -> String {
    placeholder_regex()
        .replace_all(template, |caps: &regex::Captures| {
            let name = &caps[1];
            match vars.get(name) {
                Some(v) => v.clone(),
                None => caps[0].to_string(),
            }
        })
        .into_owned()
}

/// Evaluate one DETERMINISTIC assertion (everything except `LlmJudge`) against
/// `response_text`. `vars` is already applied to the assertion before this call.
/// Returns the `AssertionResult`.
pub fn eval_assertion_deterministic(assertion: &Assertion, response_text: &str) -> AssertionResult {
    let (kind, pass, detail): (&str, bool, String) = match assertion {
        Assertion::Contains { value } => {
            let pass = response_text.to_lowercase().contains(&value.to_lowercase());
            let detail = if pass {
                format!("found \"{value}\"")
            } else {
                format!("missing \"{value}\"")
            };
            ("contains", pass, detail)
        }
        Assertion::NotContains { value } => {
            let present = response_text.to_lowercase().contains(&value.to_lowercase());
            let pass = !present;
            let detail = if pass {
                format!("absent \"{value}\"")
            } else {
                format!("unexpectedly found \"{value}\"")
            };
            ("not_contains", pass, detail)
        }
        Assertion::Equals { value } => {
            let pass = response_text.trim() == value.trim();
            let detail = if pass {
                "exact match".to_string()
            } else {
                format!("expected exactly \"{}\"", value.trim())
            };
            ("equals", pass, detail)
        }
        Assertion::Regex { value } => match Regex::new(value) {
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
        Assertion::JsonValid => {
            let pass = serde_json::from_str::<Value>(response_text.trim()).is_ok();
            let detail = if pass {
                "valid JSON".to_string()
            } else {
                "not valid JSON".to_string()
            };
            ("json_valid", pass, detail)
        }
        Assertion::LlmJudge { .. } => {
            // Caller must route llm_judge through the async judge path; this is a
            // defensive guard so a misrouted judge never silently passes.
            (
                "llm_judge",
                false,
                "llm_judge must be evaluated via the judge path".to_string(),
            )
        }
    };

    let score = if pass { 1.0 } else { 0.0 };
    AssertionResult {
        kind: kind.to_string(),
        pass,
        score,
        detail,
    }
}

/// Build the judge prompt embedding the rubric + the model output under test.
pub fn build_judge_prompt(rubric: &str, output: &str) -> String {
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
            mean_token_efficiency: 0.0,
            policy_pass_rate: 0.0,
            mean_substring_match: None,
            total_cases: 0,
            evaluators: std::collections::HashMap::new(),
        };
    }

    let nf = n as f32;
    let mean_overall = cases.iter().map(|c| c.overall).sum::<f32>() / nf;
    let mean_latency = cases.iter().map(|c| c.latency_score).sum::<f32>() / nf;
    let mean_token_efficiency = cases.iter().map(|c| c.token_efficiency).sum::<f32>() / nf;
    let policy_pass_rate = cases.iter().filter(|c| c.policy_pass).count() as f32 / nf;

    let substring_cases: Vec<f32> = cases.iter().filter_map(|c| c.substring_match).collect();
    let mean_substring_match = if substring_cases.is_empty() {
        None
    } else {
        Some(substring_cases.iter().sum::<f32>() / substring_cases.len() as f32)
    };

    let evaluators = aggregate_evaluators(cases);

    EvalRunAggregate {
        mean_overall,
        mean_latency,
        mean_token_efficiency,
        policy_pass_rate,
        mean_substring_match,
        total_cases: n,
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
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
        },
        EvalCase {
            prompt: "What is 2 + 2? Answer with just the number.".to_string(),
            expected: Some("4".to_string()),
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
        },
        EvalCase {
            prompt: "Name one primary color.".to_string(),
            expected: None,
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
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
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
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
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
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
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
        };
        let resp = make_response(5, 3, "Goodbye!");
        let score = score_case(&case, &resp, 200, true, 10_000);
        assert_eq!(score.substring_match, Some(0.0));
    }

    #[test]
    fn aggregate_three_cases_produces_valid_summary() {
        let cases = vec![
            EvalCase {
                prompt: "Say hello".to_string(),
                expected: Some("hello".to_string()),
                vars: std::collections::HashMap::new(),
                assertions: Vec::new(),
                evaluators: Vec::new(),
            },
            EvalCase {
                prompt: "What is 2+2?".to_string(),
                expected: Some("4".to_string()),
                vars: std::collections::HashMap::new(),
                assertions: Vec::new(),
                evaluators: Vec::new(),
            },
            EvalCase {
                prompt: "Name a color.".to_string(),
                expected: None,
                vars: std::collections::HashMap::new(),
                assertions: Vec::new(),
                evaluators: Vec::new(),
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
    fn aggregate_no_expected_cases_returns_none_substring() {
        let cases = vec![EvalCase {
            prompt: "ping".to_string(),
            expected: None,
            vars: std::collections::HashMap::new(),
            assertions: Vec::new(),
            evaluators: Vec::new(),
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
        vars.insert("name".to_string(), "Sam".to_string());
        let out = substitute_vars("Hi {{name}}, meet {{other}}", &vars);
        assert_eq!(out, "Hi Sam, meet {{other}}");
    }

    #[test]
    fn substitute_vars_no_placeholders_is_identity() {
        let vars = std::collections::HashMap::new();
        assert_eq!(substitute_vars("plain text", &vars), "plain text");
    }

    // ── Deterministic assertion evaluation ───────────────────────────────────

    #[test]
    fn assertion_contains_case_insensitive() {
        let a = Assertion::Contains {
            value: "Hello".to_string(),
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
        };
        assert!(eval_assertion_deterministic(&a, "all good").pass);
        assert!(!eval_assertion_deterministic(&a, "an error occurred").pass);
    }

    #[test]
    fn assertion_equals_trims_and_is_case_sensitive() {
        let a = Assertion::Equals {
            value: "42".to_string(),
        };
        assert!(eval_assertion_deterministic(&a, "  42 ").pass);
        assert!(!eval_assertion_deterministic(&a, "forty-two").pass);
    }

    #[test]
    fn assertion_regex_valid_and_invalid() {
        let ok = Assertion::Regex {
            value: "^foo".to_string(),
        };
        assert!(eval_assertion_deterministic(&ok, "foobar").pass);
        assert!(!eval_assertion_deterministic(&ok, "barfoo").pass);

        let bad = Assertion::Regex {
            value: "(".to_string(),
        };
        let r = eval_assertion_deterministic(&bad, "anything");
        assert!(!r.pass);
        assert!(r.detail.contains("invalid regex"));
    }

    #[test]
    fn assertion_json_valid() {
        let a = Assertion::JsonValid;
        assert!(eval_assertion_deterministic(&a, "{\"k\": 1}").pass);
        assert!(!eval_assertion_deterministic(&a, "not json").pass);
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
