//! Round 59: an ideographic space after a keyword stays with the drained
//! text, so the form is carried, and a long s after a non-ASCII word
//! character is a joining junction.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn offsets(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

fn sse(parts: &[String]) -> String {
    let mut raw = String::new();
    for part in parts {
        let frame = json!({ "choices": [{ "index": 0, "delta": { "content": part } }] });
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

#[test]
fn a_bearer_before_an_ideographic_space_stays_carried() {
    let scanner = scanner();
    let value = "qwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjklzxc";
    let mut one_by_one = vec!["Bearer\u{3000}".to_owned()];
    one_by_one.extend(std::iter::repeat_n(" ".to_owned(), 4356));
    one_by_one.push(format!("{value} "));
    let cases = [
        vec![
            "Bearer\u{3000}".to_owned(),
            " ".repeat(4356),
            format!("{value} "),
        ],
        one_by_one,
    ];
    for parts in cases {
        let raw = sse(&parts);
        let (streamed, blocked) =
            run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked && !visible(&streamed).contains(value), "Block");
        let (streamed, _) =
            run_streaming(&raw, &offsets(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
        assert!(!visible(&streamed).contains(value), "Sanitize");
    }
}

#[test]
fn a_long_s_after_kana_does_not_mask_the_batch() {
    let scanner = scanner();
    let raw = sse(&[
        "token=abcdefghij は".to_owned(),
        "\u{17F}ecret=abcd ok ".to_owned(),
    ]);
    for policy in [FirewallPolicy::Block, FirewallPolicy::Sanitize] {
        let (streamed, _) = run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert_eq!(visible(&streamed), visible(&buffered), "{policy:?}");
    }
}
