//! Round 52: a citation outside protected material is not simple, vLLM's
//! string `stop_reason` is an envelope lane, and a long token closing past
//! the release cut no longer pins the scan start.

use serde_json::{json, Value};

use super::scan_test::{provider_frame, run_streaming, scanner};
use super::StreamingDlp;
use crate::config::FirewallPolicy;

fn offsets(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

fn sse(frames: &[Value]) -> String {
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    raw
}

fn content(text: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": { "content": text }, "finish_reason": null }] })
}

fn visible(sse: &str) -> String {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .filter_map(|value| {
            value["choices"][0]["delta"]["content"]
                .as_str()
                .map(str::to_owned)
        })
        .collect()
}

#[test]
fn a_split_citation_outside_protected_material_is_blocked() {
    let scanner = scanner();
    let frame = |text: &str, url: &str| {
        json!({ "choices": [{ "index": 0, "delta": { "content": text }, "finish_reason": null,
            "content_filter_results": { "hate": { "filtered": false, "severity": "safe",
                "citation": { "URL": url } } } }] })
    };
    let raw = sse(&[frame("Hi ", "AKIAIOSF"), frame("there ", "ODNN7EXAMPLE")]);
    let (streamed, blocked) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked, "{streamed}");
    assert!(!streamed.contains("ODNN7EXAMPLE"), "{streamed}");
}

#[test]
fn a_vllm_stop_string_keeps_the_text_level_rewrite() {
    let scanner = scanner();
    let last = |text: &str| {
        json!({ "choices": [{ "index": 0, "delta": { "content": text }, "logprobs": null,
            "finish_reason": "stop", "stop_reason": "Observation:" }] })
    };
    let long = sse(&[
        content("Use "),
        content("token=abcd"),
        content("efgh1234"),
        content(" now"),
        last(""),
    ]);
    let short = sse(&[content("Use "), content("token=abcd"), last("efgh1234 now")]);
    for raw in [long, short] {
        let (streamed, _) =
            run_streaming(&raw, &offsets(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
        let (buffered, _, _) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
        for out in [&streamed, &buffered] {
            let text = visible(out);
            assert!(text.starts_with("Use [REDACTED:"), "{text}");
            assert!(text.ends_with(" now"), "{text}");
            assert!(out.contains("\"stop_reason\":\"Observation:\""), "{out}");
        }
    }
}

#[test]
fn a_long_token_closing_past_the_release_cut_does_not_pin_the_start() {
    let scanner = scanner();
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let mut raw = String::new();
    let mut parts = vec!["Here: ".to_owned()];
    parts.extend(std::iter::repeat_n("aB1c".repeat(250), 64));
    parts.push("== ".to_owned());
    let words: Vec<String> = (0..60).map(|index| format!(" word{index}x")).collect();
    let first_word = parts.len();
    parts.extend(words);
    for (index, part) in parts.iter().enumerate() {
        let frame = provider_frame(index, part);
        raw.push_str(&frame);
        dlp.push(frame.as_bytes(), &scanner).unwrap();
        if index > first_word {
            assert!(!dlp.buffer_remaining, "{index}: held whole");
            assert!(
                dlp.text.len() < 16 * 1024,
                "{index}: retained {} bytes",
                dlp.text.len()
            );
        }
    }
    raw.push_str("data: [DONE]\n\n");
    let (streamed, _) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert_eq!(streamed, buffered);
}
