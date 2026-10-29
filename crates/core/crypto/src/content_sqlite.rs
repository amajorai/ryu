//! SQLite helpers for stores that seal content per value (feature `sqlite`).
//!
//! * [`enable_secure_delete`] on **every** connection of a sealed store, before
//!   its migration runs, so every rewritten cell is zeroed as it is replaced.
//! * The state table `ryu_content_seal(store, item, state, cursor, kcv,
//!   min_reader, updated_at)` records, per `<table>.<column>` item, how far the
//!   migration got, and per store (`item = "__store__"`) the key check value of
//!   the root that sealed it and the minimum reader format.
//! * [`migrate_columns`] seals existing plaintext: cursor pagination over a
//!   stable key (never a bare rowid), `open_*` on every value, seal **only**
//!   values whose open reported `needs_reseal` (legacy plaintext or a retired
//!   key), compare-and-swap updates, cursor persisted in the same transaction.
//!   One pass, O(n); running it again changes nothing. Values that do not open
//!   are counted and left alone. It refuses a store whose recorded key matches
//!   neither the cipher's current nor a retired root, and before an unfinished
//!   item rewrites anything it marks the store `vacuum_pending`, so a crash
//!   before [`finish_store`] still leaves the scrub owed.
//! * [`finish_store`] scrubs plaintext freed before or during the migration:
//!   `wal_checkpoint(TRUNCATE)`, a freelist scrub (zero blobs written over every
//!   free page one bounded chunk per transaction, the WAL truncated after each,
//!   only while one chunk plus headroom is free), and `VACUUM` only when the
//!   store is small and the disk has room; otherwise the store is marked
//!   `vacuum_pending` (with the finished scrub recorded, so it is not repeated)
//!   and [`run_pending_vacuum`] compacts it at the next start, before it serves
//!   requests, whatever its size. Owners on the Core/Gateway boot path call
//!   [`run_pending_vacuum_gated`] instead and compact a larger store off the
//!   boot path: they hand a job to [`defer_compaction`], which runs it on a
//!   background thread under the store's own connection lock. Run it while no
//!   other connection to the store is open: a reader holding a snapshot blocks
//!   the WAL truncation, and then the store is left `vacuum_pending` (and an
//!   error returned) instead of being reported clean.
//! * [`migrate_columns`] and [`finish_store_with`] refuse a connection without
//!   `secure_delete = ON`, and each migration batch takes the write lock before
//!   it reads (`BEGIN IMMEDIATE`), so a concurrent writer waits on the busy
//!   timeout instead of failing the batch with a stale snapshot.
//! * [`check_store_key`] compares the store's recorded key check value with the
//!   cipher's: a store sealed under a key this process does not hold is
//!   unhealthy and must refuse writes, never re-seal or reset.

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};

use crate::content::{
    is_content_seal_error, ContentCipher, ContentContext, KcvMatch, COMPAT_ESCAPE,
    CONTENT_TEXT_PREFIX,
};
use crate::custody::SUPPORTED_MIN_READER;

/// The state table every sealed store carries.
pub const STATE_TABLE: &str = "ryu_content_seal";
/// The `item` of the per-store row (key check value, minimum reader).
pub const STORE_ITEM: &str = "__store__";
/// Rows per migration transaction.
pub const BATCH_SIZE: usize = 500;
/// Stores at or below this size are vacuumed right after their migration.
pub const VACUUM_NOW_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// Free space required beyond twice the store size before a `VACUUM`.
pub const VACUUM_HEADROOM_BYTES: u64 = 256 * 1024 * 1024;
const VACUUM_RETRY_SECS: i64 = 24 * 60 * 60;
const SCRUB_TABLE: &str = "ryu_content_scrub";
/// Largest zero blob written by one scrub transaction. The WAL is truncated
/// after each, so the scrub needs about one chunk of extra disk at a time.
const SCRUB_CHUNK_BYTES: i64 = 64 * 1024 * 1024;
/// Store-row `cursor` marking a finished freelist scrub: only the `VACUUM` is
/// still owed. Optionally followed by `:<unix seconds>` of the last attempt.
const SCRUBBED_CURSOR: &str = "scrubbed";
/// How long after a store opens its deferred compaction starts (see
/// [`defer_compaction`]), so boot and first requests are not competing with it.
const COMPACTION_DELAY: std::time::Duration = std::time::Duration::from_secs(120);
/// Busy timeout applied to a connection that has none, so a migration batch or
/// checkpoint waits for a concurrent writer or reader instead of failing.
const DEFAULT_BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// How many times a `wal_checkpoint(TRUNCATE)` blocked by a reader is retried.
const CHECKPOINT_ATTEMPTS: u32 = 3;

/// Migration states of an item.
pub mod states {
    /// Not started.
    pub const PENDING: &str = "pending";
    /// In progress; `cursor` holds the last key processed.
    pub const SEALING: &str = "sealing";
    /// Every value was sealed (or counted unreadable).
    pub const SEALED: &str = "sealed";
    /// Store row: the migration finished and the store is compacted.
    pub const OK: &str = "ok";
    /// Store row: the freed-page scrub and `VACUUM` are still owed (a migration
    /// started and `finish_store` has not confirmed them, or a size or
    /// free-space gate deferred the `VACUUM`).
    pub const VACUUM_PENDING: &str = "vacuum_pending";
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Turn on `PRAGMA secure_delete` for this connection. Call on every connection
/// of a sealed store, before its migration.
pub fn enable_secure_delete(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "secure_delete", "ON")
        .context("enabling secure_delete")?;
    Ok(())
}

/// Refuse a connection without `PRAGMA secure_delete = ON` (`FAST` does not zero
/// overflow pages): rewriting a cell without it leaves the old plaintext in the
/// page's unallocated space, which the freelist scrub does not reach.
pub fn require_secure_delete(conn: &Connection) -> Result<()> {
    let mode: i64 = conn
        .query_row("PRAGMA secure_delete", [], |row| row.get(0))
        .context("reading secure_delete")?;
    if mode != 1 {
        bail!(
            "secure_delete is not on for this connection; call enable_secure_delete before \
             migrating or finishing a sealed store"
        );
    }
    Ok(())
}

fn ensure_busy_timeout(conn: &Connection) -> Result<()> {
    let current: i64 = conn
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .context("reading busy_timeout")?;
    if current <= 0 {
        conn.busy_timeout(DEFAULT_BUSY_TIMEOUT)
            .context("setting busy_timeout")?;
    }
    Ok(())
}

/// Create the state table if it is missing.
pub fn ensure_state_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {STATE_TABLE} (
            store      TEXT NOT NULL,
            item       TEXT NOT NULL,
            state      TEXT NOT NULL,
            cursor     TEXT,
            kcv        TEXT,
            min_reader INTEGER NOT NULL DEFAULT {SUPPORTED_MIN_READER},
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (store, item)
        )"
    ))
    .context("creating the content-seal state table")
}

fn valid_ident(name: &str) -> Result<&str> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && !name.as_bytes()[0].is_ascii_digit();
    if !ok {
        bail!("invalid SQL identifier {name:?} in a column plan");
    }
    Ok(name)
}

/// Whether a column holds TEXT (`encb:v1:`) or BLOB (`RYU-CB01`) values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColumnKind {
    /// TEXT values sealed as `encb:v1:`.
    Text,
    /// BLOB values sealed as `RYU-CB01`.
    Blob,
}

/// The type of a plan's stable order key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyKind {
    /// A TEXT/UUID primary key.
    Text,
    /// An explicitly declared `INTEGER PRIMARY KEY` column.
    Integer,
}

/// The key and context columns of one row, handed to a plan's context builder.
#[derive(Clone, Debug)]
pub struct RowKey {
    values: Vec<(String, Value)>,
}

impl RowKey {
    /// A column value rendered as text (`""` for NULL or a BLOB).
    pub fn text(&self, column: &str) -> String {
        match self.values.iter().find(|(name, _)| name == column) {
            Some((_, Value::Text(text))) => text.clone(),
            Some((_, Value::Integer(n))) => n.to_string(),
            Some((_, Value::Real(r))) => r.to_string(),
            _ => String::new(),
        }
    }

    /// The order key rendered as text.
    pub fn key(&self) -> String {
        self.values
            .first()
            .map(|(name, _)| self.text(name))
            .unwrap_or_default()
    }
}

type ContextBuilder = Arc<dyn Fn(&RowKey) -> ContentContext + Send + Sync>;

/// One sealed column of one table, with the stable key that orders the
/// migration and binds each value (AAD).
#[derive(Clone)]
pub struct ColumnPlan {
    table: String,
    column: String,
    key: String,
    key_kind: KeyKind,
    kind: ColumnKind,
    context_columns: Vec<String>,
    context: ContextBuilder,
}

impl std::fmt::Debug for ColumnPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ColumnPlan")
            .field("item", &self.item())
            .field("key", &self.key)
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

impl ColumnPlan {
    /// A plan for `table.column` ordered and bound by `key`. The default context
    /// is `ContentContext::new("<table>.<column>").with("id", <key>)`.
    ///
    /// Refuses `rowid`, `_rowid_` and `oid`: an implicit rowid is not stable
    /// across `VACUUM` or table rebuilds, so it must never be bound into AAD.
    pub fn new(
        table: &str,
        column: &str,
        key: &str,
        key_kind: KeyKind,
        kind: ColumnKind,
    ) -> Result<Self> {
        let lowered = key.to_ascii_lowercase();
        if matches!(lowered.as_str(), "rowid" | "_rowid_" | "oid") {
            bail!(
                "column plan for {table}.{column} uses the implicit rowid as its key; bind an \
                 explicit TEXT id or INTEGER PRIMARY KEY column instead"
            );
        }
        let (table, column, key) = (valid_ident(table)?, valid_ident(column)?, valid_ident(key)?);
        let purpose = format!("{table}.{column}");
        Ok(Self {
            table: table.to_owned(),
            column: column.to_owned(),
            key: key.to_owned(),
            key_kind,
            kind,
            context_columns: Vec::new(),
            context: Arc::new(move |row: &RowKey| {
                ContentContext::new(purpose.clone()).with("id", row.key())
            }),
        })
    }

    /// [`Self::new`] for a TEXT column.
    pub fn text(table: &str, column: &str, key: &str, key_kind: KeyKind) -> Result<Self> {
        Self::new(table, column, key, key_kind, ColumnKind::Text)
    }

    /// [`Self::new`] for a BLOB column.
    pub fn blob(table: &str, column: &str, key: &str, key_kind: KeyKind) -> Result<Self> {
        Self::new(table, column, key, key_kind, ColumnKind::Blob)
    }

