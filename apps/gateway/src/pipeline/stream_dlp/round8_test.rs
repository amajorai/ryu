//! A delta text field interrupted by another and resumed (interleaved
//! thinking) is one string, on both paths.

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

const TAIL: &str = "KLMNOPQRSTUVWXYZ0123";

fn interleaved(reasoning: &str) -> String {
    sse(&[
        frame("content", "Your key: sk-ABCDEFGHIJ"),
        frame("reasoning_content", reasoning),
        frame("content", &format!("{TAIL} done.")),
    ])
}

#[test]
fn a_value_split_around_reasoning_is_judged_as_one_answer_string() {
    let scanner = scanner();
    for reasoning in ["checking", "checking the docs first "] {
        let raw = interleaved(reasoning);
        let (_, _, oracle) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
        assert!(oracle.is_some(), "the joined answer holds a key");
        let (streamed, blocked) =
            run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked, "{reasoning:?}");
        assert!(!content_of(&streamed).contains(TAIL), "{streamed}");
        for policy in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
            let (streamed, _) =
                run_streaming(&raw, &per_frame(&raw), policy.clone(), &scanner).unwrap();
            let text = content_of(&streamed);
            assert!(!text.contains(TAIL), "{policy:?} {reasoning:?}: {text}");
        }
    }
}

#[test]
fn the_buffered_rewrite_redacts_a_resumed_field_as_one_string() {
    let scanner = scanner();
    let raw = interleaved("checking");
    for policy in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
        let (rewritten, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        let text = content_of(&rewritten);
        assert!(!text.contains(TAIL), "{policy:?}: {text}");
    }
}

#[test]
fn a_clean_resumed_field_keeps_its_text() {
    let scanner = scanner();
    let raw = sse(&[
        frame("content", "Let me look that up."),
        frame("reasoning_content", "searching the docs"),
        frame("content", "Found it: the answer is forty two."),
    ]);
    let (oracle, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    let (streamed, blocked) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(!blocked);
    assert_eq!(content_of(&streamed), content_of(&oracle));
    assert_eq!(
        content_of(&streamed),
        "Let me look that up.Found it: the answer is forty two."
    );
}

fn reasoning_with_format(text: &str, format: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": {
        "reasoning": text,
        "reasoning_details": [{ "type": "reasoning.text", "text": text, "format": format, "index": 0 }]
    } }] })
}

fn content_with_blocklist(text: &str, id: &str) -> Value {
    json!({ "choices": [{
        "index": 0,
        "delta": { "content": text },
        "content_filter_results": {
            "custom_blocklists": { "filtered": false, "details": [{ "filtered": false, "id": id }] }
        }
    }] })
}

#[test]
fn choice_provider_strings_split_across_frames_are_lanes() {
    let scanner = scanner();
    let cases = [
        sse(&[
            reasoning_with_format("thinking ", "sk-ABCDEFGHIJ"),
            reasoning_with_format("more ", TAIL),
            reasoning_with_format("done ", "x"),
        ]),
        sse(&[
            content_with_blocklist("hello ", "sk-ABCDEFGHIJ"),
            content_with_blocklist("there ", TAIL),
            content_with_blocklist("friend.", "x"),
        ]),
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
                !(streamed.contains("sk-ABCDEFGHIJ") && streamed.contains(TAIL)),
                "{policy:?}: {streamed}"
            );
            let (rewritten, _, _) =
                super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
            assert!(
                !(rewritten.contains("sk-ABCDEFGHIJ") && rewritten.contains(TAIL)),
                "{policy:?}: {rewritten}"
            );
        }
    }
}

#[test]
fn a_fullwidth_digit_run_is_judged_as_the_whole_text_judges_it() {
    let scanner = scanner();
    let fullwidth = |digits: &str| -> String {
        digits
            .chars()
            .map(|digit| match digit.to_digit(10) {
                Some(value) => char::from_u32(0xFF10 + value).unwrap_or(digit),
                None => '\u{3000}',
            })
            .collect()
    };
    let mut text = "Order ref ".to_owned();
    text.push_str(&"x".repeat(300));
    text.push(' ');
    text.push_str(&fullwidth("9 9 9 9 9 4111 1111 1111 1111"));
    text.push_str(" thanks.");
    let parts: Vec<Value> = text
        .chars()
        .map(|character| frame("content", &character.to_string()))
        .collect();
    let raw = sse(&parts);
    let (oracle, _, found) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    let (_, blocked) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert_eq!(blocked, found.is_some());
    let (streamed, _) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    assert_eq!(content_of(&streamed), content_of(&oracle));
}

#[test]
fn text_before_a_connection_string_streams_ahead_of_it() {
    let scanner = scanner();
    let mut dlp = super::StreamingDlp::new(FirewallPolicy::Sanitize, true);
    let mut early = String::new();
    let mut parts: Vec<String> = std::iter::repeat_n("\u{6570}\u{636e}".to_owned(), 20).collect();
    parts.push("postgres://admin:hunter2".to_owned());
    parts.extend(std::iter::repeat_n("\u{5e93}".to_owned(), 40));
    for part in &parts {
        let step = dlp
            .push(
                format!("data: {}\n\n", frame("content", part)).as_bytes(),
                &scanner,
            )
            .unwrap();
        early.push_str(&step.bytes);
    }
    let released = content_of(&early);
    // The CJK text well before the form went out; the form did not.
    assert!(
        released.starts_with(&"\u{6570}\u{636e}".repeat(10)),
        "{released}"
    );
    assert!(!released.contains("postgres"), "{released}");
    let rest = dlp
        .push(
            format!("data: {}\n\n", frame("content", "@db done")).as_bytes(),
            &scanner,
        )
        .unwrap();
    let mut all = early;
    all.push_str(&rest.bytes);
    all.push_str(&dlp.finish(&scanner).unwrap().bytes);
    assert!(!content_of(&all).contains("hunter2"));
}
