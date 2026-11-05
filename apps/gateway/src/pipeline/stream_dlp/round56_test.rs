//! Round 56: a split right after a word character, before `(` or `+`, keeps
//! the word boundary a phone match needs.

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

#[test]
fn a_phone_glued_to_released_text_is_redacted_in_place() {
    let scanner = scanner();
    let cases: [&[&str]; 3] = [
        &["请拨打电话", "(555", ") 123", "-4567", "，谢谢。"],
        &["联系电话", "+1 415", "-555-0134", "。"],
        &["Call me now at x", "(555", ") 123", "-4567", " ok."],
    ];
    for parts in cases {
        let mut raw = String::new();
        for part in parts {
            let frame = json!({ "model": "m", "choices": [{ "index": 0,
                "delta": { "content": part }, "finish_reason": null }] });
            raw.push_str(&format!("data: {frame}\n\n"));
        }
        raw.push_str("data: [DONE]\n\n");
        let (streamed, _) =
            run_streaming(&raw, &offsets(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
        let (buffered, _, _) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
        assert_eq!(visible(&streamed), visible(&buffered), "{parts:?}");
        assert!(!visible(&streamed).contains("[REDACTED]["), "{parts:?}");
    }
}
