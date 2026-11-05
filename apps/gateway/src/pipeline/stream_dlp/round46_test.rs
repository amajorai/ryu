//! Round 46: the final head split refuses a junction that changes how the
//! head redacts, and the carried form keeps a non-ASCII left character as
//! written.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
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
fn a_junction_that_hides_a_key_does_not_release_the_head_raw() {
    let scanner = scanner();
    let gho = concat!("gho_", "16C7e42F292c6912E7710c838347Ae178B4a");
    let cases = [
        (
            "Key: AKIAIOSFODNN7EXAMPLE",
            "x".to_owned(),
            FirewallPolicy::WarnAndContinue,
        ),
        (
            &*format!("Key: {gho}"),
            "a".repeat(240),
            FirewallPolicy::Block,
        ),
    ]
    .map(|(text, arguments, policy)| (text.to_owned(), arguments, policy));
    for (text, arguments, policy) in cases {
        let raw = sse(&[
            json!({ "choices": [{ "index": 0,
                "delta": { "role": "assistant", "content": text }, "finish_reason": null }] }),
            json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{ "index": 0,
                "id": "call_1", "type": "function",
                "function": { "name": "save", "arguments": arguments } }] },
                "finish_reason": null }] }),
            json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }] }),
        ]);
        let (streamed, _) = run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert!(!streamed.contains("AKIAIOSFODNN7EXAMPLE"), "{streamed}");
        assert!(!streamed.contains(gho), "{streamed}");
        assert_eq!(visible(&streamed), visible(&buffered), "{policy:?}");
    }
}

#[test]
fn a_carried_keyword_keeps_a_left_character_case_folding_would_join() {
    let scanner = scanner();
    let token = "abcdefghijklmnopqrst";
    for left in ['\u{212A}', '\u{17F}', '\u{130}'] {
        let frames = [
            content(&format!("Use {left}bearer")),
            content(&" ".repeat(5000)),
            content(token),
            content(" now."),
        ];
        let raw = sse(&frames);
        for policy in [
            FirewallPolicy::Block,
            FirewallPolicy::Sanitize,
            FirewallPolicy::WarnAndContinue,
        ] {
            let (streamed, _) =
                run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
            let (buffered, _, _) =
                super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
            assert!(
                !visible(&buffered).contains(token),
                "{left} {policy:?}: buffered"
            );
            assert!(
                !visible(&streamed).contains(token),
                "{left} {policy:?}: released"
            );
        }
        let frames = [
            content(&format!("My {left}passport")),
            content(&" ".repeat(5000)),
            content("AB1234567"),
            content(" ok"),
        ];
        let raw = sse(&frames);
        let (streamed, blocked) =
            run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked, "{left}: passport not blocked");
        assert!(!visible(&streamed).contains("AB1234567"));
    }
}
