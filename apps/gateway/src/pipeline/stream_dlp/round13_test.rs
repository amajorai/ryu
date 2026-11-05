//! Copies are judged by their text, choice 0 by its lane key, a carried
//! keyword never loses a letter, and a broken copy redacts like the buffered
//! rewrite.

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

fn delta(fields: Value) -> Value {
    json!({ "choices": [{ "index": 0, "delta": fields }] })
}

fn together(key: &str, text: &str, copied: bool) -> Value {
    let mut choice = json!({ "index": 0, "delta": { key: text } });
    if copied {
        choice["text"] = json!(text);
    }
    json!({ "choices": [choice] })
}

const PAT_TAIL: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn assert_blocked_and_hidden(raw: &str) {
    let scanner = scanner();
    let (_, _, oracle) =
        super::super::rewrite_sse_for_dlp(raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(oracle.is_some(), "{raw}");
    let (streamed, blocked) =
        run_streaming(raw, &per_frame(raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked, "{streamed}");
    assert!(!streamed.contains(PAT_TAIL), "{streamed}");
    for policy in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
        let (streamed, _) = run_streaming(raw, &per_frame(raw), policy.clone(), &scanner).unwrap();
        assert!(!streamed.contains(PAT_TAIL), "{policy:?}: {streamed}");
    }
}

#[test]
fn a_copy_that_differs_from_its_field_is_judged_as_its_own_lane() {
    let details = |reasoning: &str, copy: &str| {
        delta(json!({ "reasoning": reasoning,
            "reasoning_details": [{ "type": "reasoning.text", "text": copy }] }))
    };
    let raw = sse(&[
        details("ghp_", "ghp_"),
        delta(json!({ "content": "ok" })),
        details("x", PAT_TAIL),
    ]);
    assert_blocked_and_hidden(&raw);
}

#[test]
fn choice_zero_out_of_place_is_judged_with_its_lanes() {
    let variants = [
        json!({ "choices": [{ "index": 0.0, "delta": { "content": PAT_TAIL } }] }),
        json!({ "choices": [
            { "index": 1, "delta": { "content": "x" } },
            { "index": 0, "delta": { "content": PAT_TAIL } }] }),
    ];
    for last in variants {
        let raw = sse(&[
            delta(json!({ "content": "ghp_" })),
            delta(json!({ "reasoning_content": "ok " })),
            last,
        ]);
        assert_blocked_and_hidden(&raw);
    }
}

#[test]
fn a_zero_width_character_before_a_carried_keyword_keeps_the_keyword() {
    let scanner = scanner();
    for lead in ["\u{200b}", "\u{feff}", "\u{2060}"] {
        let mut frames = vec![delta(json!({ "content": format!("{lead}passport") }))];
        frames.extend((0..2500).map(|_| delta(json!({ "content": " #" }))));
        frames.push(delta(json!({ "content": " AB1234567" })));
        frames.push(delta(json!({ "content": " thanks" })));
        let raw = sse(&frames);
        let (_, _, oracle) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
        assert!(oracle.is_some());
        let (streamed, blocked) =
            run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked, "{lead:?}");
        assert!(!streamed.contains("AB1234567"), "{lead:?}");
    }
}

#[test]
fn a_broken_copy_redacts_only_the_value() {
    let scanner = scanner();
    let raw = sse(&[
        together("reasoning", "Let me check. ", true),
        together("content", "Your key is sk-abcdefghij", true),
        together("content", "klmnopqrstuvwxyzABCD thanks", true),
    ]);
    for policy in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
        let (oracle, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        let (streamed, _) =
            run_streaming(&raw, &per_frame(&raw), policy.clone(), &scanner).unwrap();
        for pointer in ["/choices/0/delta/content", "/choices/0/text"] {
            assert_eq!(
                joined(&streamed, pointer),
                joined(&oracle, pointer),
                "{policy:?} {pointer}"
            );
        }
        assert!(joined(&streamed, "/choices/0/delta/content").ends_with("thanks"));
    }
}

#[test]
fn a_copy_of_the_answer_only_still_streams() {
    let scanner = scanner();
    let mut dlp = super::StreamingDlp::new(FirewallPolicy::Block, true);
    let mut early = String::new();
    let mut frames = vec![together("reasoning", "Thinking it over. ", false)];
    frames.extend(["Hello ", "there ", "friend. "].map(|word| together("content", word, true)));
    for frame in &frames {
        early.push_str(
            &dlp.push(format!("data: {frame}\n\n").as_bytes(), &scanner)
                .unwrap()
                .bytes,
        );
    }
    assert!(
        joined(&early, "/choices/0/text").starts_with("Hello"),
        "{early}"
    );
}
