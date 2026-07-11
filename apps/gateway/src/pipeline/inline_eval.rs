//! Pure helpers for the unified-evaluator **inline guardrail** bridge (P3).
//!
//! The orchestration (resolving the per-agent policy, scanning, calling the
//! inspector, applying the block/sanitize/warn action, emitting audit + alerts)
//! lives in [`super`] because it needs the pipeline's private machinery. Only the
//! provider-free, network-free decision logic lives here so it can be unit-tested
//! directly, without a live judge or a constructed request context.

use crate::config::FirewallPolicy;
use crate::firewall::DetectionKind;

/// What an enabled inline evaluator does once it has (or has not) flagged the
/// target text. Derived purely from `(flagged, action)`; the caller maps it to the
/// EXISTING firewall block/sanitize/warn branches — no new enforcement path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InlineOutcome {
    /// Not flagged (or an unenforceable impl) — let the turn proceed untouched.
    Allow,
    /// Flagged + `Block` — reject the turn (403) via `GatewayError::FirewallBlocked`.
    Block,
    /// Flagged + `Sanitize` — redact the target text in place.
    Sanitize,
    /// Flagged + `WarnAndContinue` — log + emit a policy alert, allow the turn.
    Warn,
}

/// Map `(flagged, action)` to the outcome. A clean scan is always [`InlineOutcome::Allow`];
/// a flag maps to the binding's inline action. This is the single seam the input
/// and output orchestrations share, so an inline detector can only ever act on the
/// BAD condition (flag), never on a good one.
pub(crate) fn inline_outcome(flagged: bool, action: &FirewallPolicy) -> InlineOutcome {
    if !flagged {
        return InlineOutcome::Allow;
    }
    match action {
        FirewallPolicy::Block => InlineOutcome::Block,
        FirewallPolicy::Sanitize => InlineOutcome::Sanitize,
        FirewallPolicy::WarnAndContinue => InlineOutcome::Warn,
    }
}

/// The [`DetectionKind`] whose compiled pattern set backs a deterministic
/// (`Regex`/`Heuristic`) inline evaluator id. `None` for evaluators with no regex
/// representation (LLM-judge and image detectors take other paths; Code/Builtin
/// are unenforced this phase). Keeping this a small table (not a `match` buried in
/// the scanner) means the id ⇒ kind mapping is one auditable place.
pub(crate) fn inline_detection_kind(id: &str) -> Option<DetectionKind> {
    match id {
        "pii_leakage" => Some(DetectionKind::Pii),
        "code_injection" => Some(DetectionKind::CodeInjection),
        "prompt_injection" => Some(DetectionKind::PromptInjection),
        _ => None,
    }
}

/// The deterministic lexical-seed [`DetectionKind`] that backs an **LLM-judge**
/// evaluator when the judge fails open (no provider / timeout / unparseable). This
/// is the "deterministic floor" for the Block-default safety detectors: it is only
/// consulted when the judge did NOT answer (see `InspectorVerdict::available`), so
/// a present judge's context judgment always wins and the seed's own false
/// positives (e.g. a quoted/condemned stereotype) can't hard-block. `None` for
/// judge detectors with no lexical seed.
pub(crate) fn llm_judge_backstop_kind(id: &str) -> Option<DetectionKind> {
    match id {
        "toxicity" => Some(DetectionKind::Toxicity),
        "bias_fairness" => Some(DetectionKind::Bias),
        _ => None,
    }
}

/// Combine an LLM-judge verdict with its deterministic lexical-seed backstop.
///
/// The seed only counts when the judge did NOT answer (`!available` — no provider /
/// timeout / unparseable, the common local-only deploy): then it is the sole floor,
/// closing the "enforced=true but silently no-op" honesty gap. When the judge DID
/// answer, its context judgment wins outright, so the seed's own false positives
/// (a quoted/condemned stereotype, casual profanity) never hard-flag. This is the
/// single decision seam the async LlmJudge arm defers to so the truth table is
/// unit-testable without a live judge.
pub(crate) fn backstop_flag(available: bool, judge_flagged: bool, seed_hit: bool) -> bool {
    (!available && seed_hit) || judge_flagged
}

/// The image [`DetectionKind`] for an image-target evaluator id. These kinds are
/// **labels only** this phase (image judging is not wired — see the multimodal
/// hook), used for the honest not-enforced log so the two variants are neither
/// dead nor faked.
pub(crate) fn image_detection_kind(id: &str) -> Option<DetectionKind> {
    match id {
        "explicit_content" => Some(DetectionKind::ExplicitImage),
        "sensitive_imagery" => Some(DetectionKind::SensitiveImage),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_scan_always_allows() {
        assert_eq!(
            inline_outcome(false, &FirewallPolicy::Block),
            InlineOutcome::Allow
        );
        assert_eq!(
            inline_outcome(false, &FirewallPolicy::Sanitize),
            InlineOutcome::Allow
        );
    }

    #[test]
    fn flag_maps_to_action() {
        assert_eq!(
            inline_outcome(true, &FirewallPolicy::Block),
            InlineOutcome::Block
        );
        assert_eq!(
            inline_outcome(true, &FirewallPolicy::Sanitize),
            InlineOutcome::Sanitize
        );
        assert_eq!(
            inline_outcome(true, &FirewallPolicy::WarnAndContinue),
            InlineOutcome::Warn
        );
    }

    #[test]
    fn backstop_flag_truth_table() {
        // Judge NOT available + seed hit ⇒ flag (the honesty-gap case: no provider,
        // but obvious slur/threat still caught deterministically).
        assert!(backstop_flag(false, false, true));
        // Judge available + clean ⇒ NOT flagged even if the seed would (judge's
        // context wins; no quoted-stereotype / casual-profanity seed FP).
        assert!(!backstop_flag(true, false, true));
        // Judge available + flagged ⇒ flag.
        assert!(backstop_flag(true, true, false));
        // Nothing fires ⇒ allow.
        assert!(!backstop_flag(false, false, false));
    }

    #[test]
    fn llm_judge_backstop_maps_safety_seeds() {
        // The Block-default LlmJudge safety detectors have a deterministic lexical
        // seed backstop (used only when the judge fails open); others do not.
        assert_eq!(
            llm_judge_backstop_kind("toxicity"),
            Some(DetectionKind::Toxicity)
        );
        assert_eq!(
            llm_judge_backstop_kind("bias_fairness"),
            Some(DetectionKind::Bias)
        );
        assert_eq!(llm_judge_backstop_kind("pii_leakage"), None);
        assert_eq!(llm_judge_backstop_kind("explicit_content"), None);
    }

    #[test]
    fn detection_kind_maps_regex_detectors() {
        assert_eq!(inline_detection_kind("pii_leakage"), Some(DetectionKind::Pii));
        assert_eq!(
            inline_detection_kind("code_injection"),
            Some(DetectionKind::CodeInjection)
        );
        assert_eq!(
            inline_detection_kind("prompt_injection"),
            Some(DetectionKind::PromptInjection)
        );
        assert_eq!(inline_detection_kind("toxicity"), None);
        assert_eq!(inline_detection_kind("unknown"), None);
    }
}
