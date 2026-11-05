//! A held group chain keeps bounded matches running into it unreleased, and a
//! chain closed by glued punctuation is judged whole.

use super::round15_test::{assert_parity, content, sse};

fn chain_after(first: &[&str], last: &str) -> String {
    let mut frames: Vec<_> = first.iter().map(|part| content(part)).collect();
    frames.extend((0..45).map(|_| content("0000 ")));
    frames.push(content(last));
    sse(&frames)
}

#[test]
fn a_bounded_match_running_into_a_held_chain_is_not_released_early() {
    assert_parity(&chain_after(&["SSN 123\n", "45 ", "6789 "], "done."));
    assert_parity(&chain_after(&["Call 555\n", "123 ", "4567 "], "done."));
    assert_parity(&chain_after(&["Call 1 (555) ", "123 ", "4567 "], "done."));
}

#[test]
fn a_chain_closed_by_glued_punctuation_is_judged_whole() {
    for last in ["1.", "1,", "1)"] {
        let frames: Vec<_> = ["Card: ", "4111 ", "1111 ", "1111 ", "1111 ", last, " ok"]
            .into_iter()
            .map(content)
            .collect();
        assert_parity(&sse(&frames));
    }
    assert_parity(&sse(&[
        content("Card: 4111 1111 1111 1111 1."),
        content(" ok"),
    ]));
}