    /// Bind a custom context built from the key and `columns` (for example
    /// `(doc_id, seq)`). The builder must produce exactly what the store's own
    /// read and write paths use.
    pub fn with_context(
        mut self,
        columns: &[&str],
        build: impl Fn(&RowKey) -> ContentContext + Send + Sync + 'static,
    ) -> Result<Self> {
        self.context_columns = columns
            .iter()
            .map(|column| valid_ident(column).map(str::to_owned))
            .collect::<Result<_>>()?;
        self.context = Arc::new(build);
        Ok(self)
    }

    /// The state-table item name, `<table>.<column>`.
    pub fn item(&self) -> String {
        format!("{}.{}", self.table, self.column)
    }

    /// The context of a row.
    pub fn context_for(&self, row: &RowKey) -> ContentContext {
        (self.context)(row)
    }

    fn select_sql(&self, after_cursor: bool) -> String {
        let mut columns = format!("\"{}\", \"{}\"", self.key, self.column);
        for extra in &self.context_columns {
            columns.push_str(&format!(", \"{extra}\""));
        }
        let filter = if after_cursor {
            format!("WHERE \"{}\" > ?1 ", self.key)
        } else {
            String::new()
        };
        format!(
            "SELECT {columns} FROM \"{}\" {filter}ORDER BY \"{}\" LIMIT {BATCH_SIZE}",
            self.table, self.key
        )
    }

    fn row_key(&self, key: &Value, extras: &[Value]) -> RowKey {
        let mut values = vec![(self.key.clone(), key.clone())];
        for (name, value) in self.context_columns.iter().zip(extras) {
            values.push((name.clone(), value.clone()));
        }
        RowKey { values }
    }

    fn cursor_value(&self, cursor: &str) -> Result<Value> {
        Ok(match self.key_kind {
            KeyKind::Text => Value::Text(cursor.to_owned()),
            KeyKind::Integer => Value::Integer(
                cursor
                    .parse()
                    .with_context(|| format!("corrupt migration cursor for {}", self.item()))?,
            ),
        })
    }
}

/// Counters of one [`migrate_columns`] run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MigrationReport {
    /// Values sealed by this run.
    pub sealed: u64,
    /// Values that were already sealed under the current key.
    pub already_sealed: u64,
    /// Values that did not open (left untouched; report them in health).
    pub unreadable: u64,
    /// Values a concurrent write changed between read and update (left as the
    /// writer stored them; writers seal).
    pub raced: u64,
    /// Items skipped because a previous run finished them.
    pub finished_items: u64,
}

fn item_row(
    conn: &Connection,
    store: &str,
    item: &str,
) -> Result<Option<(String, Option<String>)>> {
    conn.query_row(
        &format!("SELECT state, cursor FROM {STATE_TABLE} WHERE store = ?1 AND item = ?2"),
        params![store, item],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .context("reading the content-seal state")
}

fn set_item(
    conn: &Connection,
    store: &str,
    item: &str,
    state: &str,
    cursor: Option<&str>,
) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO {STATE_TABLE} (store, item, state, cursor, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(store, item) DO UPDATE SET
                state = excluded.state, cursor = excluded.cursor, updated_at = excluded.updated_at"
        ),
        params![store, item, state, cursor, now_secs()],
    )
    .context("writing the content-seal state")?;
    Ok(())
}

/// The migration state of one item (`None` when never started).
pub fn item_state(conn: &Connection, store: &str, item: &str) -> Result<Option<String>> {
    ensure_state_table(conn)?;
    Ok(item_row(conn, store, item)?.map(|(state, _)| state))
}

enum Outcome {
    Sealed(Value),
    Already,
    Unreadable,
}

fn reseal_value(
    cipher: &ContentCipher,
    kind: ColumnKind,
    stored: &Value,
    context: &ContentContext,
) -> Result<Outcome> {
    let result = match kind {
        ColumnKind::Text => {
            let text = match stored {
                Value::Text(text) => text.clone(),
                Value::Integer(n) => n.to_string(),
                Value::Real(r) => r.to_string(),
                Value::Blob(bytes) => match String::from_utf8(bytes.clone()) {
                    Ok(text) => text,
                    Err(_) => return Ok(Outcome::Unreadable),
                },
                Value::Null => return Ok(Outcome::Already),
            };
            cipher.open_text(&text, context).and_then(|opened| {
                if opened.needs_reseal {
                    // Legacy plaintext written by a keyless satellite carries
                    // the compat escape (`encb:raw:`); seal the inner value.
                    let plain = if text.starts_with(CONTENT_TEXT_PREFIX) {
                        opened.value.as_str()
                    } else {
                        opened
                            .value
                            .strip_prefix(COMPAT_ESCAPE)
                            .unwrap_or(&opened.value)
                    };
                    Ok(Some(Value::Text(cipher.seal_text(plain, context)?)))
                } else {
                    Ok(None)
                }
            })
        }
        ColumnKind::Blob => {
            let bytes = match stored {
                Value::Blob(bytes) => bytes.clone(),
                Value::Text(text) => text.clone().into_bytes(),
                Value::Integer(n) => n.to_string().into_bytes(),
                Value::Real(r) => r.to_string().into_bytes(),
                Value::Null => return Ok(Outcome::Already),
            };
            cipher.open_bytes(&bytes, context).and_then(|opened| {
                if opened.needs_reseal {
                    Ok(Some(Value::Blob(
                        cipher.seal_bytes(&opened.value, context)?,
                    )))
                } else {
                    Ok(None)
                }
            })
        }
    };
    match result {
        Ok(Some(sealed)) => Ok(Outcome::Sealed(sealed)),
        Ok(None) => Ok(Outcome::Already),
        Err(error) if is_content_seal_error(&error) => Ok(Outcome::Unreadable),
        Err(error) => Err(error),
    }
}

/// Seal every legacy value of every planned column (see the module docs).
/// Resumable: the cursor is committed with each batch. Idempotent: finished
/// items are skipped, and values that already open under the current key are
/// never rewritten. Refused unless [`enable_secure_delete`] ran on `conn`. Each
/// batch holds the write lock from its read to its commit (`BEGIN IMMEDIATE`);
/// a connection without a busy timeout gets one, so concurrent writers on other
/// connections wait for the batch instead of failing it.
///
/// On a store recorded under a retired root ([`StoreKeyState::Retired`], after
/// [`reset_items`]), the run that seals the store's last unfinished item with no
/// unreadable value also moves the store's key check value to the current root,
/// in the same transaction. If any value stayed unreadable, the retired record is
/// kept (and logged) so the next start walks the store again.
pub fn migrate_columns(
    conn: &mut Connection,
    cipher: &ContentCipher,
    plans: &[ColumnPlan],
) -> Result<MigrationReport> {
    require_secure_delete(conn)?;
    ensure_busy_timeout(conn)?;
    ensure_state_table(conn)?;
    let store = cipher.store().to_owned();
    // Never seal remaining plaintext under a key the store's record does not
    // name: that would leave a mixed-key store (module docs, design 2a).
    let key_state = check_store_key(conn, cipher)?;
    if let StoreKeyState::Mismatch { .. } = key_state {
        return Err(mismatch_error(&store));
    }
    let was_retired = key_state == StoreKeyState::Retired;
    let mut report = MigrationReport::default();
    for plan in plans {
        let item = plan.item();
        let (state, mut cursor) =
            item_row(conn, &store, &item)?.unwrap_or_else(|| (states::PENDING.to_owned(), None));
        if state == states::SEALED {
            report.finished_items += 1;
            continue;
        }
        // Record the scrub debt before any cell is rewritten, in the same
        // transaction that starts the item: a crash between the last batch and
        // `finish_store` then leaves the store `vacuum_pending`, and
        // `run_pending_vacuum` finishes the scrub at the next start.
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        mark_scrub_owed(&tx, &store)?;
        set_item(&tx, &store, &item, states::SEALING, cursor.as_deref())?;
        tx.commit()?;
        loop {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let batch: Vec<(Value, Value, Vec<Value>)> = {
                let mut statement = tx.prepare(&plan.select_sql(cursor.is_some()))?;
                let extra = plan.context_columns.len();
                let map_row = |row: &rusqlite::Row<'_>| {
                    let key: Value = row.get(0)?;
                    let value: Value = row.get(1)?;
                    let mut extras = Vec::with_capacity(extra);
                    for index in 0..extra {
                        extras.push(row.get::<_, Value>(2 + index)?);
                    }
                    Ok((key, value, extras))
                };
                let rows = match &cursor {
                    Some(cursor) => statement
                        .query_map(params![plan.cursor_value(cursor)?], map_row)?
                        .collect::<rusqlite::Result<Vec<_>>>()?,
                    None => statement
                        .query_map([], map_row)?
                        .collect::<rusqlite::Result<Vec<_>>>()?,
                };
                rows
            };
            let update = format!(
                "UPDATE \"{}\" SET \"{}\" = ?1 WHERE \"{}\" = ?2 AND \"{}\" IS ?3",
                plan.table, plan.column, plan.key, plan.column
            );
            for (key, value, extras) in &batch {
                let row = plan.row_key(key, extras);
                match reseal_value(cipher, plan.kind, value, &plan.context_for(&row))? {
                    Outcome::Sealed(sealed) => {
                        let changed = tx.execute(&update, params![sealed, key, value])?;
                        if changed == 1 {
                            report.sealed += 1;
                        } else {
                            report.raced += 1;
                        }
                    }
                    Outcome::Already => report.already_sealed += 1,
                    Outcome::Unreadable => report.unreadable += 1,
                }
            }
            if let Some((key, _, _)) = batch.last() {
                cursor = Some(plan.row_key(key, &[]).key());
            }
            set_item(&tx, &store, &item, states::SEALING, cursor.as_deref())?;
            tx.commit()?;
            if batch.len() < BATCH_SIZE {
                break;
            }
        }
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        set_item(&tx, &store, &item, states::SEALED, None)?;
        if was_retired && report.unreadable == 0 && all_items_sealed(&tx, &store)? {
            // Every value now opens under the current root: the record moves on.
            record_store_kcv(&tx, &store, cipher.kcv())?;
        }
        tx.commit()?;
    }
    if was_retired && report.unreadable > 0 {
        tracing::warn!(
            store = %store,
            "content store keeps its retired key record: some values did not open"
        );
    }
    if report.unreadable > 0 {
        tracing::warn!(
            store = %store,
            unreadable = report.unreadable,
            "content migration left values that do not open untouched"
        );
    }
    Ok(report)
}

