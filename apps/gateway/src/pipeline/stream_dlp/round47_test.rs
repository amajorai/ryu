//! Round 47: a scan start never begins a digit chain right after an open
//! keyword form, whose secrets-first replacement regroups the chain.

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
fn a_chain_after_a_bearer_value_groups_as_the_whole_text_does() {
    let scanner = scanner();
    let mut parts = vec![
        "Email me at a@b.co about it.".to_owned(),
        " Use".to_owned(),
        " bearer".to_owned(),
        " 9000000000000000".to_owned(),
    ];
    for group in 1..=150 {
        let digits = match group {
            139 => "411",
            140..=143 => "111",
            144 => "118",
            _ => "777",
        };
        parts.push(format!(" {digits}"));
    }
    parts.push(", done.".to_owned());
    for _ in 0..20 {
        parts.extend([" More", " words", " here."].map(str::to_owned));
    }
    let mut raw = String::new();
    for part in &parts {
        let frame = json!({ "choices": [{ "index": 0, "delta": { "content": part },
            "finish_reason": null }] });
        raw.push_str(&format!("data: {frame}\n\n"));
    }
    raw.push_str("data: [DONE]\n\n");
    let (streamed, _) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    assert!(visible(&buffered).contains("[REDACTED:CREDIT_CARD]"));
    assert!(!visible(&streamed).contains("411 111 111 111 111 118"));
    assert_eq!(visible(&streamed), visible(&buffered));
}
