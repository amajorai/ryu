//! External-store tables and row mapping.

use super::*;

/// Create the external-store tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_external_stores (
             id                    TEXT PRIMARY KEY,
             name                  TEXT NOT NULL UNIQUE,
             kind                  TEXT NOT NULL,
             address               TEXT NOT NULL,
             namespace             TEXT,
             auth_method           TEXT NOT NULL,
             auth_mount            TEXT,
             role                  TEXT,
             mount                 TEXT NOT NULL DEFAULT '',
             path_prefix           TEXT NOT NULL DEFAULT '',
             kv_version            INTEGER NOT NULL DEFAULT 2,
             project_id            TEXT NOT NULL DEFAULT '',
             infisical_environment TEXT NOT NULL DEFAULT '',
             secret_path           TEXT NOT NULL DEFAULT '/',
             nonce                 BLOB NOT NULL,
             ciphertext            BLOB NOT NULL,
             key_version           INTEGER NOT NULL DEFAULT 0,
             created_at            INTEGER NOT NULL,
             updated_at            INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS vault_external_sources (
             id                  TEXT PRIMARY KEY,
             store_id            TEXT NOT NULL,
             environment         TEXT NOT NULL,
             path                TEXT NOT NULL,
             remote_path         TEXT NOT NULL DEFAULT '',
             mode                TEXT NOT NULL,
             scope_id            TEXT NOT NULL,
             cache_ttl_secs      INTEGER NOT NULL,
             stale_if_error_secs INTEGER NOT NULL DEFAULT 0,
             sync_interval_secs  INTEGER NOT NULL,
             last_sync_at        INTEGER,
             last_status         TEXT,
             last_error          TEXT,
             last_count          INTEGER NOT NULL DEFAULT 0,
             created_at          INTEGER NOT NULL,
             UNIQUE (scope_id, environment, path)
         );
         CREATE TABLE IF NOT EXISTS vault_external_destinations (
             id            TEXT PRIMARY KEY,
             store_id      TEXT NOT NULL,
             environment   TEXT NOT NULL,
             path          TEXT NOT NULL,
             remote_path   TEXT NOT NULL DEFAULT '',
             scope_id      TEXT NOT NULL,
             interval_secs INTEGER NOT NULL,
             dirty         INTEGER NOT NULL DEFAULT 1,
             last_push_at  INTEGER,
             last_status   TEXT,
             last_error    TEXT,
             last_count    INTEGER NOT NULL DEFAULT 0,
             failures      INTEGER NOT NULL DEFAULT 0,
             created_at    INTEGER NOT NULL,
             UNIQUE (store_id, remote_path)
         );",
    )
    .context("initializing external-store schema")?;
    // Secret-sync target settings (added after the first release).
    super::super::ensure_columns(
        conn,
        "vault_external_stores",
        &[("options", "TEXT NOT NULL DEFAULT '{}'")],
    )
}

pub(super) const STORE_COLUMNS: &str =
    "id, name, kind, address, namespace, auth_method, auth_mount, role,
    mount, path_prefix, kv_version, project_id, infisical_environment, secret_path,
    created_at, updated_at, options";

pub(super) fn store_from_row(row: &Row<'_>) -> rusqlite::Result<Option<StoreRecord>> {
    let (Some(kind), Some(auth_method)) = (
        StoreKind::parse(&row.get::<_, String>(2)?),
        AuthMethod::parse(&row.get::<_, String>(5)?),
    ) else {
        return Ok(None);
    };
    Ok(Some(StoreRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        kind,
        address: row.get(3)?,
        namespace: row.get(4)?,
        auth_method,
        auth_mount: row.get(6)?,
        role: row.get(7)?,
        mount: row.get(8)?,
        path_prefix: row.get(9)?,
        kv_version: row.get(10)?,
        project_id: row.get(11)?,
        infisical_environment: row.get(12)?,
        secret_path: row.get(13)?,
        // An unreadable options blob reads as empty; the target then fails
        // its own validation at push time instead of hiding the store.
        options: serde_json::from_str(&row.get::<_, String>(16)?).unwrap_or_default(),
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    }))
}

