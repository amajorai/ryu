//! Shared test helpers and the pure helper tests of the keyword index.

use std::path::{Path, PathBuf};

use super::*;

pub(super) fn key(n: u8) -> BlindIndex {
    BlindIndex::from_root(&[n; 32], MESSAGE_FTS_STORE, TERMS_FIELD)
}

pub(super) fn index() -> MessageFtsIndex {
    MessageFtsIndex::open_in_memory_with_blind_index(key(7)).expect("open index")
}

pub(super) fn file_bytes(path: &Path) -> Vec<u8> {
    let mut bytes = std::fs::read(path).unwrap_or_default();
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    bytes.extend(std::fs::read(PathBuf::from(wal)).unwrap_or_default());
    bytes
}

pub(super) fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
}

/// Postings of a token stored in an FTS5 leaf: the first term of a page is
/// whole, later ones are prefix-compressed, so probe the token's tail.
pub(super) fn holds_token(bytes: &[u8], token: &str) -> bool {
    contains(bytes, &token[token.len() - 24..])
}

/// bm25 relevance mapping is bounded and monotonic (better rank → higher score).
#[test]
fn bm25_relevance_is_bounded_and_monotonic() {
    let strong = bm25_to_relevance(-5.0);
    let weak = bm25_to_relevance(-0.5);
    assert!(strong > weak);
    assert!((0.0..=1.0).contains(&strong));
    assert!((0.0..=1.0).contains(&weak));
    assert_eq!(bm25_to_relevance(1.0), 0.0);
}

/// Stopword-only and empty queries have no match expression.
#[test]
fn match_expression_uses_blind_tokens() {
    let terms = key(1);
    assert_eq!(blind_match_expression(&terms, "the and of"), None);
    assert_eq!(blind_match_expression(&terms, ""), None);
    let expr = blind_match_expression(&terms, "Solo duo").unwrap();
    assert!(!expr.contains("solo"));
    assert_eq!(
        expr,
        format!(
            "{} OR {}",
            terms.term_token("duo"),
            terms.term_token("solo")
        )
    );
}