/// Whether every migration item of `store` (not the store row) is `sealed`.
fn all_items_sealed(conn: &Connection, store: &str) -> Result<bool> {
    let unfinished: i64 = conn
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM {STATE_TABLE}
                 WHERE store = ?1 AND item != ?2 AND state != ?3"
            ),
            params![store, STORE_ITEM, states::SEALED],
            |row| row.get(0),
        )
        .context("reading the content-seal state")?;
    Ok(unfinished == 0)
}

/// Mark planned items as not finished, so the next [`migrate_columns`] run walks
/// them again (after adopting a new key with retired keys, for example).
pub fn reset_items(conn: &Connection, store: &str, plans: &[ColumnPlan]) -> Result<()> {
    ensure_state_table(conn)?;
    for plan in plans {
        set_item(conn, store, &plan.item(), states::PENDING, None)?;
    }
    Ok(())
}

/// Test helper (also for other crates' tests): every non-NULL value of every
/// planned column opens under `cipher` with its plan's context and does not
/// need a reseal. Run it after every table-rebuild migration test.
pub fn assert_all_open(
    conn: &Connection,
    cipher: &ContentCipher,
    plans: &[ColumnPlan],
) -> Result<()> {
    for plan in plans {
        let mut columns = format!("\"{}\", \"{}\"", plan.key, plan.column);
        for extra in &plan.context_columns {
            columns.push_str(&format!(", \"{extra}\""));
        }
        let sql = format!("SELECT {columns} FROM \"{}\"", plan.table);
        let mut statement = conn.prepare(&sql)?;
        let extra = plan.context_columns.len();
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let key: Value = row.get(0)?;
            let value: Value = row.get(1)?;
            let mut extras = Vec::with_capacity(extra);
            for index in 0..extra {
                extras.push(row.get::<_, Value>(2 + index)?);
            }
            let row_key = plan.row_key(&key, &extras);
            let context = plan.context_for(&row_key);
            let sealed = match (&plan.kind, &value) {
                (_, Value::Null) => continue,
                (ColumnKind::Text, Value::Text(text)) => {
                    let opened = cipher.open_text(text, &context);
                    ContentCipher::is_sealed_text(text)
                        && matches!(opened, Ok(ref o) if !o.needs_reseal)
                        || (text.is_empty() && opened.is_ok())
                }
                (ColumnKind::Blob, Value::Blob(bytes)) => {
                    let opened = cipher.open_bytes(bytes, &context);
                    ContentCipher::is_sealed_bytes(bytes)
                        && matches!(opened, Ok(ref o) if !o.needs_reseal)
                        || (bytes.is_empty() && opened.is_ok())
                }
                _ => false,
            };
            if !sealed {
                bail!(
                    "{} row {} is not sealed under the current key for its context",
                    plan.item(),
                    row_key.key()
                );
            }
        }
    }
    Ok(())
}

/// The per-store record (`item = "__store__"`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreRecord {
    /// `ok` or `vacuum_pending` (or a migration state while the store's first
    /// migration runs).
    pub state: String,
    /// Key check value of the root that sealed the store.
    pub kcv: Option<String>,
    /// Lowest reader format that can open the store.
    pub min_reader: i64,
}

/// The per-store record, if any (a store that was never sealed has none).
/// Satellites use it to tell "never sealed" (compat mode allowed) from "holds
/// sealed data" (no key → unhealthy).
pub fn read_store_record(conn: &Connection, store: &str) -> Result<Option<StoreRecord>> {
    ensure_state_table(conn)?;
    conn.query_row(
        &format!("SELECT state, kcv, min_reader FROM {STATE_TABLE} WHERE store = ?1 AND item = ?2"),
        params![store, STORE_ITEM],
        |row| {
            Ok(StoreRecord {
                state: row.get(0)?,
                kcv: row.get(1)?,
                min_reader: row.get(2)?,
            })
        },
    )
    .optional()
    .context("reading the store's content-seal record")
}

/// How a store's recorded key relates to the cipher a process holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoreKeyState {
    /// No key was recorded yet; the cipher's KCV is now recorded.
    Recorded,
    /// Sealed under the cipher's current root.
    Current,
    /// Sealed under one of the cipher's retired roots: values open; reseal them
    /// (run [`reset_items`], then [`migrate_columns`]). The migration run that
    /// finishes the store's last item with no unreadable value records the
    /// current root, so the next check reports [`Self::Current`].
    Retired,
    /// Sealed under a root this process does not hold. The store is unhealthy:
    /// refuse writes, never re-seal or reset it.
    Mismatch {
        /// The recorded key check value.
        recorded: String,
    },
}

impl StoreKeyState {
    /// Whether the store may be written.
    pub fn writable(&self) -> bool {
        !matches!(self, Self::Mismatch { .. })
    }
}

/// Error for a store sealed under a newer reader format.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewerStoreFormat {
    /// The store.
    pub store: String,
    /// Its recorded minimum reader.
    pub min_reader: i64,
}

impl std::fmt::Display for NewerStoreFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} was written by a newer Ryu (needs reader format {}, this build reads {}); \
             update Ryu",
            self.store, self.min_reader, SUPPORTED_MIN_READER
        )
    }
}

impl std::error::Error for NewerStoreFormat {}

/// Check (and on first use record) the store's key check value and reader
/// format. Errors with [`NewerStoreFormat`] when a newer build sealed it.
pub fn check_store_key(conn: &Connection, cipher: &ContentCipher) -> Result<StoreKeyState> {
    let store = cipher.store();
    match read_store_record(conn, store)? {
        Some(record) => {
            if record.min_reader > SUPPORTED_MIN_READER {
                return Err(NewerStoreFormat {
                    store: store.to_owned(),
                    min_reader: record.min_reader,
                }
                .into());
            }
            let Some(kcv) = record.kcv else {
                record_store_kcv(conn, store, cipher.kcv())?;
                return Ok(StoreKeyState::Recorded);
            };
            Ok(match cipher.match_kcv(&kcv) {
                KcvMatch::Current => StoreKeyState::Current,
                KcvMatch::Retired => StoreKeyState::Retired,
                KcvMatch::Unknown => {
                    tracing::error!(
                        store = %store,
                        "content store was sealed under a different key; refusing writes \
                         (run `ryu-core keys status`)"
                    );
                    StoreKeyState::Mismatch { recorded: kcv }
                }
            })
        }
        None => {
            record_store_kcv(conn, store, cipher.kcv())?;
            Ok(StoreKeyState::Recorded)
        }
    }
}

/// Record `kcv` as the key that seals `store` (after a reseal under a new key).
pub fn record_store_kcv(conn: &Connection, store: &str, kcv: &str) -> Result<()> {
    ensure_state_table(conn)?;
    conn.execute(
        &format!(
            "INSERT INTO {STATE_TABLE} (store, item, state, kcv, min_reader, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(store, item) DO UPDATE SET kcv = excluded.kcv,
                min_reader = MAX(min_reader, excluded.min_reader), updated_at = excluded.updated_at"
        ),
        params![
            store,
            STORE_ITEM,
            states::OK,
            kcv,
            SUPPORTED_MIN_READER,
            now_secs()
        ],
    )
    .context("recording the store key check value")?;
    Ok(())
}

fn set_store_state(
    conn: &Connection,
    store: &str,
    state: &str,
    cursor: Option<&str>,
) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO {STATE_TABLE} (store, item, state, cursor, min_reader, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(store, item) DO UPDATE SET state = excluded.state,
                cursor = excluded.cursor, updated_at = excluded.updated_at"
        ),
        params![
            store,
            STORE_ITEM,
            state,
            cursor,
            SUPPORTED_MIN_READER,
            now_secs()
        ],
    )
    .context("writing the store state")?;
    Ok(())
}

/// The store row's `cursor`: whether the freelist scrub already finished (only
/// the `VACUUM` is owed) and when a gated attempt last ran.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct PendingCursor {
    scrubbed: bool,
    last_attempt: Option<i64>,
}

impl PendingCursor {
    fn parse(cursor: Option<&str>) -> Self {
        let Some(cursor) = cursor else {
            return Self::default();
        };
        match cursor.strip_prefix(SCRUBBED_CURSOR) {
            Some(rest) => Self {
                scrubbed: true,
                last_attempt: rest.strip_prefix(':').and_then(|v| v.parse().ok()),
            },
            None => Self {
                scrubbed: false,
                last_attempt: cursor.parse().ok(),
            },
        }
    }

    fn encode(self) -> Option<String> {
        match (self.scrubbed, self.last_attempt) {
            (false, None) => None,
            (false, Some(at)) => Some(at.to_string()),
            (true, None) => Some(SCRUBBED_CURSOR.to_owned()),
            (true, Some(at)) => Some(format!("{SCRUBBED_CURSOR}:{at}")),
        }
    }
}

fn set_pending(conn: &Connection, store: &str, cursor: PendingCursor) -> Result<()> {
    set_store_state(
        conn,
        store,
        states::VACUUM_PENDING,
        cursor.encode().as_deref(),
    )
}

/// Move the store row to `vacuum_pending` unless it already is (keeping its
/// last-attempt time, key check value and reader format). A finished scrub it
/// recorded is forgotten: the caller is about to free new plaintext. Only a
/// verified [`finish_store`] or [`run_pending_vacuum`] moves it back to `ok`.
fn mark_scrub_owed(conn: &Connection, store: &str) -> Result<()> {
    let current = item_row(conn, store, STORE_ITEM)?;
    if let Some((state, cursor)) = &current {
        if state == states::VACUUM_PENDING {
            let parsed = PendingCursor::parse(cursor.as_deref());
            if !parsed.scrubbed {
                return Ok(());
            }
            return set_pending(
                conn,
                store,
                PendingCursor {
                    scrubbed: false,
                    ..parsed
                },
            );
        }
    }
    set_store_state(conn, store, states::VACUUM_PENDING, None)
}

/// `PRAGMA wal_checkpoint(TRUNCATE)` until it reports every WAL frame copied
/// back and the WAL truncated. A reader holding a snapshot blocks it (`busy`);
/// it is retried on the connection's busy timeout, then reported as an error so
/// callers never record a store as scrubbed while old frames remain. Outside
/// WAL mode the pragma reports `(0, -1, -1)` and this succeeds.
fn checkpoint_truncate(conn: &Connection) -> Result<()> {
    let mut last = (0, 0, 0);
    for attempt in 0..CHECKPOINT_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let result: (i64, i64, i64) = conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .context("checkpointing the WAL")?;
        if result.0 == 0 && result.1 == result.2 {
            return Ok(());
        }
        last = result;
    }
    bail!(
        "the WAL could not be checkpointed and truncated (busy {}, {} frames, {} copied); \
         another connection holds the store open",
        last.0,
        last.1,
        last.2
    )
}

