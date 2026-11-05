//! Every text field of a frame takes part in resume tracking, a pinned
//! form's opener window is measured from the cut, and only the first choice
//! feeds the field history.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn frame(key: &str, part: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": { key: part } }] })
}

fn sse(frames: &[Value]) -> String {
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    raw
}

fn per_frame(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

fn field_of(sse: &str, pointer: &str) -> String {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .filter_map(|frame| {
            frame
                .pointer(pointer)
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

#[test]
fn a_field_resuming_beside_another_in_one_frame_is_one_lane() {
    let scanner = scanner();
    let raw = sse(&[
        frame("reasoning_content", "key sk-ab"),
        frame("content", "hello "),
        json!({ "choices": [{ "index": 0, "delta": {
            "content": " x", "reasoning_content": "cdefghijklmnopqrstuvwxyz0123" } }] }),
    ]);
    let (_, blocked) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    for policy in [
        FirewallPolicy::Block,
        FirewallPolicy::Sanitize,
        FirewallPolicy::WarnAndContinue,
    ] {
        let (streamed, _) =
            run_streaming(&raw, &per_frame(&raw), policy.clone(), &scanner).unwrap();
        let reasoning = field_of(&streamed, "/choices/0/delta/reasoning_content");
        assert!(
            !reasoning.contains("cdefghijklmnop"),
            "{policy:?}: {streamed}"
        );
    }
}

#[test]
fn a_bounded_match_before_a_pinned_form_is_judged_before_release() {
    let scanner = scanner();
    let mut frames = vec![
        frame("content", "Call 555"),
        frame("content", " 123-4567,"),
        frame("content", "postgres://"),
    ];
    frames.extend((0..70).map(|_| frame("content", "\u{5bc6}")));
    frames.push(frame("content", " done"));
    let raw = sse(&frames);
    let last = *per_frame(&raw).last().unwrap();
    let (streamed, blocked) =
        run_streaming(&raw, &[last], FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    assert!(
        !field_of(&streamed, "/choices/0/delta/content").contains("555"),
        "{streamed}"
    );
    let (streamed, _) = run_streaming(&raw, &[last], FirewallPolicy::Sanitize, &scanner).unwrap();
    assert!(
        !field_of(&streamed, "/choices/0/delta/content").contains("555"),
        "{streamed}"
    );
}

#[test]
fn other_choices_do_not_feed_the_first_choices_field_history() {
    let scanner = scanner();
    let choice = |index: u64, key: &str, part: &str| json!({ "choices": [{ "index": index, "delta": { key: part } }] });
    let raw = sse(&[
        choice(0, "reasoning_content", "Let me think. "),
        choice(0, "content", "token=abcd"),
        choice(1, "reasoning_content", "Hmm. "),
        choice(1, "content", "efgh1234 ok"),
        choice(0, "content", " done."),
    ]);
    for policy in [FirewallPolicy::Block, FirewallPolicy::WarnAndContinue] {
        let (oracle, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        let (streamed, blocked) =
            run_streaming(&raw, &per_frame(&raw), policy.clone(), &scanner).unwrap();
        assert!(!blocked);
        assert_eq!(streamed, oracle, "{policy:?}");
    }
}
