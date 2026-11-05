//! Round 48: a scan start never lands inside a replacement the whole text
//! makes near a digit chain, and a long token whose tail cannot be cut holds
//! the stream whole instead of being rescanned on every push.

use serde_json::{json, Value};

use super::scan_test::{provider_frame, run_streaming, scanner};
use super::StreamingDlp;
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

#[test]
fn a_chain_after_a_crossing_replacement_groups_as_the_whole_text_does() {
    let scanner = scanner();
    let leads: [&[&str]; 3] = [
        &[" Use", " bearer", " ABCD-9000000000000000"],
        &[" Use", " bearer", " v1.9000000000000000"],
        &[" Call", " +1", " (555)", " 123-4567"],
    ];
    for lead in leads {
        let mut parts = vec!["Email me at a@b.co about it.".to_owned()];
        parts.extend(lead.iter().map(|part| (*part).to_owned()));
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
        let raw = sse(&parts);
        let (streamed, _) =
            run_streaming(&raw, &offsets(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
        let (buffered, _, _) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
        assert!(
            !visible(&streamed).contains("411 111 111 111 111 118"),
            "{lead:?}"
        );
        assert_eq!(visible(&streamed), visible(&buffered), "{lead:?}");
    }
}

#[test]
fn a_long_token_with_a_replaced_tail_holds_instead_of_rescanning() {
    let scanner = scanner();
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let mut parts = vec!["Link: ".to_owned()];
    parts.extend(std::iter::repeat_n("x".repeat(100), 200));
    parts.push("&secret=abcdefghijkl".to_owned());
    parts.extend(std::iter::repeat_n(" ".to_owned(), 600));
    parts.extend(std::iter::repeat_n(" ok".to_owned(), 100));
    let mut raw = String::new();
    for (index, part) in parts.iter().enumerate() {
        let frame = provider_frame(index, part);
        raw.push_str(&frame);
        dlp.push(frame.as_bytes(), &scanner).unwrap();
    }
    assert!(dlp.buffer_remaining, "the long token was walked whole");
    raw.push_str("data: [DONE]\n\n");
    let (streamed, _) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(!streamed.contains("abcdefghijkl"));
    assert_eq!(visible(&streamed), visible(&buffered));
}
