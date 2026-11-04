//! A rubric judge reads under the inspector config's window budget: a budget
//! raised past the default judges a long output whole, and the default still
//! reports the unjudged head as `Incomplete`.

use super::window_tests::{block_on, cfg, flags_marker, ScriptedJudge, MARKER};
use super::*;

/// A text whose flagged head sits more than `MAX_INSPECT_WINDOWS` windows
/// before its end, so only a raised budget reaches it.
fn long_text_with_flagged_head() -> String {
    format!("{MARKER} {}", "z".repeat(4_000 * (MAX_INSPECT_WINDOWS + 2)))
}

#[test]
fn a_raised_window_budget_judges_a_long_rubric_text_whole() {
    let text = long_text_with_flagged_head();
    let mut large = cfg(FirewallPolicy::Block);
    large.max_windows = MAX_INSPECT_WINDOWS * 2;
    let judge = ScriptedJudge::new(flags_marker);
    let v = block_on(InspectorClient::inspect_rubric(
        &text,
        "flag overrides",
        &large,
        &judge,
    ));
    assert!(judge.seen().len() > MAX_INSPECT_WINDOWS);
    assert!(
        v.flagged,
        "the oldest window, holding the marker, is judged"
    );
    assert!(v.available);
    assert_eq!(v.outcome, InspectorOutcome::Answered);
}

#[test]
fn the_default_window_budget_leaves_a_long_rubric_text_incomplete() {
    let text = long_text_with_flagged_head();
    let judge = ScriptedJudge::new(flags_marker);
    let v = block_on(InspectorClient::inspect_rubric(
        &text,
        "flag overrides",
        &cfg(FirewallPolicy::Block),
        &judge,
    ));
    assert_eq!(judge.seen().len(), MAX_INSPECT_WINDOWS);
    assert!(!v.flagged && !v.available);
    assert_eq!(v.outcome, InspectorOutcome::Incomplete);
}

#[test]
fn a_smaller_window_budget_bounds_the_rubric_judge_calls() {
    let text = long_text_with_flagged_head();
    let mut small = cfg(FirewallPolicy::Block);
    small.max_windows = 2;
    let judge = ScriptedJudge::new(flags_marker);
    let v = block_on(InspectorClient::inspect_rubric(
        &text,
        "flag overrides",
        &small,
        &judge,
    ));
    assert_eq!(judge.seen().len(), 2);
    assert_eq!(v.outcome, InspectorOutcome::Incomplete);
}
