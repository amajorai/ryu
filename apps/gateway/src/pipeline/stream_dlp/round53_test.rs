//! Round 53: both paths scan each frame's own strings (no newline join across
//! frames), and OpenRouter's Responses-API statuses are protocol metadata.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn offsets(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
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

#[test]
fn both_paths_reach_the_same_verdict_on_odd_frames() {
    let scanner = scanner();
    let raw = "data: [\"call me at 555\"]\n\ndata: [\"123-4567\"]\n\ndata: [DONE]\n\n";
    let (streamed, blocked) =
        run_streaming(raw, &offsets(raw), FirewallPolicy::Block, &scanner).unwrap();
    let (buffered, _, violation) =
        super::super::rewrite_sse_for_dlp(raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert_eq!(blocked, violation.is_some(), "{streamed} / {buffered}");
}

#[test]
fn an_openrouter_completed_status_keeps_the_text_level_rewrite() {
    let scanner = scanner();
    let frame = |text: &str, finish: Value, native: Value| {
        json!({ "choices": [{ "index": 0, "delta": { "content": text },
            "finish_reason": finish, "native_finish_reason": native }] })
    };
    let frames = [
        frame("Mail jane.d", Value::Null, Value::Null),
        frame("oe@example.com for details.", Value::Null, Value::Null),
        frame("", json!("stop"), json!("completed")),
    ];
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    let (streamed, _) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    for out in [&buffered, &streamed] {
        assert_eq!(visible(out), "Mail [REDACTED:EMAIL] for details.", "{out}");
        assert!(
            out.contains("\"native_finish_reason\":\"completed\""),
            "{out}"
        );
    }
}
