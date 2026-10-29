//! Durable, windowed charged-spend counters.
//!
//! Every charge is added to one counter per [`BudgetWindow`] for its
//! `(scope, id)`: the current UTC day, ISO week, calendar month, and lifetime.
//! A cap then reads the counter for the window it is configured with. Because a
//! window is identified by its start instant, rolling over midnight (or a week,
//! or a month) needs no reset job — the next charge simply lands in a new row.
//!
//! [`MemorySpendStore`] keeps counters in process memory (tests and gateways
//! without an audit database). [`SqliteSpendStore`] mirrors the same in-memory
//! map onto a SQLite file next to `audit.db`: reads stay lock-free map lookups
//! on the request path, writes are queued to a background thread, and the file
//! is loaded back on start so spend survives a restart.
//!
//! ## At rest
//!
//! Subject ids (org, member, team, key, service-account, user and agent ids)
//! never reach `spend.db` in plaintext. The `id` column holds a `bi1:` blind
//! token (keyed HMAC, store [`SPEND_STORE`], field [`SUBJECT_FIELD`]) under the
//! Gateway component key, so every lookup stays an exact-match key; the
//! `subject` column holds the id sealed as `encb:v1:` (bound to its scope and
//! token), which lets a store sealed under a retired key be re-keyed. Scopes,
//! windows and amounts stay plaintext. The store records the component key's
//! check value in `ryu_content_seal`; a store sealed under a key this process
//! does not hold, or a keyless process meeting a store that was already
//! sealed, makes the store unhealthy ([`SpendStore::health`]): nothing is read
//! or written and callers refuse metered requests. It is never reset. Legacy
//! plaintext rows are rehashed in one transaction on open, then freed pages
//! are scrubbed.
//!
//! A process without the key that meets a store that was never sealed (no
//! recorded check value, no `bi1:` token) keeps counting by raw id, as a
//! pre-sealing Gateway did ([`SpendStore::sealing`] reports `no key`); the
//! first start that holds a key rehashes those rows.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use dashmap::DashMap;
use ryu_crypto::content_sqlite::{self, StoreKeyState};
use ryu_crypto::{BlindIndex, ContentCipher, ContentContext};

use crate::window::BudgetWindow;

/// Registered content-store name of the spend database (KDF input; never
/// rename it).
pub const SPEND_STORE: &str = "spend.db";
/// Blind-index field of the subject ids.
pub const SUBJECT_FIELD: &str = "subject";
/// Why a store sealed under another key refuses work.
pub const KEY_MISMATCH: &str = "budget store key mismatch";
/// Why a store refuses work in a process without the Gateway sealing key.
pub const KEY_UNAVAILABLE: &str = "budget store key unavailable";

/// The keys that protect `spend.db` subjects: the Gateway component key's
/// content cipher and blind index for [`SPEND_STORE`].
#[derive(Clone)]
pub struct SpendSeal {
    cipher: ContentCipher,
    tokens: BlindIndex,
}

impl SpendSeal {
    /// `cipher` must be the content cipher of [`SPEND_STORE`] and `tokens` the
    /// blind index of ([`SPEND_STORE`], [`SUBJECT_FIELD`]) under the same root.
    pub fn new(cipher: ContentCipher, tokens: BlindIndex) -> Self {
        Self { cipher, tokens }
    }

    /// The stored id of a subject: its blind token (ids are matched exactly,
    /// so no normalization).
    fn token(&self, id: &str) -> String {
        self.tokens.token(id)
    }

    fn subject_context(scope: &str, token: &str) -> ContentContext {
        ContentContext::new("spend_counters.subject")
            .with("scope", scope.to_owned())
            .with("id", token.to_owned())
    }

    fn seal_subject(&self, scope: &str, token: &str, id: &str) -> StoreResult<String> {
        Ok(self
            .cipher
            .seal_text(id, &Self::subject_context(scope, token))?)
    }

    fn open_subject(&self, scope: &str, token: &str, stored: &str) -> StoreResult<String> {
        if !ContentCipher::is_sealed_text(stored) {
            return Err("subject is not sealed".into());
        }
        Ok(self
            .cipher
            .open_text(stored, &Self::subject_context(scope, token))?
            .value)
    }
}

/// Errors of the open/migrate path (SQLite and sealing), never carrying ids.
type StoreError = Box<dyn std::error::Error + Send + Sync>;
type StoreResult<T> = Result<T, StoreError>;

/// Whether a stored id is a blind token rather than a legacy plaintext id.
fn is_token(id: &str) -> bool {
    id.len() == 36 && id.starts_with("bi1:")
}

/// Old non-lifetime rows are irrelevant once their window is over. Keep a
/// little over one year so a monthly report can still be reconstructed.
const RETAIN_SECS: i64 = 400 * 86_400;
/// How often (in recorded charges) the in-memory map drops expired windows.
const PRUNE_EVERY: u64 = 4_096;

/// Storage seam for charged-spend counters, shared by the local budget
/// enforcer and the control-plane org limits.
pub trait SpendStore: Send + Sync {
    /// Charged micro-USD recorded for `(scope, id)` in the window containing
    /// `now` (Unix seconds, UTC).
    fn spent(&self, scope: &str, id: &str, window: BudgetWindow, now: i64) -> u64;
    /// Add `amount` micro-USD to every window of `(scope, id)` containing `now`.
    fn add(&self, scope: &str, id: &str, amount: u64, now: i64);
    /// Block until queued writes are persisted. `Err` means some spend is
    /// still unpersisted (it stays pending and is retried); callers such as a
    /// shutdown path must not report success. A no-op for in-memory stores.
    fn flush(&self) -> Result<(), String> {
        Ok(())
    }
    /// `Err(reason)` when the store cannot be trusted with spend (sealed under
    /// another key, or no key in this process). Metered requests must be
    /// refused then; the counters are neither reset nor rewritten.
    fn health(&self) -> Result<(), String> {
        Ok(())
    }
    /// How subject ids reach disk: `sealed`, `no key` (a never-sealed store
    /// counted by raw id because this process holds no key) or `memory`.
    fn sealing(&self) -> &'static str {
        "memory"
    }
}

