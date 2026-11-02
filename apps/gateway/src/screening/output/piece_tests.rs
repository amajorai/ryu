//! Output pieces: every character of a window reaches some item, and no item
//! is larger than the smallest output backend reads.

use ryu_gw_screening::estimate_tokens;

use super::{pieces, WINDOW_CHARS};

#[test]
fn dense_text_is_cut_to_the_budget_and_nothing_is_dropped() {
    let text: String = "\u{754c}".repeat(20_000) + "END";
    let cut = pieces(&text, 1_024);
    assert!(cut.len() >= 20, "{}", cut.len());
    for piece in &cut {
        assert!(
            estimate_tokens(piece) <= 1_024,
            "{}",
            estimate_tokens(piece)
        );
    }
    assert_eq!(cut.concat(), text);
}

#[test]
fn prose_keeps_the_buffered_window_size() {
    let prose = "the quick brown fox jumps over the lazy dog ".repeat(400);
    let cut = pieces(&prose, 2_048);
    assert_eq!(cut[0].chars().count(), WINDOW_CHARS * 4);
    assert_eq!(cut.concat(), prose);
    assert!(pieces("", 2_048).is_empty());
}