/// Drop the scrub's scratch table without rewriting its pages (they hold only
/// zeros), then truncate the WAL. `secure_delete` is turned back on even when
/// the drop fails.
fn drop_scrub_table(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA secure_delete = OFF")
        .context("pausing secure_delete for the scrub table")?;
    let dropped = conn
        .execute_batch(&format!("DROP TABLE IF EXISTS {SCRUB_TABLE}"))
        .context("dropping the scrub table");
    let restored = conn
        .execute_batch("PRAGMA secure_delete = ON")
        .context("re-enabling secure_delete");
    dropped?;
    restored?;
    checkpoint_truncate(conn)
}

/// Overwrite every free page with zeros: zero blobs as large as the freelist
/// take the free pages, one chunk of at most `SCRUB_CHUNK_BYTES` per
/// transaction with a WAL truncate after each, so the WAL (and the extra disk
/// the scrub needs) stays near one chunk. Before each chunk the volume must
/// have that chunk plus `policy.headroom_bytes` free; when it does not, the
/// scrub stops and `Ok(None)` is returned (the caller keeps the store
/// pending). The scratch table is dropped and the WAL truncated on every path,
/// including errors. Returns the number of free pages scrubbed.
pub fn scrub_freelist(
    conn: &Connection,
    db_path: &Path,
    policy: &VacuumPolicy,
) -> Result<Option<u64>> {
    // A scratch table left by an interrupted scrub holds only zeros.
    drop_scrub_table(conn)?;
    let free_pages: i64 = conn.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
    if free_pages <= 0 {
        return Ok(Some(0));
    }
    let page_size: i64 = conn.query_row("PRAGMA page_size", [], |row| row.get(0))?;
    let mut remaining = free_pages * page_size;
    conn.execute_batch(&format!("CREATE TABLE {SCRUB_TABLE} (b BLOB)"))?;
    let filled = (|| -> Result<bool> {
        while remaining > 0 {
            let chunk = remaining.min(SCRUB_CHUNK_BYTES);
            let needed = (chunk as u64).saturating_add(policy.headroom_bytes);
            if !has_room(db_path, needed, policy) {
                return Ok(false);
            }
            // Autocommit: each chunk is its own transaction.
            conn.execute(
                &format!("INSERT INTO {SCRUB_TABLE} (b) VALUES (zeroblob(?1))"),
                params![chunk],
            )
            .context("zero-filling free pages")?;
            checkpoint_truncate(conn)?;
            remaining -= chunk;
        }
        Ok(true)
    })();
    let dropped = drop_scrub_table(conn);
    let filled = filled?;
    dropped?;
    Ok(filled.then_some(free_pages as u64))
}

/// Free bytes on the volume holding `dir`, or `None` when unknown.
pub type FreeSpaceProbe = fn(&Path) -> Option<u64>;

fn os_free_space(dir: &Path) -> Option<u64> {
    fs4::available_space(dir).ok()
}

/// Size and free-space gates for [`finish_store_with`] and
/// [`run_pending_vacuum_with`].
#[derive(Clone, Copy, Debug)]
pub struct VacuumPolicy {
    /// Stores larger than this are not vacuumed inline (at open); their
    /// compaction is left to [`defer_compaction`].
    pub vacuum_now_max_bytes: u64,
    /// Free space required beyond twice the store size (vacuum) or one scrub
    /// chunk (freelist scrub).
    pub headroom_bytes: u64,
    /// Reads the free space of the store's volume (tests inject a small one).
    pub free_space: FreeSpaceProbe,
}

impl Default for VacuumPolicy {
    fn default() -> Self {
        Self {
            vacuum_now_max_bytes: VACUUM_NOW_MAX_BYTES,
            headroom_bytes: VACUUM_HEADROOM_BYTES,
            free_space: os_free_space,
        }
    }
}

/// What [`finish_store`] did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FinishOutcome {
    /// Free pages overwritten with zeros.
    pub scrubbed_pages: u64,
    /// Whether the store was vacuumed now.
    pub vacuumed: bool,
    /// Whether a vacuum is still owed (size or free-space gate).
    pub vacuum_pending: bool,
}

fn store_size(db_path: &Path) -> u64 {
    std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0)
}

fn has_room(db_path: &Path, needed: u64, policy: &VacuumPolicy) -> bool {
    let dir = db_path.parent().unwrap_or_else(|| Path::new("."));
    (policy.free_space)(dir).is_some_and(|available| available >= needed)
}

fn vacuum_fits(db_path: &Path, size: u64, policy: &VacuumPolicy) -> bool {
    let needed = size.saturating_mul(2).saturating_add(policy.headroom_bytes);
    has_room(db_path, needed, policy)
}

/// [`finish_store_with`] under the default policy.
pub fn finish_store(conn: &Connection, db_path: &Path, store: &str) -> Result<FinishOutcome> {
    finish_store_with(conn, db_path, store, &VacuumPolicy::default())
}

/// Scrub plaintext freed by a migration (see the module docs). `conn` must not
/// be inside a transaction, `secure_delete` must be on (refused otherwise), and
/// no other connection to the store may be open: when the WAL cannot be
/// truncated the store is marked `vacuum_pending` (retried at the next start by
/// [`run_pending_vacuum`]) and the error is returned.
pub fn finish_store_with(
    conn: &Connection,
    db_path: &Path,
    store: &str,
    policy: &VacuumPolicy,
) -> Result<FinishOutcome> {
    require_secure_delete(conn)?;
    ensure_busy_timeout(conn)?;
    ensure_state_table(conn)?;
    let result = finish_store_inner(conn, db_path, store, policy);
    if result.is_err() {
        // Best effort: the original error is the one worth reporting.
        let _ = set_store_state(conn, store, states::VACUUM_PENDING, None);
    }
    result
}

fn finish_store_inner(
    conn: &Connection,
    db_path: &Path,
    store: &str,
    policy: &VacuumPolicy,
) -> Result<FinishOutcome> {
    checkpoint_truncate(conn)?;
    // A scrub recorded as finished is not repeated: every page freed since then
    // was freed with `secure_delete` on (required above), so it is zeroed
    // already. Callers that free plaintext otherwise go through
    // `mark_scrub_owed`, which forgets the finished scrub.
    let already_scrubbed = item_row(conn, store, STORE_ITEM)?.is_some_and(|(state, cursor)| {
        state == states::VACUUM_PENDING && PendingCursor::parse(cursor.as_deref()).scrubbed
    });
    let scrubbed = if already_scrubbed {
        Some(0)
    } else {
        scrub_freelist(conn, db_path, policy)?
    };
    let Some(scrubbed_pages) = scrubbed else {
        tracing::warn!(
            store = %store,
            "not enough free disk space to zero-fill freed pages; retried at a later start"
        );
        set_pending(conn, store, PendingCursor::default())?;
        return Ok(FinishOutcome {
            vacuum_pending: true,
            ..FinishOutcome::default()
        });
    };
    let size = store_size(db_path);
    let mut outcome = FinishOutcome {
        scrubbed_pages,
        ..FinishOutcome::default()
    };
    if size <= policy.vacuum_now_max_bytes && vacuum_fits(db_path, size, policy) {
        conn.execute_batch("VACUUM")
            .context("vacuuming the store")?;
        checkpoint_truncate(conn)?;
        set_store_state(conn, store, states::OK, None)?;
        outcome.vacuumed = true;
    } else {
        tracing::warn!(
            store = %store,
            bytes = size,
            "content store compaction deferred (size or free-space gate); free pages are \
             zero-filled, fragments of old plaintext may remain inside partly used pages until \
             it runs"
        );
        set_pending(
            conn,
            store,
            PendingCursor {
                scrubbed: true,
                last_attempt: None,
            },
        )?;
        outcome.vacuum_pending = true;
    }
    Ok(outcome)
}

/// At a store's start, before it serves requests and before other connections
/// open: finish the work the last [`finish_store`] deferred (or could not
/// confirm). The freelist scrub runs first unless it already finished, then
/// the `VACUUM` runs however large the store is (design: vacuum once, at the
/// next start), when the disk has room, at most once per day per store after a
/// free-space refusal. For owners that do not register a [`defer_compaction`]
/// job (satellite stores, Shadow, ...). An owner on the Core/Gateway boot path
/// that does register one calls [`run_pending_vacuum_gated`] instead. Returns
/// whether it vacuumed.
pub fn run_pending_vacuum(conn: &Connection, db_path: &Path, store: &str) -> Result<bool> {
    run_pending_vacuum_with(conn, db_path, store, &start_policy(false))
}

/// [`run_pending_vacuum`] for a boot path: the `VACUUM` runs only when the
/// store is at most `VACUUM_NOW_MAX_BYTES`. A larger store gets its freelist
/// scrub now and stays `vacuum_pending`; the caller must then hand its
/// compaction to [`defer_compaction`] (or run [`compact_deferred`] on its own
/// background thread), or the `VACUUM` never runs.
pub fn run_pending_vacuum_gated(conn: &Connection, db_path: &Path, store: &str) -> Result<bool> {
    run_pending_vacuum_with(conn, db_path, store, &start_policy(true))
}

/// The policy a start applies: size-gated only for owners that defer large
/// compactions ([`run_pending_vacuum_gated`]).
fn start_policy(gated: bool) -> VacuumPolicy {
    if gated {
        VacuumPolicy::default()
    } else {
        ungated_policy()
    }
}

fn ungated_policy() -> VacuumPolicy {
    VacuumPolicy {
        vacuum_now_max_bytes: u64::MAX,
        ..VacuumPolicy::default()
    }
}

/// Compact a store whose `VACUUM` is owed, however large (the same work as
/// [`run_pending_vacuum`]). For a background job holding the store's
/// connection lock (see [`defer_compaction`]), never for a boot path.
pub fn compact_deferred(conn: &Connection, db_path: &Path, store: &str) -> Result<bool> {
    run_pending_vacuum_with(conn, db_path, store, &ungated_policy())
}

/// Whether the store still owes its compaction (`vacuum_pending`).
pub fn compaction_owed(conn: &Connection, store: &str) -> Result<bool> {
    ensure_state_table(conn)?;
    Ok(
        item_row(conn, store, STORE_ITEM)?
            .is_some_and(|(state, _)| state == states::VACUUM_PENDING),
    )
}

