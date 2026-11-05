//! A carried keyword still reaches its value across text of another lane.

use serde_json::{json, Value};

use super::round15_test::{content, sse};
use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn with_gap(lead: &str, padding: &str, count: usize, gap: Value, value: &str) -> String {
    let mut frames = vec![
        json!({ "choices": [{ "index": 0, "delta": { "role": "assistant", "content": "" } }] }),
        content(lead),
    ];
    frames.extend((0..count).map(|_| content(padding)));
    frames.push(gap);
    frames.push(content(value));
    frames.push(content(" thanks"));
    sse(&frames)
}

/// Frames putting another lane's text between the padding and the value;
/// the first four also carry the field's own `padding`.
fn gaps(padding: &str) -> [Value; 7] {
    [
        json!({ "choices": [{ "index": 0, "delta": { "content": padding, "refusal": "!" } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": padding, "tool_calls": [{ "index": 0,
            "id": "c1", "type": "function", "function": { "name": "f", "arguments": "{}" } }] } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": padding } },
            { "index": 1, "delta": { "content": "!" } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": padding, "reasoning_content": "!" } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{ "index": 0, "id": "c1",
            "type": "function", "function": { "name": "f", "arguments": "{}" } }] } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "refusal": "!" } }] }),
        json!({ "choices": [{ "index": 1, "delta": { "content": "!" } }] }),
    ]
}

#[test]
fn a_carried_keyword_reaches_its_value_across_another_lane() {
    let scanner = scanner();
    for gap in gaps(" #") {
        let raw = with_gap("My passport", " #", 3000, gap, " AB1234567");
        let splits: Vec<_> = raw.match_indices("data: ").map(|(at, _)| at).collect();
        let (streamed, blocked) =
            run_streaming(&raw, &splits, FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked);
        assert!(!streamed.contains("AB1234567"));
        let (streamed, _) =
            run_streaming(&raw, &splits, FirewallPolicy::Sanitize, &scanner).unwrap();
        assert!(!streamed.contains("AB1234567"));
    }
    for gap in gaps("\u{a0}\u{a0}") {
        let token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
        let raw = with_gap(
            "Authorization: Bearer",
            "\u{a0}\u{a0}",
            2500,
            gap,
            &format!(" {token}"),
        );
        let splits: Vec<_> = raw.match_indices("data: ").map(|(at, _)| at).collect();
        let (streamed, _) =
            run_streaming(&raw, &splits, FirewallPolicy::WarnAndContinue, &scanner).unwrap();
        assert!(!streamed.contains(token));
    }
}

#[test]
fn blocklist_ids_under_filter_offsets_are_lanes() {
    let scanner = scanner();
    let frame = |text: &str, id: &str| {
        json!({ "choices": [{ "index": 0, "delta": { "content": text },
            "content_filter_offsets": { "check_offset": 0, "start_offset": 0, "end_offset": 2,
                "custom_blocklists": [{ "filtered": false, "id": id }] } }] })
    };
    let raw = sse(&[
        frame("Hi", "sk-abcdefghij"),
        frame(" there ", "klmnopqrstuvwxyz"),
        frame("friend.", "x"),
    ]);
    let splits: Vec<_> = raw.match_indices("data: ").map(|(at, _)| at).collect();
    let (_, blocked) = run_streaming(&raw, &splits, FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    let (streamed, _) = run_streaming(&raw, &splits, FirewallPolicy::Sanitize, &scanner).unwrap();
    assert!(!(streamed.contains("sk-abcdefghij") && streamed.contains("klmnopqrstuvwxyz")));
}
