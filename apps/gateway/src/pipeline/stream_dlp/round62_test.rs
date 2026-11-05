//! Round 62: a reasoning_details entry out of position gives up the copies
//! (their released text is judged whole), and a key holding `/` never aliases
//! another field's lane.

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

#[test]
fn a_details_entry_out_of_position_joins_the_released_copy() {
    let scanner = scanner();
    for field in ["text", "summary"] {
        let kind = if field == "text" {
            "reasoning.text"
        } else {
            "reasoning.summary"
        };
        let raw = sse(&[
            json!({ "choices": [{ "index": 0, "delta": { "role": "assistant", "content": "",
                "reasoning": "Contact john.doe",
                "reasoning_details": [{ "type": kind, "index": 0, field: "Contact john.doe" }] } }] }),
            json!({ "choices": [{ "index": 0, "delta": { "content": "Sure. " } }] }),
            json!({ "choices": [{ "index": 0, "delta": { "reasoning_details": [
                { "type": kind, "index": 1 },
                { "type": kind, "index": 0, field: "@example.com" }] },
                "finish_reason": "stop" }] }),
        ]);
        let (_, _, violation) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
        assert!(violation.is_some(), "{field}: buffered");
        let (streamed, blocked) =
            run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
        assert!(
            blocked && !streamed.contains("@example.com"),
            "{field}: {streamed}"
        );
    }
}

#[test]
fn a_slash_key_does_not_alias_a_released_field() {
    let scanner = scanner();
    let raw = sse(&[
        json!({ "choices": [{ "index": 0, "delta": { "content": "Contact john.doe" } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "reasoning": "Checking. " } }] }),
        json!({ "choices": [{ "index": 0, "delta": {}, "delta/content": "@example.com" }] }),
    ]);
    let (_, blocked) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
    let (_, _, violation) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert_eq!(blocked, violation.is_some());
}
