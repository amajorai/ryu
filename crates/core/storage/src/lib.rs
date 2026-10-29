//! Plugin-owned key/value storage — the extracted `storage` primitive crate.
//!
//! Each plugin gets an isolated, namespaced KV space exposed **only** through the
//! plugin-host `storage` capability (gated by the `storage:kv` grant). This is
//! where a plugin keeps durable state instead of Core growing bespoke columns for
//! it — e.g. the goal plugin's per-conversation completion condition + turn count
//! live here (key = conversation id), not on the `conversations` table.
//!
//! Placement (Core vs Gateway): this stores *what a plugin is tracking* — it
//! decides what runs, not what is allowed — so it is Core-tier. Rows are
//! namespaced by `(plugin_id, namespace, key)` so one plugin can never read
//! another's state.
//!
//! This crate is a **pure** primitive: [`PluginStorage::open`] takes an explicit
//! db path, so the crate has ZERO dependency on `apps/core`. The single kernel
//! coupling — choosing the default `~/.ryu/plugin-storage.db` path — and the
//! process-global handle stay Core-side as wiring (`apps/core/src/plugin_storage`).
//!
//! Encryption at rest: every value is sealed (`encb:v1:`) under the
//! `plugin-storage.db` content key rooted at the owning plugin's subkey and bound
//! to `(plugin_id, namespace, key)` (see [`seal`]). `plugin_id`, `namespace`,
//! `key`, `updated_at` and the plaintext byte length `value_len` (the quota
//! counter) stay clear. Callers see plaintext: sealing happens inside this crate,
//! so the sandbox bridge, Companion UIs and Core's direct callers are unchanged.
//! A value an app already sealed itself (`encp:v1:`) is wrapped again and comes
//! back exactly as the app stored it. Legacy plaintext rows are sealed on open
//! (idempotent, resumable) and the freed pages scrubbed.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::content_sqlite::{self, states, StoreKeyState};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

pub mod seal;

use seal::value_context;
pub use seal::{PluginCipherResolver, StorageKeys, STORE};

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Bounds for the plugin-owned KV plane. Storage is a durable capability, so a
/// plugin must not be able to turn one grant into unbounded heap, SQLite, or
/// response growth. Byte limits count the plaintext a plugin stored, not the
/// sealed envelope.
pub const MAX_PLUGIN_ID_BYTES: usize = 256;
pub const MAX_NAMESPACE_BYTES: usize = 256;
pub const MAX_KEY_BYTES: usize = 512;
pub const MAX_VALUE_BYTES: usize = 1024 * 1024;
pub const MAX_PLUGIN_STORAGE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_PLUGIN_STORAGE_KEYS: u64 = 10_000;
pub const MAX_KEYS_RESPONSE: u64 = 10_000;

/// Rows per migration batch (each batch is one write transaction).
const MIGRATION_BATCH: i64 = 500;

/// The plaintext byte length of a row: `value_len`, or the stored length for a
/// row an older build wrote without it.
const VALUE_BYTES_SQL: &str = "COALESCE(value_len, length(CAST(value AS BLOB)))";

fn validate_component(name: &str, value: &str, max_bytes: usize) -> Result<()> {
    if value.is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        anyhow::bail!("{name} must be non-empty, control-free, and at most {max_bytes} bytes");
    }
    Ok(())
}

fn validate_plugin_id(plugin_id: &str) -> Result<()> {
    validate_component("plugin_id", plugin_id, MAX_PLUGIN_ID_BYTES)
}

fn validate_namespace(namespace: &str) -> Result<()> {
    validate_component("namespace", namespace, MAX_NAMESPACE_BYTES)
}

fn validate_key(key: &str) -> Result<()> {
    validate_component("key", key, MAX_KEY_BYTES)
}

fn validate_value(value: &str) -> Result<()> {
    if value.len() > MAX_VALUE_BYTES {
        anyhow::bail!("value exceeds the {MAX_VALUE_BYTES} byte limit");
    }
    Ok(())
}

/// What the open-time migration did (tests and logs).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MigrationReport {
    /// Rows sealed by this run.
    pub sealed: u64,
    /// Rows that did not open (left untouched).
    pub unreadable: u64,
}

/// One stored row as read for a copy (`rekey_plugin`, tenant migration).
struct RawRow {
    plugin_id: String,
    namespace: String,
    key: String,
    value: String,
    value_len: Option<i64>,
    updated_at: i64,
}

/// SQLite-backed per-plugin KV store. Cheap to clone (wraps `Arc`s).
#[derive(Clone)]
pub struct PluginStorage {
    conn: Arc<Mutex<Connection>>,
    keys: StorageKeys,
    writable: bool,
    unreadable: Arc<AtomicU64>,
}

impl PluginStorage {
    /// Open (or create) the store at a specific path and run migrations. The
    /// keys come from the process's crypto host (Core installs it at boot);
    /// without one the open fails closed.
    pub fn open(path: PathBuf) -> Result<Self> {
        Self::open_with_keys(path, StorageKeys::from_process()?)
    }

