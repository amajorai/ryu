//! Per-value sealing of SQLite columns through SQL functions.
//!
//! Sealed TEXT columns hold `encb:v1:` envelopes (see [`super`]),
//! each bound to `<table>.<column>` and its row's stable id, the same context
//! the open-time migration (`content_sqlite::migrate_columns` with
//! `ColumnPlan::text(table, column, id)`) uses. Two scalar functions are
//! registered on the store's connection:
//!
//! - `ryu_seal(purpose, id, value)` seals `value` (NULL stays NULL). Writes
//!   wrap the bound plaintext parameter in it, so plaintext is never stored. In
//!   compat mode (no key, never sealed) it returns the value unchanged, except
//!   that a value starting with `encb:` gets an `encb:raw:` escape (stripped on
//!   open) so an envelope lookalike stays readable and sealable later; on an
//!   unhealthy store it fails the statement (writes are refused).
//! - `ryu_open(purpose, id, stored)` opens a value (NULL stays NULL; legacy
//!   plaintext passes through). A value that does not open becomes
//!   [`UNREADABLE`] and is counted; row mappers turn it into an
//!   [`Unreadable`] error with [`opened`], list helpers skip such rows
//!   ([`is_unreadable`]) and get-by-id paths report the error.
//!
//! Sorting and filtering on a sealed column happen on `ryu_open(...)` (after
//! decrypt, in memory); an index can no longer cover such a column.
//!
//! Every Rust app satellite that seals SQLite columns this way re-exports this
//! module as its `seal_sql` (feature `sqlite-functions`); satellites never
//! depend on `apps/core`.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use crate::content_sqlite::{
    enable_secure_delete, finish_store, migrate_columns, run_pending_vacuum, ColumnPlan,
};
use crate::ContentContext;
use anyhow::Result;
use rusqlite::functions::{Context as FnContext, FunctionFlags};
use rusqlite::types::{Type, ValueRef};
use rusqlite::{Connection, Row, RowIndex};

use super::{reopen_plaintext_items, sqlite_store_seal, PluginKeys, StoreSeal};

/// What `ryu_open` returns for a value that does not open.
pub const UNREADABLE: &str = "\u{1}ryu:unreadable\u{1}";

/// The error a row mapper reports for a sealed value that does not open.
#[derive(Debug, Clone, Copy)]
pub struct Unreadable;

impl std::fmt::Display for Unreadable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a sealed value does not open")
    }
}

impl std::error::Error for Unreadable {}

/// A store's sealing state, shared by its connection's SQL functions.
#[derive(Clone)]
pub struct SqlSeal {
    store: Arc<str>,
    state: Arc<RwLock<StoreSeal>>,
    unreadable: Arc<AtomicU64>,
}

impl std::fmt::Debug for SqlSeal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqlSeal")
            .field("store", &self.store)
            .field("state", &self.current().label())
            .finish_non_exhaustive()
    }
}

impl SqlSeal {
    /// A state over `seal` for `store`.
    pub fn new(store: &str, seal: StoreSeal) -> Self {
        Self {
            store: Arc::from(store),
            state: Arc::new(RwLock::new(seal)),
            unreadable: Arc::new(AtomicU64::new(0)),
        }
    }

    /// The registered store name.
    pub fn store(&self) -> &str {
        &self.store
    }

