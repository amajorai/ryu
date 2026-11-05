//! Unbounded forms across CJK text, field-aware lanes, mirrors and dedupe.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use super::StreamingDlp;
use crate::config::FirewallPolicy;

fn field(sse: &str, pointer: &str) -> String {
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

fn sse(frames: &[Value]) -> String {
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    raw
}

fn content(part: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": { "content": part } }] })
}

fn per_frame(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

#[test]
fn an_unbounded_form_running_through_cjk_text_is_held_whole() {
    let scanner = scanner();
    let mut parts = vec![
        "\u{8fde}\u{63a5}\u{4e32} ".to_owned(),
        "postgres://admin:hunter2".to_owned(),
    ];
    parts.extend(std::iter::repeat_n("\u{6570}".to_owned(), 70));
    parts.extend(["@db".to_owned(), " \u{5b8c}\u{6210}".to_owned()]);
    let frames: Vec<Value> = parts.iter().map(|part| content(part)).collect();
    let raw = sse(&frames);
    let (_, _, oracle) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(oracle.is_some());
    for policy in [FirewallPolicy::Block, FirewallPolicy::Sanitize] {
        let (streamed, _) =
            run_streaming(&raw, &per_frame(&raw), policy.clone(), &scanner).unwrap();
        let text = field(&streamed, "/choices/0/delta/content");
        assert!(
            !text.contains("hunter2") && !text.contains("postgres://"),
            "{policy:?}: {text}"
        );
    }
}

#[test]
fn ascii_urls_and_words_like_secretary_are_not_held() {
    let scanner = scanner();
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let mut sent = String::new();
    for part in [
        "visit ",
        "https://example.com/docs ",
        "or ask the secretary ",
        "now ",
    ] {
        sent.push_str(
            &dlp.push(format!("data: {}\n\n", content(part)).as_bytes(), &scanner)
                .unwrap()
                .bytes,
        );
    }
    assert_eq!(
        field(&sent, "/choices/0/delta/content"),
        "visit https://example.com/docs or ask the secretary now "
    );
}

#[test]
fn a_secret_split_at_a_reasoning_to_answer_frame_is_not_released_raw() {
    let scanner = scanner();
    let frames = [
        json!({ "choices": [{ "index": 0, "delta": { "reasoning_content": "The key is in the" } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "reasoning_content": " box" } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "reasoning_content": " now" } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": "gho_AAAA", "reasoning_content": "." } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": "BBBBBBBBBBBBBBBBBBBBBBBB" } }] }),
    ];
    let raw = sse(&frames);
    for policy in [FirewallPolicy::WarnAndContinue, FirewallPolicy::Sanitize] {
        let (streamed, _) =
            run_streaming(&raw, &per_frame(&raw), policy.clone(), &scanner).unwrap();
        let answer = field(&streamed, "/choices/0/delta/content");
        assert!(
            !answer.contains("gho_AAAA") || !answer.contains("BBBBBBBB"),
            "{policy:?}: {answer}"
        );
    }
}

#[test]
fn every_reasoning_mirror_follows_the_redaction() {
    let scanner = scanner();
    let frame = |part: &str| {
        json!({ "choices": [{ "index": 0, "delta": {
            "reasoning_content": part, "reasoning": part,
            "reasoning_details": [{ "type": "reasoning.text", "text": part, "format": "unknown", "index": 0 }]
        } }] })
    };
    let raw = sse(&["key ", "sk-abcdefghij", "klmnopqrstuvwxyz0123", " now. "].map(frame));
    let (streamed, _) =
        run_streaming(&raw, &[], FirewallPolicy::WarnAndContinue, &scanner).unwrap();
    assert!(
        !streamed.contains("sk-abcdefghij") && !streamed.contains("klmnopq"),
        "{streamed}"
    );
}

#[test]
fn equal_answer_and_reasoning_texts_are_two_texts() {
    let frame = json!({ "choices": [{ "index": 0, "delta": { "content": "same", "reasoning_content": "same" } }] });
    assert!(!super::super::simple_content_delta(&frame));
    let mirrored = json!({ "choices": [{ "index": 0, "delta": { "reasoning": "same", "reasoning_content": "same" } }] });
    assert!(super::super::simple_content_delta(&mirrored));
}
