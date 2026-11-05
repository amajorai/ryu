//! Round 41: the long-token cut sees a keyword through stripped characters,
//! and keeps an ASCII word character before a keyword it starts at.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

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

fn chunks(text: &str, size: usize) -> Vec<String> {
    let characters: Vec<char> = text.chars().collect();
    characters
        .chunks(size)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

#[test]
fn a_keyword_split_by_zero_width_characters_is_still_seen_at_the_cut() {
    let scanner = scanner();
    let zw = |count: usize| "\u{200B}".repeat(count);
    let hashes = |count: usize| "#".repeat(count);
    let first = vec![
        format!("{}pass{}port{} ", hashes(4200), zw(40), hashes(4287)),
        "AB1234567".to_owned(),
    ];
    let mut second = vec!["hi ".to_owned()];
    second.extend(chunks(
        &format!("{}pa{}ssport{}", hashes(3990), zw(200), hashes(1000)),
        100,
    ));
    second.extend(std::iter::repeat_n(" #".to_owned(), 2000));
    second.extend([" AB1234567".to_owned(), " end".to_owned()]);
    for parts in [first, second] {
        let raw = sse(&parts);
        for policy in [FirewallPolicy::Block, FirewallPolicy::Sanitize] {
            let (streamed, _) =
                run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
            let (buffered, _, _) =
                super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
            let released = visible(&streamed).contains("AB1234567");
            // Under Sanitize the PII rewrite runs on the raw text, where the
            // stripped characters still split the keyword, on either path.
            let buffered_released = visible(&buffered).contains("AB1234567");
            assert!(
                !released || (policy != FirewallPolicy::Block && buffered_released),
                "{policy:?}: passport number released"
            );
        }
    }
}

#[test]
fn a_keyword_glued_to_a_word_stays_clean_at_the_cut() {
    let scanner = scanner();
    let hashes = |count: usize| "#".repeat(count);
    let mut cases: Vec<Vec<String>> = ["x", "7", "_"]
        .iter()
        .map(|left| {
            vec![
                format!("{}passport{} ", left.repeat(4200), hashes(4347)),
                "AB1234567".to_owned(),
            ]
        })
        .collect();
    let mut glued = vec!["hi ".to_owned()];
    glued.extend(chunks(
        &format!("{}xpassport{}", hashes(4090), hashes(1000)),
        100,
    ));
    glued.extend(std::iter::repeat_n(" #".to_owned(), 2000));
    glued.extend([" AB1234567".to_owned(), " end".to_owned()]);
    cases.push(glued);
    for parts in cases {
        let raw = sse(&parts);
        for policy in [FirewallPolicy::Block, FirewallPolicy::Sanitize] {
            let (streamed, blocked) =
                run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
            let (buffered, _, _) =
                super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
            assert!(!blocked, "{policy:?}: falsely blocked");
            assert_eq!(visible(&streamed), visible(&buffered), "{policy:?}");
            assert!(visible(&streamed).contains("AB1234567"), "{policy:?}");
        }
    }
}