/// [`run_pending_vacuum`] with explicit gates (tests, [`compact_deferred`]).
pub fn run_pending_vacuum_with(
    conn: &Connection,
    db_path: &Path,
    store: &str,
    policy: &VacuumPolicy,
) -> Result<bool> {
    ensure_state_table(conn)?;
    let Some((state, cursor)) = item_row(conn, store, STORE_ITEM)? else {
        return Ok(false);
    };
    if state != states::VACUUM_PENDING {
        return Ok(false);
    }
    let mut cursor = PendingCursor::parse(cursor.as_deref());
    let now = now_secs();
    if let Some(last) = cursor.last_attempt {
        if now - last < VACUUM_RETRY_SECS {
            return Ok(false);
        }
    }
    require_secure_delete(conn)?;
    ensure_busy_timeout(conn)?;
    checkpoint_truncate(conn)?;
    if !cursor.scrubbed {
        if scrub_freelist(conn, db_path, policy)?.is_none() {
            tracing::warn!(
                store = %store,
                "not enough free disk space to zero-fill freed pages; retrying tomorrow"
            );
            cursor.last_attempt = Some(now);
            set_pending(conn, store, cursor)?;
            return Ok(false);
        }
        cursor = PendingCursor {
            scrubbed: true,
            last_attempt: None,
        };
        set_pending(conn, store, cursor)?;
    }
    let size = store_size(db_path);
    if size > policy.vacuum_now_max_bytes {
        tracing::info!(
            store = %store,
            bytes = size,
            "content store compaction left to the background (free pages are zero-filled)"
        );
        return Ok(false);
    }
    if !vacuum_fits(db_path, size, policy) {
        tracing::warn!(store = %store, "not enough free disk space to compact the store; retrying tomorrow");
        cursor.last_attempt = Some(now);
        set_pending(conn, store, cursor)?;
        return Ok(false);
    }
    tracing::info!(store = %store, bytes = size, "compacting content store");
    conn.execute_batch("VACUUM")
        .context("vacuuming the store")?;
    checkpoint_truncate(conn)?;
    set_store_state(conn, store, states::OK, None)?;
    Ok(true)
}

/// A deferred compaction: runs [`compact_deferred`] under the store's own
/// connection lock. Returns `None` when the store is gone (dropped).
pub type CompactionJob = Box<dyn FnOnce() -> Option<Result<bool>> + Send>;

struct CompactionQueue {
    jobs: Vec<(String, CompactionJob)>,
    worker: bool,
    running: Option<String>,
}

static COMPACTIONS: std::sync::Mutex<CompactionQueue> = std::sync::Mutex::new(CompactionQueue {
    jobs: Vec::new(),
    worker: false,
    running: None,
});

fn compactions() -> std::sync::MutexGuard<'static, CompactionQueue> {
    COMPACTIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Queue the `VACUUM` of a store too large to compact while it opens. The job
/// runs on a background thread a couple of minutes later (after boot), one
/// store at a time; it must take the store's connection lock and call
/// [`compact_deferred`], so requests to that store wait for it instead of
/// failing. A failure keeps the store `vacuum_pending` for its next open.
pub fn defer_compaction(store: &str, job: CompactionJob) {
    let mut queue = compactions();
    queue.jobs.push((store.to_owned(), job));
    if queue.worker {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("ryu-compaction".into())
        .spawn(|| loop {
            std::thread::sleep(COMPACTION_DELAY);
            run_deferred_compactions();
            let mut queue = compactions();
            if queue.jobs.is_empty() {
                queue.worker = false;
                return;
            }
        });
    match spawned {
        Ok(_) => queue.worker = true,
        Err(error) => tracing::warn!("could not start the compaction worker: {error}"),
    }
}

/// Run every queued compaction now, on the calling thread (the worker, or a
/// maintenance action). Returns how many stores were vacuumed.
pub fn run_deferred_compactions() -> usize {
    let mut vacuumed = 0;
    loop {
        let next = {
            let mut queue = compactions();
            if queue.jobs.is_empty() {
                None
            } else {
                let (store, job) = queue.jobs.remove(0);
                queue.running = Some(store.clone());
                Some((store, job))
            }
        };
        let Some((store, job)) = next else {
            return vacuumed;
        };
        tracing::info!(store = %store, "compacting content store in the background");
        match job() {
            Some(Ok(true)) => vacuumed += 1,
            Some(Ok(false)) | None => {}
            Some(Err(error)) => {
                tracing::warn!(store = %store, "background compaction failed; retried at the next start: {error:#}")
            }
        }
        compactions().running = None;
    }
}

/// The store a background compaction is rewriting right now, if any (health).
pub fn compacting_store() -> Option<String> {
    compactions().running.clone()
}

/// Lends a store's connection to a deferred compaction: take the owner's lock
/// and call the closure with the connection (for a `tokio` mutex,
/// `|m, f| f(&m.blocking_lock())`; the job runs on a plain thread).
pub type WithConnection<L> = fn(&L, &mut dyn FnMut(&Connection));

/// [`defer_compaction`] for an owner that keeps its connection in `owner`
/// behind a lock: the job takes that lock through `with_conn` and runs
/// [`compact_deferred`], so requests to the store wait for it. Nothing is
/// queued when the store does not owe its compaction.
pub fn defer_compaction_with<L: Send + Sync + 'static>(
    store: &str,
    db_path: &Path,
    owner: &std::sync::Arc<L>,
    with_conn: WithConnection<L>,
) {
    defer_compaction(store, compaction_job_with(store, db_path, owner, with_conn));
}

fn compaction_job_with<L: Send + Sync + 'static>(
    store: &str,
    db_path: &Path,
    owner: &std::sync::Arc<L>,
    with_conn: WithConnection<L>,
) -> CompactionJob {
    let weak = std::sync::Arc::downgrade(owner);
    let path = db_path.to_path_buf();
    let store = store.to_owned();
    Box::new(move || {
        let owner = weak.upgrade()?;
        let mut outcome = None;
        with_conn(&owner, &mut |conn| {
            outcome = Some(compact_deferred(conn, &path, &store));
        });
        outcome
    })
}

/// How many sealed message bodies [`probe_sealed_messages`] reads from each
/// end of `messages`.
pub const PROBE_SAMPLES: usize = 3;

/// Phase-1 sealed message bodies (`enc:v1:`) of a `conversations.db`, read with
/// a plain read-only connection: the [`PROBE_SAMPLES`] newest rows first, then
/// the oldest. Empty when the database or table is missing.
///
/// The newest rows come first because they are sealed under the key the data
/// folder uses now: an older build could silently replace a lost key, leaving
/// the oldest bodies sealed under a key that no longer exists.
pub fn sealed_message_sample(db: &Path) -> Vec<String> {
    if !db.exists() {
        return Vec::new();
    }
    let Ok(conn) = Connection::open_with_flags(
        db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };
    let mut sample: Vec<(i64, String)> = Vec::new();
    for order in ["DESC", "ASC"] {
        let Ok(mut statement) = conn.prepare(&format!(
            "SELECT rowid, content FROM messages WHERE content LIKE 'enc:v1:%' \
             ORDER BY rowid {order} LIMIT {PROBE_SAMPLES}"
        )) else {
            return Vec::new();
        };
        let rows = match statement.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        }) {
            Ok(rows) => rows.flatten().collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        for row in rows {
            if !sample.iter().any(|(rowid, _)| *rowid == row.0) {
                sample.push(row);
            }
        }
    }
    sample.into_iter().map(|(_, content)| content).collect()
}

/// Probe a candidate master key against a `conversations.db`:
/// [`KeyProbe::Passed`](crate::KeyProbe::Passed) when any sampled sealed body
/// opens (see [`sealed_message_sample`]), `Failed` when bodies exist and none
/// opens, `NoSealedData` when there are none.
pub fn probe_sealed_messages(db: &Path, cipher: &crate::FieldCipher) -> crate::KeyProbe {
    let sample = sealed_message_sample(db);
    if sample.is_empty() {
        return crate::KeyProbe::NoSealedData;
    }
    if sample.iter().any(|stored| cipher.open(stored).is_ok()) {
        crate::KeyProbe::Passed
    } else {
        crate::KeyProbe::Failed
    }
}

/// Whether any database file under `dir` (non-recursive, `*.db`) records a
/// sealed store, and the key check values it records. Used by key custody to
/// refuse generating a new master key when sealed data exists.
pub fn recorded_store_kcvs(dir: &Path) -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("db") {
            continue;
        }
        let Ok(conn) = Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) else {
            continue;
        };
        let has_table: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![STATE_TABLE],
                |_| Ok(true),
            )
            .optional()
            .ok()
            .flatten()
            .unwrap_or(false);
        if !has_table {
            continue;
        }
        let Ok(mut statement) = conn.prepare(&format!(
            "SELECT store, kcv FROM {STATE_TABLE} WHERE item = ?1 AND kcv IS NOT NULL"
        )) else {
            continue;
        };
        let rows: Vec<(String, String)> = match statement.query_map(params![STORE_ITEM], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            Ok(rows) => rows.flatten().collect(),
            Err(_) => Vec::new(),
        };
        found.extend(rows);
    }
    found
}

