//! A split reasoning/answer frame is one provider frame for envelope lanes,
//! a trimmed field next to another lane still reaches a carried keyword,
//! and usage on every chunk does not stop the split.

use serde_json::{json, Value};

use super::round15_test::{content, sse};
use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn splits(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

#[test]
fn an_envelope_value_split_around_a_boundary_frame_is_caught() {
    let scanner = scanner();
    let raw = sse(&[
        json!({ "choices": [{ "index": 0, "delta": { "reasoning_content": "Let me think. " } }] }),
        json!({ "system_fingerprint": "AKIAIOSF", "choices": [{ "index": 0,
            "delta": { "reasoning_content": "Done. ", "content": "Hello " } }] }),
        json!({ "system_fingerprint": "ODNN7EXAMPLE", "choices": [{ "index": 0,
            "delta": { "content": "world. " } }] }),
    ]);
    let (streamed, blocked) =
        run_streaming(&raw, &splits(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    assert!(!streamed.contains("AKIAIOSF"), "{streamed}");
    for policy in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
        let (streamed, _) = run_streaming(&raw, &splits(&raw), policy.clone(), &scanner).unwrap();
        assert!(
            !streamed.contains("AKIAIOSF") && !streamed.contains("ODNN7EXAMPLE"),
            "{policy:?}: {streamed}"
        );
        let (rewritten, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert!(
            !(rewritten.contains("AKIAIOSF") && rewritten.contains("ODNN7EXAMPLE")),
            "buffered {policy:?}"
        );
    }
}

#[test]
fn a_trimmed_field_next_to_another_lane_still_reaches_its_keyword() {
    let scanner = scanner();
    let word = format!("{} ", "a".repeat(1023));
    let mut frames: Vec<Value> = (0..1100).map(|_| content(&word)).collect();
    frames.push(content("My passport"));
    frames.extend((0..3000).map(|_| content(" #")));
    frames.push(json!({ "choices": [{ "index": 0, "delta": {
        "audio": { "transcript": "x" }, "content": " AB1234567" } }] }));
    let raw = sse(&frames);
    let (streamed, blocked) =
        run_streaming(&raw, &splits(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    assert!(!streamed.contains("AB1234567"));
    let (streamed, _) =
        run_streaming(&raw, &splits(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    assert!(!streamed.contains("AB1234567"));
}

#[test]
fn usage_on_every_chunk_still_splits_the_boundary() {
    let scanner = scanner();
    let usage = json!({ "prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8 });
    let mut frames = vec![
        json!({ "choices": [{ "index": 0, "delta": { "reasoning_content": "think " } }],
            "usage": usage }),
        json!({ "choices": [{ "index": 0, "delta": { "reasoning_content": " done.",
            "content": "Hello" } }], "usage": usage }),
    ];
    for word in [" there", " friend,", " how", " are", " you?"] {
        frames.push(
            json!({ "choices": [{ "index": 0, "delta": { "content": word } }],
            "usage": usage }),
        );
    }
    let mut dlp = super::StreamingDlp::new(FirewallPolicy::Sanitize, true);
    let mut early = String::new();
    for frame in &frames {
        early.push_str(
            &dlp.push(format!("data: {frame}\n\n").as_bytes(), &scanner)
                .unwrap()
                .bytes,
        );
    }
    assert!(early.contains("Hello"), "{early}");
}