type CounterKey = (String, String, BudgetWindow, i64);

/// Shared in-memory counter map used by both store implementations.
#[derive(Default)]
struct CounterMap {
    counters: DashMap<CounterKey, u64>,
    adds: AtomicU64,
}

impl CounterMap {
    fn spent(&self, scope: &str, id: &str, window: BudgetWindow, now: i64) -> u64 {
        let key = (scope.to_owned(), id.to_owned(), window, window.start(now));
        self.counters.get(&key).map_or(0, |value| *value)
    }

    /// Add to every window and return the `(window, start)` pairs touched.
    fn add(&self, scope: &str, id: &str, amount: u64, now: i64) -> [(BudgetWindow, i64); 4] {
        let touched = BudgetWindow::ALL.map(|window| (window, window.start(now)));
        for (window, start) in touched {
            let mut entry = self
                .counters
                .entry((scope.to_owned(), id.to_owned(), window, start))
                .or_insert(0);
            *entry = entry.saturating_add(amount);
        }
        if self.adds.fetch_add(1, Ordering::Relaxed) % PRUNE_EVERY == PRUNE_EVERY - 1 {
            self.prune(now);
        }
        touched
    }

    /// Drop counters whose window has already closed. They can never be read
    /// again by an enforcer (a read always asks for the current window).
    fn prune(&self, now: i64) {
        self.counters
            .retain(|(_, _, window, start), _| *start == window.start(now));
    }
}

/// Process-memory spend counters. Restart resets them.
#[derive(Default)]
pub struct MemorySpendStore {
    map: CounterMap,
}

impl MemorySpendStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SpendStore for MemorySpendStore {
    fn spent(&self, scope: &str, id: &str, window: BudgetWindow, now: i64) -> u64 {
        self.map.spent(scope, id, window, now)
    }
    fn add(&self, scope: &str, id: &str, amount: u64, now: i64) {
        if amount > 0 {
            self.map.add(scope, id, amount, now);
        }
    }
}

/// A signal to the writer thread. The increments themselves never travel
/// through the channel: they are coalesced in [`PendingWrites`], so a burst
/// cannot overflow a queue and drop spend from the durable copy.
enum WriteSignal {
    /// New increments are pending.
    Wake,
    /// Persist everything pending, then acknowledge with whether it all
    /// reached the file.
    Flush(mpsc::SyncSender<Result<(), String>>),
}

/// One counter increment not yet written: the amount and the subject's raw id
/// (sealed into the `subject` column on insert; the key carries its token).
#[derive(Clone)]
struct PendingIncrement {
    amount: u64,
    subject: String,
}

/// Increments not yet written, merged per counter key. Bounded by the number
/// of distinct `(scope, id, window, window_start)` keys touched between two
/// drains, not by the number of charges.
type PendingWrites = Arc<Mutex<HashMap<CounterKey, PendingIncrement>>>;

/// SQLite-backed spend counters. The in-memory map is authoritative for reads;
/// the file is the durable copy reloaded on start. Counter keys hold subject
/// tokens, never raw ids.
pub struct SqliteSpendStore {
    map: CounterMap,
    pending: PendingWrites,
    sender: mpsc::SyncSender<WriteSignal>,
    /// `Some` while the store is healthy (its key matches the file).
    seal: Option<SpendSeal>,
    /// A never-sealed store opened without a key: counted by raw id.
    plain: bool,
    /// Why the store refuses work, when it does.
    unhealthy: Option<String>,
    /// Fault injection for tests: while non-zero, each write attempt fails
    /// (and decrements it) before touching SQLite.
    #[cfg_attr(not(test), allow(dead_code))]
    injected_failures: Arc<AtomicU64>,
}

/// First retry delay after a failed write; doubles up to [`RETRY_MAX`].
const RETRY_MIN: Duration = Duration::from_millis(50);
const RETRY_MAX: Duration = Duration::from_secs(5);

