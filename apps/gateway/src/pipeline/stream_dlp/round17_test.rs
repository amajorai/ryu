//! A closed group chain is never cut into by a later scan start.

use super::round15_test::{assert_parity, content, sse};

#[test]
fn a_closed_chain_is_not_rescanned_from_inside() {
    let mut groups = vec!["0000"; 3200];
    groups[533..537].copy_from_slice(&["4111", "1111", "1111", "1111"]);
    let mut frames = vec![content("Numbers: ")];
    frames.extend(groups.iter().map(|group| content(&format!("{group} "))));
    frames.push(content(&format!("{} ", "a".repeat(1000))));
    frames.push(content("done."));
    assert_parity(&sse(&frames));
}

#[test]
fn long_capitalized_text_streams_as_before() {
    let mut frames = vec![content("Answer: ")];
    frames.extend((0..3000).map(|_| content(" WORD")));
    frames.push(content(" 4111 1111 1111 1111 done."));
    assert_parity(&sse(&frames));
}
