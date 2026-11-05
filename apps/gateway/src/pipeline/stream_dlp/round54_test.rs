//! Round 54: a release that ended mid-word does not give the next split a
//! word boundary the joined text lacks.

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
fn a_mid_word_release_does_not_mask_the_next_batch() {
    let scanner = scanner();
    let cases: [[&str; 3]; 3] = [
        [
            "Use my",
            "token=abcdefghij to",
            " log in. Contact jane@example.com and more ",
        ],
        [
            "Use db",
            "password=hunter22 x",
            " then mail jane@example.com and more ",
        ],
        [
            "Use my",
            "secret=abcd x",
            " then mail jane@example.com and more ",
        ],
    ];
    for parts in cases {
        let mut raw = String::new();
        for part in parts {
            let frame = json!({ "choices": [{ "index": 0, "delta": { "content": part },
                "finish_reason": null }] });
            raw.push_str(&format!("data: {frame}\n\n"));
        }
        let last = json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] });
        raw.push_str(&format!("data: {last}\n\ndata: [DONE]\n\n"));
        let (streamed, _) =
            run_streaming(&raw, &offsets(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
        let (buffered, _, _) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
        assert_eq!(visible(&streamed), visible(&buffered), "{parts:?}");
        assert!(!visible(&streamed).contains("[REDACTED]["), "{parts:?}");
    }
}