pub(super) const SOURCE_COLUMNS: &str =
    "id, store_id, environment, path, remote_path, mode, scope_id,
    cache_ttl_secs, stale_if_error_secs, sync_interval_secs, last_sync_at, last_status,
    last_error, last_count, created_at";

pub(super) fn source_from_row(row: &Row<'_>) -> rusqlite::Result<SourceRecord> {
    let mode: String = row.get(5)?;
    Ok(SourceRecord {
        id: row.get(0)?,
        store_id: row.get(1)?,
        environment: row.get(2)?,
        path: row.get(3)?,
        remote_path: row.get(4)?,
        mode: if mode == "sync" {
            SourceMode::Sync
        } else {
            SourceMode::Live
        },
        scope_id: row.get(6)?,
        cache_ttl_secs: row.get(7)?,
        stale_if_error_secs: row.get(8)?,
        sync_interval_secs: row.get(9)?,
        last_sync_at: row.get(10)?,
        last_status: row.get(11)?,
        last_error: row.get(12)?,
        last_count: row.get(13)?,
        created_at: row.get(14)?,
    })
}

pub(super) const DESTINATION_COLUMNS: &str =
    "id, store_id, environment, path, remote_path, scope_id,
    interval_secs, dirty, last_push_at, last_status, last_error, last_count, created_at,
    failures";

pub(super) fn destination_from_row(row: &Row<'_>) -> rusqlite::Result<DestinationRecord> {
    Ok(DestinationRecord {
        id: row.get(0)?,
        store_id: row.get(1)?,
        environment: row.get(2)?,
        path: row.get(3)?,
        remote_path: row.get(4)?,
        scope_id: row.get(5)?,
        interval_secs: row.get(6)?,
        dirty: row.get::<_, i64>(7)? != 0,
        last_push_at: row.get(8)?,
        last_status: row.get(9)?,
        last_error: row.get(10)?,
        last_count: row.get(11)?,
        created_at: row.get(12)?,
        failures: row.get(13)?,
    })
}

/// Milliseconds to wait before retrying a destination after `failures`
/// consecutive failures: one loop tick, doubling, capped at its interval.
pub(super) fn retry_backoff_ms(failures: i64, interval_secs: i64) -> i64 {
    let tick_ms = LOOP_TICK.as_millis() as i64;
    let exponent = (failures - 1).clamp(0, 20) as u32;
    tick_ms
        .saturating_mul(1_i64 << exponent)
        .min(interval_secs.saturating_mul(1000))
}

/// Whether the loop should push `destination` at `now`.
pub(super) fn destination_due(destination: &DestinationRecord, now: i64) -> bool {
    let Some(at) = destination.last_push_at else {
        return true;
    };
    let elapsed = now - at;
    if destination.failures > 0 {
        return elapsed >= retry_backoff_ms(destination.failures, destination.interval_secs);
    }
    destination.dirty || elapsed >= destination.interval_secs * 1000
}

pub(super) fn store_locked(conn: &Connection, id: &str) -> Result<StoreRecord> {
    conn.query_row(
        &format!("SELECT {STORE_COLUMNS} FROM vault_external_stores WHERE id = ?1"),
        params![id],
        store_from_row,
    )
    .optional()?
    .flatten()
    .ok_or_else(|| VaultError::NotFound(format!("external store `{id}`")).into())
}

pub(super) fn source_locked(conn: &Connection, id: &str) -> Result<SourceRecord> {
    conn.query_row(
        &format!("SELECT {SOURCE_COLUMNS} FROM vault_external_sources WHERE id = ?1"),
        params![id],
        source_from_row,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("external source `{id}`")).into())
}

pub(super) fn destination_locked(conn: &Connection, id: &str) -> Result<DestinationRecord> {
    conn.query_row(
        &format!("SELECT {DESTINATION_COLUMNS} FROM vault_external_destinations WHERE id = ?1"),
        params![id],
        destination_from_row,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("external destination `{id}`")).into())
}

pub(super) fn collect<T>(
    conn: &Connection,
    sql: &str,
    map: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], map)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
