//! Round 77: an object-form reasoning_details is judged by the buffered
//! lanes, and output evaluators judge the model's text as a client renders
//! it, not every JSON string glued together.

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
fn an_object_form_reasoning_details_split_is_blocked_on_both_paths() {
    let scanner = scanner();
    let frame = |text: &str, signature: &str| {
        json!({ "choices": [{ "index": 0, "delta": { "content": text,
            "reasoning_details": { "0": { "type": "reasoning.encrypted",
                "signature": signature } } } }] })
    };
    let raw = sse(&[frame("See ", "john.doe@exa"), frame("you ", "mple.com")]);
    let (streamed, blocked) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
    let (_, _, violation) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(blocked && !streamed.contains("mple.com"), "{streamed}");
    assert!(violation.is_some(), "buffered");
}

#[test]
fn evaluators_judge_the_rendered_text() {
    let scanner = scanner();
    let frame = |text: &str| {
        json!({ "id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 1,
            "model": "gpt-4o", "choices": [{ "index": 0, "delta": { "content": text },
                "finish_reason": null }] })
    };
    let raw = sse(&[frame("you should kill"), frame(" yourself")]);
    for policy in [FirewallPolicy::Block, FirewallPolicy::Sanitize] {
        let (_, assembled, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert_eq!(assembled, "you should kill yourself", "{policy:?}");
    }
}
