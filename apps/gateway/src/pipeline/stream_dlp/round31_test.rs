//! Object choices after a carried keyword, zero-width padding, and empty
//! frames after released text.

use serde_json::json;

use super::round15_test::{content, sse};
use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn splits(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

#[test]
fn object_choices_continuing_after_a_carried_keyword_are_judged() {
    let scanner = scanner();
    let token = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd";
    let raw = sse(&[
        content(&format!("Bearer{}", "\u{3000}".repeat(2000))),
        json!({ "choices": { "0": { "index": 0, "delta": { "content": token } } } }),
    ]);
    let (streamed, blocked) =
        run_streaming(&raw, &splits(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked || !streamed.contains(token), "{streamed}");
    assert!(!streamed.contains(token));
    for policy in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
        let (streamed, _) = run_streaming(&raw, &splits(&raw), policy.clone(), &scanner).unwrap();
        assert!(!streamed.contains(token), "{policy:?}");
    }
}

#[test]
fn zero_width_padding_does_not_stretch_the_reach() {
    let scanner = scanner();
    let mut dlp = super::StreamingDlp::new(FirewallPolicy::Sanitize, true);
    dlp.push(format!("data: {}\n\n", content("ok ")).as_bytes(), &scanner)
        .unwrap();
    let frame = format!(
        "data: {}\n\n",
        content(&format!("{}a ", "\u{200b}".repeat(20_000)))
    );
    for _ in 0..60 {
        dlp.push(frame.as_bytes(), &scanner).unwrap();
    }
    dlp.finish(&scanner).unwrap();
}

#[test]
fn empty_frames_after_released_text_are_not_recorded() {
    let scanner = scanner();
    let mut dlp = super::StreamingDlp::new(FirewallPolicy::Sanitize, true);
    let mut out = String::new();
    out.push_str(
        &dlp.push(format!("data: {}\n\n", content("Hi ")).as_bytes(), &scanner)
            .unwrap()
            .bytes,
    );
    let empty = format!("data: {}\n\n", content(""));
    for _ in 0..2000 {
        out.push_str(&dlp.push(empty.as_bytes(), &scanner).unwrap().bytes);
    }
    assert!(dlp.recent.len() < 10, "{}", dlp.recent.len());
    assert!(out.matches("data: ").count() > 1000);
}
