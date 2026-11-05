//! vLLM's mirrored `reasoning` is a field of its own, and detection sees what
//! Sanitize rewrites.

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

fn reasoning_of(sse: &str) -> String {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .filter_map(|frame| {
            frame
                .pointer("/choices/0/delta/reasoning")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

#[test]
fn a_mirrored_reasoning_field_continued_alone_is_one_lane() {
    let scanner = scanner();
    let mirrored = delta(json!({
        "reasoning_content": "key sk-abcdefgh", "reasoning": "key sk-abcdefgh" }));
    let rest = delta(json!({ "reasoning": "ijklmnopqrstuvwxyz0123 done" }));
    let cases = [
        sse(&[mirrored.clone(), rest.clone()]),
        sse(&[mirrored, delta(json!({ "content": "Hi " })), rest]),
    ];
    for raw in cases {
        let (_, _, oracle) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
        assert!(oracle.is_some());
        let (_, blocked) =
            run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked);
        for policy in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
            let (streamed, _) =
                run_streaming(&raw, &per_frame(&raw), policy.clone(), &scanner).unwrap();
            assert!(
                !reasoning_of(&streamed).contains("ijklmnop"),
                "{policy:?}: {streamed}"
            );
        }
    }
}

#[test]
fn a_mirrored_reasoning_stream_still_streams() {
    let scanner = scanner();
    let mut dlp = super::StreamingDlp::new(FirewallPolicy::Block, true);
    let mut early = String::new();
    for word in ["Let ", "me ", "think ", "about ", "this. "] {
        let frame = delta(json!({ "reasoning_content": word, "reasoning": word }));
        early.push_str(
            &dlp.push(format!("data: {frame}\n\n").as_bytes(), &scanner)
                .unwrap()
                .bytes,
        );
    }
    assert!(reasoning_of(&early).starts_with("Let me think"), "{early}");
}

#[test]
fn detection_sees_a_value_a_homoglyph_sets_apart() {
    let scanner = scanner();
    // Folding the Cyrillic letter to `x` joins it to the number; the raw
    // text keeps the boundary that sanitize redacts at.
    let text = "Call \u{445}555-123-4567 now";
    assert_ne!(scanner.sanitize(text), text);
    assert!(scanner.scan_outbound(text).is_some());
}
