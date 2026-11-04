//! Swappable cheap-LLM traffic inspector — an opt-in detection *method* that runs
//! alongside the regex firewall scanner.
//!
//! The inspector asks a cheap model whether the inbound turn is a prompt
//! injection or leaks PII/secrets, then the pipeline applies the configured
//! [`crate::config::FirewallPolicy`] action to a flagged turn (Block / Sanitize /
//! Warn). The model is resolved through the normal [`ModelRouter`] so it stays
//! swappable, and it is called via [`crate::providers::Provider::complete`]
//! through the governed nonrecursive inference client, which preserves DLP,
//! model policy, rate limits, budgets and usage accounting.
//!
//! The judge reads the WHOLE text: it is split into windows of
//! [`judge::MAX_INSPECT_CHARS`], judged newest content first, and a flag in any
//! window flags the turn. Each window reaches the judge fenced as untrusted
//! data with chat-template control tokens neutralised. Only a parsed verdict
//! is an answer: a refusal, a content-filter stop, an empty, cut-off or
//! unparseable reply, or a window budget that ran out before the oldest
//! content is never a clean verdict ([`InspectorOutcome`]).
//!
//! With `inspector.fail_mode` closed (the default under the `Block` action)
//! the Inspector stage fails CLOSED on every missing verdict an attacker can
//! steer or force ([`fail_closed`]): a refusal, a malformed or cut-off reply,
//! plain prose with no verdict, a window budget that ran out, and a judge
//! provider that is unreachable, errors or times out (a payload sized or
//! shaped to time the judge out is as attacker-controlled as a refusal bait).
//! The verdict comes back flagged with the [`UNAVAILABLE_CATEGORY`], and the
//! configured action applies to it: Block refuses the turn. Only a judge that
//! flags nothing but topic words outside the declared vocabulary stays open
//! (logged, `available = false`): the shipped classify-tier default does that
//! on benign turns. An operator who would rather keep serving while the
//! classify tier is down sets `fail_mode = "open"`. Rubric judges never fail
//! closed here; `available = false` makes their caller run the deterministic
//! seed backstop over the full text.

use tracing::warn;

use crate::config::{FirewallPolicy, InspectorConfig, InspectorFailMode, InspectorMode};
use crate::{error::GatewayError, pipeline::inference_governance::InferenceClient};
// The prompts, the parser and the category check live in the screening
// crate (`ryu_gw_screening::backends::inspector`), so the node-tier stage
// here and the floor-tier screener adapter share one prompt and one parser.
use ryu_gw_screening::backends::inspector as judge;

#[path = "inspector_windows.rs"]
mod windows;
use windows::{run_inspection, Judge};

/// Windows judged per turn by default (about 60,000 characters); the stage
/// reads `InspectorConfig::max_windows`. Past the budget is unjudged, and the
/// verdict says so.
pub const MAX_INSPECT_WINDOWS: usize = crate::config::DEFAULT_INSPECTOR_WINDOWS;
/// A rubric judge's timeout when the inspector config leaves it at zero.
const RUBRIC_DEFAULT_TIMEOUT_MS: u64 = 1_500;
/// Judge calls in flight at once for one turn.
const WINDOW_CONCURRENCY: usize = 4;
/// The category a fail-closed verdict carries.
pub const UNAVAILABLE_CATEGORY: &str = "inspector_unavailable";

/// How the inspection ended. Variants run from least to most severe, and
/// every outcome that [`InspectorOutcome::fails_closed`] ranks above every one
/// that does not, so the worst window decides a multi-window turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum InspectorOutcome {
    /// Every window got a verdict.
    Answered,
    /// Not inspected: disabled, too short, or empty.
    Skipped,
    /// A flag naming only topic words, outside the declared vocabulary.
    OffVocabulary,
    /// No provider, a provider error or a timeout (off-fleet provider
    /// refusals arrive here too). Ranks above [`Self::OffVocabulary`]: the
    /// per-window fold keeps the worst outcome, and a fail-closed outcome in
    /// any window must outrank a fail-open one in another.
    ProviderUnavailable,
    /// Prose with no JSON object that does not read as a refusal.
    Unparseable,
    /// The window budget ran out before the oldest content was judged.
    Incomplete,
    /// A reply with no usable verdict (no JSON verdict, a missing `flagged`,
    /// a contradictory verdict, a clean verdict cut off by `length`).
    Malformed,
    /// The judge or its provider refused (`message.refusal`, a
    /// `content_filter` stop, empty content, refusal prose).
    Refused,
}

