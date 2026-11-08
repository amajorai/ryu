//! Schema versions for `plugin-secrets.db`.
//!
//! * version 0/1: `plugin_secrets(plugin_id, key, …)` and the first
//!   `vault_secrets` table keyed by `(scope, scope_id, binding, name)`.
//! * version 2: values gain an id, environment, folder path, version number,
//!   metadata, soft delete, and a `key_version` for the vault keyring; every
//!   other vault table (versions, environments, folders, imports, policies,
//!   change requests, audit, keyring, engines) is created.
//! * version 3: KV v2 metadata parity. Values gain `custom_metadata`,
//!   `cas_required`, `delete_version_after_secs`, and a `metadata_version`
//!   check-and-set counter; versions gain a per-version soft delete
//!   (`deleted_at`, `deleted_by`); environments gain `cas_required`. Every
//!   column is additive with a default, so v2 rows keep their meaning.
//!
//! The upgrade runs in one transaction. [`backup_before_upgrade`] writes a
//! consistent copy (`VACUUM INTO`) next to the database first, which is the
//! documented rollback path: an older binary cannot read a newer schema.

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};

/// The schema version this binary writes.
pub const SCHEMA_VERSION: i64 = 3;

fn user_version(conn: &Connection) -> Result<i64> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .context("reading plugin-secrets schema version")
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |row| row.get::<_, i64>(0),
    )? > 0)
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Before upgrading an existing database, write `<path>.v<old>.bak`.
pub fn backup_before_upgrade(conn: &Connection, path: &Path) -> Result<()> {
    let version = user_version(conn)?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    if !table_exists(conn, "plugin_secrets")? && !table_exists(conn, "vault_secrets")? {
        return Ok(());
    }
    let backup = path.with_extension(format!("db.v{}.bak", version.max(1)));
    if backup.exists() {
        return Ok(());
    }
    conn.execute(
        "VACUUM INTO ?1",
        params![backup.to_string_lossy().to_string()],
    )
    .with_context(|| format!("backing up plugin-secrets db to {}", backup.display()))?;
    Ok(())
}

const VAULT_SECRETS_V2: &str = "
CREATE TABLE IF NOT EXISTS vault_secrets (
    id                   TEXT PRIMARY KEY,
    scope                TEXT NOT NULL,
    scope_id             TEXT NOT NULL,
    environment          TEXT NOT NULL DEFAULT 'default',
    path                 TEXT NOT NULL DEFAULT '/',
    binding_kind         TEXT NOT NULL DEFAULT '',
    binding_id           TEXT NOT NULL DEFAULT '',
    name                 TEXT NOT NULL,
    nonce                BLOB NOT NULL,
    ciphertext           BLOB NOT NULL,
    key_version          INTEGER NOT NULL DEFAULT 0,
    version              INTEGER NOT NULL DEFAULT 1,
    description          TEXT NOT NULL DEFAULT '',
    tags                 TEXT NOT NULL DEFAULT '[]',
    expires_at           INTEGER,
    rotation_period_secs INTEGER,
    generator            TEXT,
    expand_references    INTEGER NOT NULL DEFAULT 0,
    max_versions         INTEGER NOT NULL DEFAULT 20,
    created_at           INTEGER NOT NULL,
    created_by           TEXT,
    updated_at           INTEGER NOT NULL,
    updated_by           TEXT,
    rotated_at           INTEGER NOT NULL,
    deleted_at           INTEGER,
    deleted_by           TEXT,
    UNIQUE (scope, scope_id, environment, path, binding_kind, binding_id, name)
);
CREATE INDEX IF NOT EXISTS idx_vault_secrets_lookup
    ON vault_secrets(environment, path, name);
