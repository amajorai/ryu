//! Round 43: every text-level batch drops its token mirrors together once
//! anything in it changed, and a folded carried keyword is joined only to
//! folded text.

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

fn together(content: &str, token: u64, finish: Value) -> Value {
    json!({ "choices": [{ "index": 0, "text": content, "logprobs": null,
        "finish_reason": finish, "seed": null,
        "delta": { "token_id": token, "content": content, "tool_calls": null } }] })
}

#[test]
fn an_empty_chunk_inside_a_redacted_value_drops_its_token_id() {
    let scanner = scanner();
    let raw = sse(&[
        together("password=", 101, Value::Null),
        together("", 202, Value::Null),
        together("秘密秘密 ", 303, Value::Null),
        together("", 404, json!("stop")),
    ]);
    for policy in [FirewallPolicy::WarnAndContinue, FirewallPolicy::Block] {
        let (streamed, _) = run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        assert!(!streamed.contains("秘密"), "{policy:?}: {streamed}");
        assert!(!streamed.contains("202"), "{policy:?}: {streamed}");
    }
}

#[test]
fn a_folded_carried_keyword_does_not_mask_a_clean_stream() {
    let scanner = scanner();
    let mut parts = vec!["Auth: \u{FF22}\u{FF25}\u{FF21}\u{FF32}\u{FF25}\u{FF32}".to_owned()];
    parts.extend(std::iter::repeat_n("    ".to_owned(), 1300));
    parts.push("abcdefghijklmnopqr".to_owned());
    for word in "ok and then some more ordinary words to finish the reply here".split(' ') {
        parts.push(format!(" {word}"));
    }
    parts.extend(std::iter::repeat_n(" text".to_owned(), 60));
    let frames: Vec<Value> = parts
        .iter()
        .map(|part| {
            json!({ "choices": [{ "index": 0, "delta": { "content": part },
            "finish_reason": null }] })
        })
        .collect();
    let raw = sse(&frames);
    for policy in [
        FirewallPolicy::Block,
        FirewallPolicy::Sanitize,
        FirewallPolicy::WarnAndContinue,
    ] {
        let (streamed, blocked) =
            run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert!(!blocked, "{policy:?}");
        assert_eq!(visible(&streamed), visible(&buffered), "{policy:?}");
        assert!(!streamed.contains("[REDACTED"), "{policy:?}");
    }
}