/// Create `path` owner-only if it is missing and tighten an existing database
/// and its WAL/shared-memory files to 0600. SQLite creates `-wal`/`-shm` with
/// the database file's mode, so a 0600 database keeps them owner-only too.
fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        if !path.exists() {
            let _ = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path);
        }
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        for candidate in [
            path.to_path_buf(),
            path.with_file_name(format!("{name}-wal")),
            path.with_file_name(format!("{name}-shm")),
        ] {
            if candidate.exists() {
                let _ =
                    std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Rehash every legacy plaintext id into its token, with its sealed subject,
/// merging amounts on conflict, in one transaction: a crash leaves either the
/// legacy rows or the sealed ones, never neither. Returns the rows rewritten.
fn migrate_legacy_ids(conn: &mut rusqlite::Connection, seal: &SpendSeal) -> StoreResult<usize> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let legacy: Vec<(String, String, String, i64, i64)> = {
        let mut stmt = tx.prepare(
            "SELECT scope, id, window, window_start, amount FROM spend_counters
             WHERE NOT (length(id) = 36 AND substr(id, 1, 4) = 'bi1:')",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (scope, id, window, start, amount) in &legacy {
        let token = seal.token(id);
        let subject = seal.seal_subject(scope, &token, id)?;
        tx.execute(
            "INSERT INTO spend_counters (scope, id, window, window_start, amount, subject)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (scope, id, window, window_start)
             DO UPDATE SET amount = amount + excluded.amount,
                           subject = COALESCE(subject, excluded.subject)",
            rusqlite::params![scope, token, window, start, amount, subject],
        )?;
        tx.execute(
            "DELETE FROM spend_counters
             WHERE scope = ?1 AND id = ?2 AND window = ?3 AND window_start = ?4",
            rusqlite::params![scope, id, window, start],
        )?;
    }
    tx.commit()?;
    Ok(legacy.len())
}

/// Re-key a store sealed under a retired key: open each sealed subject (the
/// cipher still opens retired roots), recompute its token under the current
/// key and move the counter there. Rows that do not open are counted and left
/// alone. Returns `(rewritten, unreadable)`.
fn rekey_retired(conn: &mut rusqlite::Connection, seal: &SpendSeal) -> StoreResult<(usize, usize)> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let rows: Vec<(String, String, String, i64, i64, Option<String>)> = {
        let mut stmt = tx.prepare(
            "SELECT scope, id, window, window_start, amount, subject FROM spend_counters",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let (mut rewritten, mut unreadable) = (0, 0);
    for (scope, token, window, start, amount, subject) in rows {
        if !is_token(&token) {
            continue;
        }
        let Some(id) = subject
            .as_deref()
            .and_then(|stored| seal.open_subject(&scope, &token, stored).ok())
        else {
            unreadable += 1;
            continue;
        };
        let current = seal.token(&id);
        let sealed = seal.seal_subject(&scope, &current, &id)?;
        if current == token {
            tx.execute(
                "UPDATE spend_counters SET subject = ?5
                 WHERE scope = ?1 AND id = ?2 AND window = ?3 AND window_start = ?4",
                rusqlite::params![scope, token, window, start, sealed],
            )?;
        } else {
            tx.execute(
                "INSERT INTO spend_counters (scope, id, window, window_start, amount, subject)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (scope, id, window, window_start)
                 DO UPDATE SET amount = amount + excluded.amount, subject = excluded.subject",
                rusqlite::params![scope, current, window, start, amount, sealed],
            )?;
            tx.execute(
                "DELETE FROM spend_counters
                 WHERE scope = ?1 AND id = ?2 AND window = ?3 AND window_start = ?4",
                rusqlite::params![scope, token, window, start],
            )?;
        }
        rewritten += 1;
    }
    tx.commit()?;
    Ok((rewritten, unreadable))
}

/// What [`SqliteSpendStore::load`] found.
struct Loaded {
    conn: rusqlite::Connection,
    map: CounterMap,
    /// `Some(reason)` when the store must refuse work.
    unhealthy: Option<String>,
    /// Opened without a key on a never-sealed store: rows keep raw ids.
    plain: bool,
    /// The store's `VACUUM` is still owed (too large to run while it opens):
    /// the writer thread runs it before it starts writing.
    compaction_owed: bool,
}

/// How the writer thread persists counters.
enum WriteMode {
    /// Subject tokens with sealed subjects.
    Sealed(SpendSeal),
    /// Raw ids, no subject (a never-sealed store in a keyless process).
    Plain,
}

/// Whether a store holds anything sealed: a recorded key check value or a
/// `bi1:` token. Such a store must never be written by raw id.
fn holds_sealed_data(conn: &rusqlite::Connection) -> StoreResult<bool> {
    let recorded = content_sqlite::read_store_record(conn, SPEND_STORE)
        .map_err(StoreError::from)?
        .is_some_and(|record| record.kcv.is_some());
    if recorded {
        return Ok(true);
    }
    Ok(conn
        .prepare(
            "SELECT 1 FROM spend_counters
             WHERE length(id) = 36 AND substr(id, 1, 4) = 'bi1:' LIMIT 1",
        )?
        .exists([])?)
}

/// Load the counters of the windows current at `now`: token-keyed rows, or
/// raw-id rows for a plain store.
fn load_counters(conn: &rusqlite::Connection, now: i64, plain: bool) -> StoreResult<CounterMap> {
    let map = CounterMap::default();
    let mut stmt =
        conn.prepare("SELECT scope, id, window, window_start, amount FROM spend_counters")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
        ))
    })?;
    for (scope, id, window, start, amount) in rows.flatten() {
        let Some(window) = BudgetWindow::from_storage(&window) else {
            continue;
        };
        // Only the current window is ever read; older rows stay on disk
        // for reporting but are not worth holding in memory.
        if is_token(&id) != plain && start == window.start(now) {
            map.counters.insert(
                (scope, id, window, start),
                u64::try_from(amount).unwrap_or(0),
            );
        }
    }
    Ok(map)
}

/// Create (if needed) the counter table, with its `subject` column.
fn ensure_schema(conn: &rusqlite::Connection) -> StoreResult<()> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS spend_counters (
             scope        TEXT    NOT NULL,
             id           TEXT    NOT NULL,
             window       TEXT    NOT NULL,
             window_start INTEGER NOT NULL,
             amount       INTEGER NOT NULL DEFAULT 0,
             subject      TEXT,
             PRIMARY KEY (scope, id, window, window_start)
         );",
    )?;
    let has_subject = conn
        .prepare("SELECT 1 FROM pragma_table_info('spend_counters') WHERE name = 'subject'")?
        .exists([])?;
    if !has_subject {
        conn.execute_batch("ALTER TABLE spend_counters ADD COLUMN subject TEXT")?;
    }
    Ok(())
}

impl SqliteSpendStore {
    /// Open (or create) the counter database at `path`, prune windows older
    /// than the retention horizon, and load the rest into memory.
    ///
    /// `seal` is the Gateway component key's [`SpendSeal`], or why there is
    /// none. When the file was sealed under another key, or holds sealed data
    /// and no key is held, the store opens unhealthy ([`SpendStore::health`])
    /// and leaves the file as it is. Without a key, a never-sealed file keeps
    /// counting by raw id.
    pub fn open(path: &Path, seal: Result<SpendSeal, String>) -> Result<Self, String> {
        Self::open_at(path, seal, crate::window::unix_now())
    }

