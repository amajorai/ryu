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
//! Under the `Block` action the Inspector stage fails CLOSED on every missing
//! verdict an attacker can steer or force ([`fail_closed`]): a refusal, a
//! malformed or cut-off reply, plain prose with no verdict, a window budget
//! that ran out, and a judge provider that is unreachable, errors or times out
//! (a payload sized or shaped to time the judge out is as attacker-controlled
//! as a refusal bait). The verdict comes back flagged with the
//! [`UNAVAILABLE_CATEGORY`], so the stage's Block arm refuses the turn. Only a
//! judge that flags nothing but topic words outside the declared vocabulary
//! stays fail-open (logged, `available = false`): the shipped classify-tier
//! default does that on benign turns. An operator who would rather keep
//! serving while the classify tier is down sets the inspector action to
//! `warn_and_continue`, which logs and audits flags without refusing. Rubric
//! judges never fail closed here; `available = false` makes their caller run
//! the deterministic seed backstop over the full text.

use futures_util::future::join_all;
use serde_json::json;
use tracing::warn;

use crate::config::{FirewallPolicy, InspectorConfig, InspectorMode};
use crate::{error::GatewayError, pipeline::inference_governance::InferenceClient};
// The prompts, the parser and the category check live in the screening
// crate (`ryu_gw_screening::backends::inspector`), so the node-tier stage
// here and the floor-tier screener adapter share one prompt and one parser.
use ryu_gw_screening::backends::inspector::{self as judge, JudgeReply};

/// Windows judged per turn: about 60,000 characters with the overlap.
/// Content past the budget is not judged, and the verdict says so.
pub const MAX_INSPECT_WINDOWS: usize = 16;
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