/// Error helper for stores: the message a write path returns on a key mismatch.
pub fn mismatch_error(store: &str) -> anyhow::Error {
    anyhow!(
        "{store} is sealed under a different key than this process holds; writes are refused \
         to protect it (run `ryu-core keys status`)"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::KEY_LEN;

    fn cipher(n: u8) -> ContentCipher {
        ContentCipher::from_root(&[n; KEY_LEN], "notes.db")
    }

    fn setup(path: &Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT, data BLOB);
             CREATE TABLE events (seq INTEGER PRIMARY KEY, payload TEXT);",
        )
        .unwrap();
        conn
    }

    fn plans() -> Vec<ColumnPlan> {
        vec![
            ColumnPlan::text("notes", "body", "id", KeyKind::Text).unwrap(),
            ColumnPlan::blob("notes", "data", "id", KeyKind::Text).unwrap(),
            ColumnPlan::text("events", "payload", "seq", KeyKind::Integer).unwrap(),
        ]
    }

    #[test]
    fn plans_refuse_implicit_rowids_and_bad_identifiers() {
        for key in ["rowid", "ROWID", "_rowid_", "oid"] {
            assert!(ColumnPlan::text("t", "c", key, KeyKind::Integer).is_err());
        }
        assert!(ColumnPlan::text("t; DROP", "c", "id", KeyKind::Text).is_err());
    }

    #[test]
    fn migration_strips_the_compat_escape_before_sealing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.db");
        let mut conn = setup(&path);
        enable_secure_delete(&conn).unwrap();
        // A keyless satellite stored an envelope-lookalike as `encb:raw:<value>`.
        conn.execute(
            "INSERT INTO notes (id, body) VALUES ('n1', ?1)",
            params![format!("{COMPAT_ESCAPE}encb:v1:hello")],
        )
        .unwrap();
        let c = cipher(1);
        let plan = [ColumnPlan::text("notes", "body", "id", KeyKind::Text).unwrap()];
        let run = migrate_columns(&mut conn, &c, &plan).unwrap();
        assert_eq!(run.sealed, 1);
        assert_eq!(run.unreadable, 0);
        let body: String = conn
            .query_row("SELECT body FROM notes WHERE id = 'n1'", [], |r| r.get(0))
            .unwrap();
        let opened = c
            .open_text(&body, &ContentContext::new("notes.body").with("id", "n1"))
            .unwrap();
        assert_eq!(opened.value, "encb:v1:hello");
    }

    #[test]
    fn migration_seals_legacy_values_once_and_a_second_run_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.db");
        let mut conn = setup(&path);
        enable_secure_delete(&conn).unwrap();
        for i in 0..1200 {
            conn.execute(
                "INSERT INTO notes (id, body, data) VALUES (?1, ?2, ?3)",
                params![
                    format!("n{i:05}"),
                    format!("plaintext body {i}"),
                    vec![1u8, 2, 3, i as u8]
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO events (seq, payload) VALUES (?1, ?2)",
                params![i, format!("event {i}")],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO notes (id, body, data) VALUES ('null', NULL, NULL)",
            [],
        )
        .unwrap();
        let c = cipher(1);
        let first = migrate_columns(&mut conn, &c, &plans()).unwrap();
        assert_eq!(first.sealed, 3600);
        assert_eq!(first.unreadable, 0);
        assert_all_open(&conn, &c, &plans()).unwrap();
        let snapshot: Vec<(String, String)> = conn
            .prepare("SELECT id, body FROM notes WHERE body IS NOT NULL ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        // Second run: items are finished.
        let second = migrate_columns(&mut conn, &c, &plans()).unwrap();
        assert_eq!(second.sealed, 0);
        assert_eq!(second.finished_items, 3);
        // Even a forced walk seals nothing new (TEXT and BLOB).
        reset_items(&conn, c.store(), &plans()).unwrap();
        let forced = migrate_columns(&mut conn, &c, &plans()).unwrap();
        assert_eq!(forced.sealed, 0);
        assert_eq!(forced.already_sealed, 3600 + 2);
        let after: Vec<(String, String)> = conn
            .prepare("SELECT id, body FROM notes WHERE body IS NOT NULL ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(snapshot, after, "sealed values are never rewritten");
        // Values are bound to their row.
        let body: String = conn
            .query_row("SELECT body FROM notes WHERE id = 'n00001'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            c.open_text(
                &body,
                &ContentContext::new("notes.body").with("id", "n00001")
            )
            .unwrap()
            .value,
            "plaintext body 1"
        );
        assert!(c
            .open_text(
                &body,
                &ContentContext::new("notes.body").with("id", "n00002")
            )
            .is_err());
        // Raw plaintext is gone from the db and the WAL after finish_store.
        finish_store(&conn, &path, c.store()).unwrap();
        for file in ["notes.db", "notes.db-wal"] {
            let bytes = std::fs::read(dir.path().join(file)).unwrap_or_default();
            assert!(
                !bytes.windows(15).any(|w| w == b"plaintext body "),
                "{file} still holds plaintext"
            );
            assert!(!bytes.windows(6).any(|w| w == b"event "), "{file}");
        }
    }

    #[test]
    fn unreadable_values_are_counted_and_left_alone_and_races_are_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = setup(&dir.path().join("notes.db"));
        enable_secure_delete(&conn).unwrap();
        let foreign = cipher(9)
            .seal_text("x", &ContentContext::new("notes.body").with("id", "a"))
            .unwrap();
        conn.execute(
            "INSERT INTO notes (id, body) VALUES ('a', ?1)",
            params![foreign],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes (id, body) VALUES ('b', 'encb:v1:legacy-looking')",
            [],
        )
        .unwrap();
        let report = migrate_columns(&mut conn, &cipher(1), &plans()[..1]).unwrap();
        assert_eq!(report.unreadable, 2);
        let stored: String = conn
            .query_row("SELECT body FROM notes WHERE id = 'a'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, foreign);
        // The CAS refuses to overwrite a value that changed after it was read.
        let changed = conn
            .execute(
                "UPDATE notes SET body = 'new' WHERE id = 'a' AND body IS 'old'",
                [],
            )
            .unwrap();
        assert_eq!(changed, 0);
    }

    #[test]
    fn a_resumed_migration_continues_from_its_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = setup(&dir.path().join("notes.db"));
        enable_secure_delete(&conn).unwrap();
        for i in 0..10 {
            conn.execute(
                "INSERT INTO events (seq, payload) VALUES (?1, ?2)",
                params![i, format!("e{i}")],
            )
            .unwrap();
        }
        ensure_state_table(&conn).unwrap();
        // Simulate a crash after seq 4: items up to 4 were sealed.
        let c = cipher(1);
        for i in 0..=4 {
            let ctx = ContentContext::new("events.payload").with("id", i.to_string());
            let sealed = c.seal_text(&format!("e{i}"), &ctx).unwrap();
            conn.execute(
                "UPDATE events SET payload = ?1 WHERE seq = ?2",
                params![sealed, i],
            )
            .unwrap();
        }
        set_item(
            &conn,
            c.store(),
            "events.payload",
            states::SEALING,
            Some("4"),
        )
        .unwrap();
        let report = migrate_columns(&mut conn, &c, &plans()[2..]).unwrap();
        assert_eq!(report.sealed, 5);
        assert_eq!(
            report.already_sealed, 0,
            "rows before the cursor are not re-read"
        );
        assert_all_open(&conn, &c, &plans()[2..]).unwrap();
    }

    #[test]
    fn retired_keys_are_resealed_under_the_current_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = setup(&dir.path().join("notes.db"));
        enable_secure_delete(&conn).unwrap();
        let old = cipher(1);
        let sealed = old
            .seal_text("kept", &ContentContext::new("notes.body").with("id", "a"))
            .unwrap();
        conn.execute(
            "INSERT INTO notes (id, body) VALUES ('a', ?1)",
            params![sealed],
        )
        .unwrap();
        assert_eq!(
            check_store_key(&conn, &old).unwrap(),
            StoreKeyState::Recorded
        );
        let current = cipher(2).with_retired_roots(&[[1; KEY_LEN]]);
        assert_eq!(
            check_store_key(&conn, &current).unwrap(),
            StoreKeyState::Retired
        );
        // The documented contract: reset, then migrate. No manual KCV write.
        reset_items(&conn, current.store(), &plans()[..1]).unwrap();
        let report = migrate_columns(&mut conn, &current, &plans()[..1]).unwrap();
        assert_eq!(report.sealed, 1);
        assert_eq!(
            check_store_key(&conn, &current).unwrap(),
            StoreKeyState::Current
        );
        assert_all_open(&conn, &cipher(2), &plans()[..1]).unwrap();
        // The next start finds nothing to do.
        let report = migrate_columns(&mut conn, &current, &plans()[..1]).unwrap();
        assert_eq!(report.finished_items, 1);
        assert_eq!(report.sealed, 0);
    }

    #[test]
    fn a_retired_store_with_unreadable_or_unfinished_items_keeps_its_retired_record() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = setup(&dir.path().join("notes.db"));
        enable_secure_delete(&conn).unwrap();
        let old = cipher(1);
        let context = |id: &str| ContentContext::new("notes.body").with("id", id.to_owned());
        let sealed = old.seal_text("kept", &context("a")).unwrap();
        // Sealed under a key neither cipher holds: does not open.
        let foreign = cipher(9).seal_text("lost", &context("b")).unwrap();
        for (id, value) in [("a", sealed), ("b", foreign)] {
            conn.execute(
                "INSERT INTO notes (id, body) VALUES (?1, ?2)",
                params![id, value],
            )
            .unwrap();
        }
        assert_eq!(
            check_store_key(&conn, &old).unwrap(),
            StoreKeyState::Recorded
        );
        let current = cipher(2).with_retired_roots(&[[1; KEY_LEN]]);
        reset_items(&conn, current.store(), &plans()[..1]).unwrap();
        let report = migrate_columns(&mut conn, &current, &plans()[..1]).unwrap();
        assert_eq!((report.sealed, report.unreadable), (1, 1));
        assert_eq!(
            check_store_key(&conn, &current).unwrap(),
            StoreKeyState::Retired
        );

        // Two items reset, migrated in separate calls: only the call that
        // finishes the last item moves the record.
        conn.execute("DELETE FROM notes WHERE id = 'b'", [])
            .unwrap();
        reset_items(&conn, current.store(), &plans()[..2]).unwrap();
        migrate_columns(&mut conn, &current, &plans()[..1]).unwrap();
        assert_eq!(
            check_store_key(&conn, &current).unwrap(),
            StoreKeyState::Retired
        );
        migrate_columns(&mut conn, &current, &plans()[1..2]).unwrap();
        assert_eq!(
            check_store_key(&conn, &current).unwrap(),
            StoreKeyState::Current
        );
    }

    #[test]
    fn a_store_sealed_under_an_unknown_key_is_a_mismatch_and_newer_formats_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let conn = setup(&dir.path().join("notes.db"));
        assert_eq!(
            check_store_key(&conn, &cipher(1)).unwrap(),
            StoreKeyState::Recorded
        );
        let state = check_store_key(&conn, &cipher(2)).unwrap();
        assert!(matches!(state, StoreKeyState::Mismatch { .. }));
        assert!(!state.writable());
        conn.execute(
            &format!("UPDATE {STATE_TABLE} SET min_reader = 99 WHERE item = '{STORE_ITEM}'"),
            [],
        )
        .unwrap();
        let error = check_store_key(&conn, &cipher(1)).unwrap_err();
        assert!(error.downcast_ref::<NewerStoreFormat>().is_some());
        let kcvs = recorded_store_kcvs(dir.path());
        assert_eq!(kcvs.len(), 1);
        assert_eq!(kcvs[0].1, cipher(1).kcv());
    }

    #[test]
    fn a_crash_before_finish_store_leaves_the_scrub_owed_and_the_next_start_runs_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.db");
        {
            let mut conn = setup(&path);
            // Plaintext freed before phase 2 (secure_delete off) stays on free pages.
            for i in 0..100 {
                conn.execute(
                    "INSERT INTO notes (id, body) VALUES (?1, ?2)",
                    params![
                        format!("gone{i}"),
                        format!("{}freed-secret-{i}", "pad ".repeat(3000))
                    ],
                )
                .unwrap();
            }
            conn.execute("DELETE FROM notes", []).unwrap();
            for i in 0..50 {
                conn.execute(
                    "INSERT INTO notes (id, body, data) VALUES (?1, ?2, ?3)",
                    params![
                        format!("n{i}"),
                        format!("plaintext body {i}"),
                        b"blob-plain".to_vec()
                    ],
                )
                .unwrap();
            }
            enable_secure_delete(&conn).unwrap();
            let c = cipher(1);
            assert_eq!(check_store_key(&conn, &c).unwrap(), StoreKeyState::Recorded);
            let report = migrate_columns(&mut conn, &c, &plans()[..2]).unwrap();
            assert_eq!(report.sealed, 100);
            // Killed here: finish_store never ran.
        }
        let conn = Connection::open(&path).unwrap();
        enable_secure_delete(&conn).unwrap();
        let record = read_store_record(&conn, "notes.db").unwrap().unwrap();
        assert_eq!(record.state, states::VACUUM_PENDING);
        assert_eq!(
            record.kcv.as_deref(),
            Some(cipher(1).kcv()),
            "the KCV is kept"
        );
        let ran = run_pending_vacuum_with(
            &conn,
            &path,
            "notes.db",
            &VacuumPolicy {
                vacuum_now_max_bytes: u64::MAX,
                headroom_bytes: 0,
                ..VacuumPolicy::default()
            },
        )
        .unwrap();
        assert!(ran);
        assert_eq!(
            read_store_record(&conn, "notes.db").unwrap().unwrap().state,
            states::OK
        );
        for file in ["notes.db", "notes.db-wal"] {
            let bytes = std::fs::read(dir.path().join(file)).unwrap_or_default();
            assert!(!bytes.windows(12).any(|w| w == b"freed-secret"), "{file}");
            assert!(
                !bytes.windows(15).any(|w| w == b"plaintext body "),
                "{file}"
            );
            assert!(!bytes.windows(10).any(|w| w == b"blob-plain"), "{file}");
        }
        // A later run with nothing left to seal does not reopen the debt.
        drop(conn);
        let mut conn = Connection::open(&path).unwrap();
        enable_secure_delete(&conn).unwrap();
        let again = migrate_columns(&mut conn, &cipher(1), &plans()[..2]).unwrap();
        assert_eq!(again.sealed, 0);
        assert_eq!(again.finished_items, 2);
        assert_eq!(
            read_store_record(&conn, "notes.db").unwrap().unwrap().state,
            states::OK
        );
    }

    #[test]
    fn migration_refuses_a_store_recorded_under_another_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = setup(&dir.path().join("notes.db"));
        enable_secure_delete(&conn).unwrap();
        conn.execute(
            "INSERT INTO notes (id, body) VALUES ('a', 'still plain')",
            [],
        )
        .unwrap();
        assert_eq!(
            check_store_key(&conn, &cipher(1)).unwrap(),
            StoreKeyState::Recorded
        );
        let error = migrate_columns(&mut conn, &cipher(2), &plans()[..1]).unwrap_err();
        assert!(error.to_string().contains("different key"), "{error}");
        let body: String = conn
            .query_row("SELECT body FROM notes WHERE id = 'a'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(body, "still plain");
        assert_eq!(item_state(&conn, "notes.db", "notes.body").unwrap(), None);
        assert_eq!(
            read_store_record(&conn, "notes.db").unwrap().unwrap().state,
            states::OK
        );
    }

    #[test]
    fn the_freelist_scrub_removes_deleted_plaintext_without_a_vacuum() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.db");
        let conn = setup(&path);
        // Plaintext deleted BEFORE secure_delete was on stays on free pages.
        // The values span overflow pages, which a delete frees whole; residue
        // inside partly used pages is what the (deferred) VACUUM removes.
        for i in 0..200 {
            conn.execute(
                "INSERT INTO notes (id, body) VALUES (?1, ?2)",
                params![
                    format!("x{i}"),
                    format!("{}leaked-secret-{i}", "pad ".repeat(3000))
                ],
            )
            .unwrap();
        }
        conn.execute("DELETE FROM notes", []).unwrap();
        checkpoint_truncate(&conn).unwrap();
        let raw = std::fs::read(&path).unwrap();
        assert!(
            raw.windows(13).any(|w| w == b"leaked-secret"),
            "precondition"
        );
        enable_secure_delete(&conn).unwrap();
        let policy = VacuumPolicy {
            vacuum_now_max_bytes: 0,
            headroom_bytes: 0,
            ..VacuumPolicy::default()
        };
        let outcome = finish_store_with(&conn, &path, "notes.db", &policy).unwrap();
        assert!(outcome.scrubbed_pages > 0);
        assert!(outcome.vacuum_pending);
        assert!(!outcome.vacuumed);
        let raw = std::fs::read(&path).unwrap();
        assert!(!raw.windows(13).any(|w| w == b"leaked-secret"));
        let record = read_store_record(&conn, "notes.db").unwrap().unwrap();
        assert_eq!(record.state, states::VACUUM_PENDING);
        // The deferred vacuum runs at the next start (gates permitting).
        let ran = run_pending_vacuum_with(
            &conn,
            &path,
            "notes.db",
            &VacuumPolicy {
                vacuum_now_max_bytes: u64::MAX,
                headroom_bytes: 0,
                ..VacuumPolicy::default()
            },
        )
        .unwrap();
        assert!(ran);
        assert_eq!(
            read_store_record(&conn, "notes.db").unwrap().unwrap().state,
            states::OK
        );
    }

    #[test]
    fn migrating_or_finishing_without_secure_delete_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.db");
        let mut conn = setup(&path);
        conn.execute("INSERT INTO notes (id, body) VALUES ('a', 'plain')", [])
            .unwrap();
        for mode in ["OFF", "FAST"] {
            conn.pragma_update(None, "secure_delete", mode).unwrap();
            let error = migrate_columns(&mut conn, &cipher(1), &plans()[..1]).unwrap_err();
            assert!(error.to_string().contains("secure_delete"), "{error}");
            assert!(finish_store(&conn, &path, "notes.db").is_err());
        }
        let body: String = conn
            .query_row("SELECT body FROM notes WHERE id = 'a'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(body, "plain", "nothing was migrated");
        enable_secure_delete(&conn).unwrap();
        assert_eq!(
            migrate_columns(&mut conn, &cipher(1), &plans()[..1])
                .unwrap()
                .sealed,
            1
        );
    }

    #[test]
    fn a_concurrent_writer_waits_for_migration_batches_and_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.db");
        let mut conn = setup(&path);
        enable_secure_delete(&conn).unwrap();
        const ROWS: usize = 3000;
        for i in 0..ROWS {
            conn.execute(
                "INSERT INTO notes (id, body) VALUES (?1, ?2)",
                params![format!("n{i:05}"), format!("plaintext body {i}")],
            )
            .unwrap();
        }
        let c = cipher(1);
        let start = Arc::new(std::sync::Barrier::new(2));
        let writer = {
            let path = path.clone();
            let start = Arc::clone(&start);
            let c = c.clone();
            std::thread::spawn(move || {
                let other = Connection::open(&path).unwrap();
                other
                    .busy_timeout(std::time::Duration::from_secs(10))
                    .unwrap();
                enable_secure_delete(&other).unwrap();
                start.wait();
                let mut written = Vec::new();
                for i in (0..ROWS).step_by(7) {
                    let id = format!("n{i:05}");
                    let value = format!("writer {i}");
                    if i % 2 == 0 {
                        // A sealing write path.
                        let ctx = ContentContext::new("notes.body").with("id", id.as_str());
                        let sealed = c.seal_text(&value, &ctx).unwrap();
                        other
                            .execute(
                                "UPDATE notes SET body = ?1 WHERE id = ?2",
                                params![sealed, id],
                            )
                            .unwrap();
                    } else {
                        // A legacy plaintext write.
                        other
                            .execute(
                                "UPDATE notes SET body = ?1 WHERE id = ?2",
                                params![value, id],
                            )
                            .unwrap();
                    }
                    other
                        .execute(
                            "INSERT INTO notes (id, body) VALUES (?1, ?2)",
                            params![format!("w{i:05}"), format!("inserted {i}")],
                        )
                        .unwrap();
                    written.push((id, value));
                }
                written
            })
        };
        start.wait();
        let first = migrate_columns(&mut conn, &c, &plans()[..1])
            .expect("a concurrent writer never fails a migration batch");
        let written = writer.join().unwrap();
        assert_eq!(first.unreadable, 0);
        // Rows the writer added behind the cursor are sealed by the next pass.
        reset_items(&conn, c.store(), &plans()[..1]).unwrap();
        migrate_columns(&mut conn, &c, &plans()[..1]).unwrap();
        assert_all_open(&conn, &c, &plans()[..1]).unwrap();
        for (id, value) in written {
            let body: String = conn
                .query_row("SELECT body FROM notes WHERE id = ?1", params![id], |r| {
                    r.get(0)
                })
                .unwrap();
            let ctx = ContentContext::new("notes.body").with("id", id.as_str());
            assert_eq!(c.open_text(&body, &ctx).unwrap().value, value, "{id}");
        }
    }

    #[test]
    fn a_reader_holding_the_store_open_leaves_it_vacuum_pending_not_clean() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.db");
        let mut conn = setup(&path);
        conn.busy_timeout(std::time::Duration::from_millis(100))
            .unwrap();
        enable_secure_delete(&conn).unwrap();
        for i in 0..50 {
            conn.execute(
                "INSERT INTO notes (id, body) VALUES (?1, ?2)",
                params![format!("n{i:03}"), format!("plaintext body {i}")],
            )
            .unwrap();
        }
        let c = cipher(1);
        let reader = Connection::open(&path).unwrap();
        reader.execute_batch("BEGIN").unwrap();
        let _: i64 = reader
            .query_row("SELECT count(*) FROM notes", [], |r| r.get(0))
            .unwrap();
        migrate_columns(&mut conn, &c, &plans()[..1]).unwrap();
        let error = finish_store(&conn, &path, c.store()).unwrap_err();
        assert!(error.to_string().contains("checkpoint"), "{error:#}");
        assert_eq!(
            read_store_record(&conn, c.store()).unwrap().unwrap().state,
            states::VACUUM_PENDING
        );
        let wal = std::fs::metadata(dir.path().join("notes.db-wal")).unwrap();
        assert!(wal.len() > 0, "the WAL was not truncated");
        // Once the reader is gone, the next start finishes the job.
        reader.execute_batch("COMMIT").unwrap();
        drop(reader);
        let ran = run_pending_vacuum_with(
            &conn,
            &path,
            c.store(),
            &VacuumPolicy {
                vacuum_now_max_bytes: u64::MAX,
                headroom_bytes: 0,
                ..VacuumPolicy::default()
            },
        )
        .unwrap();
        assert!(ran);
        assert_eq!(
            read_store_record(&conn, c.store()).unwrap().unwrap().state,
            states::OK
        );
        for file in ["notes.db", "notes.db-wal"] {
            let bytes = std::fs::read(dir.path().join(file)).unwrap_or_default();
            assert!(
                !bytes.windows(15).any(|w| w == b"plaintext body "),
                "{file} still holds plaintext"
            );
        }
    }

    fn no_free_space(_: &Path) -> Option<u64> {
        Some(0)
    }

    fn ample_free_space(_: &Path) -> Option<u64> {
        Some(u64::MAX)
    }

    fn store_cursor(conn: &Connection, store: &str) -> Option<String> {
        item_row(conn, store, STORE_ITEM).unwrap().unwrap().1
    }

    /// Plaintext deleted before `secure_delete` was on, left on free pages.
    fn leak_on_free_pages(conn: &Connection) {
        for i in 0..200 {
            conn.execute(
                "INSERT INTO notes (id, body) VALUES (?1, ?2)",
                params![
                    format!("x{i}"),
                    format!("{}leaked-secret-{i}", "pad ".repeat(3000))
                ],
            )
            .unwrap();
        }
        conn.execute("DELETE FROM notes", []).unwrap();
        checkpoint_truncate(conn).unwrap();
    }

    fn holds(path: &Path, needle: &[u8]) -> bool {
        std::fs::read(path)
            .unwrap_or_default()
            .windows(needle.len())
            .any(|w| w == needle)
    }

    #[test]
    fn the_scrub_waits_for_free_space_and_is_not_repeated_once_done() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.db");
        let wal = dir.path().join("notes.db-wal");
        let conn = setup(&path);
        leak_on_free_pages(&conn);
        enable_secure_delete(&conn).unwrap();
        // No room for one chunk: nothing is written, the store stays owed.
        let full = VacuumPolicy {
            vacuum_now_max_bytes: u64::MAX,
            headroom_bytes: 0,
            free_space: no_free_space,
        };
        let outcome = finish_store_with(&conn, &path, "notes.db", &full).unwrap();
        assert_eq!(outcome.scrubbed_pages, 0);
        assert!(outcome.vacuum_pending && !outcome.vacuumed);
        assert!(holds(&path, b"leaked-secret"), "nothing was scrubbed");
        // Only the state row was written; no zero fill reached the WAL.
        assert!(std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0) < 64 * 1024);
        let scratch: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = ?1",
                params![SCRUB_TABLE],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(scratch, 0, "the scratch table never outlives the scrub");
        assert_eq!(store_cursor(&conn, "notes.db"), None);
        // With room, a later start scrubs; the store is too large to vacuum at
        // open, so the scrub is recorded and only the VACUUM stays owed.
        let gated = VacuumPolicy {
            vacuum_now_max_bytes: 0,
            headroom_bytes: 0,
            free_space: ample_free_space,
        };
        assert!(!run_pending_vacuum_with(&conn, &path, "notes.db", &gated).unwrap());
        assert!(!holds(&path, b"leaked-secret"));
        // Only the state row was written; no zero fill reached the WAL.
        assert!(std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0) < 64 * 1024);
        assert_eq!(
            store_cursor(&conn, "notes.db").as_deref(),
            Some(SCRUBBED_CURSOR)
        );
        assert!(compaction_owed(&conn, "notes.db").unwrap());
        // The next start does not repeat the fill: a probe reporting a full disk
        // would make a scrub give up and stamp a retry time.
        let gated_full = VacuumPolicy {
            free_space: no_free_space,
            ..gated
        };
        assert!(!run_pending_vacuum_with(&conn, &path, "notes.db", &gated_full).unwrap());
        assert_eq!(
            store_cursor(&conn, "notes.db").as_deref(),
            Some(SCRUBBED_CURSOR)
        );
        // New plaintext debt forgets the finished scrub.
        mark_scrub_owed(&conn, "notes.db").unwrap();
        assert_eq!(store_cursor(&conn, "notes.db"), None);
    }

    #[test]
    fn large_stores_are_not_vacuumed_at_open_but_by_the_background_compaction() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.db");
        let conn = setup(&path);
        leak_on_free_pages(&conn);
        enable_secure_delete(&conn).unwrap();
        ensure_state_table(&conn).unwrap();
        mark_scrub_owed(&conn, "notes.db").unwrap();
        let small_gate = VacuumPolicy {
            vacuum_now_max_bytes: 1,
            headroom_bytes: 0,
            free_space: ample_free_space,
        };
        assert!(!run_pending_vacuum_with(&conn, &path, "notes.db", &small_gate).unwrap());
        assert!(compaction_owed(&conn, "notes.db").unwrap());
        let conn = Arc::new(std::sync::Mutex::new(conn));
        let weak = Arc::downgrade(&conn);
        let job_path = path.clone();
        defer_compaction(
            "notes.db",
            Box::new(move || {
                let conn = weak.upgrade()?;
                let conn = conn.lock().unwrap();
                // `compact_deferred` with a probe that does not depend on
                // this machine's free disk space.
                let unbounded = VacuumPolicy {
                    vacuum_now_max_bytes: u64::MAX,
                    headroom_bytes: 0,
                    free_space: ample_free_space,
                };
                Some(run_pending_vacuum_with(
                    &conn, &job_path, "notes.db", &unbounded,
                ))
            }),
        );
        assert_eq!(run_deferred_compactions(), 1);
        assert_eq!(compacting_store(), None);
        let conn = conn.lock().unwrap();
        assert!(!compaction_owed(&conn, "notes.db").unwrap());
        assert_eq!(
            read_store_record(&conn, "notes.db").unwrap().unwrap().state,
            states::OK
        );
    }

    #[test]
    fn a_compaction_job_runs_under_the_owners_lock_and_skips_a_dropped_store() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static LOCKED: AtomicUsize = AtomicUsize::new(0);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.db");
        let conn = setup(&path);
        enable_secure_delete(&conn).unwrap();
        ensure_state_table(&conn).unwrap();
        let owner = Arc::new(std::sync::Mutex::new(conn));
        let with_conn: WithConnection<std::sync::Mutex<Connection>> = |owner, run| {
            LOCKED.fetch_add(1, Ordering::SeqCst);
            run(&*owner.lock().unwrap());
        };
        // Nothing owed: the job runs under the lock and reports no VACUUM.
        let job = compaction_job_with("notes.db", &path, &owner, with_conn);
        assert!(!job().unwrap().unwrap());
        assert_eq!(LOCKED.load(Ordering::SeqCst), 1);
        // The store was dropped before the worker got to it: nothing runs.
        let job = compaction_job_with("notes.db", &path, &owner, with_conn);
        drop(owner);
        assert!(job().is_none());
        assert_eq!(LOCKED.load(Ordering::SeqCst), 1);
    }

    /// Stores opened on Core's or the Gateway's boot path never call the
    /// ungated `run_pending_vacuum`: a multi-GB `VACUUM` there would hold the
    /// boot. They call `run_pending_vacuum_gated` and defer a larger store's
    /// compaction (`defer_compaction`, `defer_compaction_with`).
    #[test]
    fn boot_path_stores_never_call_the_ungated_start_vacuum() {
        fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if path.file_name().is_some_and(|name| name == "target") {
                        continue;
                    }
                    rust_files(&path, out);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    out.push(path);
                }
            }
        }
        let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let root = crate_dir.join("../../..");
        let mut files = Vec::new();
        for dir in [
            "apps/core/src",
            "apps/gateway/src",
            "crates/core",
            "crates/gateway",
        ] {
            rust_files(&root.join(dir), &mut files);
        }
        assert!(
            files.len() > 100,
            "the guard must see the Core sources (found {})",
            files.len()
        );
        let own = crate_dir.canonicalize().unwrap();
        let offenders: Vec<String> = files
            .iter()
            .filter(|path| !path.canonicalize().is_ok_and(|path| path.starts_with(&own)))
            .filter(|path| {
                std::fs::read_to_string(path).is_ok_and(|text| text.contains("run_pending_vacuum("))
            })
            .map(|path| path.display().to_string())
            .collect();
        assert!(
            offenders.is_empty(),
            "boot-path stores must call run_pending_vacuum_gated and defer large \
             compactions: {offenders:?}"
        );
    }

    #[test]
    fn a_store_over_the_gate_without_a_deferred_job_is_compacted_at_its_start() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.db");
        let conn = setup(&path);
        leak_on_free_pages(&conn);
        enable_secure_delete(&conn).unwrap();
        ensure_state_table(&conn).unwrap();
        mark_scrub_owed(&conn, "notes.db").unwrap();
        let size = store_size(&path);
        assert!(size > 1);
        // A boot-path owner's gate this store exceeds: only the scrub runs.
        let gated = VacuumPolicy {
            vacuum_now_max_bytes: size - 1,
            headroom_bytes: 0,
            free_space: ample_free_space,
        };
        assert!(!run_pending_vacuum_with(&conn, &path, "notes.db", &gated).unwrap());
        assert!(compaction_owed(&conn, "notes.db").unwrap());
        assert_eq!(
            start_policy(true).vacuum_now_max_bytes,
            VACUUM_NOW_MAX_BYTES
        );
        // An owner with no deferred job calls `run_pending_vacuum`, which has
        // no size gate: the store is compacted at this start, however large
        // (free space probe injected so the test does not depend on the disk).
        let ungated = VacuumPolicy {
            free_space: ample_free_space,
            ..start_policy(false)
        };
        assert_eq!(ungated.vacuum_now_max_bytes, u64::MAX);
        assert!(run_pending_vacuum_with(&conn, &path, "notes.db", &ungated).unwrap());
        assert!(!compaction_owed(&conn, "notes.db").unwrap());
        assert_eq!(
            read_store_record(&conn, "notes.db").unwrap().unwrap().state,
            states::OK
        );
        assert!(!holds(&path, b"leaked-secret"));
    }

    #[test]
    fn pending_cursors_round_trip() {
        for cursor in [
            PendingCursor::default(),
            PendingCursor {
                scrubbed: false,
                last_attempt: Some(42),
            },
            PendingCursor {
                scrubbed: true,
                last_attempt: None,
            },
            PendingCursor {
                scrubbed: true,
                last_attempt: Some(7),
            },
        ] {
            assert_eq!(PendingCursor::parse(cursor.encode().as_deref()), cursor);
        }
        // Rows written by earlier builds hold a bare timestamp.
        assert_eq!(
            PendingCursor::parse(Some("1700000000")).last_attempt,
            Some(1_700_000_000)
        );
    }
}
