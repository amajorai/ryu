//! Wire contract for the Ryu **self-healing** loop — the shapes that cross the
//! boundary between Core and the out-of-process `ryu-healing` sidecar.
//!
//! When a run fails, Core raises the `core#run.failed` kernel event (payload: the
//! run's instruction + failure output, truncated with [`truncate_context`]), which
//! the sidecar receives on `POST /api/healing/report-failure`. The sidecar owns the
//! whole decision side — the per-source attempt cap, the cooldown, the Gateway
//! diagnosis call, the `healing.*` prefs — and turns it into a [`HealVerdict`],
//! which it applies by calling Core's grant-gated kernel capabilities. Core owns
//! the *actions* themselves (the approvals-inbox write and the agent / workflow
//! re-run) and mints the re-run id. (An older Core posted the flat payload and
//! applied the returned verdict itself; the sidecar still answers that form.)
//!
//! So the two halves need the same verdict vocabulary and neither may link the
//! other. This crate is that shared middle: `serde`-only, no `apps/core`
//! dependency, no `axum`/`tokio`. Same topology as
//! [`ryu-teams-contracts`](https://docs.rs/ryu-teams-contracts) between Core and the
//! teams sidecar.
//!
//! Two constants live here for a sharper reason than the enum does. [`HEAL_PREFIX`]
//! and [`MAX_CONTEXT_CHARS`] are agreements the two binaries keep **out of band** —
//! nothing on the wire carries them, so a mismatch is not a deserialization error,
//! it is silently wrong behaviour:
//!
//! - Core mints a re-run id as `{HEAL_PREFIX}{uuid}`; the sidecar's `decide_heal`
//!   drops any failure whose source id starts with `HEAL_PREFIX` (rule #1, *never
//!   heal a heal*). If the two strings ever diverge, the loop guard stops firing and
//!   a failing heal-retry heals itself forever.
//! - Core truncates the failed run's context with [`truncate_context`] before
//!   posting it, applying a policy the sidecar's prompt budget assumes.
//! - The `kind` field of the report body is a bare string on both sides, and the
//!   sidecar's parse is `"workflow"`-or-else-agent — so a misspelling does not 400,
//!   it silently heals a failed workflow as if it were an agent.
//!   [`SOURCE_KIND_AGENT`] / [`SOURCE_KIND_WORKFLOW`] are that agreement.
//!
//! What is deliberately NOT here: `HealSource`, `HealDecision`, `HealConfig`,
//! `HealAttempt` and the `HealingHost` trait. `HealSource` does not cross the wire as
//! a *type* — each side keeps its own enum, flattened to / parsed from the `kind`
//! string above — and the rest are the sidecar engine's own internals. The rule this
//! crate follows: share what nothing else can check. A mismatched enum shape is a
//! compile error at the flatten; a mismatched string literal is a silent behaviour
//! change, so the literal is shared and the enum is not.

use serde::{Deserialize, Serialize};

// ── Out-of-band agreements ──────────────────────────────────────────────────────

/// Conversation/run-id prefix marking a heal re-run — the **never-heal-a-heal**
/// marker. Core stamps it on every re-run id it mints; the sidecar's `decide_heal`
/// refuses to heal a source id carrying it. Shared because nothing on the wire
/// carries this string: a drift between the two binaries is an infinite heal loop,
/// not a parse error.
pub const HEAL_PREFIX: &str = "healrun_";

/// Upper bound (in `char`s, not bytes) on each half of the failure context Core
/// posts to the sidecar. See [`truncate_context`].
pub const MAX_CONTEXT_CHARS: usize = 4000;

/// `kind` discriminant for a chat / agent / scheduled-agent failure.
pub const SOURCE_KIND_AGENT: &str = "agent";
/// `kind` discriminant for a workflow-run failure.
pub const SOURCE_KIND_WORKFLOW: &str = "workflow";

/// Char-bounded truncation of a failed run's instruction / failure output to
/// [`MAX_CONTEXT_CHARS`], never splitting a multi-byte codepoint. Applied Core-side,
/// because Core is the half that reads the failed run's messages out of its
/// conversation store (a kernel coupling), but the *policy* belongs to the diagnosis
/// prompt the sidecar builds — hence the shared home.
///
/// A truncated string is one char longer than the bound: the trailing `…` marks the
/// cut so the diagnosis model can tell a clipped context from a complete one.
pub fn truncate_context(text: &str) -> String {
    let t = text.trim();
    if t.chars().count() > MAX_CONTEXT_CHARS {
        let mut s: String = t.chars().take(MAX_CONTEXT_CHARS).collect();
        s.push('…');
        s
    } else {
        t.to_string()
    }
}

// ── The verdict ─────────────────────────────────────────────────────────────────

