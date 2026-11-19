//! Lifecycle schema, JSON list columns and lease attribution.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::vault::VaultError;

use super::context::*;

// ── Schema ────────────────────────────────────────────────────────────────

pub(super) fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `ALTER TABLE … ADD COLUMN` unless the column already exists.
pub(crate) fn add_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<()> {
    if !has_column(conn, table, column)? {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl};"))?;
    }
    Ok(())
}

/// Add the lifecycle columns and the token-role table. Runs after the machine
/// and lease schemas; idempotent and backward compatible.
pub fn init_schema(conn: &Connection) -> Result<()> {
    for (column, decl) in [
        ("parent_accessor", "TEXT"),
        ("orphan", "INTEGER NOT NULL DEFAULT 0"),
        ("max_expires_at", "INTEGER"),
        ("period_secs", "INTEGER"),
        ("num_uses", "INTEGER"),
        ("bound_cidrs", "TEXT"),
        ("role", "TEXT"),
        ("ttl_secs", "INTEGER"),
        ("scoped", "INTEGER NOT NULL DEFAULT 0"),
        ("renewable", "INTEGER NOT NULL DEFAULT 1"),
        // When a use spent the token's last one; cleared by an explicit revoke.
        ("spent_at", "INTEGER"),
    ] {
        add_column(conn, "vault_tokens", column, decl)?;
    }
    add_column(conn, "vault_machine_identities", "token_config", "TEXT")?;
    add_column(conn, "vault_approle_secret_ids", "cidr_list", "TEXT")?;
    add_column(
        conn,
        "vault_approle_secret_ids",
        "token_bound_cidrs",
        "TEXT",
    )?;
    add_column(conn, "vault_leases", "token_accessor", "TEXT")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS vault_tokens_parent ON vault_tokens (parent_accessor);
         CREATE INDEX IF NOT EXISTS vault_leases_token ON vault_leases (token_accessor);
         CREATE TABLE IF NOT EXISTS vault_token_roles (
             name       TEXT PRIMARY KEY,
             config     TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
         );",
    )
    .context("initializing token lifecycle schema")
}

pub(super) fn json_list(text: Option<String>) -> Vec<String> {
    text.and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub(super) fn list_json(list: &[String]) -> Result<Option<String>> {
    Ok(if list.is_empty() {
        None
    } else {
        Some(serde_json::to_string(list)?)
    })
}

/// The token a lease created now is recorded on: the current request's
/// token, read again under the connection lock, so revoking that token
/// revokes the lease.
///
/// The request passed `token_lookup` earlier, without the lock held since.
/// If the token was revoked, or its identity disabled or deleted, in
/// between, the revoke tree that ran then never sees a lease attached now,
/// so the lease is refused instead. A token revoked only because a use spent
/// its last one (`spent_at`, which an explicit revoke clears) still holds
/// the lease: use exhaustion does not end the leases a token holds.
pub(crate) fn request_lease_holder_locked(conn: &Connection) -> Result<Option<String>> {
    let Some(accessor) = request_token_accessor() else {
        return Ok(None);
    };
    let row: Option<(Option<i64>, Option<i64>, i64)> = conn
        .query_row(
            "SELECT t.revoked_at, t.spent_at, i.disabled
             FROM vault_tokens t JOIN vault_machine_identities i ON i.id = t.identity_id
             WHERE t.accessor = ?1",
            params![accessor],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match row {
        Some((_, _, disabled)) if disabled != 0 => {
            Err(VaultError::Denied("identity is disabled".into()).into())
        }
        Some((None, _, _)) | Some((Some(_), Some(_), _)) => Ok(Some(accessor)),
        // Revoked explicitly, or the token or its identity deleted.
        _ => Err(VaultError::Denied("the token has expired or was revoked".into()).into()),
    }
}