    /// `open`, loading the counters of the windows current at `now`.
    fn open_at(path: &Path, seal: Result<SpendSeal, String>, now: i64) -> Result<Self, String> {
        let seal = match seal {
            Ok(seal) => Some(seal),
            Err(reason) => {
                tracing::warn!(%reason, "no Gateway sealing key: spend.db subject ids are not sealed");
                None
            }
        };
        let loaded = Self::load(path, now, seal.as_ref()).map_err(|error| error.to_string())?;
        let unhealthy = loaded.unhealthy;
        let plain = loaded.plain && unhealthy.is_none();
        // One queued `Wake` is enough: the writer drains every pending
        // increment when it handles it, so further wakes may be skipped.
        let (sender, receiver) = mpsc::sync_channel::<WriteSignal>(1);
        let pending = PendingWrites::default();
        let writer_pending = Arc::clone(&pending);
        let injected_failures = Arc::new(AtomicU64::new(0));
        let writer_failures = Arc::clone(&injected_failures);
        let writer_mode = if unhealthy.is_some() {
            None
        } else if plain {
            Some(WriteMode::Plain)
        } else {
            seal.clone().map(WriteMode::Sealed)
        };
        let mut conn = loaded.conn;
        let compaction =
            (loaded.compaction_owed && unhealthy.is_none()).then(|| path.to_path_buf());
        std::thread::Builder::new()
            .name("ryu-spend-store".to_owned())
            .spawn(move || {
                // Off the boot path: increments wait in memory meanwhile.
                if let Some(path) = compaction {
                    if let Err(error) = content_sqlite::compact_deferred(&conn, &path, SPEND_STORE) {
                        tracing::warn!(%error, "spend.db compaction failed; retrying at the next start");
                    }
                }
                write_loop(
                    &mut conn,
                    &receiver,
                    &writer_pending,
                    &writer_failures,
                    writer_mode.as_ref(),
                );
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            map: loaded.map,
            pending,
            sender,
            seal: seal.filter(|_| unhealthy.is_none()),
            plain,
            unhealthy,
            injected_failures,
        })
    }

    /// The id a counter is keyed by: the subject's token while healthy. An
    /// unhealthy store counts in memory only, by raw id.
    fn key_id(&self, id: &str) -> String {
        self.seal
            .as_ref()
            .map_or_else(|| id.to_owned(), |seal| seal.token(id))
    }

