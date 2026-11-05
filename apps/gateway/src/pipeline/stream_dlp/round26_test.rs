//! Both halves of a split frame wait for the next provider frame, and a
//! trimmed history starts at a token edge.

use serde_json::{json, Value};

use super::round15_test::{content, sse};
use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn splits(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

#[test]
fn the_reasoning_half_of_a_split_frame_waits_with_the_answer_half() {
    let scanner = scanner();
    let raw = sse(&[
        json!({ "system_fingerprint": "AKIAIOSF", "choices": [{ "index": 0,
            "delta": { "reasoning_content": "Done. ", "content": "Hello " } }] }),
        json!({ "system_fingerprint": "ODNN7EXAMPLE", "choices": [{ "index": 0,
            "delta": { "content": "world. " } }] }),
    ]);
    let (streamed, blocked) =
        run_streaming(&raw, &splits(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    assert!(!streamed.contains("AKIAIOSF"), "{streamed}");
    let (streamed, _) =
        run_streaming(&raw, &splits(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    assert!(
        !streamed.contains("AKIAIOSF") && !streamed.contains("ODNN7EXAMPLE"),
        "{streamed}"
    );
}

#[test]
fn a_trimmed_history_never_starts_inside_a_token() {
    let scanner = scanner();
    let word = format!("{} ", "a".repeat(1023));
    let mut frames: Vec<Value> = (0..2047)
        .map(|index| {
            if index == 1024 {
                content(&format!(
                    "{} 9123-45-6789 {}",
                    "a".repeat(74),
                    "a".repeat(936)
                ))
            } else {
                content(&word)
            }
        })
        .collect();
    frames.push(content(&format!("{} ", "a".repeat(1099))));
    frames.extend(["b ", "c "].map(content));
    frames.push(json!({ "choices": [{ "index": 0, "delta": {
        "audio": { "transcript": "x" }, "content": "ok " } }] }));
    let raw = sse(&frames);
    let (_, _, oracle) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    let (_, blocked) = run_streaming(&raw, &splits(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert_eq!(blocked, oracle.is_some());
}
