//! A resumed field is judged whole however long it is, the final head split
//! sees released text, and a form-pinned scan never stops inside a token.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn frame(key: &str, part: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": { key: part } }] })
}

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

fn content_of(sse: &str) -> String {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .filter_map(|frame| {
            frame
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn prose(bytes: usize) -> Vec<Value> {
    let word =
        "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incid ";
    (0..bytes / word.len() + 1)
        .map(|_| frame("content", word))
        .collect()
}

#[test]
fn a_long_resumed_field_still_masks_the_continuation() {
    let scanner = scanner();
    let mut frames = vec![
        frame("content", "Mail alice@exa"),
        frame("reasoning_content", "checking"),
        frame("content", "mple.com "),
    ];
    frames.extend(prose(9000));
    let raw = sse(&frames);
    let (streamed, _) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    assert!(!content_of(&streamed).contains("mple.com"));
}

#[test]
fn the_final_head_split_sees_the_resumed_fields_released_text() {
    let scanner = scanner();
    let raw = sse(&[
        frame("content", "Email: alice@exa"),
        frame("reasoning_content", "think"),
        frame("content", "mple"),
        json!({ "choices": [{ "index": 0, "delta": {
            "content": ".com done", "reasoning_content": "more" } }] }),
    ]);
    let (streamed, _) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    assert!(!content_of(&streamed).contains("mple"), "{streamed}");
    let raw = sse(&[
        frame("content", "token=abcd"),
        frame("reasoning_content", "hm"),
        frame("content", "ef"),
        json!({ "choices": [{ "index": 0, "delta": { "content": "gh1234" },
            "finish_reason": "stop", "stop_reason": "END" }] }),
    ]);
    let (streamed, _) = run_streaming(
        &raw,
        &per_frame(&raw),
        FirewallPolicy::WarnAndContinue,
        &scanner,
    )
    .unwrap();
    let text = content_of(&streamed);
    assert!(!text.contains("ef") && !text.contains("gh1234"), "{text}");
}

#[test]
fn a_keyword_far_before_the_gap_still_judges_the_resumed_value() {
    let scanner = scanner();
    let mut frames = vec![frame("content", "Authorization: Bearer")];
    frames.extend((0..82).map(|_| frame("content", &" ".repeat(100))));
    frames.push(frame("reasoning_content", "Let me check."));
    frames.push(frame(
        "content",
        "eyJhbGciOiJIUzI1NiJ9eyJzdWIiOiIxMjM0NTY3ODkwIn0abcdefgh done",
    ));
    let raw = sse(&frames);
    let (streamed, _) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(!streamed.contains("eyJhbGciOiJIUzI1NiJ9"), "{streamed}");
}

#[test]
fn a_long_clean_interleaved_stream_matches_the_buffered_rewrite() {
    let scanner = scanner();
    // One frame: each frame is also scanned on its own, and "555-123-4567"
    // alone is a phone number.
    let mut frames = vec![frame("content", "Ref x555-123-4567 ")];
    frames.extend(prose(8200));
    frames.push(frame("reasoning_content", "ok"));
    frames.push(frame("content", "done."));
    let mut redacted = vec![
        frame("content", "see "),
        frame("content", "token="),
        frame("content", "abcd"),
        frame("content", "efgh1234"),
        frame("content", " "),
    ];
    redacted.extend(prose(8200));
    redacted.push(frame("reasoning_content", "think"));
    redacted.push(frame("content", "done"));
    for frames in [frames, redacted] {
        let raw = sse(&frames);
        for policy in [FirewallPolicy::Block, FirewallPolicy::WarnAndContinue] {
            let (oracle, _, found) =
                super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
            let (streamed, blocked) =
                run_streaming(&raw, &per_frame(&raw), policy.clone(), &scanner).unwrap();
            assert_eq!(blocked, found.is_some() && policy == FirewallPolicy::Block);
            assert_eq!(content_of(&streamed), content_of(&oracle), "{policy:?}");
        }
    }
}

#[test]
fn a_form_pinned_scan_judges_whole_tokens_before_release() {
    let scanner = scanner();
    let mut frames = vec![
        frame("content", "\u{8bf7}\u{62e8}\u{6253} "),
        frame("content", "555"),
        frame("content", "-123"),
        frame("content", "-4567"),
    ];
    frames.push(frame("content", &"\u{8c22}".repeat(63)));
    frames.push(frame("content", "password="));
    frames.push(frame("content", "hunter22 ok"));
    let raw = sse(&frames);
    let second = per_frame(&raw)[1];
    let (streamed, blocked) =
        run_streaming(&raw, &[second], FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    assert!(!content_of(&streamed).contains("555"), "{streamed}");
}