    /// The current state.
    pub fn current(&self) -> StoreSeal {
        self.state
            .read()
            .map(|state| state.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
    }

    /// Unreadable values seen since the store opened.
    pub fn unreadable(&self) -> u64 {
        self.unreadable.load(Ordering::Relaxed)
    }

    /// Count one unreadable value (`what` names the column).
    pub fn note_unreadable(&self, what: &str) {
        let total = self.unreadable.fetch_add(1, Ordering::Relaxed) + 1;
        tracing::warn!(store = %self.store, column = %what, total, "skipping a sealed value that does not open");
    }

    /// The health item: `{state, detail?, unreadable_rows}`.
    pub fn health(&self) -> serde_json::Value {
        let mut health = self.current().health();
        health["unreadable_rows"] = self.unreadable().into();
        health
    }

    /// Seal a value in Rust (copies to a new id, rebuilds).
    pub fn seal_text(&self, value: &str, purpose: &str, id: &str) -> Result<String> {
        self.current()
            .seal_text(value, &ContentContext::for_id(purpose, id))
    }

    /// Open a value in Rust.
    pub fn open_text(&self, stored: &str, purpose: &str, id: &str) -> Result<String> {
        self.current()
            .open_text(stored, &ContentContext::for_id(purpose, id))
    }

    /// A keyless (compat-mode) process that shares the store with the keyed
    /// sidecar: re-read the store record and stop writing plaintext once the
    /// sidecar has sealed it. Call before each write a keyless process makes.
    pub fn refresh_compat(&self, conn: &Connection) -> Result<()> {
        if !matches!(self.current(), StoreSeal::Compat) {
            return Ok(());
        }
        let recorded = crate::content_sqlite::read_store_record(conn, &self.store)?;
        if recorded.and_then(|record| record.kcv).is_some() {
            if let Ok(mut state) = self.state.write() {
                *state = StoreSeal::Unhealthy(format!(
                    "{} was sealed by the app's sidecar; this process holds no key, so it \
                     neither writes nor reads sealed values (use the running app)",
                    self.store
                ));
            }
        }
        Ok(())
    }
}

fn text_arg(ctx: &FnContext<'_>, index: usize) -> Option<String> {
    match ctx.get_raw(index) {
        ValueRef::Null => None,
        ValueRef::Text(text) => Some(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Integer(n) => Some(n.to_string()),
        ValueRef::Real(r) => Some(r.to_string()),
    }
}

fn user_error(error: anyhow::Error) -> rusqlite::Error {
    rusqlite::Error::UserFunctionError(error.into())
}

fn context_args(ctx: &FnContext<'_>) -> rusqlite::Result<(String, String)> {
    let purpose = text_arg(ctx, 0)
        .ok_or_else(|| user_error(anyhow::anyhow!("a sealed value needs a purpose")))?;
    let id = text_arg(ctx, 1)
        .ok_or_else(|| user_error(anyhow::anyhow!("a sealed value needs a row id")))?;
    Ok((purpose, id))
}

/// Register `ryu_seal` and `ryu_open` on `conn` (see the module docs).
pub fn register(conn: &Connection, seal: &SqlSeal) -> Result<()> {
    let flags = FunctionFlags::SQLITE_UTF8;
    let sealer = seal.clone();
    conn.create_scalar_function("ryu_seal", 3, flags, move |ctx| {
        let Some(value) = text_arg(ctx, 2) else {
            return Ok(None);
        };
        let (purpose, id) = context_args(ctx)?;
        sealer
            .current()
            .seal_text(&value, &ContentContext::for_id(purpose, id))
            .map(Some)
            .map_err(user_error)
    })?;
    let opener = seal.clone();
    conn.create_scalar_function("ryu_open", 3, flags, move |ctx| {
        let Some(stored) = text_arg(ctx, 2) else {
            return Ok(None);
        };
        let (purpose, id) = context_args(ctx)?;
        match opener
            .current()
            .open_text(&stored, &ContentContext::for_id(purpose.clone(), id))
        {
            Ok(value) => Ok(Some(value)),
            Err(_) => {
                opener.note_unreadable(&purpose);
                Ok(Some(UNREADABLE.to_owned()))
            }
        }
    })?;
    Ok(())
}

/// Open the sealing of one SQLite store on `conn` (its tables must exist):
/// `secure_delete` on, the key state checked and recorded, any deferred
/// compaction run, legacy plaintext sealed (resumable, idempotent), freed pages
/// scrubbed, and the SQL functions registered. `path` is `None` for an
/// in-memory store (nothing to compact).
pub fn open_store(
    conn: &mut Connection,
    keys: &PluginKeys,
    store: &str,
    plans: &[ColumnPlan],
    path: Option<&Path>,
) -> Result<SqlSeal> {
    enable_secure_delete(conn)?;
    let seal = sqlite_store_seal(keys, conn, store)?;
    if let StoreSeal::Sealing(cipher) = &seal {
        if let Some(path) = path {
            if let Err(error) = run_pending_vacuum(conn, path, store) {
                tracing::warn!("{store}: deferred compaction failed: {error:#}");
            }
        }
        reopen_plaintext_items(conn, store, plans)?;
        let report = migrate_columns(conn, cipher, plans)?;
        if report.sealed > 0 {
            tracing::info!(count = report.sealed, "{store}: sealed legacy values");
            if let Some(path) = path {
                if let Err(error) = finish_store(conn, path, store) {
                    tracing::warn!("{store}: scrubbing freed pages failed: {error:#}");
                }
            }
        }
    }
    let seal = SqlSeal::new(store, seal);
    register(conn, &seal)?;
    Ok(seal)
}

/// Read a column produced by `ryu_open(...)`: [`UNREADABLE`] becomes an
/// [`Unreadable`] conversion error.
pub fn opened<I: RowIndex + Copy>(row: &Row<'_>, index: I) -> rusqlite::Result<String> {
    let value: String = row.get(index)?;
    if value == UNREADABLE {
        return Err(unreadable_error(index.idx(row.as_ref()).unwrap_or(0)));
    }
    Ok(value)
}

/// [`opened`] for a nullable column.
pub fn opened_opt<I: RowIndex + Copy>(row: &Row<'_>, index: I) -> rusqlite::Result<Option<String>> {
    let value: Option<String> = row.get(index)?;
    match value {
        Some(value) if value == UNREADABLE => {
            Err(unreadable_error(index.idx(row.as_ref()).unwrap_or(0)))
        }
        other => Ok(other),
    }
}

fn unreadable_error(index: usize) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(Unreadable))
}

