//! Round 58: a split between two non-ASCII word characters next to a digit
//! (kana before fullwidth digits) moves back, as an ASCII one does.

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
fn fullwidth_digits_after_kana_do_not_mask_the_batch() {
    let scanner = scanner();
    let tail = "よろしくお願いいたします。".repeat(6);
    let cases: [Vec<&str>; 2] = [
        vec![
            "社員番号は",
            "１２３-４５-６７８９、メールは",
            "taro@example.com",
            " です。",
            &tail,
        ],
        vec![
            "Cafe\u{301}",
            "(555) 123-4567 ",
            "and mail taro@example.com now ",
            &tail,
        ],
    ];
    for parts in cases {
        let mut raw = String::new();
        for part in &parts {
            let frame = json!({ "choices": [{ "index": 0, "delta": { "content": part } }] });
            raw.push_str(&format!("data: {frame}\n\n"));
        }
        raw.push_str("data: [DONE]\n\n");
        let (streamed, _) =
            run_streaming(&raw, &offsets(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
        let (buffered, _, _) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
        assert_eq!(visible(&streamed), visible(&buffered), "{parts:?}");
        assert!(visible(&streamed).ends_with(&tail), "{parts:?}");
    }
}
