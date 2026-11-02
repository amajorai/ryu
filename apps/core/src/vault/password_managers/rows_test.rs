//! Provider errors are cut on a char boundary before they are stored.

use super::*;

/// 299 ASCII bytes then a 3-byte character spanning bytes 299..302, so a byte
/// cut at 300 lands inside it.
fn multibyte_at_the_cut() -> String {
    format!(
        "{}€ and the rest of a localized provider message",
        "a".repeat(299)
    )
}

#[test]
fn short_cuts_on_a_char_boundary_at_the_limit() {
    let text = multibyte_at_the_cut();
    assert!(!text.is_char_boundary(MAX_ERROR_LEN));
    let cut = short(&text);
    assert_eq!(cut, "a".repeat(299));

    // Every width of character straddling the limit falls back to its start.
    for wide in ['é', '€', '🔑'] {
        let text = format!("{}{wide}{wide}", "x".repeat(MAX_ERROR_LEN - 1));
        let cut = short(&text);
        assert!(cut.len() <= MAX_ERROR_LEN, "{wide}");
        assert!(text.starts_with(&cut), "{wide}");
        assert_eq!(cut.len(), MAX_ERROR_LEN - 1, "{wide}");
    }

    assert_eq!(short("short message"), "short message");
    assert_eq!(short(&"b".repeat(400)), "b".repeat(MAX_ERROR_LEN));
    assert_eq!(short(&"ü".repeat(200)), "ü".repeat(MAX_ERROR_LEN / 2));
}

#[test]
fn record_check_stores_a_multibyte_failure_without_panicking() {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO vault_pm_accounts (id, name, provider, nonce, ciphertext, created_at, updated_at)
         VALUES ('acct', 'work', 'bitwarden-sm', x'00', x'00', 0, 0)",
        [],
    )
    .unwrap();
    let failure = ProviderFailure {
        kind: FailureKind::Auth,
        message: multibyte_at_the_cut(),
    };

    record_check(&conn, "acct", Err(&failure)).unwrap();

    let (state, last_error): (String, String) = conn
        .query_row(
            "SELECT state, last_error FROM vault_pm_accounts WHERE id = 'acct'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, "reconnect_required");
    assert_eq!(last_error, "a".repeat(299));
}