/// Under `Block`, turn a missing verdict that [`InspectorOutcome::fails_closed`]
/// into a flag so the Block path refuses the turn. Other actions and
/// outcomes pass through unchanged.
pub fn fail_closed(mut verdict: InspectorVerdict, action: &FirewallPolicy) -> InspectorVerdict {
    if verdict.flagged || *action != FirewallPolicy::Block || !verdict.outcome.fails_closed() {
        return verdict;
    }
    warn!(
        outcome = verdict.outcome.label(),
        "inspector: no verdict for the whole turn; failing closed under Block"
    );
    verdict.flagged = true;
    verdict.categories = vec![UNAVAILABLE_CATEGORY.to_owned()];
    verdict.reason = format!(
        "the inspector could not judge the whole turn ({}); blocked fail-closed",
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
    /// The Inspector stage's verdict for `text` under `cfg.action`:
    /// [`Self::assess`], then [`fail_closed`] and the Sanitize semantics.
    pub async fn inspect(
        text: &str,
        cfg: &InspectorConfig,
        inference: &dyn InferenceClient,
    ) -> Result<InspectorVerdict, GatewayError> {
        let verdict = Self::assess(text, cfg, inference).await?;
        Ok(sanitize_semantics(
            fail_closed(verdict, &cfg.action),
            &cfg.action,
        ))
    }

    /// The judge's verdict over all of `text`, with no action applied.
    pub async fn assess(
        text: &str,
        cfg: &InspectorConfig,
        inference: &dyn InferenceClient,
    ) -> Result<InspectorVerdict, GatewayError> {
        if !cfg.enabled || text.trim().is_empty() || text.chars().count() < cfg.min_chars {
            return Ok(InspectorVerdict::allow());
        }
        run_inspection(
            &system_prompt(cfg.mode),
            text,
            &cfg.model,
            cfg.timeout_ms,
            inference,
            true,
        )
        .await
    }

    pub async fn inspect_rubric(
        text: &str,
        rubric: &str,
        model: &str,
        timeout_ms: u64,
        inference: &dyn InferenceClient,
    ) -> Result<InspectorVerdict, GatewayError> {
        if text.trim().is_empty() || rubric.trim().is_empty() {
            return Ok(InspectorVerdict::allow());
        }
        run_inspection(
            &rubric_system_prompt(rubric),
            text,
            model,
            timeout_ms,
            inference,
            false,
        )
        .await
    }
}

/// Folds per-window results into one verdict.
#[derive(Default)]
struct Windows {
    flagged: bool,
    categories: Vec<String>,
    reason: String,
    worst: Option<InspectorOutcome>,
}

impl Windows {
    fn add(&mut self, window: Result<judge::JudgeVerdict, InspectorOutcome>) {
        match window {
            Ok(verdict) if verdict.flagged => {
                self.flagged = true;
                for category in verdict.categories {
                    if !self.categories.contains(&category) {
                        self.categories.push(category);
                    }
                }
                if self.reason.is_empty() {
                    self.reason = verdict.reason;
                }
            }
            Ok(verdict) => {
                if self.reason.is_empty() {
                    self.reason = verdict.reason;
                }
            }
            Err(outcome) => self.worst = self.worst.max(Some(outcome)),
        }
    }

    fn finish(self, complete: bool) -> InspectorVerdict {
        let mut worst = self.worst;
        if !complete {
            worst = worst.max(Some(InspectorOutcome::Incomplete));
        }
        let outcome = match (self.flagged, worst) {
            (true, _) | (false, None) => InspectorOutcome::Answered,
            (false, Some(outcome)) => outcome,
        };
        InspectorVerdict {
            flagged: self.flagged,
            categories: self.categories,
            reason: self.reason,
            available: outcome == InspectorOutcome::Answered,
            outcome,
        }
    }
}

/// Judge `text` window by window, newest content first, stopping at the
/// first flag. Provider failures are an outcome, not a clean verdict;
/// governance errors propagate. The client enforces DLP, budgets and
/// accounting without recursion.
async fn run_inspection(
    system_prompt: &str,
    text: &str,
    model: &str,
    timeout_ms: u64,
    inference: &dyn InferenceClient,
    restrict_categories: bool,
) -> Result<InspectorVerdict, GatewayError> {
    let (windows, complete) = judge::inspect_windows(
        text,
        judge::MAX_INSPECT_CHARS,
        judge::WINDOW_OVERLAP_CHARS,
        MAX_INSPECT_WINDOWS,
    );
    if !complete {
        warn!(
            chars = text.chars().count(),
            windows = windows.len(),
            "inspector: text exceeds the window budget; the oldest content is not judged"
        );
    }
    let mut folded = Windows::default();
    for batch in windows.chunks(WINDOW_CONCURRENCY) {
        let results = join_all(batch.iter().map(|window| {
            judge_window(
                system_prompt,
                window,
                model,
                timeout_ms,
                inference,
                restrict_categories,
            )
        }))
        .await;
        for result in results {
            folded.add(result?);
        }
        if folded.flagged {
            break;
        }
    }
    Ok(folded.finish(complete))
}

/// One judge call over one window.
async fn judge_window(
    system_prompt: &str,
    window: &str,
    model: &str,
    timeout_ms: u64,
    inference: &dyn InferenceClient,
    restrict_categories: bool,
) -> Result<Result<judge::JudgeVerdict, InspectorOutcome>, GatewayError> {
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": judge::judge_user_content(window)},
        ],
        "temperature": 0,
        "max_tokens": 200,
        "stream": false,
    });
    let Some(response) = inference.complete(model, body, timeout_ms).await? else {
        warn!("inspector: judge provider unavailable; this window has no verdict");
        return Ok(Err(InspectorOutcome::ProviderUnavailable));
    };
    let outcome = match judge::classify_reply(&response, restrict_categories) {
        JudgeReply::Verdict(verdict) => return Ok(Ok(verdict)),
        JudgeReply::Refused(why) => {
            warn!(why, "inspector: the judge refused; not a clean verdict");
            InspectorOutcome::Refused
        }
        JudgeReply::Malformed(why) => {
            warn!(why, "inspector: the judge gave no usable verdict");
            InspectorOutcome::Malformed
        }
        JudgeReply::Unparseable => {
            warn!("inspector: the judge answered in prose with no verdict");
            InspectorOutcome::Unparseable
        }
        JudgeReply::OffVocabulary => {
            warn!("inspector: the judge flagged only topic words; not a verdict");
            InspectorOutcome::OffVocabulary
        }
    };
    Ok(Err(outcome))
}

/// System prompt for an ad-hoc rubric judge. `flagged` is true only when the
/// rubric's bad condition clearly holds, matching the inline-guardrail semantics.
fn rubric_system_prompt(rubric: &str) -> String {
    judge::rubric_system_prompt(rubric)
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
