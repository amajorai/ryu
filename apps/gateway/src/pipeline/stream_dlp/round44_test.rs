//! Round 44: a group chain the scan start would cut after a word character
//! holds the stream whole, and the carried keyword is joined as written to
//! the raw region and folded to the folded region, never mixed.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn offsets(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

fn sse(parts: &[String]) -> String {
    let mut raw = String::new();
    for part in parts {
        let frame = json!({ "choices": [{ "index": 0, "delta": { "content": part },
            "finish_reason": null }] });
        raw.push_str(&format!("data: {frame}\n\n"));
    }
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

fn prose() -> Vec<String> {
    "is mine and the rest of this reply is ordinary prose that keeps going for a while"
        .split(' ')
        .map(|word| format!(" {word}"))
        .chain(std::iter::repeat_n(" more".to_owned(), 40))
        .collect()
}

#[test]
fn a_chain_glued_to_a_word_is_not_regrouped_by_the_scan_start() {
    let scanner = scanner();
    let mut parts = vec!["Here: ".to_owned(), "x".repeat(2000)];
    parts.extend(std::iter::repeat_n("00000 ".to_owned(), 598));
    parts.extend(["37828 ", "22463 ", "10005", "! "].map(str::to_owned));
    let raw = sse(&parts);
    let (streamed, _) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    assert!(!visible(&streamed).contains("37828 22463 10005"));
    assert_eq!(visible(&streamed), visible(&buffered));
}

#[test]
fn a_carried_keyword_still_catches_a_value_only_the_raw_text_matches() {
    let scanner = scanner();
    let mut parts = vec!["My passport".to_owned(), " ".repeat(6000)];
    parts.push("AB1234567\u{0410}".to_owned());
    parts.extend(prose());
    let raw = sse(&parts);
    let (streamed, blocked) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked, "not blocked");
    assert!(!visible(&streamed).contains("AB1234567"));
}

#[test]
fn a_homoglyph_left_character_and_a_folded_value_are_not_mixed() {
    let scanner = scanner();
    let mut parts = vec!["Ref \u{0425}passport".to_owned(), " ".repeat(6000)];
    parts.push("\u{0410}B1234567".to_owned());
    parts.extend(prose());
    let raw = sse(&parts);
    let (streamed, blocked) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(!blocked, "falsely blocked");
    assert_eq!(visible(&streamed), visible(&buffered));
}