/// The concrete action a failed-run evaluation resolves to — the serialized verdict
/// the `ryu-healing` sidecar returns to Core so **Core** performs the welded action
/// (approvals write / agent-or-workflow re-run) on the sidecar's behalf. The sidecar
/// also dispatches the same verdict against its own `HealingHost`, so both paths
/// branch on one enum.
///
/// The [`HEAL_PREFIX`] re-run id is minted by whichever side dispatches the verdict,
/// not carried in it: it is only meaningful at the moment the re-run starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum HealVerdict {
    /// No action (the reason is logged).
    Skip { reason: String },
    /// Auto-apply an agent fix: re-run the agent with the corrected prompt.
    RerunAgent {
        agent_id: Option<String>,
        prompt: String,
    },
    /// Auto-apply a workflow fix: re-run the failed workflow from scratch.
    RerunWorkflow { source_id: String },
    /// Queue a proposed agent fix into the approvals inbox.
    QueueFix {
        source_id: String,
        agent_id: Option<String>,
        diagnosis: String,
        corrected: String,
    },
    /// Queue a proposed workflow fix into the approvals inbox.
    QueueWorkflow {
        source_id: String,
        diagnosis: String,
    },
    /// Queue a terminal "attempts exhausted" review item (no auto-action).
    QueueExhausted { source_id: String, note: String },
    /// An `action` this binary does not know — a logged no-op on the receiving side.
    ///
    /// A shared crate stops *source* drift, not *binary* skew: the sidecar ships as
    /// its own executable with a `RYU_HEALING_BIN` override, so a newer sidecar
    /// answering an older Core is reachable in the field. Without this arm an
    /// unrecognized `action` fails the whole `resp.json()`, which the caller logs and
    /// drops — so one new variant would silently kill **every** heal, not just its
    /// own. With it, the unknown verdict alone degrades to a warning.
    #[serde(other)]
    Unknown,
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- truncate_context -----------------------------------------------------

    #[test]
    fn truncate_context_trims_and_passes_short() {
        assert_eq!(truncate_context("  hi there  "), "hi there");
        assert_eq!(truncate_context(""), "");
    }

    #[test]
    fn truncate_context_bounds_long_input_on_char_boundary() {
        // Multi-byte input: a byte-based slice would panic or corrupt here.
        let long: String = "😀".repeat(MAX_CONTEXT_CHARS + 1);
        let out = truncate_context(&long);
        assert_eq!(out.chars().count(), MAX_CONTEXT_CHARS + 1);
        assert!(out.ends_with('…'));
        assert!(out.chars().take(MAX_CONTEXT_CHARS).all(|c| c == '😀'));
    }

    #[test]
    fn truncate_context_keeps_exactly_max_untouched() {
        let exact: String = "a".repeat(MAX_CONTEXT_CHARS);
        let out = truncate_context(&exact);
        assert_eq!(out, exact);
        assert!(!out.ends_with('…'));
    }

    // --- HealVerdict wire form ------------------------------------------------

    #[test]
    fn verdict_serializes_with_a_snake_case_action_tag() {
        let v = HealVerdict::QueueFix {
            source_id: "conv1".into(),
            agent_id: Some("a1".into()),
            diagnosis: "bad tool call".into(),
            corrected: "try again".into(),
        };
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["action"], "queue_fix");
        assert_eq!(json["source_id"], "conv1");
    }

    #[test]
    fn verdict_round_trips_every_known_variant() {
        let all = vec![
            HealVerdict::Skip {
                reason: "disabled".into(),
            },
            HealVerdict::RerunAgent {
                agent_id: None,
                prompt: "p".into(),
            },
            HealVerdict::RerunWorkflow {
                source_id: "wf1".into(),
            },
            HealVerdict::QueueFix {
                source_id: "c".into(),
                agent_id: Some("a".into()),
                diagnosis: "d".into(),
                corrected: "x".into(),
            },
            HealVerdict::QueueWorkflow {
                source_id: "wf2".into(),
                diagnosis: "d".into(),
            },
            HealVerdict::QueueExhausted {
                source_id: "c2".into(),
                note: "n".into(),
            },
        ];
        for v in all {
            let s = serde_json::to_string(&v).unwrap();
            assert_eq!(serde_json::from_str::<HealVerdict>(&s).unwrap(), v);
        }
    }

    /// The whole justification for the `Unknown` arm: a newer sidecar's verdict must
    /// parse into a no-op, not fail the response body and take every other heal with
    /// it.
    #[test]
    fn unknown_action_deserializes_instead_of_erroring() {
        let future = r#"{"action":"rerun_gateway","source_id":"c1","extra":42}"#;
        assert_eq!(
            serde_json::from_str::<HealVerdict>(future).unwrap(),
            HealVerdict::Unknown
        );
    }

    #[test]
    fn a_verdict_with_no_action_tag_is_still_a_hard_error() {
        // `#[serde(other)]` catches unknown tags, not a missing/!string tag — a
        // malformed body must stay loud.
        assert!(serde_json::from_str::<HealVerdict>(r#"{"reason":"x"}"#).is_err());
    }

    /// Pins the exact bytes, because the sidecar's parse is `"workflow"`-or-else-
    /// agent: a typo here is not a 400, it is a workflow healed as an agent.
    #[test]
    fn source_kinds_are_the_wire_spellings() {
        assert_eq!(SOURCE_KIND_AGENT, "agent");
        assert_eq!(SOURCE_KIND_WORKFLOW, "workflow");
    }

    #[test]
    fn heal_prefix_is_the_never_heal_a_heal_marker() {
        let minted = format!("{HEAL_PREFIX}deadbeef");
        assert!(minted.starts_with(HEAL_PREFIX));
        assert!(!"conv_deadbeef".starts_with(HEAL_PREFIX));
    }
}
