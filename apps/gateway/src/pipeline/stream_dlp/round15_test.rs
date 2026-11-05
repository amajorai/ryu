//! Choice indexes read as clients read them, and group chains (cards,
//! IBANs) judged whole, as the whole text groups them.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

pub(super) fn sse(frames: &[Value]) -> String {
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    raw
}

fn per_frame(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

pub(super) fn content(text: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": { "content": text } }] })
}

fn content_of(sse: &str) -> String {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .filter_map(|frame| {
            frame
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

/// The stream decides as the buffered rewrite does, under Block and
/// Sanitize.
pub(super) fn assert_parity(raw: &str) {
    let scanner = scanner();
    let (_, _, found) =
        super::super::rewrite_sse_for_dlp(raw, &scanner, &FirewallPolicy::Block).unwrap();
    let (_, blocked) =
        run_streaming(raw, &per_frame(raw), FirewallPolicy::Block, &scanner).unwrap();
    assert_eq!(blocked, found.is_some());
    let (oracle, _, _) =
        super::super::rewrite_sse_for_dlp(raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    let (streamed, _) =
        run_streaming(raw, &per_frame(raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    assert_eq!(content_of(&streamed), content_of(&oracle));
}

#[test]
fn a_choice_index_written_as_a_float_or_string_joins_its_lane() {
    let scanner = scanner();
    for index in [json!(0.0), json!("0")] {
        let raw = sse(&[
            content("key: sk-"),
            json!({ "choices": [
                { "index": 1, "delta": { "content": " " } },
                { "index": index, "delta": { "content": "ABCDEFGHIJKLMNOPQRSTUVWX" } }] }),
        ]);
        let (_, _, oracle) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
        assert!(oracle.is_some(), "{index}");
        let (streamed, blocked) =
            run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked, "{index}");
        assert!(!streamed.contains("ABCDEFGHIJKLMNOPQRSTUVWX"), "{index}");
    }
}

#[test]
fn iban_groups_are_grouped_as_the_whole_text_groups_them() {
    let mut frames = vec![content("IBANs: ")];
    for _ in 0..30 {
        for group in ["RO49 ", "AAAA ", "1B31 ", "0075 ", "9384 ", "0000 "] {
            frames.push(content(group));
        }
    }
    frames.push(content("end. Thanks for reading."));
    assert_parity(&sse(&frames));
}

#[test]
fn a_long_digit_run_held_whole_is_not_judged_from_inside() {
    let mut groups = vec!["0000"; 4100];
    groups[4002..4006].copy_from_slice(&["4111", "1111", "1111", "1111"]);
    let mut frames = vec![content("Numbers: ")];
    frames.extend(groups.iter().map(|group| content(&format!("{group} "))));
    frames.push(content("done."));
    assert_parity(&sse(&frames));
}

#[test]
fn a_digit_run_still_growing_is_not_judged_cut_short() {
    let frames: Vec<Value> = ["Card: ", "4111 ", "1111 ", "1111 ", "1111 ", "1 ok"]
        .into_iter()
        .map(content)
        .collect();
    assert_parity(&sse(&frames));
}
