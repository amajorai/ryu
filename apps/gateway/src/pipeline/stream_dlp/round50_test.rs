//! Round 50: finish reasons are fixed protocol values (a split value cannot
//! hide in them), envelope paths the buffered lanes name differently hold the
//! stream, and the crossing window stays bounded.

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

fn visible(sse: &str) -> String {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .filter_map(|value| {
            value["choices"][0]["delta"]["content"]
                .as_str()
                .map(str::to_owned)
        })
        .collect()
}

fn blocked_both(raw: &str) {
    let scanner = scanner();
    let (streamed, blocked) =
        run_streaming(raw, &offsets(raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked, "stream released: {streamed}");
    assert!(!streamed.contains("MNOP"), "{streamed}");
}

#[test]
fn a_key_split_over_native_finish_reasons_is_blocked() {
    blocked_both(&sse(&[
        json!({ "choices": [{ "index": 0, "delta": { "role": "assistant", "content": "Done " },
            "finish_reason": null, "native_finish_reason": "AKIAABCDEFGHIJKL" }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": "now." },
            "finish_reason": "stop", "native_finish_reason": "MNOP" }] }),
    ]));
}

#[test]
fn envelope_paths_the_buffered_lanes_name_differently_hold_the_stream() {
    blocked_both(&sse(&[
        json!({ "choices": [{ "index": 0, "delta": { "content": "Hi " } }],
            "citations": [{ "index": 3, "text": "AKIAABCDEFGHIJKL" }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": "there." } }],
            "citations": [{}, {}, {}, { "text": "MNOP" }] }),
    ]));
    // A key holding `/` is its own lane on both paths (escaped since round
    // 62): neither joins it with a nested field.
    let raw = sse(&[
        json!({ "choices": [{ "index": 0, "delta": { "content": "Hi " } }],
            "a/b": "AKIAABCDEFGHIJKL" }),
        json!({ "choices": [{ "index": 0, "delta": { "content": "there." } }],
            "a": { "b": "MNOP" } }),
    ]);
    let scanner = scanner();
    let (_, blocked) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
    let (_, _, violation) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert_eq!(blocked, violation.is_some());
}

#[test]
fn a_together_eos_chunk_keeps_the_text_level_rewrite() {
    let scanner = scanner();
    let frame = |text: &str, token: u64, finish: Value| {
        json!({ "choices": [{ "index": 0, "text": text, "logprobs": null,
            "finish_reason": finish, "seed": 42,
            "delta": { "token_id": token, "role": "assistant", "content": text,
                "tool_calls": null } }] })
    };
    let raw = sse(&[
        frame("Reach me at jane", 1, Value::Null),
        frame(".doe@exam", 2, Value::Null),
        frame("ple.com", 3, Value::Null),
        frame("", 2, json!("eos")),
    ]);
    let (streamed, _) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    for out in [&streamed, &buffered] {
        assert_eq!(visible(out), "Reach me at [REDACTED:EMAIL]", "{out}");
        assert!(out.contains("\"finish_reason\":\"eos\""), "{out}");
    }
}
