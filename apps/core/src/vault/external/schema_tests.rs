//! Schema upgrade and destination scheduling tests.

use super::*;

#[test]
fn stores_from_before_secret_syncs_gain_empty_options() {
    let conn = Connection::open_in_memory().unwrap();
    // The first release's table, without `options`.
    conn.execute_batch(
        "CREATE TABLE vault_external_stores (
             id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
             address TEXT NOT NULL, namespace TEXT, auth_method TEXT NOT NULL, auth_mount TEXT,
             role TEXT, mount TEXT NOT NULL DEFAULT '', path_prefix TEXT NOT NULL DEFAULT '',
             kv_version INTEGER NOT NULL DEFAULT 2, project_id TEXT NOT NULL DEFAULT '',
             infisical_environment TEXT NOT NULL DEFAULT '', secret_path TEXT NOT NULL DEFAULT '/',
             nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, key_version INTEGER NOT NULL DEFAULT 0,
             created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
         INSERT INTO vault_external_stores (id, name, kind, address, auth_method, mount, nonce,
             ciphertext, created_at, updated_at)
         VALUES ('xs_1', 'bao', 'openbao', 'https://bao.example.com', 'token', 'secret', x'00',
             x'00', 1, 1);",
    )
    .unwrap();
    init_schema(&conn).unwrap();
    init_schema(&conn).unwrap();
    let record = store_locked(&conn, "xs_1").unwrap();
    assert_eq!(record.kind, StoreKind::Openbao);
    assert_eq!(record.options, TargetOptions::default());
    // A store of a kind this build does not know is skipped, not an error.
    conn.execute(
        "UPDATE vault_external_stores SET kind = 'future-kind' WHERE id = 'xs_1'",
        [],
    )
    .unwrap();
    assert!(store_locked(&conn, "xs_1").is_err());
}

#[test]
fn failing_destinations_back_off_up_to_their_interval() {
    let tick = LOOP_TICK.as_millis() as i64;
    assert_eq!(retry_backoff_ms(1, 3600), tick);
    assert_eq!(retry_backoff_ms(3, 3600), tick * 4);
    assert_eq!(retry_backoff_ms(40, 120), 120_000);
    let mut destination = DestinationRecord {
        id: "xdst_1".into(),
        store_id: "xs_1".into(),
        environment: "default".into(),
        path: "/".into(),
        remote_path: String::new(),
        scope_id: "node-1".into(),
        interval_secs: 3600,
        dirty: false,
        last_push_at: None,
        last_status: None,
        last_error: None,
        last_count: 0,
        failures: 0,
        created_at: 0,
    };
    assert!(destination_due(&destination, 0), "never pushed");
    destination.last_push_at = Some(1_000);
    assert!(!destination_due(&destination, 2_000));
    destination.dirty = true;
    assert!(destination_due(&destination, 2_000));
    destination.failures = 2;
    assert!(!destination_due(&destination, 1_000 + tick));
    assert!(destination_due(&destination, 1_000 + tick * 2));
}