CREATE INDEX IF NOT EXISTS idx_vault_secrets_scope
    ON vault_secrets(scope, scope_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS vault_secret_versions (
    secret_id   TEXT NOT NULL,
    version     INTEGER NOT NULL,
    nonce       BLOB,
    ciphertext  BLOB,
    key_version INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    created_by  TEXT,
    source      TEXT NOT NULL DEFAULT 'write',
    destroyed   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (secret_id, version)
);
CREATE TABLE IF NOT EXISTS vault_environments (
    slug               TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    protected          INTEGER NOT NULL DEFAULT 0,
    required_approvals INTEGER NOT NULL DEFAULT 1,
    position           INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_folders (
    environment TEXT NOT NULL,
    path        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (environment, path)
);
CREATE TABLE IF NOT EXISTS vault_kv_folder_versions (
    scope_id    TEXT NOT NULL,
    environment TEXT NOT NULL,
    path        TEXT NOT NULL,
    version     INTEGER NOT NULL,
    key_sum     INTEGER NOT NULL,
    PRIMARY KEY (scope_id, environment, path)
);
CREATE TABLE IF NOT EXISTS vault_imports (
    id                 TEXT PRIMARY KEY,
    environment        TEXT NOT NULL,
    path               TEXT NOT NULL,
    source_environment TEXT NOT NULL,
    source_path        TEXT NOT NULL,
    position           INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL,
    UNIQUE (environment, path, source_environment, source_path)
);
";

fn upgrade_to_v2(conn: &Connection) -> Result<()> {
    if !column_exists(conn, "plugin_secrets", "key_version")? {
        conn.execute(
            "ALTER TABLE plugin_secrets ADD COLUMN key_version INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    let legacy =
        table_exists(conn, "vault_secrets")? && !column_exists(conn, "vault_secrets", "id")?;
    if legacy {
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_vault_secrets_scope;
             DROP INDEX IF EXISTS idx_vault_secrets_name;
             ALTER TABLE vault_secrets RENAME TO vault_secrets_v1;",
        )?;
    }
    conn.execute_batch(VAULT_SECRETS_V2)?;
    if legacy {
        conn.execute_batch(
            "INSERT INTO vault_secrets
                (id, scope, scope_id, environment, path, binding_kind, binding_id, name,
                 nonce, ciphertext, key_version, version, created_at, updated_at, rotated_at)
             SELECT lower(hex(randomblob(16))), scope, scope_id, 'default', '/', binding_kind,
                    binding_id, name, nonce, ciphertext, 0, 1, updated_at, updated_at, updated_at
             FROM vault_secrets_v1;
             INSERT INTO vault_secret_versions
                (secret_id, version, nonce, ciphertext, key_version, created_at, source)
             SELECT id, 1, nonce, ciphertext, 0, updated_at, 'migration' FROM vault_secrets;
             DROP TABLE vault_secrets_v1;",
        )?;
    }
    Ok(())
}

/// Columns added in schema 3, as `(table, column, definition)`.
const V3_COLUMNS: &[(&str, &str, &str)] = &[
    (
        "vault_secrets",
        "custom_metadata",
        "TEXT NOT NULL DEFAULT '{}'",
    ),
    (
        "vault_secrets",
        "cas_required",
        "INTEGER NOT NULL DEFAULT 0",
    ),
    ("vault_secrets", "delete_version_after_secs", "INTEGER"),
    (
        "vault_secrets",
        "metadata_version",
        "INTEGER NOT NULL DEFAULT 1",
    ),
    (
        "vault_secrets",
        "value_type",
        "TEXT NOT NULL DEFAULT 'secret'",
    ),
    ("vault_secret_versions", "deleted_at", "INTEGER"),
    ("vault_secret_versions", "deleted_by", "TEXT"),
    (
        "vault_environments",
        "cas_required",
        "INTEGER NOT NULL DEFAULT 0",
    ),
];

/// Add the schema-3 columns. Idempotent: it runs on every open, so a fresh
/// database (created from the v2 DDL) and an upgraded one converge.
fn upgrade_to_v3(conn: &Connection) -> Result<()> {
    for (table, column, definition) in V3_COLUMNS {
        if !column_exists(conn, table, column)? {
            conn.execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                [],
            )
            .with_context(|| format!("adding {table}.{column}"))?;
        }
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_vault_secret_versions_age
             ON vault_secret_versions(created_at) WHERE deleted_at IS NULL AND destroyed = 0;",
    )?;
    Ok(())
}

/// Bring `conn` to [`SCHEMA_VERSION`] and create every vault table.
pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .context("configuring plugin-secrets db")?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS plugin_secrets (
             plugin_id   TEXT NOT NULL,
             key         TEXT NOT NULL,
             nonce       BLOB NOT NULL,
             ciphertext  BLOB NOT NULL,
             updated_at  INTEGER NOT NULL,
             key_version INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY (plugin_id, key)
         );",
    )?;
    let version = user_version(&tx)?;
    if version < 2 {
        upgrade_to_v2(&tx).context("upgrading plugin-secrets schema to version 2")?;
    }
    tx.execute_batch(VAULT_SECRETS_V2)?;
    upgrade_to_v3(&tx).context("upgrading plugin-secrets schema to version 3")?;
    tx.execute(
        "INSERT OR IGNORE INTO vault_environments (slug, name, protected, position, created_at)
         VALUES ('default', 'Default', 0, 0, ?1)",
        params![crate::vault::now_millis()],
    )?;
    crate::vault::keyring::init_schema(&tx)?;
    crate::vault::audit::init_schema(&tx)?;
    crate::vault::audit_devices::init_schema(&tx)?;
    crate::vault::policy::init_schema(&tx)?;
    crate::vault::access_requests::init_schema(&tx)?;
    crate::vault::changes::init_schema(&tx)?;
    crate::vault::leases::init_schema(&tx)?;
    crate::vault::dynamic::init_schema(&tx)?;
    crate::vault::dynamic::static_roles::init_schema(&tx)?;
    crate::vault::transit::init_schema(&tx)?;
    crate::vault::pki::init_schema(&tx)?;
    crate::vault::ssh::init_schema(&tx)?;
    crate::vault::machine::init_schema(&tx)?;
    crate::vault::broker::init_schema(&tx)?;
    crate::vault::tokens::init_schema(&tx)?;
    crate::vault::wrapping::init_schema(&tx)?;
    crate::vault::quotas::init_schema(&tx)?;
    crate::vault::totp::init_schema(&tx)?;
    crate::vault::password_policy::init_schema(&tx)?;
    crate::vault::identity_tokens::init_schema(&tx)?;
    crate::vault::external::init_schema(&tx)?;
    crate::vault::items::init_schema(&tx)?;
    crate::vault::password_managers::init_schema(&tx)?;
    tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
    tx.commit().context("committing plugin-secrets migration")?;
    Ok(())
}

#[cfg(test)]
#[path = "migrate_tests.rs"]
mod tests;
