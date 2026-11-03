//! The Inspector stage under Sanitize: an injection flag is forwarded but
//! never stands in for a verdict on the rest of the turn.

use super::window_tests::{block_on, cfg, content, flags_marker, ScriptedJudge, MARKER};
use super::*;

// review-sanitize-action-gaps-open: under Sanitize an injection flag is not
// redactable and is forwarded, but it is no verdict on the rest of the turn.
// An injection phrase in the newest window used to end the judging and mask
// the rest: the older windows were never judged for what Sanitize redacts,
// and a turn past the window budget passed under a closed fail mode.
#[test]
fn an_injection_flag_under_sanitize_never_masks_the_rest_of_the_turn() {
    // Past the budget: the injection flag must not hide the unjudged head.
    let text = format!("{} {MARKER}", "z".repeat(4_000 * 3));
    let mut closed = cfg(FirewallPolicy::Sanitize);
    closed.max_windows = 2;
    closed.fail_mode = Some(InspectorFailMode::Closed);
    let judge = ScriptedJudge::new(flags_marker);
    let v = block_on(InspectorClient::inspect(&text, &closed, &judge));
    assert!(
        v.flagged,
        "a partial turn fails closed under Sanitize: {v:?}"
    );
    assert_eq!(v.categories, vec![UNAVAILABLE_CATEGORY]);

    // Within the budget: every window is judged, and a PII flag in an older
    // window reaches the Sanitize path.
    let text = format!("my card is 4111 {} {MARKER}", "z".repeat(4_000 * 6));
    let judge = ScriptedJudge::new(|user| {
        if user.contains("4111") {
            content(r#"{"flagged": true, "categories": ["pii"], "reason": "card"}"#)
        } else {
            flags_marker(user)
        }
    });
    let v = block_on(InspectorClient::inspect(
        &text,
        &cfg(FirewallPolicy::Sanitize),
        &judge,
    ));
    assert!(judge.seen().len() > 4, "judging went past the first batch");
    assert!(v.flagged, "{v:?}");
    assert!(v.categories.contains(&"pii".to_owned()), "{v:?}");

    // Block still stops at the first flag.
    let judge = ScriptedJudge::new(flags_marker);
    let v = block_on(InspectorClient::inspect(
        &text,
        &cfg(FirewallPolicy::Block),
        &judge,
    ));
    assert!(v.flagged);
    assert_eq!(judge.seen().len(), 4, "one batch, then the flag ends it");
}