    fn load(path: &Path, now: i64, seal: Option<&SpendSeal>) -> StoreResult<Loaded> {
        let unhealthy = |reason: String| {
            Ok(Loaded {
                conn: rusqlite::Connection::open_in_memory()?,
                map: CounterMap::default(),
                unhealthy: Some(reason),
                plain: false,
                compaction_owed: false,
            })
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        restrict_permissions(path);
        let mut conn = rusqlite::Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        content_sqlite::enable_secure_delete(&conn).map_err(StoreError::from)?;
        ensure_schema(&conn)?;
        restrict_permissions(path);

        let Some(seal) = seal else {
            // No key: a store that already holds sealed data is left exactly
            // as it is and refuses work; a never-sealed one keeps counting by
            // raw id until a key is held (design: keyless compat mode).
            if holds_sealed_data(&conn)? {
                tracing::error!(
                    "{KEY_UNAVAILABLE}: spend.db is sealed and this process holds no key; \
                     metered requests are refused"
                );
                return unhealthy(KEY_UNAVAILABLE.to_owned());
            }
            conn.execute(
                "DELETE FROM spend_counters WHERE window != 'lifetime' AND window_start < ?1",
                [now.saturating_sub(RETAIN_SECS)],
            )?;
            let map = load_counters(&conn, now, true)?;
            return Ok(Loaded {
                conn,
                map,
                unhealthy: None,
                plain: true,
                compaction_owed: false,
            });
        };

        let key_state = match content_sqlite::check_store_key(&conn, &seal.cipher) {
            Ok(state) => state,
            Err(error) if error.is::<content_sqlite::NewerStoreFormat>() => {
                tracing::error!(%error, "spend.db refused; metered requests are refused");
                return unhealthy(error.to_string());
            }
            Err(error) => return Err(error.into()),
        };
        match key_state {
            StoreKeyState::Mismatch { .. } => {
                tracing::error!(
                    "{KEY_MISMATCH}: spend.db was sealed under another key; it is left \
                     untouched and metered requests are refused (run `ryu-core keys status`)"
                );
                return unhealthy(KEY_MISMATCH.to_owned());
            }
            StoreKeyState::Retired => {
                let (rewritten, unreadable) = rekey_retired(&mut conn, seal)?;
                tracing::info!(
                    rewritten,
                    unreadable,
                    "re-keyed spend.db from a retired key"
                );
                if unreadable == 0 {
                    content_sqlite::record_store_kcv(&conn, SPEND_STORE, seal.cipher.kcv())
                        .map_err(StoreError::from)?;
                }
            }
            StoreKeyState::Recorded | StoreKeyState::Current => {}
        }
        if let Err(error) = content_sqlite::run_pending_vacuum_gated(&conn, path, SPEND_STORE) {
            tracing::warn!(%error, "spend.db compaction failed; retrying at the next start");
        }
        let migrated = migrate_legacy_ids(&mut conn, seal)?;
        if migrated > 0 {
            tracing::info!(rows = migrated, "sealed spend.db subject ids");
            if let Err(error) = content_sqlite::finish_store(&conn, path, SPEND_STORE) {
                tracing::warn!(%error, "spend.db scrub deferred to the next start");
            }
        }
        conn.execute(
            "DELETE FROM spend_counters WHERE window != 'lifetime' AND window_start < ?1",
            [now.saturating_sub(RETAIN_SECS)],
        )?;
        restrict_permissions(path);

        let map = load_counters(&conn, now, false)?;
        let compaction_owed = content_sqlite::compaction_owed(&conn, SPEND_STORE).unwrap_or(false);
        Ok(Loaded {
            conn,
            map,
            unhealthy: None,
            plain: false,
            compaction_owed,
        })
    }
}

/// Merge `increments` into the pending set (new charges, or a failed write
/// being retried).
fn merge_pending(pending: &PendingWrites, increments: HashMap<CounterKey, PendingIncrement>) {
    let mut guard = pending
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    for (key, increment) in increments {
        guard
            .entry(key)
            .and_modify(|total| total.amount = total.amount.saturating_add(increment.amount))
            .or_insert(increment);
    }
}

/// Persist increments keyed by subject token, sealing each subject into the
/// `subject` column (or by raw id, unsealed, for a plain store). Fails
/// closed: no mode, no write.
fn write_increments(
    conn: &mut rusqlite::Connection,
    increments: &HashMap<CounterKey, PendingIncrement>,
    mode: Option<&WriteMode>,
) -> StoreResult<()> {
    let seal = match mode {
        None => return Err(KEY_UNAVAILABLE.into()),
        Some(WriteMode::Sealed(seal)) => Some(seal),
        Some(WriteMode::Plain) => None,
    };
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO spend_counters (scope, id, window, window_start, amount, subject)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (scope, id, window, window_start)
             DO UPDATE SET amount = amount + excluded.amount,
                           subject = COALESCE(subject, excluded.subject)",
        )?;
        for ((scope, token, window, start), increment) in increments {
            let subject = match seal {
                Some(seal) => Some(seal.seal_subject(scope, token, &increment.subject)?),
                None => None,
            };
            stmt.execute(rusqlite::params![
                scope,
                token,
                window.as_str(),
                start,
                i64::try_from(increment.amount).unwrap_or(i64::MAX),
                subject,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Take ALL pending increments and write them in one transaction. A failed
/// write is merged back so it is retried, never lost.
fn drain_pending(
    conn: &mut rusqlite::Connection,
    pending: &PendingWrites,
    injected_failures: &AtomicU64,
    seal: Option<&WriteMode>,
) -> Result<(), String> {
    let increments = std::mem::take(
        &mut *pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    );
    if increments.is_empty() {
        return Ok(());
    }
    let injected = injected_failures
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |left| {
            left.checked_sub(1)
        })
        .is_ok();
    let result = if injected {
        Err("injected spend write failure".to_owned())
    } else {
        write_increments(conn, &increments, seal).map_err(|error| error.to_string())
    };
    if let Err(error) = &result {
        tracing::error!("spend counter write failed: {error}; will retry");
        merge_pending(pending, increments);
    }
    result
}

/// Persist on every signal. After a failure the loop wakes ITSELF with
/// exponential backoff, so merged-back spend is retried even when no new
/// charge arrives. A flush is acknowledged with the outcome of its own drain:
/// `Ok` only when nothing is left pending.
fn write_loop(
    conn: &mut rusqlite::Connection,
    receiver: &mpsc::Receiver<WriteSignal>,
    pending: &PendingWrites,
    injected_failures: &AtomicU64,
    seal: Option<&WriteMode>,
) {
    let mut retry: Option<Duration> = None;
    loop {
        let signal = match retry {
            None => match receiver.recv() {
                Ok(signal) => signal,
                Err(_) => return,
            },
            Some(delay) => match receiver.recv_timeout(delay) {
                Ok(signal) => signal,
                Err(mpsc::RecvTimeoutError::Timeout) => WriteSignal::Wake,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    // The store is gone: one last attempt, then stop.
                    let _ = drain_pending(conn, pending, injected_failures, seal);
                    return;
                }
            },
        };
        let result = drain_pending(conn, pending, injected_failures, seal);
        retry = match &result {
            Ok(()) => None,
            Err(_) => Some(retry.map_or(RETRY_MIN, |delay| (delay * 2).min(RETRY_MAX))),
        };
        if let WriteSignal::Flush(done) = signal {
            let _ = done.send(result);
        }
    }
}

impl SpendStore for SqliteSpendStore {
    fn spent(&self, scope: &str, id: &str, window: BudgetWindow, now: i64) -> u64 {
        self.map.spent(scope, &self.key_id(id), window, now)
    }

    fn add(&self, scope: &str, id: &str, amount: u64, now: i64) {
        if amount == 0 {
            return;
        }
        let key_id = self.key_id(id);
        let touched = self.map.add(scope, &key_id, amount, now);
        if self.unhealthy.is_some() {
            // Never written: the file belongs to another key (or none is held).
            return;
        }
        {
            let mut guard = self
                .pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for (window, start) in touched {
                guard
                    .entry((scope.to_owned(), key_id.clone(), window, start))
                    .and_modify(|total| total.amount = total.amount.saturating_add(amount))
                    .or_insert_with(|| PendingIncrement {
                        amount,
                        subject: id.to_owned(),
                    });
            }
        }
        // Never blocks the request path. A full channel already holds a wake
        // that will drain this increment along with everything else pending.
        let _ = self.sender.try_send(WriteSignal::Wake);
    }

    fn flush(&self) -> Result<(), String> {
        if let Some(reason) = &self.unhealthy {
            return Err(reason.clone());
        }
        let (done, wait) = mpsc::sync_channel(1);
        self.sender
            .send(WriteSignal::Flush(done))
            .map_err(|_| "spend store writer stopped".to_owned())?;
        wait.recv()
            .map_err(|_| "spend store writer stopped".to_owned())?
    }

    fn health(&self) -> Result<(), String> {
        self.unhealthy.clone().map_or(Ok(()), Err)
    }

    fn sealing(&self) -> &'static str {
        if self.plain {
            "no key"
        } else {
            "sealed"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400;
    // 2026-10-08T15:30:00Z
    const NOW: i64 = 1_791_473_400;

    fn seal(n: u8) -> SpendSeal {
        SpendSeal::new(
            ContentCipher::from_root(&[n; 32], SPEND_STORE),
            BlindIndex::from_root(&[n; 32], SPEND_STORE, SUBJECT_FIELD),
        )
    }

    fn temp_db(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "ryu-spend-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("spend.db");
        (dir, path)
    }

    /// Every byte of the database and its WAL, for "not on disk" checks.
    fn disk_bytes(path: &Path) -> Vec<u8> {
        let mut bytes = std::fs::read(path).unwrap_or_default();
        bytes.extend(std::fs::read(path.with_file_name("spend.db-wal")).unwrap_or_default());
        bytes
    }

    fn contains(haystack: &[u8], needle: &str) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle.as_bytes())
    }

    /// A spend.db as a pre-sealing Gateway wrote it.
    fn write_legacy(path: &Path, rows: &[(&str, &str, i64)]) {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE spend_counters (
                 scope TEXT NOT NULL, id TEXT NOT NULL, window TEXT NOT NULL,
                 window_start INTEGER NOT NULL, amount INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY (scope, id, window, window_start));",
        )
        .unwrap();
        for (scope, id, amount) in rows {
            for window in BudgetWindow::ALL {
                conn.execute(
                    "INSERT INTO spend_counters VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![scope, id, window.as_str(), window.start(NOW), amount],
                )
                .unwrap();
            }
        }
    }