    /// [`Self::open`] under explicit keys (tests, tools).
    pub fn open_with_keys(path: PathBuf, keys: StorageKeys) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening plugin-storage db {}", path.display()))?;
        Self::from_connection(conn, Some(&path), keys)
    }

    /// In-memory store for tests (keys from the process, like [`Self::open`]).
    pub fn in_memory() -> Result<Self> {
        Self::in_memory_with_keys(StorageKeys::from_process()?)
    }

    /// In-memory store under explicit keys.
    pub fn in_memory_with_keys(keys: StorageKeys) -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory plugin-storage db")?;
        Self::from_connection(conn, None, keys)
    }

    fn from_connection(
        mut conn: Connection,
        path: Option<&Path>,
        keys: StorageKeys,
    ) -> Result<Self> {
        content_sqlite::enable_secure_delete(&conn)?;
        Self::init_schema(&conn)?;
        let key_state = content_sqlite::check_store_key(&conn, keys.store_cipher())
            .context("checking the plugin storage key")?;
        let writable = key_state.writable();
        let unreadable = Arc::new(AtomicU64::new(0));
        if writable {
            let retired = key_state == StoreKeyState::Retired;
            let report = Self::migrate_rows(&keys, &mut conn, retired)
                .context("sealing legacy plugin storage rows")?;
            if retired && report.unreadable == 0 {
                content_sqlite::record_store_kcv(&conn, STORE, keys.store_cipher().kcv())?;
            }
            if report.unreadable > 0 {
                tracing::warn!(
                    unreadable = report.unreadable,
                    "plugin storage: rows that do not open were left untouched"
                );
                unreadable.fetch_add(report.unreadable, Ordering::Relaxed);
            }
            if let Some(path) = path {
                // A failed scrub stays owed (`vacuum_pending`) and is retried at
                // the next start; it never blocks the store from serving.
                if report.sealed > 0 {
                    if let Err(error) = content_sqlite::finish_store(&conn, path, STORE) {
                        tracing::warn!("plugin storage: scrub deferred: {error:#}");
                    }
                } else if content_sqlite::read_store_record(&conn, STORE)?
                    .is_some_and(|record| record.state == states::VACUUM_PENDING)
                {
                    if let Err(error) = content_sqlite::run_pending_vacuum_gated(&conn, path, STORE)
                    {
                        tracing::warn!("plugin storage: compaction deferred: {error:#}");
                    }
                }
            }
        } else {
            tracing::error!(
                "plugin storage is sealed under a key this process does not hold; writes are \
                 refused and the data is left untouched"
            );
        }
        let compaction_owed = writable
            && path.is_some()
            && content_sqlite::compaction_owed(&conn, STORE).unwrap_or(false);
        let conn = Arc::new(Mutex::new(conn));
        if let (true, Some(path)) = (compaction_owed, path) {
            // Too large to compact while it opens: the background worker runs it
            // later under this store's lock.
            let weak = Arc::downgrade(&conn);
            let path = path.to_path_buf();
            content_sqlite::defer_compaction(
                STORE,
                Box::new(move || {
                    let conn = weak.upgrade()?;
                    let conn = conn.blocking_lock();
                    Some(content_sqlite::compact_deferred(&conn, &path, STORE))
                }),
            );
        }
        Ok(Self {
            conn,
            keys,
            writable,
            unreadable,
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS plugin_kv (
                 plugin_id  TEXT NOT NULL,
                 namespace  TEXT NOT NULL,
                 key        TEXT NOT NULL,
                 value      TEXT NOT NULL,
                 updated_at INTEGER NOT NULL,
                 value_len  INTEGER,
                 PRIMARY KEY (plugin_id, namespace, key)
             );",
        )
        .context("initializing plugin-storage schema")?;
        let has_len: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('plugin_kv') WHERE name = 'value_len'")?
            .exists([])?;
        if !has_len {
            conn.execute_batch("ALTER TABLE plugin_kv ADD COLUMN value_len INTEGER")
                .context("adding plugin_kv.value_len")?;
        }
        Ok(())
    }

    /// Seal every legacy row (and, after a key rotation, every row sealed under
    /// a retired key), recording each row's plaintext length. Cursor batches
    /// over the primary key, one write transaction each, compare-and-swap
    /// updates; idempotent (values that already open under the current key are
    /// never rewritten) and resumable (a crash leaves only finished batches).
    fn migrate_rows(
        keys: &StorageKeys,
        conn: &mut Connection,
        walk_all: bool,
    ) -> Result<MigrationReport> {
        let mut report = MigrationReport::default();
        // Candidates: rows without a recorded length or not carrying the
        // envelope. The prefix is only a candidate filter: every candidate is
        // opened, and only values whose open reports `needs_reseal` are sealed,
        // so a legacy value that merely starts with the prefix is counted as
        // unreadable, never sealed twice.
        let filter = if walk_all {
            ""
        } else {
            "AND (value_len IS NULL OR substr(value, 1, 8) <> 'encb:v1:')"
        };
        let select = format!(
            "SELECT plugin_id, namespace, key, value, value_len FROM plugin_kv
             WHERE (plugin_id, namespace, key) > (?1, ?2, ?3) {filter}
             ORDER BY plugin_id, namespace, key LIMIT {MIGRATION_BATCH}"
        );
        let mut cursor = (String::new(), String::new(), String::new());
        let mut scrub_marked = false;
        loop {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let batch: Vec<(String, String, String, String, Option<i64>)> = {
                let mut statement = tx.prepare(&select)?;
                let rows = statement.query_map(params![cursor.0, cursor.1, cursor.2], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for (plugin_id, namespace, key, value, value_len) in &batch {
                let cipher = keys.plugin(plugin_id)?;
                let context = value_context(plugin_id, namespace, key);
                let opened = match cipher.open_text(value, &context) {
                    Ok(opened) => opened,
                    Err(error) if ryu_crypto::content::is_content_seal_error(&error) => {
                        report.unreadable += 1;
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                let plain_len = opened.value.len() as i64;
                if !opened.needs_reseal {
                    if value_len.is_none() {
                        tx.execute(
                            "UPDATE plugin_kv SET value_len = ?4
                             WHERE plugin_id = ?1 AND namespace = ?2 AND key = ?3",
                            params![plugin_id, namespace, key, plain_len],
                        )?;
                    }
                    continue;
                }
                if !scrub_marked {
                    // Record the scrub debt before the first cell is rewritten,
                    // so a crash before `finish_store` leaves it owed.
                    tx.execute(
                        &format!(
                            "UPDATE {} SET state = ?3 WHERE store = ?1 AND item = ?2",
                            content_sqlite::STATE_TABLE
                        ),
                        params![STORE, content_sqlite::STORE_ITEM, states::VACUUM_PENDING],
                    )?;
                    scrub_marked = true;
                }
                let sealed = cipher.seal_text(&opened.value, &context)?;
                let changed = tx.execute(
                    "UPDATE plugin_kv SET value = ?4, value_len = ?5
                     WHERE plugin_id = ?1 AND namespace = ?2 AND key = ?3 AND value IS ?6",
                    params![plugin_id, namespace, key, sealed, plain_len, value],
                )?;
                report.sealed += changed as u64;
            }
            if let Some((plugin_id, namespace, key, _, _)) = batch.last() {
                cursor = (plugin_id.clone(), namespace.clone(), key.clone());
            }
            tx.commit()?;
            if (batch.len() as i64) < MIGRATION_BATCH {
                break;
            }
        }
        Ok(report)
    }

    /// Rows skipped or refused because their sealed value did not open (since
    /// this process opened the store). Surfaced as a health item.
    pub fn unreadable_rows(&self) -> u64 {
        self.unreadable.load(Ordering::Relaxed)
    }

    /// False when the store was sealed under a key this process does not hold:
    /// writes are refused and the data is left untouched.
    pub fn writable(&self) -> bool {
        self.writable
    }

    fn ensure_writable(&self) -> Result<()> {
        if self.writable {
            Ok(())
        } else {
            Err(content_sqlite::mismatch_error(STORE))
        }
    }

    /// Open one stored value. A value that does not open is an error (counted).
    fn open_value(
        &self,
        plugin_id: &str,
        namespace: &str,
        key: &str,
        stored: &str,
    ) -> Result<String> {
        let cipher = self.keys.plugin(plugin_id)?;
        match cipher.open_text(stored, &value_context(plugin_id, namespace, key)) {
            Ok(opened) => Ok(opened.value),
            Err(error) => {
                if ryu_crypto::content::is_content_seal_error(&error) {
                    self.unreadable.fetch_add(1, Ordering::Relaxed);
                }
                Err(error.context(format!(
                    "plugin storage value {namespace}/{key} of {plugin_id} does not open"
                )))
            }
        }
    }

    fn seal_value(
        &self,
        plugin_id: &str,
        namespace: &str,
        key: &str,
        value: &str,
    ) -> Result<String> {
        self.ensure_writable()?;
        self.keys
            .plugin(plugin_id)?
            .seal_text(value, &value_context(plugin_id, namespace, key))
    }

    /// Read a value. `Ok(None)` when the key is unset; an error when the stored
    /// value does not open (never an empty value).
    pub async fn get(&self, plugin_id: &str, namespace: &str, key: &str) -> Result<Option<String>> {
        validate_plugin_id(plugin_id)?;
        validate_namespace(namespace)?;
        validate_key(key)?;
        let stored = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT value FROM plugin_kv WHERE plugin_id = ?1 AND namespace = ?2 AND key = ?3",
                params![plugin_id, namespace, key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading plugin_kv")?
        };
        stored
            .map(|stored| self.open_value(plugin_id, namespace, key, &stored))
            .transpose()
    }

    /// Count and byte quota check for writing `value_len` bytes to a row whose
    /// current plaintext length is `existing` (`None` when the row is absent).
    fn check_quota(
        conn: &Connection,
        plugin_id: &str,
        existing: Option<i64>,
        value_len: usize,
    ) -> Result<()> {
        let (count, bytes): (i64, i64) = conn.query_row(
            &format!(
                "SELECT COUNT(*), COALESCE(SUM({VALUE_BYTES_SQL}), 0)
                 FROM plugin_kv WHERE plugin_id = ?1"
            ),
            params![plugin_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if existing.is_none() && count as u64 >= MAX_PLUGIN_STORAGE_KEYS {
            anyhow::bail!("plugin storage exceeds the {MAX_PLUGIN_STORAGE_KEYS} key limit");
        }
        let retained_bytes =
            (bytes.max(0) as u64).saturating_sub(existing.unwrap_or(0).max(0) as u64);
        if retained_bytes.saturating_add(value_len as u64) > MAX_PLUGIN_STORAGE_BYTES {
            anyhow::bail!("plugin storage exceeds the {MAX_PLUGIN_STORAGE_BYTES} byte limit");
        }
        Ok(())
    }

    fn upsert(
        conn: &Connection,
        plugin_id: &str,
        namespace: &str,
        key: &str,
        sealed: &str,
        value_len: usize,
    ) -> Result<()> {
        conn.execute(
            "INSERT INTO plugin_kv (plugin_id, namespace, key, value, updated_at, value_len)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(plugin_id, namespace, key)
             DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
                value_len = excluded.value_len",
            params![
                plugin_id,
                namespace,
                key,
                sealed,
                now_millis(),
                value_len as i64
            ],
        )?;
        Ok(())
    }

    /// Upsert a value.
    pub async fn set(
        &self,
        plugin_id: &str,
        namespace: &str,
        key: &str,
        value: &str,
    ) -> Result<()> {
        validate_plugin_id(plugin_id)?;
        validate_namespace(namespace)?;
        validate_key(key)?;
        validate_value(value)?;
        let sealed = self.seal_value(plugin_id, namespace, key, value)?;
        let conn = self.conn.lock().await;
        let existing: Option<i64> = conn
            .query_row(
                &format!(
                    "SELECT {VALUE_BYTES_SQL} FROM plugin_kv
                     WHERE plugin_id = ?1 AND namespace = ?2 AND key = ?3"
                ),
                params![plugin_id, namespace, key],
                |row| row.get(0),
            )
            .optional()?;
        Self::check_quota(&conn, plugin_id, existing, value.len())?;
        // The compare-and-set path reports the raw SQLite error, as before.
        Self::upsert(&conn, plugin_id, namespace, key, &sealed, value.len())
            .context("writing plugin_kv")
    }

    /// Atomically replace a value only when it still equals `expected`.
    /// `None` means the key must be absent; a `None` replacement deletes it.
    /// The connection mutex is held across the read and write so concurrent
    /// plugin-host calls cannot lose a read-modify-write update. The comparison
    /// is on the opened plaintext; a current value that does not open is an
    /// error, never a mismatch that a write could paper over.
    pub async fn compare_and_set(
        &self,
        plugin_id: &str,
        namespace: &str,
        key: &str,
        expected: Option<&str>,
        value: Option<&str>,
    ) -> Result<bool> {
        validate_plugin_id(plugin_id)?;
        validate_namespace(namespace)?;
        validate_key(key)?;
        if let Some(value) = value {
            validate_value(value)?;
        }
        self.ensure_writable()?;
        let sealed = value
            .map(|value| self.seal_value(plugin_id, namespace, key, value))
            .transpose()?;
        let conn = self.conn.lock().await;
        let stored = conn
            .query_row(
                "SELECT value FROM plugin_kv WHERE plugin_id = ?1 AND namespace = ?2 AND key = ?3",
                params![plugin_id, namespace, key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading plugin_kv for compare_and_set")?;
        let current = stored
            .map(|stored| self.open_value(plugin_id, namespace, key, &stored))
            .transpose()?;
        if current.as_deref() != expected {
            return Ok(false);
        }
        match (value, sealed) {
            (Some(value), Some(sealed)) => {
                let existing = current.as_deref().map(|c| c.len() as i64);
                Self::check_quota(&conn, plugin_id, existing, value.len())?;
                Self::upsert(&conn, plugin_id, namespace, key, &sealed, value.len())?;
            }
            _ => {
                conn.execute(
                    "DELETE FROM plugin_kv WHERE plugin_id = ?1 AND namespace = ?2 AND key = ?3",
                    params![plugin_id, namespace, key],
                )?;
            }
        }
        Ok(true)
    }

    /// Re-seal `row` for a new `(plugin_id, namespace)`: open with the old
    /// context, seal with the new one. `None` when the old value does not open.
    fn reseal_for(&self, row: &RawRow, plugin_id: &str, namespace: &str) -> Result<Option<String>> {
        let old = self.keys.plugin(&row.plugin_id)?;
        let opened = match old.open_text(
            &row.value,
            &value_context(&row.plugin_id, &row.namespace, &row.key),
        ) {
            Ok(opened) => opened.value,
            Err(error) if ryu_crypto::content::is_content_seal_error(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let new = self.keys.plugin(plugin_id)?;
        Ok(Some(new.seal_text(
            &opened,
            &value_context(plugin_id, namespace, &row.key),
        )?))
    }

    fn select_rows(conn: &Connection, sql: &str, param: &str) -> Result<Vec<RawRow>> {
        let mut statement = conn.prepare(sql)?;
        let rows = statement.query_map(params![param], |row| {
            Ok(RawRow {
                plugin_id: row.get(0)?,
                namespace: row.get(1)?,
                key: row.get(2)?,
                value: row.get(3)?,
                value_len: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Copy `rows` to `(target plugin, target namespace)` re-sealed for their new
    /// place (`INSERT OR IGNORE`: an existing target row wins), then delete each
    /// source row that was copied or superseded. Rows that do not open stay
    /// where they are (counted), so nothing is lost silently. Returns the number
    /// of source rows removed.
    fn move_rows(
        &self,
        conn: &Connection,
        rows: &[RawRow],
        target: impl Fn(&RawRow) -> (String, String),
    ) -> Result<usize> {
        let transaction = conn.unchecked_transaction()?;
        let mut removed = 0;
        let mut unreadable = 0u64;
        for row in rows {
            let (plugin_id, namespace) = target(row);
            let Some(sealed) = self.reseal_for(row, &plugin_id, &namespace)? else {
                unreadable += 1;
                continue;
            };
            transaction.execute(
                "INSERT OR IGNORE INTO plugin_kv
                     (plugin_id, namespace, key, value, updated_at, value_len)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    plugin_id,
                    namespace,
                    row.key,
                    sealed,
                    row.updated_at,
                    row.value_len
                ],
            )?;
            removed += transaction.execute(
                "DELETE FROM plugin_kv WHERE plugin_id = ?1 AND namespace = ?2 AND key = ?3",
                params![row.plugin_id, row.namespace, row.key],
            )?;
        }
        transaction.commit()?;
        if unreadable > 0 {
            self.unreadable.fetch_add(unreadable, Ordering::Relaxed);
            tracing::warn!(
                unreadable,
                "plugin storage: rows that do not open were left in place"
            );
        }
        Ok(removed)
    }

    /// Move legacy unscoped namespaces into one authenticated user's tenant.
    /// Rows already carrying a tenant prefix win on a rerun, so a failed schema
    /// version write cannot duplicate or overwrite newer state. Each moved value
    /// is re-sealed for its new namespace.
    pub async fn migrate_legacy_namespaces(&self, tenant: &str) -> Result<usize> {
        let tenant = tenant.trim();
        if tenant.is_empty() {
            return Ok(0);
        }
        validate_component("tenant", tenant, MAX_NAMESPACE_BYTES)?;
        self.ensure_writable()?;
        let prefix = format!("tenant:{tenant}:");
        let conn = self.conn.lock().await;
        let rows = Self::select_rows(
            &conn,
            "SELECT plugin_id, namespace, key, value, value_len, updated_at FROM plugin_kv
             WHERE namespace NOT LIKE ?1",
            "tenant:%",
        )?;
        self.move_rows(&conn, &rows, |row| {
            (row.plugin_id.clone(), format!("{prefix}{}", row.namespace))
        })
    }

    /// Delete a value (no-op if absent).
    pub async fn delete(&self, plugin_id: &str, namespace: &str, key: &str) -> Result<()> {
        validate_plugin_id(plugin_id)?;
        validate_namespace(namespace)?;
        validate_key(key)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM plugin_kv WHERE plugin_id = ?1 AND namespace = ?2 AND key = ?3",
            params![plugin_id, namespace, key],
        )
        .context("deleting plugin_kv")?;
        Ok(())
    }

    /// Move every row owned by `from` to `to` — the plugin-id rename migration.
    ///
    /// The KV is keyed `(plugin_id, namespace, key)`, so a plugin whose id changes
    /// would otherwise silently lose all of its state: a goal plugin's active
    /// conditions, the learning log, anything a hook stashed. The rows are still
    /// there, just unreachable under the new id, which reads to a user as data loss
    /// with no error anywhere.
    ///
    /// `INSERT OR IGNORE` + `DELETE` rather than `UPDATE`: if the new id already has
    /// a row at the same `(namespace, key)` — a re-run, or a fresh install that
    /// already wrote state — the NEW value wins and the stale legacy row is dropped.
    /// Each value is opened under `from`'s key and re-sealed under `to`'s (the
    /// key and the AAD both name the plugin).
    ///
    /// Returns the number of legacy rows removed.
    ///
    /// # Errors
    /// Returns `Err` if the SQLite transaction fails.
    pub async fn rekey_plugin(&self, from: &str, to: &str) -> Result<usize> {
        validate_plugin_id(from)?;
        validate_plugin_id(to)?;
        self.ensure_writable()?;
        let conn = self.conn.lock().await;
        let rows = Self::select_rows(
            &conn,
            "SELECT plugin_id, namespace, key, value, value_len, updated_at FROM plugin_kv
             WHERE plugin_id = ?1",
            from,
        )?;
        self.move_rows(&conn, &rows, |row| (to.to_owned(), row.namespace.clone()))
    }

    /// Return the number of records and value bytes owned by one plugin.
    ///
    /// The byte count intentionally measures stored values (their plaintext
    /// length), which is the useful number for the uninstall preview and does
    /// not expose another plugin's namespace or key names.
    pub async fn usage(&self, plugin_id: &str) -> Result<(u64, u64)> {
        validate_plugin_id(plugin_id)?;
        let conn = self.conn.lock().await;
        let (count, bytes): (i64, i64) = conn.query_row(
            &format!(
                "SELECT COUNT(*), COALESCE(SUM({VALUE_BYTES_SQL}), 0)
                 FROM plugin_kv WHERE plugin_id = ?1"
            ),
            params![plugin_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok((count.max(0) as u64, bytes.max(0) as u64))
    }

    /// Delete every record owned by one plugin. Returns the number of rows
    /// removed so callers can make the cleanup observable without reading keys.
    pub async fn delete_plugin(&self, plugin_id: &str) -> Result<usize> {
        validate_plugin_id(plugin_id)?;
        let conn = self.conn.lock().await;
        Ok(conn.execute(
            "DELETE FROM plugin_kv WHERE plugin_id = ?1",
            params![plugin_id],
        )?)
    }

    /// List the keys a plugin has set within a namespace (newest first).
    pub async fn keys(&self, plugin_id: &str, namespace: &str) -> Result<Vec<String>> {
        validate_plugin_id(plugin_id)?;
        validate_namespace(namespace)?;
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT key FROM plugin_kv WHERE plugin_id = ?1 AND namespace = ?2
                 ORDER BY updated_at DESC LIMIT ?3",
            )
            .context("preparing plugin_kv keys query")?;
        let rows = stmt
            .query_map(
                params![plugin_id, namespace, MAX_KEYS_RESPONSE as i64 + 1],
                |row| row.get::<_, String>(0),
            )
            .context("querying plugin_kv keys")?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.context("reading plugin_kv key row")?);
        }
        if out.len() as u64 > MAX_KEYS_RESPONSE {
            anyhow::bail!("plugin storage key listing exceeds the {MAX_KEYS_RESPONSE} item limit");
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn set_get_delete_roundtrip() {
        let s = PluginStorage::in_memory().unwrap();
        assert_eq!(s.get("p", "ns", "k").await.unwrap(), None);
        s.set("p", "ns", "k", "v1").await.unwrap();
        assert_eq!(s.get("p", "ns", "k").await.unwrap().as_deref(), Some("v1"));
        // Upsert overwrites.
        s.set("p", "ns", "k", "v2").await.unwrap();
        assert_eq!(s.get("p", "ns", "k").await.unwrap().as_deref(), Some("v2"));
        s.delete("p", "ns", "k").await.unwrap();
        assert_eq!(s.get("p", "ns", "k").await.unwrap(), None);
    }

    #[tokio::test]
    async fn compare_and_set_is_atomic_and_checks_absence() {
        let s = PluginStorage::in_memory().unwrap();
        assert!(s
            .compare_and_set("p", "ns", "k", None, Some("v1"))
            .await
            .unwrap());
        assert!(!s
            .compare_and_set("p", "ns", "k", None, Some("v2"))
            .await
            .unwrap());
        assert!(s
            .compare_and_set("p", "ns", "k", Some("v1"), Some("v2"))
            .await
            .unwrap());
        assert!(s
            .compare_and_set("p", "ns", "k", Some("v2"), None)
            .await
            .unwrap());
        assert_eq!(s.get("p", "ns", "k").await.unwrap(), None);
    }

    #[tokio::test]
    async fn migrates_legacy_namespaces_once_into_a_tenant() {
        let s = PluginStorage::in_memory().unwrap();
        s.set("p", "default", "k", "legacy").await.unwrap();
        s.set("p", "tenant:other:default", "k", "other")
            .await
            .unwrap();

        assert_eq!(s.migrate_legacy_namespaces("user-1").await.unwrap(), 1);
        assert_eq!(s.get("p", "default", "k").await.unwrap(), None);
        assert_eq!(
            s.get("p", "tenant:user-1:default", "k")
                .await
                .unwrap()
                .as_deref(),
            Some("legacy")
        );
        assert_eq!(s.migrate_legacy_namespaces("user-1").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn plugins_are_isolated_by_id_and_namespace() {
        let s = PluginStorage::in_memory().unwrap();
        s.set("plugin-a", "default", "shared", "a").await.unwrap();
        s.set("plugin-b", "default", "shared", "b").await.unwrap();
        // Same key, different plugin → isolated.
        assert_eq!(
            s.get("plugin-a", "default", "shared")
                .await
                .unwrap()
                .as_deref(),
            Some("a")
        );
        assert_eq!(
            s.get("plugin-b", "default", "shared")
                .await
                .unwrap()
                .as_deref(),
            Some("b")
        );
        // Same plugin, different namespace → isolated.
        s.set("plugin-a", "other", "shared", "a2").await.unwrap();
        assert_eq!(
            s.get("plugin-a", "default", "shared")
                .await
                .unwrap()
                .as_deref(),
            Some("a")
        );
    }

    #[tokio::test]
    async fn keys_lists_namespaced_keys() {
        let s = PluginStorage::in_memory().unwrap();
        s.set("p", "goals", "conv-1", "x").await.unwrap();
        s.set("p", "goals", "conv-2", "y").await.unwrap();
        s.set("p", "other", "conv-3", "z").await.unwrap();
        let mut keys = s.keys("p", "goals").await.unwrap();
        keys.sort();
        assert_eq!(keys, vec!["conv-1".to_string(), "conv-2".to_string()]);
    }

    #[tokio::test]
    async fn usage_and_delete_plugin_are_scoped() {
        let s = PluginStorage::in_memory().unwrap();
        s.set("p", "default", "one", "123").await.unwrap();
        s.set("p", "other", "two", "4567").await.unwrap();
        s.set("other", "default", "one", "outside").await.unwrap();

        assert_eq!(s.usage("p").await.unwrap(), (2, 7));
        assert_eq!(s.delete_plugin("p").await.unwrap(), 2);
        assert_eq!(s.usage("p").await.unwrap(), (0, 0));
        assert_eq!(
            s.get("other", "default", "one").await.unwrap().as_deref(),
            Some("outside")
        );
    }

    #[tokio::test]
    async fn storage_rejects_oversized_values_and_total_growth() {
        let s = PluginStorage::in_memory().unwrap();
        let oversized = "x".repeat(MAX_VALUE_BYTES + 1);
        assert!(s.set("p", "default", "too-big", &oversized).await.is_err());

        let full_value = "x".repeat(MAX_VALUE_BYTES);
        for index in 0..(MAX_PLUGIN_STORAGE_BYTES as usize / MAX_VALUE_BYTES) {
            s.set("p", "default", &format!("k-{index}"), &full_value)
                .await
                .unwrap();
        }
        assert!(
            s.set("p", "default", "one-more", "x").await.is_err(),
            "a plugin must not grow beyond its durable storage quota"
        );
    }

    #[tokio::test]
    async fn storage_rejects_controlled_identifiers() {
        let s = PluginStorage::in_memory().unwrap();
        assert!(s.set("p", "default", "bad\nkey", "v").await.is_err());
        assert!(s.get("p", "default", "bad\nkey").await.is_err());
    }

    // ── Encryption at rest ────────────────────────────────────────────────────

    use ryu_crypto::ContentCipher;

    /// Fixed test keys: a store cipher under `[root; 32]` and a distinct root
    /// per plugin id.
    fn test_keys(root: u8) -> StorageKeys {
        StorageKeys::new(
            ContentCipher::from_root(&[root; 32], STORE),
            Arc::new(move |plugin_id: &str| {
                let mut plugin_root = [root; 32];
                for (index, byte) in plugin_id.bytes().enumerate() {
                    plugin_root[index % 32] ^= byte.wrapping_add(index as u8);
                }
                Ok(ContentCipher::from_root(&plugin_root, STORE))
            }),
        )
    }

    fn file_contains(path: &Path, needle: &str) -> bool {
        std::fs::read(path)
            .map(|bytes| bytes.windows(needle.len()).any(|w| w == needle.as_bytes()))
            .unwrap_or(false)
    }

    fn raw_value(path: &Path, plugin_id: &str, namespace: &str, key: &str) -> Option<String> {
        let conn = Connection::open(path).unwrap();
        conn.query_row(
            "SELECT value FROM plugin_kv WHERE plugin_id = ?1 AND namespace = ?2 AND key = ?3",
            params![plugin_id, namespace, key],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    fn legacy_db(path: &Path, rows: &[(&str, &str, &str, &str)]) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE plugin_kv (
                 plugin_id  TEXT NOT NULL,
                 namespace  TEXT NOT NULL,
                 key        TEXT NOT NULL,
                 value      TEXT NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY (plugin_id, namespace, key)
             );",
        )
        .unwrap();
        for (plugin_id, namespace, key, value) in rows {
            conn.execute(
                "INSERT INTO plugin_kv VALUES (?1, ?2, ?3, ?4, 1)",
                params![plugin_id, namespace, key, value],
            )
            .unwrap();
        }
    }

    #[tokio::test]
    async fn values_are_sealed_on_disk_and_read_back_in_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plugin-storage.db");
        let s = PluginStorage::open_with_keys(path.clone(), test_keys(7)).unwrap();
        s.set(
            "@ryu/people",
            "default",
            "contact-1",
            "Ada Quillfeather, 555-0199",
        )
        .await
        .unwrap();
        assert!(s
            .compare_and_set("@ryu/recap", "conv", "c1", None, Some("cas-summary-marker"))
            .await
            .unwrap());
        assert!(raw_value(&path, "@ryu/people", "default", "contact-1")
            .unwrap()
            .starts_with("encb:v1:"));
        for file in [path.clone(), dir.path().join("plugin-storage.db-wal")] {
            assert!(!file_contains(&file, "Quillfeather"), "{}", file.display());
            assert!(
                !file_contains(&file, "cas-summary-marker"),
                "{}",
                file.display()
            );
        }
        assert_eq!(
            s.get("@ryu/people", "default", "contact-1")
                .await
                .unwrap()
                .as_deref(),
            Some("Ada Quillfeather, 555-0199")
        );
        // The quota counts the plaintext a plugin stored, not the envelope.
        assert_eq!(s.usage("@ryu/people").await.unwrap(), (1, 26));
    }

    #[tokio::test]
    async fn a_value_copied_to_another_row_or_plugin_does_not_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plugin-storage.db");
        let s = PluginStorage::open_with_keys(path.clone(), test_keys(7)).unwrap();
        s.set("p", "ns", "a", "alpha").await.unwrap();
        s.set("p", "ns", "b", "beta").await.unwrap();
        s.set("q", "ns", "a", "gamma").await.unwrap();
        let sealed = raw_value(&path, "p", "ns", "a").unwrap();
        {
            let conn = s.conn.lock().await;
            conn.execute(
                "UPDATE plugin_kv SET value = ?1 WHERE (plugin_id, key) IN (('p', 'b'), ('q', 'a'))",
                params![sealed],
            )
            .unwrap();
        }
        assert!(
            s.get("p", "ns", "b").await.is_err(),
            "a swapped row must not open"
        );
        assert!(
            s.get("q", "ns", "a").await.is_err(),
            "another plugin's value must not open"
        );
        assert!(s
            .compare_and_set("p", "ns", "b", Some("beta"), Some("x"))
            .await
            .is_err());
        assert_eq!(s.unreadable_rows(), 3);
        assert_eq!(
            s.get("p", "ns", "a").await.unwrap().as_deref(),
            Some("alpha")
        );
    }

    #[tokio::test]
    async fn legacy_plaintext_is_read_sealed_on_open_and_the_second_open_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plugin-storage.db");
        legacy_db(
            &path,
            &[
                ("@ryu/invoices", "default", "inv-1", "legacy-invoice-marker"),
                ("goal", "tenant:u:goals", "conv-9", "legacy-goal-marker"),
            ],
        );
        let s = PluginStorage::open_with_keys(path.clone(), test_keys(7)).unwrap();
        assert_eq!(
            s.get("@ryu/invoices", "default", "inv-1")
                .await
                .unwrap()
                .as_deref(),
            Some("legacy-invoice-marker")
        );
        assert_eq!(s.usage("goal").await.unwrap(), (1, 18));
        let first = raw_value(&path, "goal", "tenant:u:goals", "conv-9").unwrap();
        assert!(first.starts_with("encb:v1:"));
        drop(s);
        for file in [path.clone(), dir.path().join("plugin-storage.db-wal")] {
            assert!(
                !file_contains(&file, "legacy-invoice-marker"),
                "{}",
                file.display()
            );
            assert!(
                !file_contains(&file, "legacy-goal-marker"),
                "{}",
                file.display()
            );
        }
        let s = PluginStorage::open_with_keys(path.clone(), test_keys(7)).unwrap();
        assert_eq!(
            raw_value(&path, "goal", "tenant:u:goals", "conv-9").unwrap(),
            first
        );
        assert_eq!(
            s.get("goal", "tenant:u:goals", "conv-9")
                .await
                .unwrap()
                .as_deref(),
            Some("legacy-goal-marker")
        );
    }

    #[tokio::test]
    async fn an_app_sealed_value_is_wrapped_and_returned_unchanged() {
        let s = PluginStorage::in_memory_with_keys(test_keys(7)).unwrap();
        let app_sealed = "encp:v1:AAECAwQFBgcICQoL1nNMTWwoK3z4Hm2Ay9qBARr3Zp4hKiyv/g==";
        s.set("@ryu/life-recorder", "default", "r1", app_sealed)
            .await
            .unwrap();
        let stored: String = s
            .conn
            .lock()
            .await
            .query_row("SELECT value FROM plugin_kv", [], |row| row.get(0))
            .unwrap();
        assert!(stored.starts_with("encb:v1:"));
        assert_eq!(
            s.get("@ryu/life-recorder", "default", "r1")
                .await
                .unwrap()
                .as_deref(),
            Some(app_sealed)
        );
        assert!(s
            .compare_and_set(
                "@ryu/life-recorder",
                "default",
                "r1",
                Some(app_sealed),
                None
            )
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn rekey_and_tenant_moves_reseal_for_the_new_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plugin-storage.db");
        let s = PluginStorage::open_with_keys(path.clone(), test_keys(7)).unwrap();
        s.set("old-id", "default", "k", "moved-value")
            .await
            .unwrap();
        assert_eq!(s.rekey_plugin("old-id", "@ryu/new-id").await.unwrap(), 1);
        assert_eq!(
            s.get("@ryu/new-id", "default", "k")
                .await
                .unwrap()
                .as_deref(),
            Some("moved-value")
        );
        assert_eq!(s.migrate_legacy_namespaces("user-1").await.unwrap(), 1);
        assert_eq!(
            s.get("@ryu/new-id", "tenant:user-1:default", "k")
                .await
                .unwrap()
                .as_deref(),
            Some("moved-value")
        );
        assert_eq!(s.usage("@ryu/new-id").await.unwrap(), (1, 11));
        assert!(!file_contains(&path, "moved-value"));
        assert_eq!(s.unreadable_rows(), 0);
    }

    #[tokio::test]
    async fn a_row_that_does_not_open_is_kept_by_a_rekey() {
        let s = PluginStorage::in_memory_with_keys(test_keys(7)).unwrap();
        s.set("old-id", "default", "good", "fine").await.unwrap();
        s.conn
            .lock()
            .await
            .execute(
                "INSERT INTO plugin_kv VALUES ('old-id', 'default', 'bad', 'encb:v1:AAAA', 1, 4)",
                [],
            )
            .unwrap();
        assert_eq!(s.rekey_plugin("old-id", "new-id").await.unwrap(), 1);
        assert_eq!(s.unreadable_rows(), 1);
        let left: i64 = s
            .conn
            .lock()
            .await
            .query_row(
                "SELECT COUNT(*) FROM plugin_kv WHERE plugin_id = 'old-id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(left, 1, "the unreadable row is not dropped");
    }

    #[tokio::test]
    async fn a_store_sealed_under_another_key_refuses_writes_and_keeps_its_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plugin-storage.db");
        {
            let s = PluginStorage::open_with_keys(path.clone(), test_keys(7)).unwrap();
            s.set("p", "ns", "k", "kept").await.unwrap();
        }
        let before = raw_value(&path, "p", "ns", "k").unwrap();
        let s = PluginStorage::open_with_keys(path.clone(), test_keys(9)).unwrap();
        assert!(!s.writable());
        assert!(s.set("p", "ns", "other", "x").await.is_err());
        assert!(s.compare_and_set("p", "ns", "k", None, None).await.is_err());
        assert!(s.rekey_plugin("p", "q").await.is_err());
        assert_eq!(raw_value(&path, "p", "ns", "k").unwrap(), before);
    }
}
