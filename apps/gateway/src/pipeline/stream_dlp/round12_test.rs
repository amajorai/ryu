//! Provider copies of the text (Together `text`, OpenRouter
//! `reasoning_details`) are judged as their own lanes once they stop copying
//! every frame, and a carried keyword keeps a homoglyph's word boundary.

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

fn together(key: &str, text: &str, copied: bool) -> Value {
    let mut choice = json!({ "index": 0, "delta": { key: text } });
    if copied {
        choice["text"] = json!(text);
    }
    json!({ "choices": [choice] })
}

fn openrouter(text: &str, index: Option<u64>) -> Value {
    let mut delta = json!({ "reasoning": text });
    if let Some(index) = index {
        delta["reasoning_details"] =
            json!([{ "type": "reasoning.text", "text": text, "index": index }]);
    }
    json!({ "choices": [{ "index": 0, "delta": delta }] })
}

fn assert_copy_is_judged(raw: &str, pointer: &str) {
    let scanner = scanner();
    let (_, _, oracle) =
        super::super::rewrite_sse_for_dlp(raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(oracle.is_some(), "{raw}");
    let (_, blocked) =
        run_streaming(raw, &per_frame(raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked, "{raw}");
    for policy in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
        let (streamed, _) = run_streaming(raw, &per_frame(raw), policy.clone(), &scanner).unwrap();
        assert!(
            !joined(&streamed, pointer).contains("sk-abcdefghijklmnop"),
            "{policy:?}: {streamed}"
        );
        let (rewritten, _, _) = super::super::rewrite_sse_for_dlp(raw, &scanner, &policy).unwrap();
        assert!(
            !joined(&rewritten, pointer).contains("sk-abcdefghijklmnop"),
            "{policy:?}: {rewritten}"
        );
    }
}

#[test]
fn a_together_text_copy_that_skips_a_frame_or_switches_field_is_a_lane() {
    let gap = sse(&[
        together("content", "key sk-abcdefghij", true),
        together("content", " ", false),
        together("content", "klmnopqrstuvwxyzABCD done", true),
    ]);
    assert_copy_is_judged(&gap, "/choices/0/text");
    let switch = sse(&[
        together("reasoning", "key sk-abcdefghij", true),
        together("content", "klmnopqrstuvwxyzABCD done", true),
    ]);
    assert_copy_is_judged(&switch, "/choices/0/text");
}

#[test]
fn reasoning_details_copies_that_skip_or_change_index_are_a_lane() {
    for middle in [openrouter(" ", Some(1)), openrouter(" ", None)] {
        let raw = sse(&[
            openrouter("sk-abcdefghij", Some(0)),
            middle,
            openrouter("klmnopqrstuvwxyzAB", Some(0)),
        ]);
        assert_copy_is_judged(&raw, "/choices/0/delta/reasoning_details/0/text");
    }
}

#[test]
fn consistent_copies_still_stream() {
    let scanner = scanner();
    for frames in [
        ["Hello ", "there ", "friend. "].map(|word| together("content", word, true)),
        ["Let ", "me ", "think. "].map(|word| openrouter(word, Some(0))),
    ] {
        let mut dlp = super::StreamingDlp::new(FirewallPolicy::Block, true);
        let mut early = String::new();
        for frame in &frames {
            early.push_str(
                &dlp.push(format!("data: {frame}\n\n").as_bytes(), &scanner)
                    .unwrap()
                    .bytes,
            );
        }
        assert!(early.matches("data: ").count() >= 2, "{early}");
    }
}

#[test]
fn a_carried_keyword_keeps_a_homoglyphs_boundary() {
    let scanner = scanner();
    let mut frames = vec![together("content", "Your \u{445}passport", false)];
    frames.extend((0..2500).map(|_| together("content", " #", false)));
    frames.push(together("content", " AB1234567", false));
    frames.push(together("content", " thanks", false));
    let raw = sse(&frames);
    let (_, _, oracle) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(oracle.is_some());
    let (streamed, blocked) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    assert!(!streamed.contains("AB1234567"));
}