/// Whether a row mapper failed only because a sealed value does not open (list
/// helpers skip such rows; the value was already counted).
pub fn is_unreadable(error: &rusqlite::Error) -> bool {
    matches!(error, rusqlite::Error::FromSqlConversionFailure(_, _, inner) if inner.is::<Unreadable>())
}

/// Collect mapped rows, skipping rows whose sealed value does not open (already
/// counted): list paths never fail on one unreadable row.
pub fn collect_readable<T>(
    rows: impl Iterator<Item = rusqlite::Result<T>>,
) -> rusqlite::Result<Vec<T>> {
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(row) => out.push(row),
            Err(error) if is_unreadable(&error) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(out)
}

/// A display-only copy (a joined name, an activity line): a value that does
/// not open is shown empty rather than failing the row.
pub fn shown(value: String) -> String {
    if value == UNREADABLE {
        String::new()
    } else {
        value
    }
}

/// `ryu_open('<table>.<column>', <id>, <column>)`, for column lists.
pub fn open_expr(table: &str, column: &str, id: &str) -> String {
    format!("ryu_open('{table}.{column}', {id}, {column})")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content_sqlite::KeyKind;
    use crate::plugin_keys::KeySource;
    use crate::{ContentCipher, PluginCipher};
    use base64::Engine as _;

    fn keys(n: u8) -> PluginKeys {
        PluginKeys::sealing(
            PluginCipher::from_subkey_b64(
                "@ryu/test",
                &base64::engine::general_purpose::STANDARD.encode([n; 32]),
            )
            .unwrap(),
            KeySource::Delivered,
        )
    }

    fn store(keys: &PluginKeys) -> (Connection, SqlSeal) {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)")
            .unwrap();
        let plans = [ColumnPlan::text("t", "v", "id", KeyKind::Text).unwrap()];
        let seal = open_store(&mut conn, keys, "t.db", &plans, None).unwrap();
        (conn, seal)
    }

    #[test]
    fn values_seal_through_sql_and_open_only_in_their_row() {
        let (conn, seal) = store(&keys(1));
        for (id, value) in [("a", "alpha"), ("b", "beta")] {
            conn.execute(
                "INSERT INTO t (id, v) VALUES (?1, ryu_seal('t.v', ?1, ?2))",
                [id, value],
            )
            .unwrap();
        }
        let raw: String = conn
            .query_row("SELECT v FROM t WHERE id = 'a'", [], |row| row.get(0))
            .unwrap();
        assert!(ContentCipher::is_sealed_text(&raw));
        conn.execute(
            "UPDATE t SET v = (SELECT v FROM t WHERE id = 'a') WHERE id = 'b'",
            [],
        )
        .unwrap();
        let mut statement = conn
            .prepare("SELECT id, ryu_open('t.v', id, v) FROM t ORDER BY id")
            .unwrap();
        let rows: Vec<rusqlite::Result<(String, String)>> = statement
            .query_map([], |row| Ok((row.get(0)?, opened(row, 1)?)))
            .unwrap()
            .collect();
        assert_eq!(rows[0].as_ref().unwrap().1, "alpha");
        assert!(is_unreadable(rows[1].as_ref().unwrap_err()));
        assert_eq!(seal.unreadable(), 1);
    }

    #[test]
    fn compat_refreshes_to_unhealthy_once_the_store_is_sealed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let plans = [ColumnPlan::text("t", "v", "id", KeyKind::Text).unwrap()];
        let mut keyless = Connection::open(&path).unwrap();
        keyless
            .execute_batch("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)")
            .unwrap();
        let compat = open_store(
            &mut keyless,
            &PluginKeys::compat(),
            "t.db",
            &plans,
            Some(&path),
        )
        .unwrap();
        assert_eq!(compat.current().label(), "compat");
        let mut keyed = Connection::open(&path).unwrap();
        open_store(&mut keyed, &keys(2), "t.db", &plans, Some(&path)).unwrap();
        compat.refresh_compat(&keyless).unwrap();
        assert_eq!(compat.current().label(), "unhealthy");
        assert!(keyless
            .execute(
                "INSERT INTO t (id, v) VALUES ('x', ryu_seal('t.v', 'x', 'plain'))",
                [],
            )
            .is_err());
    }
}