    /// The stored rows and recorded key, in order (the raw file bytes can change
    /// when a closing connection checkpoints the WAL, so compare content).
    fn logical_snapshot(path: &Path) -> Vec<String> {
        let conn = rusqlite::Connection::open(path).unwrap();
        let mut rows: Vec<String> = conn
            .prepare(
                "SELECT scope || '|' || id || '|' || window || '|' || window_start || '|' ||
                        amount || '|' || COALESCE(subject, '') FROM spend_counters
                 ORDER BY scope, id, window, window_start",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        rows.extend(
            conn.prepare(
                "SELECT store || '|' || item || '|' || COALESCE(kcv, '') FROM ryu_content_seal",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .flatten(),
        );
        rows
    }

    fn row_count(path: &Path) -> i64 {
        rusqlite::Connection::open(path)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM spend_counters", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn subject_ids_never_reach_disk_in_plaintext() {
        let (dir, path) = temp_db("sealed");
        {
            let store = SqliteSpendStore::open_at(&path, Ok(seal(1)), NOW).unwrap();
            store.health().unwrap();
            store.add("member", "org-acme:alice@example.com", 70, NOW);
            store.add("key", "cred-secret-id-123", 5, NOW);
            store.flush().unwrap();
            let bytes = disk_bytes(&path);
            for id in ["alice@example.com", "org-acme", "cred-secret-id-123"] {
                assert!(
                    !contains(&bytes, id),
                    "{id} is plaintext in spend.db or its WAL"
                );
            }
        }
        let conn = rusqlite::Connection::open(&path).unwrap();
        let (id, subject): (String, String) = conn
            .query_row(
                "SELECT id, subject FROM spend_counters WHERE scope = 'key' LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(is_token(&id), "{id} is not a blind token");
        assert!(subject.starts_with("encb:v1:"));
        // The sealed subject is bound to its row: under another token it fails.
        assert!(seal(1).open_subject("key", &id, &subject).is_ok());
        let other = seal(1).token("cred-other");
        assert!(seal(1).open_subject("key", &other, &subject).is_err());
        assert!(seal(1).open_subject("member", &id, &subject).is_err());
        drop(conn);
        let reopened = SqliteSpendStore::open_at(&path, Ok(seal(1)), NOW).unwrap();
        assert_eq!(
            reopened.spent(
                "member",
                "org-acme:alice@example.com",
                BudgetWindow::Daily,
                NOW
            ),
            70
        );
        drop(reopened);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for name in ["spend.db", "spend.db-wal", "spend.db-shm"] {
                if let Ok(metadata) = std::fs::metadata(dir.join(name)) {
                    assert_eq!(
                        metadata.permissions().mode() & 0o077,
                        0,
                        "{name} is not 0600"
                    );
                }
            }
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_rows_are_rehashed_once_and_scrubbed() {
        let (dir, path) = temp_db("legacy");
        write_legacy(
            &path,
            &[
                ("member", "org-legacy:bob-legacy", 40),
                ("key", "cred-legacy-9", 3),
            ],
        );
        {
            let store = SqliteSpendStore::open_at(&path, Ok(seal(1)), NOW).unwrap();
            for window in BudgetWindow::ALL {
                assert_eq!(
                    store.spent("member", "org-legacy:bob-legacy", window, NOW),
                    40
                );
            }
            assert_eq!(
                store.spent("key", "cred-legacy-9", BudgetWindow::Lifetime, NOW),
                3
            );
            store.add("member", "org-legacy:bob-legacy", 2, NOW);
            store.flush().unwrap();
        }
        let bytes = disk_bytes(&path);
        for id in ["bob-legacy", "org-legacy", "cred-legacy-9"] {
            assert!(!contains(&bytes, id), "{id} survived the migration on disk");
        }
        let rows = row_count(&path);
        assert_eq!(rows, 8);
        // Running the migration again changes nothing.
        let again = SqliteSpendStore::open_at(&path, Ok(seal(1)), NOW).unwrap();
        assert_eq!(
            again.spent(
                "member",
                "org-legacy:bob-legacy",
                BudgetWindow::Monthly,
                NOW
            ),
            42
        );
        drop(again);
        assert_eq!(row_count(&path), rows);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_store_sealed_under_another_key_fails_closed_and_is_never_reset() {
        let (dir, path) = temp_db("mismatch");
        {
            let store = SqliteSpendStore::open_at(&path, Ok(seal(1)), NOW).unwrap();
            store.add("org", "org-kept", 500, NOW);
            store.flush().unwrap();
        }
        let before = logical_snapshot(&path);
        {
            let stranger = SqliteSpendStore::open_at(&path, Ok(seal(2)), NOW).unwrap();
            assert_eq!(stranger.health(), Err(KEY_MISMATCH.to_owned()));
            stranger.add("org", "org-kept", 1, NOW);
            assert!(stranger.flush().is_err());
        }
        assert_eq!(logical_snapshot(&path), before, "the store was rewritten");
        {
            let keyless = SqliteSpendStore::open_at(&path, Err("no key".into()), NOW).unwrap();
            assert_eq!(keyless.health(), Err(KEY_UNAVAILABLE.to_owned()));
        }
        assert_eq!(logical_snapshot(&path), before);
        let owner = SqliteSpendStore::open_at(&path, Ok(seal(1)), NOW).unwrap();
        owner.health().unwrap();
        assert_eq!(
            owner.spent("org", "org-kept", BudgetWindow::Lifetime, NOW),
            500
        );
        drop(owner);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_keyless_process_keeps_counting_on_a_never_sealed_store() {
        let (dir, path) = temp_db("keyless");
        write_legacy(&path, &[("org", "org-legacy-acme", 40)]);
        {
            let keyless = SqliteSpendStore::open_at(&path, Err("no key".into()), NOW).unwrap();
            keyless.health().unwrap();
            assert_eq!(keyless.sealing(), "no key");
            assert_eq!(
                keyless.spent("org", "org-legacy-acme", BudgetWindow::Daily, NOW),
                40
            );
            keyless.add("org", "org-legacy-acme", 2, NOW);
            keyless.add("member", "org-new:carol", 5, NOW);
            keyless.flush().unwrap();
        }
        {
            // Restart without a key: the counters survived by raw id.
            let keyless = SqliteSpendStore::open_at(&path, Err("no key".into()), NOW).unwrap();
            keyless.health().unwrap();
            assert_eq!(
                keyless.spent("org", "org-legacy-acme", BudgetWindow::Lifetime, NOW),
                42
            );
            assert_eq!(
                keyless.spent("member", "org-new:carol", BudgetWindow::Monthly, NOW),
                5
            );
        }
        // The first start with a key rehashes everything and seals the store.
        {
            let sealed = SqliteSpendStore::open_at(&path, Ok(seal(1)), NOW).unwrap();
            sealed.health().unwrap();
            assert_eq!(sealed.sealing(), "sealed");
            assert_eq!(
                sealed.spent("org", "org-legacy-acme", BudgetWindow::Weekly, NOW),
                42
            );
            assert_eq!(
                sealed.spent("member", "org-new:carol", BudgetWindow::Daily, NOW),
                5
            );
        }
        let bytes = disk_bytes(&path);
        assert!(!contains(&bytes, "org-legacy-acme"));
        // From now on a keyless process refuses rather than writing raw ids.
        let before = logical_snapshot(&path);
        {
            let keyless = SqliteSpendStore::open_at(&path, Err("no key".into()), NOW).unwrap();
            assert_eq!(keyless.health(), Err(KEY_UNAVAILABLE.to_owned()));
            keyless.add("org", "org-legacy-acme", 1, NOW);
            assert!(keyless.flush().is_err());
        }
        assert_eq!(logical_snapshot(&path), before);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_keyless_process_starts_a_fresh_store_unsealed() {
        let (dir, path) = temp_db("keyless-fresh");
        {
            let keyless = SqliteSpendStore::open_at(&path, Err("no key".into()), NOW).unwrap();
            keyless.health().unwrap();
            keyless.add("org", "org-fresh", 9, NOW);
            keyless.flush().unwrap();
        }
        let reopened = SqliteSpendStore::open_at(&path, Err("no key".into()), NOW).unwrap();
        reopened.health().unwrap();
        assert_eq!(
            reopened.spent("org", "org-fresh", BudgetWindow::Lifetime, NOW),
            9
        );
        drop(reopened);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_store_sealed_under_a_retired_key_is_rekeyed() {
        let (dir, path) = temp_db("retired");
        {
            let store = SqliteSpendStore::open_at(&path, Ok(seal(1)), NOW).unwrap();
            store.add("team", "org:team-red", 30, NOW);
            store.flush().unwrap();
        }
        let rotated = SpendSeal::new(
            ContentCipher::from_root(&[2; 32], SPEND_STORE).with_retired_roots(&[[1; 32]]),
            BlindIndex::from_root(&[2; 32], SPEND_STORE, SUBJECT_FIELD),
        );
        {
            let store = SqliteSpendStore::open_at(&path, Ok(rotated.clone()), NOW).unwrap();
            store.health().unwrap();
            assert_eq!(
                store.spent("team", "org:team-red", BudgetWindow::Weekly, NOW),
                30
            );
        }
        // The store now records the current key, so it opens without the old one.
        let current = SqliteSpendStore::open_at(&path, Ok(seal(2)), NOW).unwrap();
        current.health().unwrap();
        assert_eq!(
            current.spent("team", "org:team-red", BudgetWindow::Lifetime, NOW),
            30
        );
        drop(current);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_writes_retry_on_their_own_and_flush_reports_unpersisted_spend() {
        let dir =
            std::env::temp_dir().join(format!("ryu-spend-fail-{}-{}", std::process::id(), NOW));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("spend.db");
        let store = SqliteSpendStore::open(&path, Ok(seal(1))).expect("open spend store");
        let persisted = || -> i64 {
            rusqlite::Connection::open(&path)
                .unwrap()
                .query_row(
                    "SELECT COALESCE(SUM(amount), 0) FROM spend_counters
                     WHERE scope = 'member' AND window = 'lifetime'",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        };
        // The wake's write and the flush's write both fail.
        store.injected_failures.store(2, Ordering::Release);
        store.add("member", "org:u", 9, NOW);
        assert!(store.flush().is_err(), "flush must not report success");
        assert_eq!(persisted(), 0);
        assert_eq!(
            store.spent("member", "org:u", BudgetWindow::Lifetime, NOW),
            9
        );

        // No new charge arrives; the backoff retry persists the spend anyway.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while persisted() != 9 {
            assert!(
                std::time::Instant::now() < deadline,
                "retry never persisted"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        store.flush().expect("nothing left pending");
        drop(store);
        let reopened = SqliteSpendStore::open(&path, Ok(seal(1))).expect("reopen");
        assert_eq!(
            reopened.spent("member", "org:u", BudgetWindow::Lifetime, NOW),
            9
        );
        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sustained_bursts_beyond_the_old_queue_survive_reopen_in_full() {
        let dir =
            std::env::temp_dir().join(format!("ryu-spend-burst-{}-{}", std::process::id(), NOW));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("spend.db");
        const CHARGES: u64 = 20_000;
        {
            let store =
                SqliteSpendStore::open_at(&path, Ok(seal(1)), NOW).expect("open spend store");
            // 20k charges x 4 windows = 80k increments, far past the 4,096
            // slots the old per-increment queue had, plus many distinct keys.
            for charge in 0..CHARGES {
                store.add("member", "org:u", 1, NOW);
                store.add("key", &format!("k{}", charge % 500), 2, NOW);
            }
            store.flush().expect("flush");
        }
        let reopened =
            SqliteSpendStore::open_at(&path, Ok(seal(1)), NOW).expect("reopen spend store");
        for window in BudgetWindow::ALL {
            assert_eq!(reopened.spent("member", "org:u", window, NOW), CHARGES);
        }
        let keys: u64 = (0..500)
            .map(|key| reopened.spent("key", &format!("k{key}"), BudgetWindow::Lifetime, NOW))
            .sum();
        assert_eq!(keys, CHARGES * 2);
        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn memory_store_adds_to_every_window() {
        let store = MemorySpendStore::new();
        store.add("user", "u1", 40, NOW);
        store.add("user", "u1", 2, NOW);
        for window in BudgetWindow::ALL {
            assert_eq!(store.spent("user", "u1", window, NOW), 42);
        }
        assert_eq!(store.spent("user", "u2", BudgetWindow::Daily, NOW), 0);
        assert_eq!(store.spent("agent", "u1", BudgetWindow::Daily, NOW), 0);
    }

    #[test]
    fn a_new_day_starts_a_fresh_daily_counter_but_keeps_lifetime() {
        let store = MemorySpendStore::new();
        store.add("member", "org:u", 100, NOW);
        let tomorrow = NOW + DAY;
        assert_eq!(
            store.spent("member", "org:u", BudgetWindow::Daily, tomorrow),
            0
        );
        // Same ISO week (Thursday → Friday) and same month.
        assert_eq!(
            store.spent("member", "org:u", BudgetWindow::Weekly, tomorrow),
            100
        );
        assert_eq!(
            store.spent("member", "org:u", BudgetWindow::Monthly, tomorrow),
            100
        );
        assert_eq!(
            store.spent("member", "org:u", BudgetWindow::Lifetime, tomorrow),
            100
        );
        store.add("member", "org:u", 5, tomorrow);
        assert_eq!(
            store.spent("member", "org:u", BudgetWindow::Daily, tomorrow),
            5
        );
        assert_eq!(
            store.spent("member", "org:u", BudgetWindow::Lifetime, tomorrow),
            105
        );
    }

    #[test]
    fn prune_keeps_only_current_windows() {
        let map = CounterMap::default();
        map.add("org", "o", 7, NOW);
        map.prune(NOW + 40 * DAY);
        // Only the lifetime row survives a 40-day jump.
        assert_eq!(map.counters.len(), 1);
        assert_eq!(
            map.spent("org", "o", BudgetWindow::Lifetime, NOW + 40 * DAY),
            7
        );
    }

    #[test]
    fn sqlite_store_survives_reopen() {
        let dir = std::env::temp_dir().join(format!(
            "ryu-spend-store-{}-{}",
            std::process::id(),
            crate::window::unix_now()
        ));
        let path = dir.join("spend.db");
        let now = crate::window::unix_now();
        {
            let store = SqliteSpendStore::open(&path, Ok(seal(1))).expect("open spend store");
            store.add("key", "cred-1", 250, now);
            store.add("key", "cred-1", 50, now);
            store.add("team", "org:t1", 9, now);
            store.flush().expect("flush");
        }
        let reopened = SqliteSpendStore::open(&path, Ok(seal(1))).expect("reopen spend store");
        assert_eq!(
            reopened.spent("key", "cred-1", BudgetWindow::Daily, now),
            300
        );
        assert_eq!(
            reopened.spent("key", "cred-1", BudgetWindow::Lifetime, now),
            300
        );
        assert_eq!(
            reopened.spent("team", "org:t1", BudgetWindow::Monthly, now),
            9
        );
        reopened.add("key", "cred-1", 1, now);
        reopened.flush().expect("flush");
        drop(reopened);
        let again = SqliteSpendStore::open(&path, Ok(seal(1))).expect("reopen spend store again");
        assert_eq!(again.spent("key", "cred-1", BudgetWindow::Weekly, now), 301);
        let _ = std::fs::remove_dir_all(dir);
    }
}
