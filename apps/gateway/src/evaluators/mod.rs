//! Unified evaluator taxonomy (P0, additive).
//!
//! One shared catalog of "evaluators" — typed judges over model traffic — that
//! is designed to power **both** gateway surfaces without a second vocabulary:
//! inline guardrails (Block/Sanitize/Warn on the request/response path) and
//! offline evals (score a dataset case in [0,1]). This module is the *definition
//! + config* layer only; nothing here executes yet (every seed ships with
//! `enforced = false`). Execution wiring lands in later phases.
//!
//! Deliberate reuse — no fourth vocabulary is invented here:
//!   * inline action reuses [`crate::config::FirewallPolicy`]
//!     (`Block | WarnAndContinue | Sanitize`);
//!   * the finding/verdict shape reuses [`crate::firewall::cmdscan::Finding`] and
//!     [`crate::firewall::cmdscan::Severity`], re-exported below so downstream
//!     phases reference exactly one `Finding`/`Severity`.
//!
//! Serde conventions match the crate: struct fields serialize camelCase; unit +
//! internally-tagged enums serialize snake_case, mirroring `config::FirewallPolicy`,
//! `config::CustomPatternKind`, and `evals::Assertion`.

pub mod catalog;
pub mod registry;

use serde::{Deserialize, Serialize};

use crate::config::FirewallPolicy;

// One finding/verdict vocabulary across firewall + cmdscan + evaluators. These
// are re-exported (not redefined) so a later phase that produces evaluator
// findings uses the exact same `Finding`/`Severity` the command scanner does.
// (Unused in the P0 read-only catalog; the executors that emit findings land in
// later phases.)
#[allow(unused_imports)]
pub use crate::firewall::cmdscan::{Finding, Severity};

pub use catalog::builtin_catalog;
pub use registry::{validate_custom_evaluators, EvaluatorRegistry};

/// A single evaluator: one entry in the shared catalog. It carries enough to (a)
/// render the desktop catalog UI, (b) gate which surface may offer it
/// (`capabilities`), and (c) hold the per-surface config (`inline` / `offline`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evaluator {
    /// Stable snake_case identifier, e.g. `"pii_leakage"`, `"toxicity"`.
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// One-line description for the catalog UI.
    pub description: String,
    /// Which catalog section it belongs to.
    pub category: EvaluatorCategory,
    /// What the evaluator judges (request text, response text, a whole
    /// conversation, an agent trajectory, an image, or audio).
    pub target: EvaluatorTarget,
    /// First-class gate: which surfaces may offer this evaluator.
    pub capabilities: Capabilities,
    /// How the judgment is computed.
    #[serde(rename = "impl")]
    pub impl_: EvaluatorImpl,
    /// Inline-guardrail config; `Some` only when `capabilities.inline`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline: Option<InlineConfig>,
    /// Offline-eval config; `Some` only when `capabilities.offline`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offline: Option<OfflineConfig>,
    /// `true` for shipped seed entries; `false` for user-created ("create from
    /// scratch") evaluators. The two Custom templates are `true` (clonable seeds).
    pub builtin: bool,
    /// Honesty flag: `true` once wired to real execution. The API reports this so
    /// no surface silently implies enforcement. Set on the five text detectors
    /// wired to real inline execution in P3 (pii_leakage, code_injection,
    /// prompt_injection, toxicity, bias_fairness); everything else stays `false`.
    pub enforced: bool,
    /// Score polarity. `true` (the default) ⇒ a HIGHER score is BETTER (quality,
    /// correctness, relevance; and the security regex detectors whose 1.0 means
    /// "clean/no-match"). `false` ⇒ a higher score is WORSE — the evaluator scores
    /// how strongly a BAD signal is present (toxicity, bias, hallucination, …), so
    /// a high score must FAIL. Used by the offline pass logic ([`crate::evals::judge_pass`])
    /// so "pass" always means GOOD regardless of which direction the raw score runs.
    #[serde(default = "default_higher_is_better")]
    pub higher_is_better: bool,
}

/// Serde default for [`Evaluator::higher_is_better`]: quality-style (higher = better).
/// A catalog authored before P3 (no `higherIsBetter` key) deserializes as `true`.
fn default_higher_is_better() -> bool {
    true
}

/// Catalog section, matching the product screenshot's tabs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluatorCategory {
    Security,
    Safety,
    Quality,
    Conversation,
    Trajectory,
    Image,
    Voice,
    Custom,
}

impl EvaluatorCategory {
    /// Stable snake_case string, matching the serde wire form. Used by the
    /// offline runner to stamp each [`crate::evals::EvaluatorScore`] with its
    /// category without a serde round-trip.
    pub fn as_str(&self) -> &'static str {
        match self {
            EvaluatorCategory::Security => "security",
            EvaluatorCategory::Safety => "safety",
            EvaluatorCategory::Quality => "quality",
            EvaluatorCategory::Conversation => "conversation",
            EvaluatorCategory::Trajectory => "trajectory",
            EvaluatorCategory::Image => "image",
            EvaluatorCategory::Voice => "voice",
            EvaluatorCategory::Custom => "custom",
        }
    }
}

/// What an evaluator judges.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluatorTarget {
    Input,
    Output,
    Conversation,
    Trajectory,
    Image,
    Audio,
}

