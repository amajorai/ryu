use super::*;

/// A message that is ONLY a mention carries no prompt — nothing to route.
#[test]
fn mention_only_message_is_dropped() {
    let msg = channel_msg("<@UBOT>");
    assert!(decide_reply(&msg, GroupReplyMode::Mentions, "UBOT", false).is_none());
}

/// …unless it carries media, which IS the prompt.
#[test]
fn mention_with_media_and_no_text_is_routed() {
    let mut msg = channel_msg("<@UBOT>");
    msg.attachments.push(Attachment {
        kind: Some(AttachmentKind::Image),
        filename: Some("chart.png".into()),
        ..Default::default()
    });
    assert_eq!(
        decide_reply(&msg, GroupReplyMode::Mentions, "UBOT", false).as_deref(),
        Some("")
    );
}

// ─── Reconnect backoff (was a fixed 3s with no cap, no jitter and no attempt
// counter: a permanently-failing apps.connections.open hot-looped forever) ──

#[test]
fn backoff_grows_exponentially_and_is_capped() {
    assert_eq!(backoff_for(1), RECONNECT_BASE_BACKOFF);
    assert_eq!(backoff_for(2), Duration::from_secs(6));
    assert_eq!(backoff_for(3), Duration::from_secs(12));
    assert_eq!(backoff_for(4), Duration::from_secs(24));
    assert_eq!(backoff_for(5), Duration::from_secs(48));
    // Capped from here on — never unbounded, never a tight loop.
    assert_eq!(backoff_for(6), RECONNECT_MAX_BACKOFF);
    assert_eq!(backoff_for(MAX_RECONNECT_ATTEMPTS), RECONNECT_MAX_BACKOFF);
    assert_eq!(backoff_for(u32::MAX), RECONNECT_MAX_BACKOFF);
}

#[test]
fn backoff_is_never_shorter_than_the_base_and_jitter_stays_bounded() {
    for attempt in 1..=MAX_RECONNECT_ATTEMPTS {
        let base = backoff_for(attempt);
        let delay = reconnect_delay(attempt);
        assert!(delay >= base, "jitter must never shorten the backoff");
        // Jitter adds at most 25% on top, so a fleet never re-opens in lockstep
        // yet the delay stays predictable.
        assert!(delay <= base + base / 4 + Duration::from_millis(1));
        assert!(delay >= RECONNECT_BASE_BACKOFF);
    }
}

/// The attempt budget is finite — that is what turns a permanent failure
/// (an app token without `connections:write`) into a reported error instead
/// of an infinite retry loop.
#[test]
fn reconnect_budget_is_bounded() {
    const {
        assert!(MAX_RECONNECT_ATTEMPTS > 0);
    }
    let total: Duration = (1..MAX_RECONNECT_ATTEMPTS).map(backoff_for).sum();
    // Generous enough to ride out a real outage, finite enough to surface a
    // permanent misconfiguration to the operator.
    assert!(
        total >= Duration::from_secs(60),
        "budget too eager to give up"
    );
    assert!(
        total <= Duration::from_secs(15 * 60),
        "budget never terminates"
    );
}

#[test]
fn strip_mentions_collapses_whitespace_and_keeps_stray_text() {
    assert_eq!(strip_mentions("<@U1> hey   there"), "hey there");
    assert_eq!(strip_mentions("no mentions"), "no mentions");
    // An unterminated mention is left alone rather than eating the message.
    assert_eq!(strip_mentions("<@U1 unterminated"), "<@U1 unterminated");
}

// ─── mrkdwn conversion ─────────────────────────────────────────────────────

/// The conversion that a sequential two-pass implementation gets wrong:
/// `**bold**` becomes `*bold*`, and the `*bold*` it just produced must NOT
/// then be re-read as an italic.
#[test]
fn mrkdwn_converts_bold_without_re_reading_its_own_output() {
    assert_eq!(to_mrkdwn("**bold**"), "*bold*");
    assert_eq!(to_mrkdwn("__bold__"), "*bold*");
    assert_eq!(to_mrkdwn("*italic*"), "_italic_");
    assert_eq!(to_mrkdwn("**bold** and *italic*"), "*bold* and _italic_");
    // Already-mrkdwn emphasis survives untouched.
    assert_eq!(to_mrkdwn("_italic_"), "_italic_");
    assert_eq!(to_mrkdwn("~~gone~~"), "~gone~");
}

/// A lone asterisk is arithmetic or a footnote, not markup.
#[test]
fn mrkdwn_leaves_unmatched_emphasis_alone() {
    assert_eq!(to_mrkdwn("2 * 3 = 6"), "2 * 3 = 6");
    assert_eq!(to_mrkdwn("a *dangling marker"), "a *dangling marker");
}

#[test]
fn mrkdwn_rewrites_links_and_escapes_around_them() {
    assert_eq!(
        to_mrkdwn("see [the docs](https://example.com/a?b=1&c=2)"),
        "see <https://example.com/a?b=1&amp;c=2|the docs>"
    );
    // A bare `<` in prose is escaped, or Slack reads it as its own syntax.
    assert_eq!(to_mrkdwn("a < b && c > d"), "a &lt; b &amp;&amp; c &gt; d");
}

#[test]
fn mrkdwn_passes_code_through_untouched() {
    assert_eq!(to_mrkdwn("call `a ** b` now"), "call `a ** b` now");
    let fenced = "before\n```rust\nlet x = **y;\n```\nafter";
    // The info string goes (Slack has no highlighting) and the body is verbatim.
    assert_eq!(to_mrkdwn(fenced), "before\n```\nlet x = **y;\n```\nafter");
}

/// A `#` without whitespace after it is a channel reference, not a heading.
#[test]
fn mrkdwn_leaves_a_channel_reference_alone() {
    assert_eq!(to_mrkdwn("ask in #general"), "ask in #general");
    assert_eq!(to_mrkdwn("#general is quiet"), "#general is quiet");
}

#[test]
fn mrkdwn_maps_block_constructs_slack_lacks() {
    assert_eq!(to_mrkdwn("## Results"), "*Results*");
    // Emphasis inside a heading is dropped, not nested — Slack cannot render
    // nested asterisks.
    assert_eq!(to_mrkdwn("# A **bold** title"), "*A bold title*");
    assert_eq!(to_mrkdwn("- one\n  - two"), "• one\n  • two");
    assert_eq!(to_mrkdwn("* starred item"), "• starred item");
    assert_eq!(to_mrkdwn("> quoted **thing**"), "> quoted *thing*");
    // Tables have no equivalent at all, so the rows are left as written.
    assert_eq!(to_mrkdwn("| a | b |"), "| a | b |");
}

#[test]
fn mrkdwn_preserves_line_structure() {
    assert_eq!(to_mrkdwn("one\n\ntwo\n"), "one\n\ntwo\n");
    assert_eq!(to_mrkdwn(""), "");
}

/// A wall of markers must not recurse, hang, or grow the output. The scan is
/// linear and the nesting ceiling bounds the closer stack, so asterisk soup
/// simply collapses to the mrkdwn spelling of the same (meaningless) emphasis.
#[test]
fn mrkdwn_survives_pathological_emphasis() {
    let noisy = "*".repeat(200);
    assert!(to_mrkdwn(&noisy).chars().count() <= noisy.chars().count());
    // Whatever the markers do, the words between them must survive.
    let mixed = format!("{m}a{m}b{m}c{m}", m = "*_~");
    assert!(["a", "b", "c"]
        .iter()
        .all(|word| to_mrkdwn(&mixed).contains(word)));
}
