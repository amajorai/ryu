//! Memory schema creation and the idempotent legacy-column migration.

use rusqlite::{params, Connection};

use super::*;

#[test]
fn init_schema_migrates_a_legacy_table_and_is_idempotent() {
    let conn = Connection::open_in_memory().unwrap();
    // The original memory table, before scope/category/lifecycle metadata.
    conn.execute_batch(
        "CREATE TABLE memory_entries (
             id         TEXT PRIMARY KEY,
             user_id    TEXT NOT NULL,
             agent_id   TEXT NOT NULL,
             nonce      BLOB NOT NULL,
             ciphertext BLOB NOT NULL,
             created_at INTEGER NOT NULL
         );",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_entries (id, user_id, agent_id, nonce, ciphertext, created_at)
         VALUES ('legacy', 'local', 'agent-a', x'00', x'00', 7)",
        [],
    )
    .unwrap();

    MemoryStore::init_schema(&conn).unwrap();
    // A second run (every open) must not fail on the columns it already added.
    MemoryStore::init_schema(&conn).unwrap();

    let row: (
        String,
        Option<String>,
        String,
        i64,
        String,
        i64,
        String,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT scope, scope_id, category, importance, tags, updated_at, lifecycle,
                    supersedes_id
             FROM memory_entries WHERE id = ?1",
            params!["legacy"],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        row,
        (
            "user".to_owned(),
            None,
            "user_fact".to_owned(),
            3,
            "[]".to_owned(),
            0,
            "active".to_owned(),
            None,
        )
    );
    let proposal_and_setting_tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name IN ('memory_proposals', 'memory_settings')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(proposal_and_setting_tables, 2);
    // Dream's archive lookups go by target and by event age.
    let archive_indexes: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index'
               AND name IN ('idx_memory_proposals_target', 'idx_memory_category_age')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(archive_indexes, 2);

    // A legacy row gains the access-tracking columns as never recalled.
    let access: (Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT recall_count, last_recalled_at FROM memory_entries WHERE id = 'legacy'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(access, (Some(0), None));

    // ...and the database records when tracking began, so Dream does not read
    // the legacy row's zero count as "never used".
    let started: String = conn
        .query_row(
            "SELECT value FROM memory_meta WHERE key = 'access_tracking_started_at'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(started.parse::<i64>().unwrap() > 7);
}
