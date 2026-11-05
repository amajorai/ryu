//! A drained field history keeps an open keyword form and never starts
//! inside a group chain.

use serde_json::{json, Value};

use super::round15_test::{content, sse};
use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn splits(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

fn mixed(text: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": {
        "audio": { "transcript": "x" }, "content": text } }] })
}

#[test]
fn a_keyword_drained_from_the_history_still_reaches_its_value() {
    let scanner = scanner();
    let mut frames = vec![content("My passport")];
    frames.extend((0..2100).map(|_| content(&" #".repeat(512))));
    frames.push(mixed(" AB1234567"));
    let raw = sse(&frames);
    let (streamed, blocked) =
        run_streaming(&raw, &splits(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    assert!(!streamed.contains("AB1234567"));
    let (streamed, _) =
        run_streaming(&raw, &splits(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    assert!(!streamed.contains("AB1234567"));
}

#[test]
fn a_drained_history_never_starts_inside_a_chain() {
    let scanner = scanner();
    let word = format!("{} ", "a".repeat(1023));
    let mut frames: Vec<Value> = (0..2048)
        .map(|index| {
            if index == 1024 {
                content(&format!("a 1 4111 1111 1111 1111 {} ", "a".repeat(999)))
            } else {
                content(&word)
            }
        })
        .collect();
    frames.extend(["b ", "c "].map(content));
    frames.push(mixed("ok "));
    let raw = sse(&frames);
    let (_, _, oracle) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    let (_, blocked) = run_streaming(&raw, &splits(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert_eq!(blocked, oracle.is_some());
}
