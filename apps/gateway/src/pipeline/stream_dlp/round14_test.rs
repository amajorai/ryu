//! vLLM's reasoning pair is a copy, and a long digit-group run is grouped as
//! the whole text groups it.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

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

fn delta(fields: Value) -> Value {
    json!({ "choices": [{ "index": 0, "delta": fields }] })
}

fn joined(sse: &str, pointer: &str) -> String {
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

fn pair(text: &str) -> Value {
    delta(json!({ "reasoning_content": text, "reasoning": text }))
}

#[test]
fn a_reasoning_pair_that_starts_late_or_stops_early_is_a_lane() {
    let scanner = scanner();
    let cases = [
        sse(&[
            pair("4111 1111 "),
            pair("1111 1111"),
            delta(json!({ "reasoning_content": "2 done" })),
        ]),
        sse(&[
            delta(json!({ "reasoning_content": "x" })),
            pair("4111 1111 "),
            pair("1111 1111 "),
        ]),
    ];
    for raw in cases {
        let (_, _, oracle) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
        assert!(oracle.is_some(), "{raw}");
        let (_, blocked) =
            run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked, "{raw}");
        // Warn redacts only outbound secrets, not PII, on both paths.
        let (streamed, _) =
            run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
        assert!(
            !joined(&streamed, "/choices/0/delta/reasoning").contains("4111 1111 1111 1111"),
            "{streamed}"
        );
    }
}

#[test]
fn a_long_digit_group_run_is_grouped_as_the_whole_text_groups_it() {
    let scanner = scanner();
    let mut groups = vec!["0000"; 977];
    groups[912..916].copy_from_slice(&["4111", "1111", "1111", "1111"]);
    let mut frames = vec![
        delta(json!({ "content": "Numbers: " })),
        delta(json!({ "content": format!("{} ", groups[0]) })),
    ];
    for chunk in groups[1..].chunks(4) {
        frames.push(delta(json!({ "content": format!("{} ", chunk.join(" ")) })));
    }
    let raw = sse(&frames);
    let (_, _, oracle) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(oracle.is_some());
    let (streamed, blocked) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    assert!(!streamed.contains("4111"), "card digits released");
}
