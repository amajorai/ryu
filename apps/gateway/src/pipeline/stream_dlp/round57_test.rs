//! Round 57: a field switch merged into the segment before takes the
//! per-string path, and a mid-word split whose sent part was rewritten falls
//! back to splitting at the bound.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn offsets(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

fn texts(sse: &str) -> String {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .map(|value| {
            let delta = &value["choices"][0]["delta"];
            format!(
                "{}|{}",
                delta["reasoning_content"].as_str().unwrap_or_default(),
                delta["content"].as_str().unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join(";")
}

fn sse(deltas: &[Value]) -> String {
    let mut raw: String = deltas
        .iter()
        .map(|delta| {
            format!(
                "data: {}\n\n",
                json!({ "choices": [{ "index": 0, "delta": delta }] })
            )
        })
        .collect();
    raw.push_str("data: [DONE]\n\n");
    raw
}

#[test]
fn a_value_ending_at_a_field_switch_is_redacted_not_masked() {
    let scanner = scanner();
    let raw = sse(&[
        json!({ "reasoning_content": "The config sets password=hunterxyz" }),
        json!({ "content": "Hello there " }),
    ]);
    for policy in [FirewallPolicy::WarnAndContinue, FirewallPolicy::Sanitize] {
        let (streamed, _) = run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert_eq!(texts(&streamed), texts(&buffered), "{policy:?}");
        assert!(texts(&streamed).contains("Hello there "), "{policy:?}");
    }
}

#[test]
fn a_rewritten_word_part_falls_back_to_the_bound() {
    let scanner = scanner();
    let raw = sse(&[
        json!({ "content": "Key AKIAABCDEFGHIJKLMNOPK" }),
        json!({ "content": "EY then token=ab" }),
        json!({ "content": "cdefghij done " }),
    ]);
    let (streamed, _) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    let text = texts(&streamed);
    assert!(text.contains("EY then "), "{text}");
    assert!(text.contains(" done "), "{text}");
    assert!(
        !text.contains("abcdefghij") && !text.contains("cdefghij"),
        "{text}"
    );
}
