//! The fail-closed mask covers every lane it judged, a zero-width run is not
//! rescanned per push, and a value at the very end is redacted in place.

use serde_json::{json, Value};

use super::round15_test::{assert_parity, content, sse};
use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn splits(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

fn contents(sse: &str) -> String {
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

#[test]
fn object_choices_are_masked_like_array_choices() {
    let scanner = scanner();
    let frame = |text: &str| json!({ "choices": { "0": { "delta": { "content": text } } } });
    let raw = sse(&[frame("gho_abcdefghij"), frame("klmnopqrstuvwxyz0123")]);
    for policy in [
        FirewallPolicy::Block,
        FirewallPolicy::Sanitize,
        FirewallPolicy::WarnAndContinue,
    ] {
        let (streamed, _) = run_streaming(&raw, &splits(&raw), policy.clone(), &scanner).unwrap();
        assert!(
            !(streamed.contains("gho_abcdefghij") && streamed.contains("klmnopqrstuvwxyz0123")),
            "{policy:?}: {streamed}"
        );
        let (rewritten, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert!(
            !(rewritten.contains("gho_abcdefghij") && rewritten.contains("klmnopqrstuvwxyz0123")),
            "buffered {policy:?}: {rewritten}"
        );
    }
}

#[test]
fn a_growing_zero_width_run_is_not_rescanned_per_push() {
    let scanner = scanner();
    let mut dlp = super::StreamingDlp::new(FirewallPolicy::Block, true);
    dlp.push(format!("data: {}\n\n", content("ok ")).as_bytes(), &scanner)
        .unwrap();
    let frame = format!("data: {}\n\n", content(&"\u{200b}".repeat(16)));
    for _ in 0..4000 {
        dlp.push(frame.as_bytes(), &scanner).unwrap();
    }
    dlp.finish(&scanner).unwrap();
}

#[test]
fn a_value_at_the_very_end_is_redacted_in_place() {
    let scanner = scanner();
    let raw = sse(&["Your", " pass", "word", "=", "hun", "ter", "22"].map(content));
    assert_parity(&raw);
    let (oracle, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::WarnAndContinue)
            .unwrap();
    let (streamed, _) = run_streaming(
        &raw,
        &splits(&raw),
        FirewallPolicy::WarnAndContinue,
        &scanner,
    )
    .unwrap();
    assert_eq!(contents(&streamed), contents(&oracle));
    assert!(
        contents(&streamed).starts_with("Your [REDACTED:"),
        "{streamed}"
    );
}
