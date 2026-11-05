//! Round 49: the crossing check sees a carried keyword form, and OpenRouter's
//! `native_finish_reason` is protocol metadata on both paths.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn offsets(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
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

#[test]
fn a_carried_bearer_form_still_regroups_the_chain_after_its_value() {
    let scanner = scanner();
    let mut frames = vec![
        content("Email me at a@b.co about it."),
        content(" Use"),
        content(" bearer"),
    ];
    frames.extend(std::iter::repeat_n(content(&" ".repeat(100)), 60));
    frames.push(content(" 9000000000000000"));
    for group in 1..=150 {
        let digits = match group {
            139 => "411",
            140..=143 => "111",
            144 => "118",
            _ => "777",
        };
        frames.push(content(&format!(" {digits}")));
    }
    frames.push(content(", done."));
    for _ in 0..20 {
        frames.extend([" More", " words", " here."].map(content));
    }
    let raw = sse(&frames);
    let (streamed, _) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    assert!(visible(&buffered).contains("[REDACTED:CREDIT_CARD]"));
    assert!(!visible(&streamed).contains("411 111 111 111 111 118"));
}

#[test]
fn an_openrouter_native_finish_reason_keeps_the_text_level_rewrite() {
    let scanner = scanner();
    let frame = |text: &str, finish: Value, native: Value| {
        json!({ "choices": [{ "index": 0, "delta": { "content": text },
            "finish_reason": finish, "native_finish_reason": native }] })
    };
    let raw = sse(&[
        frame("Mail jane.d", Value::Null, Value::Null),
        frame("oe@example.com for details.", Value::Null, Value::Null),
        frame("", json!("stop"), json!("end_turn")),
    ]);
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    let (streamed, _) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    for out in [&buffered, &streamed] {
        assert_eq!(visible(out), "Mail [REDACTED:EMAIL] for details.", "{out}");
        assert!(
            out.contains("\"native_finish_reason\":\"end_turn\""),
            "{out}"
        );
    }
}
