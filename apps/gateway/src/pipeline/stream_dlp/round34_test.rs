//! Sanitize does not depend on rule order, a frame with token mirrors is not
//! split, and a punctuation-glued chain is never regrouped.

use serde_json::{json, Value};

use super::round15_test::{content, sse};
use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn splits(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

#[test]
fn a_secret_rule_never_splits_a_pii_value_under_sanitize() {
    let scanner = scanner();
    let cases = [
        ("secret=4111 1111 1111 1111 ok", "1111 1111"),
        ("password=GB29 NWBK 6016 1331 9268 19 ok", "NWBK"),
        ("secret=555-123 4567 ok", "4567"),
    ];
    for (text, fragment) in cases {
        let words: Vec<String> = text.split_inclusive(' ').map(str::to_owned).collect();
        let raw = sse(&words.iter().map(|word| content(word)).collect::<Vec<_>>());
        let (streamed, _) =
            run_streaming(&raw, &splits(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
        assert!(!streamed.contains(fragment), "stream {text}: {streamed}");
        let (rewritten, _, _) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
        assert!(
            !rewritten.contains(fragment),
            "buffered {text}: {rewritten}"
        );
        let mut value = json!({ "content": text });
        super::super::sanitize_json_strings(&mut value, &scanner);
        assert!(
            !value.to_string().contains(fragment),
            "non-stream {text}: {value}"
        );
    }
    // Secrets first still holds: a PII rule never splits a bearer token.
    let mut value =
        json!({ "content": "Authorization: Bearer abc10.1.2.3defghijklmnopqrstuvwxyz ok" });
    super::super::sanitize_json_strings(&mut value, &scanner);
    assert!(!value.to_string().contains("defghijklmnop"), "{value}");
}

#[test]
fn a_boundary_frame_with_token_ids_is_not_split() {
    let scanner = scanner();
    let raw = sse(&[json!({ "choices": [{ "index": 0,
        "delta": { "reasoning_content": "done.", "content": "Hi" },
        "token_ids": [151668, 9707], "finish_reason": null }] })]);
    let (streamed, _) =
        run_streaming(&raw, &splits(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    assert_eq!(streamed.matches("151668").count(), 1, "{streamed}");
    let (rewritten, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    assert_eq!(rewritten.matches("151668").count(), 1, "{rewritten}");
}

#[test]
fn a_punctuation_glued_chain_is_never_regrouped() {
    let scanner = scanner();
    let mut frames: Vec<Value> = vec![content("Note "), content(&format!("{}:", "a".repeat(6000)))];
    let groups = ["1111 ", "4111 ", "4111 ", "4119 "];
    frames.extend((0..101).map(|index| content(groups[index % 4])));
    frames.push(content(" and more text "));
    frames.extend((0..60).map(|_| content("word ")));
    let raw = sse(&frames);
    let (_, _, oracle) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    let (_, blocked) = run_streaming(&raw, &splits(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert_eq!(blocked, oracle.is_some());
}