impl InspectorOutcome {
    pub fn label(self) -> &'static str {
        match self {
            Self::Answered => "answered",
            Self::Skipped => "skipped",
            Self::ProviderUnavailable => "provider_unavailable",
            Self::OffVocabulary => "off_vocabulary",
            Self::Unparseable => "unparseable",
            Self::Incomplete => "incomplete",
            Self::Malformed => "malformed",
            Self::Refused => "refused",
        }
    }

    /// Whether the missing verdict is a signal an attacker can produce (a
    /// refusal-bait payload, a steered non-answer or prose reply, padding past
    /// the window budget, a payload that stalls or crashes the judge), so a
    /// Block inspector must refuse rather than allow. Only an off-vocabulary
    /// flag (topic words from an undersized judge) and a skipped inspection
    /// do not.
    pub fn fails_closed(self) -> bool {
        matches!(
            self,
            Self::Malformed
                | Self::Refused
                | Self::Incomplete
                | Self::Unparseable
                | Self::ProviderUnavailable
        )
    }
}

/// The inspector's structured verdict.
#[derive(Debug, Clone, PartialEq)]
pub struct InspectorVerdict {
    /// Whether the turn was flagged as an injection / data-leak.
    pub flagged: bool,
    /// Category labels the model returned (e.g. `injection`, `pii`, `secret`).
    pub categories: Vec<String>,
    /// Short human-readable reason (for audit/logging).
    pub reason: String,
    /// Whether the judge produced a verdict covering ALL of the text
    /// (`true`), or the result is skipped, unanswered or partial (`false`).
    /// Callers use this to decide whether to run a deterministic seed
    /// backstop: when the judge did not see everything, the lexical seed over
    /// the full text is the floor; when it did, its context judgment is
    /// trusted over the seed.
    pub available: bool,
    /// How the inspection ended.
    pub outcome: InspectorOutcome,
}

impl InspectorVerdict {
    /// The skipped / clean verdict: allow, nothing flagged, judge NOT available.
    pub fn allow() -> Self {
        Self::unanswered(InspectorOutcome::Skipped)
    }

    fn unanswered(outcome: InspectorOutcome) -> Self {
        Self {
            flagged: false,
            categories: Vec::new(),
            reason: String::new(),
            available: false,
            outcome,
        }
    }
}

/// Where [`fail_closed`] reads the fail mode from: an [`InspectorConfig`]
/// (its [`InspectorConfig::effective_fail_mode`]) or a bare action (the
/// default for that action, closed only under Block).
pub trait InspectorFailPolicy {
    fn inspector_fail_mode(&self) -> InspectorFailMode;
}

impl InspectorFailPolicy for InspectorConfig {
    fn inspector_fail_mode(&self) -> InspectorFailMode {
        self.effective_fail_mode()
    }
}

impl InspectorFailPolicy for FirewallPolicy {
    fn inspector_fail_mode(&self) -> InspectorFailMode {
        InspectorFailMode::default_for(self)
    }
}

/// Under a closed fail mode, turn a missing verdict that
/// [`InspectorOutcome::fails_closed`] into an [`UNAVAILABLE_CATEGORY`] flag so
/// the configured action applies to the turn. An open fail mode and every
/// other outcome pass through unchanged.
pub fn fail_closed(
    mut verdict: InspectorVerdict,
    policy: &impl InspectorFailPolicy,
) -> InspectorVerdict {
    if verdict.flagged
        || policy.inspector_fail_mode() != InspectorFailMode::Closed
        || !verdict.outcome.fails_closed()
    {
        return verdict;
    }
    warn!(
        outcome = verdict.outcome.label(),
        "inspector: no verdict for the whole turn; failing closed"
    );
    verdict.flagged = true;
    verdict.categories = vec![UNAVAILABLE_CATEGORY.to_owned()];
    verdict.reason = format!(
        "the inspector could not judge the whole turn ({}); failed closed",
        verdict.outcome.label()
    );
    verdict
}

/// Whether every in-vocabulary category the judge named is `injection`.
pub fn is_injection_only(categories: &[String]) -> bool {
    let mut known = categories
        .iter()
        .filter_map(|c| judge::canonical_category(c))
        .peekable();
    known.peek().is_some() && known.all(|word| word == "injection")
}

/// The Inspector stage's Sanitize semantics: an injection cannot be redacted,
/// so an injection-only flag continues unchanged with a warning (as the regex
/// firewall's injection match does), and only a PII / secret / unnamed flag
/// reaches the Sanitize path, which refuses what it cannot redact.
fn sanitize_semantics(mut verdict: InspectorVerdict, action: &FirewallPolicy) -> InspectorVerdict {
    if *action == FirewallPolicy::Sanitize
        && verdict.flagged
        && is_injection_only(&verdict.categories)
    {
        warn!(
            categories = ?verdict.categories,
            reason = %verdict.reason,
            "inspector: injection flagged under Sanitize; not redactable, forwarded unchanged"
        );
        verdict.flagged = false;
    }
    verdict
}

/// Stateless entry point for the LLM inspector.
pub struct InspectorClient;

