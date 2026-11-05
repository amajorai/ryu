//! A carried keyword is judged against whole released tokens only, and a
//! frame that sent nothing never starts the released-text check.

use super::round15_test::{assert_parity, content, sse};
use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn padded(parts: &[&str]) -> String {
    let mut frames = vec![content("Passport")];
    frames.extend((0..2500).map(|_| content(" #")));
    frames.extend(parts.iter().map(|part| content(part)));
    sse(&frames)
}

#[test]
fn a_keyword_word_split_at_a_frame_edge_stays_carried() {
    for parts in [
        ["nu", "mber A", "B123456 done "],
        ["n", "umber AB", "123456 done "],
    ] {
        let raw = padded(&parts);
        let splits: Vec<_> = raw.match_indices("data: ").map(|(at, _)| at).collect();
        // The keyword and its padding went out ahead (documented); the value
        // never does.
        let (streamed, blocked) =
            run_streaming(&raw, &splits, FirewallPolicy::Block, &scanner()).unwrap();
        assert!(blocked, "{parts:?}");
        assert!(!streamed.contains("123456"), "{parts:?}");
        let (streamed, _) =
            run_streaming(&raw, &splits, FirewallPolicy::Sanitize, &scanner()).unwrap();
        assert!(!streamed.contains("123456"), "{parts:?}");
    }
}

#[test]
fn a_value_released_in_part_keeps_its_keyword_carried() {
    let raw = padded(&[" AB12", &format!("34567{}", " x".repeat(100)), " end."]);
    let (streamed, _) = run_streaming(
        &raw,
        &raw.match_indices("data: ")
            .map(|(at, _)| at)
            .collect::<Vec<_>>(),
        FirewallPolicy::Sanitize,
        &scanner(),
    )
    .unwrap();
    assert!(!streamed.contains("34567") && !streamed.contains("AB12"));
}

#[test]
fn an_empty_frame_inside_a_redacted_value_does_not_mask_later_text() {
    let mut frames: Vec<_> = ["Contact", " bob", "@", "", "example", ".com", " today"]
        .into_iter()
        .map(content)
        .collect();
    frames.extend((0..120).map(|_| content(" word")));
    assert_parity(&sse(&frames));
}
