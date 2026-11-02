//! Source and destination errors are cut on a char boundary.

use super::*;

#[test]
fn short_error_cuts_on_a_char_boundary_at_the_limit() {
    // 299 ASCII bytes then a 3-byte character spanning bytes 299..302.
    let error = anyhow::anyhow!("{}€ and the rest of the store's message", "a".repeat(299));
    assert_eq!(short_error(&error), "a".repeat(299));

    for wide in ['é', '€', '🔑'] {
        let message = format!("{}{wide}{wide}", "x".repeat(MAX_ERROR_LEN - 1));
        let cut = short_error(&anyhow::anyhow!("{message}"));
        assert_eq!(cut, "x".repeat(MAX_ERROR_LEN - 1), "{wide}");
    }

    // The alternate format keeps the context chain, cut at the limit.
    let chained = anyhow::anyhow!("{}", "ß".repeat(200)).context("fetching `dev/api`");
    let cut = short_error(&chained);
    assert!(cut.len() <= MAX_ERROR_LEN);
    assert!(cut.starts_with("fetching `dev/api`: ß"));
    assert!(format!("{chained:#}").starts_with(&cut));

    assert_eq!(short_error(&anyhow::anyhow!("timed out")), "timed out");
}
