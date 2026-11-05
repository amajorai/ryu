//! Round 55: a mid-word split moves back only over ASCII word characters, so
//! a CJK run or punctuation never pulls it back over an earlier redaction.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn offsets(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

fn sse(parts: &[String]) -> String {
    let mut raw = String::new();
    for part in parts {
        let frame = json!({ "id": "c1", "model": "m", "choices": [{ "index": 0,
            "delta": { "content": part }, "finish_reason": null }] });
        raw.push_str(&format!("data: {frame}\n\n"));
    }
    raw.push_str("data: [DONE]\n\n");
    raw
}

#[test]
fn clean_frames_after_a_redaction_in_a_cjk_run_are_not_masked() {
    let scanner = scanner();
    let cjk = vec![
        format!(
            "{}token=abcdefghijkl{}",
            "我们".repeat(15),
            "你好".repeat(5)
        ),
        "你好".repeat(15),
        "你好".repeat(15),
        "你好".repeat(15),
    ];
    let ascii = vec![
        format!(
            "{} token=abcdefghijkl,an",
            "lorem ipsum dolor sit amet ".repeat(12)
        ),
        "d more text".to_owned(),
        " and the rest".to_owned(),
    ];
    for parts in [cjk, ascii] {
        let raw = sse(&parts);
        for policy in [FirewallPolicy::WarnAndContinue, FirewallPolicy::Block] {
            let (streamed, _) =
                run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
            let (buffered, _, _) =
                super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
            assert_eq!(streamed, buffered, "{policy:?}");
        }
    }
}