impl InspectorClient {
    /// The Inspector stage's verdict for `text` under `cfg`: [`Self::assess`],
    /// then [`fail_closed`] under `cfg`'s fail mode and the Sanitize semantics.
    pub async fn inspect(
        text: &str,
        cfg: &InspectorConfig,
        inference: &dyn InferenceClient,
    ) -> Result<InspectorVerdict, GatewayError> {
        // Under Sanitize an injection-only window flag is set aside and the
        // rest of the turn is still judged, so its gaps follow the fail mode.
        let sanitize = cfg.action == FirewallPolicy::Sanitize;
        let verdict = Self::judge_text(text, cfg, inference, sanitize).await?;
        Ok(sanitize_semantics(fail_closed(verdict, cfg), &cfg.action))
    }

    /// The judge's verdict over all of `text`, with no action applied.
    pub async fn assess(
        text: &str,
        cfg: &InspectorConfig,
        inference: &dyn InferenceClient,
    ) -> Result<InspectorVerdict, GatewayError> {
        Self::judge_text(text, cfg, inference, false).await
    }

    async fn judge_text(
        text: &str,
        cfg: &InspectorConfig,
        inference: &dyn InferenceClient,
        injection_continues: bool,
    ) -> Result<InspectorVerdict, GatewayError> {
        if !cfg.enabled || text.trim().is_empty() || text.chars().count() < cfg.min_chars {
            return Ok(InspectorVerdict::allow());
        }
        run_inspection(
            &system_prompt(cfg.mode),
            text,
            Judge {
                model: &cfg.model,
                timeout_ms: cfg.timeout_ms,
                max_windows: cfg.effective_max_windows(),
                restrict_categories: true,
                injection_continues,
            },
            inference,
        )
        .await
    }

    /// A rubric judge's verdict over all of `text`, under `cfg`'s model,
    /// timeout (1,500 ms when unset) and window budget
    /// ([`InspectorConfig::effective_max_windows`]): a budget an operator
    /// raised to judge long turns covers rubric judges too, instead of leaving
    /// them `Incomplete` past the default. `cfg.enabled` and `min_chars` gate
    /// the Inspector stage only; an inline rubric binding always runs.
    pub async fn inspect_rubric(
        text: &str,
        rubric: &str,
        cfg: &InspectorConfig,
        inference: &dyn InferenceClient,
    ) -> Result<InspectorVerdict, GatewayError> {
        if text.trim().is_empty() || rubric.trim().is_empty() {
            return Ok(InspectorVerdict::allow());
        }
        let timeout_ms = if cfg.timeout_ms == 0 {
            RUBRIC_DEFAULT_TIMEOUT_MS
        } else {
            cfg.timeout_ms
        };
        run_inspection(
            // `flagged` only when the rubric's bad condition clearly holds.
            &judge::rubric_system_prompt(rubric),
            text,
            Judge {
                model: &cfg.model,
                timeout_ms,
                max_windows: cfg.effective_max_windows(),
                restrict_categories: false,
                injection_continues: false,
            },
            inference,
        )
        .await
    }
}

/// The fixed system prompt asking for a strict JSON verdict, shaped by the mode.
fn system_prompt(mode: InspectorMode) -> String {
    judge::system_prompt(match mode {
        InspectorMode::Injection => judge::InspectorFocus::Injection,
        InspectorMode::Dlp => judge::InspectorFocus::Dlp,
        InspectorMode::Both => judge::InspectorFocus::Both,
    })
}

/// Parse the model's reply into a verdict (see [`judge::parse_verdict`]).
#[cfg_attr(not(test), allow(dead_code))]
fn parse_verdict(text: &str) -> Option<InspectorVerdict> {
    parse_verdict_with_category_policy(text, true)
}

/// A `flagged: true` verdict must name at least one of the categories the
/// system prompt declares. Gemma 3 270M, the shipped classify tier default,
/// returns topic words (`["party","birthday"]`) for benign turns, so a flagged
/// verdict with only out-of-vocabulary categories is not a verdict. A judge
/// that flags without naming any category is still trusted.
#[cfg_attr(not(test), allow(dead_code))]
fn parse_verdict_with_category_policy(
    text: &str,
    restrict_categories: bool,
) -> Option<InspectorVerdict> {
    judge::parse_verdict(text, restrict_categories).map(|verdict| InspectorVerdict {
        flagged: verdict.flagged,
        categories: verdict.categories,
        reason: verdict.reason,
        available: true,
        outcome: InspectorOutcome::Answered,
    })
}

/// The first balanced JSON object in `s`.
#[cfg_attr(not(test), allow(dead_code))]
fn extract_json_object(s: &str) -> Option<&str> {
    judge::extract_json_object(s)
}

#[cfg(test)]
#[path = "inspector_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "inspector_window_tests.rs"]
mod window_tests;

#[cfg(test)]
#[path = "inspector_fail_mode_tests.rs"]
mod fail_mode_tests;

#[cfg(test)]
#[path = "inspector_rubric_window_tests.rs"]
mod rubric_window_tests;

#[cfg(test)]
#[path = "inspector_sanitize_test.rs"]
mod sanitize_test;
