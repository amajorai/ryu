use super::*;

fn legacy_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE plugin_secrets (
             plugin_id  TEXT NOT NULL,
             key        TEXT NOT NULL,
             nonce      BLOB NOT NULL,
             ciphertext BLOB NOT NULL,
             updated_at INTEGER NOT NULL,
             PRIMARY KEY (plugin_id, key)
         );
         CREATE TABLE vault_secrets (
             scope        TEXT NOT NULL,
             scope_id     TEXT NOT NULL,
             binding_kind TEXT NOT NULL DEFAULT '',
             binding_id   TEXT NOT NULL DEFAULT '',
             name         TEXT NOT NULL,
             nonce        BLOB NOT NULL,
             ciphertext   BLOB NOT NULL,
             updated_at   INTEGER NOT NULL,
             PRIMARY KEY (scope, scope_id, binding_kind, binding_id, name)
         );",
    )
    .unwrap();
    conn
}

#[test]
fn version_one_rows_migrate_into_the_default_environment_with_history() {
    let conn = legacy_db();
    conn.execute(
        "INSERT INTO vault_secrets VALUES ('org', 'org-1', 'mcp', 'github', 'TOKEN', x'00', x'01', 42)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO plugin_secrets VALUES ('exa', 'RYU_EXA_API_KEY', x'00', x'01', 7)",
        [],
    )
    .unwrap();
    migrate(&conn).unwrap();
    assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);

    let (environment, path, version, key_version, rotated): (String, String, i64, i64, i64) = conn
        .query_row(
            "SELECT environment, path, version, key_version, rotated_at FROM vault_secrets
             WHERE name = 'TOKEN'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        (
            environment.as_str(),
            path.as_str(),
            version,
            key_version,
            rotated
        ),
        ("default", "/", 1, 0, 42)
    );
    let versions: i64 = conn
        .query_row("SELECT COUNT(*) FROM vault_secret_versions", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(versions, 1);
    let plugin_key_version: i64 = conn
        .query_row("SELECT key_version FROM plugin_secrets", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(plugin_key_version, 0);
    assert!(!table_exists(&conn, "vault_secrets_v1").unwrap());
}

#[test]
fn migration_is_idempotent() {
    let conn = legacy_db();
    migrate(&conn).unwrap();
    migrate(&conn).unwrap();
    let environments: i64 = conn
        .query_row("SELECT COUNT(*) FROM vault_environments", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(environments, 1);
}

/// A schema-2 database as the previous binary wrote it.
fn v2_db(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE plugin_secrets (
             plugin_id   TEXT NOT NULL,
             key         TEXT NOT NULL,
             nonce       BLOB NOT NULL,
             ciphertext  BLOB NOT NULL,
             updated_at  INTEGER NOT NULL,
             key_version INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY (plugin_id, key)
         );",
    )
    .unwrap();
    conn.execute_batch(VAULT_SECRETS_V2).unwrap();
    conn.execute_batch(
        "INSERT INTO vault_environments (slug, name, protected, position, created_at)
             VALUES ('default', 'Default', 0, 0, 1), ('prod', 'Production', 1, 1, 1);
         INSERT INTO vault_secrets
             (id, scope, scope_id, environment, path, name, nonce, ciphertext, version,
              description, tags, max_versions, created_at, updated_at, rotated_at)
             VALUES ('s1', 'node', 'node-1', 'prod', '/db', 'DB_URL', x'00', x'01', 2,
                     'primary', '[\"db\"]', 5, 10, 20, 20);
         INSERT INTO vault_secret_versions (secret_id, version, nonce, ciphertext, created_at)
             VALUES ('s1', 1, x'00', x'01', 10), ('s1', 2, x'00', x'01', 20);
         PRAGMA user_version = 2;",
    )
    .unwrap();
}

#[test]
fn version_two_rows_gain_kv_metadata_columns_with_neutral_defaults() {
    let conn = Connection::open_in_memory().unwrap();
    v2_db(&conn);
    migrate(&conn).unwrap();
    assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);
    let row: (String, String, i64, Option<i64>, i64, i64) = conn
        .query_row(
            "SELECT description, custom_metadata, cas_required, delete_version_after_secs,
                    metadata_version, version
             FROM vault_secrets WHERE id = 's1'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(row, ("primary".into(), "{}".into(), 0, None, 1, 2));
    let live_versions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vault_secret_versions WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(live_versions, 2);
    let cas: Vec<(String, i64)> = conn
        .prepare("SELECT slug, cas_required FROM vault_environments ORDER BY slug")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(cas, vec![("default".into(), 0), ("prod".into(), 0)]);
    // Re-running is a no-op.
    migrate(&conn).unwrap();
}

#[tokio::test]
async fn version_two_rows_read_through_the_store_after_upgrade() {
    let conn = Connection::open_in_memory().unwrap();
    v2_db(&conn);
    let store = crate::plugin_secrets::PluginSecretStore::from_connection(
        conn,
        ryu_crypto::FieldCipher::new(&[0x37; 32]),
    )
    .unwrap();
    let info = store
        .secret_info(&crate::plugin_secrets::SecretCoords {
            scope: crate::plugin_secrets::SecretScope::Node,
            scope_id: "node-1".into(),
            environment: "prod".into(),
            path: "/db".into(),
            binding: None,
            name: "DB_URL".into(),
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(info.version, 2);
    assert_eq!(info.metadata_version, 1);
    assert_eq!(info.metadata.tags, vec!["db".to_owned()]);
    assert_eq!(info.metadata.max_versions, 5);
    assert!(info.metadata.custom_metadata.is_empty());
    assert!(!info.metadata.cas_required);
    assert_eq!(info.metadata.delete_version_after_secs, None);
    // Rows from before value types are secrets: revealable, not sealed.
    assert_eq!(
        info.metadata.value_type,
        crate::plugin_secrets::kv::ValueType::Secret
    );
}

#[test]
fn upgrade_from_version_two_writes_a_v2_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugin-secrets.db");
    {
        let conn = Connection::open(&path).unwrap();
        v2_db(&conn);
        backup_before_upgrade(&conn, &path).unwrap();
        migrate(&conn).unwrap();
    }
    assert!(dir.path().join("plugin-secrets.db.v2.bak").exists());
    let backup = Connection::open(dir.path().join("plugin-secrets.db.v2.bak")).unwrap();
    assert_eq!(user_version(&backup).unwrap(), 2);
    assert!(!column_exists(&backup, "vault_secrets", "custom_metadata").unwrap());
}

#[test]
fn upgrade_writes_a_backup_next_to_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugin-secrets.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE plugin_secrets (plugin_id TEXT, key TEXT, nonce BLOB,
                 ciphertext BLOB, updated_at INTEGER, PRIMARY KEY (plugin_id, key));",
        )
        .unwrap();
        backup_before_upgrade(&conn, &path).unwrap();
        migrate(&conn).unwrap();
        // A second open after the upgrade does not overwrite the backup.
        backup_before_upgrade(&conn, &path).unwrap();
    }
    assert!(dir.path().join("plugin-secrets.db.v1.bak").exists());
}
