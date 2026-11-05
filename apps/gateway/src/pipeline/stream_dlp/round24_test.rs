//! A vLLM delta ending the reasoning and starting the answer keeps the
//! answer streaming, and text held whole is judged exactly at the end.

use serde_json::json;

use super::round15_test::{assert_parity, content, sse};
use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

#[test]
fn a_reasoning_to_answer_delta_keeps_the_answer_streaming() {
    let scanner = scanner();
    let mut frames = vec![
        json!({ "choices": [{ "index": 0, "delta": {
            "reasoning_content": "Let me think.", "reasoning": "Let me think." } }] }),
        json!({ "choices": [{ "index": 0, "delta": {
            "reasoning_content": " Done.", "reasoning": " Done.", "content": "Hello" } }] }),
    ];
    frames.extend([" there", " friend,", " how", " are", " you?"].map(content));
    let raw = sse(&frames);
    assert_parity(&raw);
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

#[test]
fn a_long_continuation_held_whole_is_judged_exactly() {
    let scanner = scanner();
    let mut frames = vec![
        content("Intro. "),
        json!({ "choices": [{ "index": 0, "delta": { "reasoning_content": "think " } }] }),
    ];
    let word = format!("{} ", "a".repeat(1023));
    frames.extend((0..1100).map(|_| content(&word)));
    let raw = sse(&frames);
    let splits: Vec<_> = raw.match_indices("data: ").map(|(at, _)| at).collect();
    let (streamed, _) =
        run_streaming(&raw, &splits, FirewallPolicy::WarnAndContinue, &scanner).unwrap();
    assert!(!streamed.contains("[REDACTED]"));
}
