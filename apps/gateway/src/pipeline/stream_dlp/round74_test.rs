//! Round 74: a choices array not plainly lane 0 at position 0 is judged by
//! the buffered lanes, envelope lanes match whole path segments, and a
//! held-whole stream's envelope lanes continue the released frames' runs.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn offsets(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

fn sse(frames: &[Value]) -> String {
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    raw
}

/// Blocked on both paths (the buffered caller replaces the frames with the
/// notice on a violation), and under Sanitize no piece goes out.
fn never_whole(raw: &str, piece: &str) {
    let scanner = scanner();
    let (streamed, blocked) =
        run_streaming(raw, &offsets(raw), FirewallPolicy::Block, &scanner).unwrap();
    let (_, _, violation) =
        super::super::rewrite_sse_for_dlp(raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(blocked && !streamed.contains(piece), "{streamed}");
    assert!(violation.is_some(), "buffered");
    let (streamed, _) =
        run_streaming(raw, &offsets(raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    for out in [&streamed, &buffered] {
        assert!(!out.contains(piece), "Sanitize: {out}");
    }
}

#[test]
fn the_index_zero_choice_at_a_later_position_is_judged() {
    never_whole(
        &sse(&[
            json!({ "choices": [{ "index": 1, "delta": { "content": "Yo " } },
                { "index": 0, "delta": { "content": "Hi " }, "stop_reason": "123-45-" }] }),
            json!({ "choices": [{ "index": 1, "delta": { "content": "man" } },
                { "index": 0, "delta": { "content": "there" }, "stop_reason": "6789" }] }),
        ]),
        "123-45-",
    );
}

#[test]
fn envelope_lanes_match_whole_segments_only() {
    never_whole(
        &sse(&[
            json!({ "choices": [{ "index": 0, "delta": { "content": "Hi " },
                "content_filter_results": { "custom_blocklists_v2": "123-45-" } }] }),
            json!({ "choices": [{ "index": 0, "delta": { "content": "there" },
                "content_filter_results": { "custom_blocklists_v2": "6789" } }] }),
        ]),
        "123-45-",
    );
}

#[test]
fn a_hold_continues_the_released_envelope_runs() {
    let scanner = scanner();
    let content = |text: &str, fingerprint: &str| {
        json!({ "choices": [{ "index": 0, "delta": { "content": text } }],
            "system_fingerprint": fingerprint })
    };
    let mut third = content("ok ", "john.doe");
    third["x"] = json!([{ "index": 1, "v": "q" }]);
    let raw = sse(&[
        content("Hi ", "john.doe"),
        content("there ", "john.doe"),
        third,
        content("done", "@example.com"),
    ]);
    let (streamed, blocked) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
    let (buffered, _, violation) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert_eq!(blocked, violation.is_some(), "{streamed}");
    assert_eq!(streamed, buffered);
}