impl EvaluatorTarget {
    /// Stable snake_case string, matching the serde wire form.
    pub fn as_str(&self) -> &'static str {
        match self {
            EvaluatorTarget::Input => "input",
            EvaluatorTarget::Output => "output",
            EvaluatorTarget::Conversation => "conversation",
            EvaluatorTarget::Trajectory => "trajectory",
            EvaluatorTarget::Image => "image",
            EvaluatorTarget::Audio => "audio",
        }
    }
}

/// Which surfaces may offer this evaluator. Offline-only entries
/// (Quality/Conversation/Trajectory/Voice) set `inline = false` and must never
/// be offered as an inline guardrail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// May run inline as a request/response guardrail.
    pub inline: bool,
    /// May run offline over a dataset case.
    pub offline: bool,
}

/// How an evaluator computes its judgment. Internally tagged on `kind`
/// (snake_case), mirroring `evals::Assertion`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EvaluatorImpl {
    /// Deterministic regex matching over the target text.
    Regex { patterns: Vec<String> },
    /// A built-in heuristic scorer (no regex, no LLM), e.g. exact-match.
    Heuristic,
    /// LLM-as-a-judge with a rubric used as the judge system prompt.
    LlmJudge { rubric: String },
    /// Sandboxed user code (JS via Deno / Python via sandbox backend).
    Code { lang: CodeLang, source: String },
    /// A named built-in detector wired elsewhere in the gateway.
    Builtin { detector: String },
    /// Untrusted third-party **policy code** running IN-PROCESS in the gateway,
    /// compiled to WebAssembly and executed in the hardened wasmtime sandbox
    /// ([`crate::wasm_policy`]). The gateway hands the guest the prompt/response
    /// excerpt and enforces its `allow | deny{reason}` verdict via the same
    /// Block/Sanitize/Warn machinery as every other inline evaluator. This is the
    /// in-process sibling of the external-service policy seam (`compression.rs`).
    ///
    /// Security posture (see the `wasm_policy` module + threat model): zero host
    /// functions, no WASI, fuel + epoch + memory bounded, fresh Store per call.
    /// `fail_open` is the DECLARED fail direction — the default (`false`) is
    /// CLOSED, so a firewall-class plugin that traps / OOMs / times out BLOCKS the
    /// request instead of silently allowing it. An enrichment-style plugin may set
    /// `fail_open = true` to be skipped on failure. Transform/patch verdicts and
    /// output-target scanning are deliberate v1 boundaries (allow/deny only).
    Wasm {
        /// The policy module as standard-base64-encoded wasm **binary** (never wat
        /// text). Size-capped and import-validated at declaration + load.
        module_base64: String,
        /// Declared fail direction. `false` (default) = fail CLOSED (block on any
        /// sandbox failure) — the safe default for a security policy.
        #[serde(default)]
        fail_open: bool,
    },
}

/// Language for a [`EvaluatorImpl::Code`] evaluator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeLang {
    Js,
    Python,
}

/// Inline-guardrail config: the action taken when the evaluator trips on the
/// request/response path. Reuses the firewall's policy enum verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineConfig {
    /// `Block | WarnAndContinue | Sanitize`.
    pub action: FirewallPolicy,
}

/// Offline-eval config: pass threshold + optional judge model override.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OfflineConfig {
    /// Score in [0,1] at/above which the case passes.
    pub threshold: f32,
    /// Judge model override; `None` routes through the default `ModelRouter`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub judge_model: Option<String>,
}

/// A per-scope override for one catalog evaluator, cascaded node → org → agent by
/// the firewall policy resolver (`firewall/resolve.rs`) with the same union + lock
/// ("cannot loosen") semantics that govern the firewall dials. It rides
/// [`crate::config::FirewallConfig`] / [`crate::config::FirewallOverlay`] so an
/// agent's guardrail policy and its evals config are one object.
///
/// `id` references a [`Evaluator`] in the P0 catalog. This is the *config* layer
/// only — nothing here executes yet (inline scanning is P3, offline scoring is
/// P2). Lock semantics, resolved by [`crate::firewall::resolve`]:
///   * `enabled` — a locked+enabled base stays enabled even if a narrower scope
///     sets `enabled = false` (ON is stricter, mirroring `apply_bool`);
///   * `inline_action` — on a locked base the resolved action is the *stricter* of
///     base vs overlay (Block > Sanitize > Warn), so a narrower scope may tighten
///     but never loosen;
///   * `offline` — on a locked base the base's offline config is kept as-is;
///   * `locked` — propagates upward: once locked at a broader scope it stays
///     locked for every narrower scope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatorBinding {
    /// Stable id of the catalog [`Evaluator`] this binding configures.
    pub id: String,
    /// Whether this evaluator is enabled at this scope.
    pub enabled: bool,
    /// Inline-guardrail action when enabled inline; `None` if not offered inline.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline_action: Option<FirewallPolicy>,
    /// Offline-eval config (threshold + judge model) when enabled offline.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offline: Option<OfflineConfig>,
    /// Freeze this binding so a narrower scope can only tighten it, never loosen.
    #[serde(default)]
    pub locked: bool,
}
