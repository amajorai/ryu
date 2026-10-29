//! Authoritative CRDT document engine (Phase 3 of the multi-user collaboration
//! epic, Core side).
//!
//! Core holds a **server-side replica** of every live collaborative document so it
//! can persist edits, rehydrate late joiners, and (later) feed the existing
//! embed/search/AI readers a materialized projection. "Authoritative" here means
//! *durable owner*, NOT *arbiter*: the underlying [`yrs`] CRDT converges without an
//! arbiter, so Core never resolves conflicts — it only stores, replays, and
//! rebroadcasts the opaque Yjs update stream.
//!
//! ## What this stage delivers
//!
//! - The [`DocRegistry`]: keyed by `doc_id`, lazily rehydrates a [`yrs::Doc`] from
//!   persistence (snapshot + replayed update log), holds it for live documents
//!   behind a per-doc [`std::sync::Mutex`] (single-writer discipline — `yrs` doc
//!   mutation is `Send` but not `Sync`), and exposes the CRDT sync primitives:
//!   [`DocRegistry::apply_remote_update`], [`DocRegistry::state_vector`],
//!   [`DocRegistry::diff_since`], [`DocRegistry::snapshot`] (compaction),
//!   [`DocRegistry::materialize`], and [`DocRegistry::flush_and_drop`]
//!   (hibernation).
//! - The [`CollabStore`]: rusqlite persistence (`~/.ryu/collab.db`) with an
//!   append-only `doc_updates` log + a compacted `doc_snapshots` projection.
//!   Update bytes, snapshots and the materialized source are sealed at rest
//!   under the `collab.db` content key (see [`seal`]).
//! - The self-framed [`DocSyncMessage`] wire protocol (1-byte tag + payload) that
//!   rides `Frame::DocSync(Vec<u8>)`, plus the pure [`classify_doc_sync`] write-ACL
//!   gate the Core `server::realtime_ws` transport applies to every inbound
//!   frame.
//!
//! ## Wiring
//!
//! [`DocRegistry`] is a field of Core's `server::ServerState` and is driven by
//! the `GET /api/realtime/ws` handler on a `kind:"document"` room: rehydrate +
//! `SyncStep1` on join, [`classify_doc_sync`] → [`DocRegistry::apply_remote_update`]
//! + rebroadcast on an inbound update, and [`DocRegistry::flush_and_drop`] +
//! [`DocRegistry::materialize`] on last-leave / quiescence.
//!
//! ## `Y.Doc -> source` materialization (what is, and is not, projected)
//!
//! The handshake, the write-ACL, the append-log, compaction, and snapshot
//! persistence are all LIVE. [`DocRegistry::materialize`] additionally decodes the
//! doc into the plain `documents.source` text the non-collaborative readers need
//! (RAG chunks, search snippets, backlinks, version snapshots), via
//! [`projection::project`]. The per-quiescence embed write-back in
//! the Core `server::realtime_ws` transport — previously wired but dormant — therefore now
//! fires for real.
//!
//! It is deliberately **databases only**. A database's `source` is a data model
//! (`{columns, rows, views}` JSON), so the projection is an exact transcription of
//! the client's `snapshotDatabase` and semantic JSON equality is the whole
//! contract. A **page's** `source` is markdown from Plate's client-side Slate ->
//! markdown serializer; reimplementing that in Rust risks *silently rewriting the
//! user's real body* on every quiescence (the write-back has no kind check, and
//! that column also re-seeds fresh rooms and feeds version snapshots). Corrupt
//! content is worse than a stale index, so pages project to `None` and their
//! editor's own markdown PUT stays authoritative. See [`projection`].
//!
//! The crate-level `dead_code` allowance mirrors [`ryu_realtime`] for the few
//! helpers only the tests exercise.
#![allow(dead_code)]

pub mod projection;
pub mod seal;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::content_sqlite::{self, StoreKeyState};
use ryu_crypto::ContentCipher;
use yrs::{
    updates::{decoder::Decode, encoder::Encode},
    Doc, ReadTxn, StateVector, Transact, Update,
};

// ── Kernel seam (`CollabHost`) ───────────────────────────────────────────────
//
// The one thing this crate cannot own — because it is a kernel utility — is the
// active `~/.ryu` data dir that `CollabStore::open_default` resolves the
// `collab.db` path against. Invert it through the narrow `CollabHost` trait:
// Core implements it once (`crate::collab_host::CoreCollabHost`) and installs it
// at boot via `set_global_host`, BEFORE `CollabStore::open_default` first opens
// the store. Mirrors the extracted `ryu-crypto` primitive's `CryptoHost` seam.

/// The kernel couplings the collaboration primitive needs but cannot own. Core
/// installs an implementation once at boot via [`set_global_host`], before the
/// first store opens.
pub trait CollabHost: Send + Sync {
    /// The active Ryu data dir (`~/.ryu`, or its profile/relocation variant)
    /// where the CRDT database (`collab.db`) lives.
    fn ryu_dir(&self) -> PathBuf;
}

/// Process-global collab host, installed once at boot by `apps/core`.
fn host_slot() -> &'static OnceLock<Arc<dyn CollabHost>> {
    static HOST: OnceLock<Arc<dyn CollabHost>> = OnceLock::new();
    &HOST
}

/// Install the host implementation. Called once from `apps/core` at startup,
/// unconditionally and BEFORE the first store opens (collab is a non-optional
/// dep — Core's `ServerState` holds a `DocRegistry` in every build). Idempotent:
/// a second call is ignored.
pub fn set_global_host(host: Arc<dyn CollabHost>) {
    let _ = host_slot().set(host);
}

/// Fetch the installed host, erroring if [`set_global_host`] was never called.
fn host() -> Result<Arc<dyn CollabHost>> {
    host_slot()
        .get()
        .cloned()
        .ok_or_else(|| anyhow!("collab host not initialized"))
}

/// After this many appended updates since the last snapshot, the next
/// [`DocRegistry::apply_remote_update`] folds the log into a fresh snapshot and
/// prunes the folded rows. Keeps the replay-on-rehydrate log bounded.
const DEFAULT_COMPACT_THRESHOLD: usize = 256;

/// Hard ceiling on a single inbound CRDT update (bytes) before we even decode it.
/// A small Yjs v1 wire payload can decode into very large internal structures
/// (large client clocks / run lengths — a decompression-style amplification), so
/// this caps memory pressure from a malicious or buggy writer. 8 MiB is far above
/// any legitimate single edit/paste yet well under the WS frame limit. An update
/// over this is rejected before `Update::decode_v1`.
const MAX_UPDATE_BYTES: usize = 8 * 1024 * 1024;

// ── DocSync wire framing ─────────────────────────────────────────────────────

/// Tag byte for a [`DocSyncMessage::SyncStep1`] frame (payload = client state
/// vector).
pub const TAG_SYNC_STEP1: u8 = 0x00;
/// Tag byte for a [`DocSyncMessage::SyncStep2`] frame (payload = server diff for
/// the peer's state vector).
pub const TAG_SYNC_STEP2: u8 = 0x01;
/// Tag byte for a [`DocSyncMessage::Update`] frame (payload = an incremental Yjs
/// update).
pub const TAG_UPDATE: u8 = 0x02;
/// Tag byte for a [`DocSyncMessage::Awareness`] frame (payload = an opaque Yjs
/// awareness update — cursors/selections/presence for a document). RELAYED to the
/// room's other members but NEVER applied to the authoritative doc or persisted.
pub const TAG_AWARENESS: u8 = 0x03;

/// One self-framed DocSync message: a 1-byte tag followed by a standard Yjs v1
/// payload. This rides `Frame::DocSync(Vec<u8>)` end-to-end; both ends are ours
/// (this engine + the future `UnifiedProvider` client), so we own the framing and
/// avoid the `y-sync`/`yrs-axum` version traps.
///
/// Payload semantics (all standard `yrs` v1 bytes, applied/produced directly):
/// - `SyncStep1` — a **state vector** (`StateVector::encode_v1`). The peer answers
///   with a `SyncStep2` diff for it. An empty payload means "I have nothing"
///   (full state requested).
/// - `SyncStep2` — a **diff update** (`encode_state_as_update_v1` against the
///   peer's SV) that brings the peer up to date.
/// - `Update` — an **incremental update** to apply and rebroadcast.
/// - `Awareness` — an opaque **awareness update** (cursors/selections/presence
///   for the document). It is ephemeral peer state, NOT a doc mutation: the
///   transport relays it to the room's other members but never applies it to the
///   authoritative `yrs` doc and never persists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocSyncMessage {
    SyncStep1(Vec<u8>),
    SyncStep2(Vec<u8>),
    Update(Vec<u8>),
    Awareness(Vec<u8>),
}

impl DocSyncMessage {
    /// The tag byte for this message.
    pub fn tag(&self) -> u8 {
        match self {
            DocSyncMessage::SyncStep1(_) => TAG_SYNC_STEP1,
            DocSyncMessage::SyncStep2(_) => TAG_SYNC_STEP2,
            DocSyncMessage::Update(_) => TAG_UPDATE,
            DocSyncMessage::Awareness(_) => TAG_AWARENESS,
        }
    }

    /// Borrow the raw Yjs payload (state vector, update, or awareness bytes).
    pub fn payload(&self) -> &[u8] {
        match self {
            DocSyncMessage::SyncStep1(b)
            | DocSyncMessage::SyncStep2(b)
            | DocSyncMessage::Update(b)
            | DocSyncMessage::Awareness(b) => b,
        }
    }

    /// Serialize to wire bytes: `[tag][payload...]`.
    pub fn encode(&self) -> Vec<u8> {
        let payload = self.payload();
        let mut out = Vec::with_capacity(1 + payload.len());
        out.push(self.tag());
        out.extend_from_slice(payload);
        out
    }

    /// Parse a wire frame `[tag][payload...]`. Errors on an empty frame or an
    /// unknown tag (fail-closed: stage 2 drops/ignores unparseable frames).
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let (&tag, payload) = bytes
            .split_first()
            .context("DocSync frame is empty (missing tag byte)")?;
        let payload = payload.to_vec();
        match tag {
            TAG_SYNC_STEP1 => Ok(DocSyncMessage::SyncStep1(payload)),
            TAG_SYNC_STEP2 => Ok(DocSyncMessage::SyncStep2(payload)),
            TAG_UPDATE => Ok(DocSyncMessage::Update(payload)),
            TAG_AWARENESS => Ok(DocSyncMessage::Awareness(payload)),
            other => anyhow::bail!("unknown DocSync tag byte: 0x{other:02x}"),
        }
    }
}

/// What the transport (`realtime_ws.rs`) should do with an inbound `DocSync`
/// binary frame, after the wire-protocol semantics + the per-connection write-ACL
/// are applied. Pure so the security-critical "read-only member's mutation is
/// dropped" rule is unit-testable in isolation (mirrors `decide_access`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocSyncAction {
    /// The frame carries an incremental update to apply to the authoritative doc
    /// and rebroadcast to the other room members. Covers both an `Update` and a
    /// client's `SyncStep2` (the diff *response* to our `SyncStep1` — it carries
    /// updates and therefore mutates the doc, so it is gated identically).
    Apply(Vec<u8>),
    /// The frame is a client `SyncStep1` (its state vector). Reply — UNICAST, to
    /// this socket only — with a `SyncStep2` diff for that state vector. This is a
    /// read, so it is ungated: a read-only viewer syncs the doc down this way.
    ReplyDiff(Vec<u8>),
    /// The frame carries an opaque Yjs **awareness** update (cursors/selections).
    /// Rebroadcast it to the room's other members as-is — it is the member's OWN
    /// ephemeral presence, never a doc mutation, so it is UNGATED (read-only
    /// viewers relay their cursor too) and is NEITHER applied to the authoritative
    /// doc NOR persisted.
    Relay(Vec<u8>),
    /// Drop the frame: either a read-only connection attempted a mutation
    /// (`Update`/`SyncStep2` with `can_write == false` — fail closed BEFORE apply)
    /// or the frame was unparseable (empty / unknown tag).
    Drop,
}

/// Classify an inbound `DocSync` binary frame against the connection's write-ACL.
/// Fail-closed: a non-writer's mutating frame and any unparseable frame both
/// resolve to [`DocSyncAction::Drop`] (the update never reaches `apply_remote_update`).
///
/// A read-only viewer is NOT locked out of reading: it receives the document via
/// its own `SyncStep1` → [`DocSyncAction::ReplyDiff`] (the server's `SyncStep2`),
/// which is ungated. Only its *mutating* frames (`Update` / its own `SyncStep2`)
/// are dropped.
pub fn classify_doc_sync(bytes: &[u8], can_write: bool) -> DocSyncAction {
    match DocSyncMessage::decode(bytes) {
        Ok(DocSyncMessage::SyncStep1(state_vector)) => DocSyncAction::ReplyDiff(state_vector),
        Ok(DocSyncMessage::Update(update) | DocSyncMessage::SyncStep2(update)) => {
            if can_write {
                DocSyncAction::Apply(update)
            } else {
                DocSyncAction::Drop
            }
        }
        // Awareness is the member's own ephemeral cursor/selection, NOT a doc
        // mutation — relayed for any member (read or write), never applied/persisted.
        Ok(DocSyncMessage::Awareness(awareness)) => DocSyncAction::Relay(awareness),
        Err(_) => DocSyncAction::Drop,
    }
}

// ── Materialized projection ──────────────────────────────────────────────────

/// The result of [`DocRegistry::materialize`]: the opaque CRDT snapshot (always
/// produced + persisted) and the decoded `source` projection.
#[derive(Debug, Clone)]
pub struct Materialized {
    /// Full-state Yjs update (`encode_state_as_update_v1` of empty SV).
    pub snapshot: Vec<u8>,
    /// Doc state vector (`StateVector::encode_v1`).
    pub state_vector: Vec<u8>,
    /// The decoded `source` projection for the embed/search readers
    /// ([`projection::project`]).
    ///
    /// `Some` for a database doc (its `{columns, rows, views}` JSON). `None` for a
    /// page (Plate's markdown serializer stays authoritative — see [`projection`]),
    /// for a whiteboard, and for an unseeded empty room. **`None` means "do not
    /// write": the caller must leave `documents.source` untouched**, never
    /// overwrite it with an empty projection.
    pub source: Option<String>,
}

// ── Persistence ──────────────────────────────────────────────────────────────

/// Default on-disk location for the collaboration database (`<data dir>/db/collab.db`).
/// Kept separate from `spaces.db`/`conversations.db` so the CRDT log layer is
/// isolated.
fn default_db_path() -> Result<PathBuf> {
    Ok(ryu_sidecar_runtime::layout::db_file(
        &host()?.ryu_dir(),
        "collab.db",
    ))
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// rusqlite persistence for the CRDT engine: an append-only `doc_updates` log and
/// a compacted `doc_snapshots` projection. All methods are synchronous and
/// serialize on a single connection `Mutex` (operations are short; never held
/// across `.await`).
///
/// Content is sealed per value (see [`seal`]): every write seals, every read
/// opens (legacy plaintext is accepted). A store sealed under a key this process
/// does not hold refuses writes and leaves the data untouched.
pub struct CollabStore {
    conn: Arc<Mutex<Connection>>,
    cipher: ContentCipher,
    writable: bool,
    unreadable: AtomicU64,
}

impl CollabStore {
    /// Open (or create) the store at the default path (`~/.ryu/collab.db`). The
    /// content key comes from the process's crypto host (Core installs it before
    /// the store opens); legacy plaintext is sealed by a background pass.
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path()?)
    }

    /// Open (or create) the store at a specific path; legacy plaintext is sealed
    /// by a background pass on its own connection.
    pub fn open(path: PathBuf) -> Result<Self> {
        let cipher = ryu_crypto::content_cipher(seal::STORE).context("resolving the collab key")?;
        Self::open_inner(path, cipher, true)
    }

    /// [`Self::open`] under an explicit content cipher, migrating legacy
    /// plaintext before it returns (tests, tools).
    pub fn open_with_cipher(path: PathBuf, cipher: ContentCipher) -> Result<Self> {
        Self::open_inner(path, cipher, false)
    }

    fn open_inner(path: PathBuf, cipher: ContentCipher, background: bool) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating collab db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening collab db {}", path.display()))?;
        let store = Self::from_connection(conn, Some(&path), cipher)?;
        if store.writable {
            let key_state = {
                let conn = store.lock();
                content_sqlite::check_store_key(&conn, &store.cipher)?
            };
            if background {
                let cipher = store.cipher.clone();
                let thread_path = path.clone();
                let spawned = std::thread::Builder::new()
                    .name("collab-seal-migration".to_owned())
                    .spawn(move || {
                        if let Err(error) =
                            Self::migrate_path(&thread_path, &cipher, &key_state, false)
                        {
                            tracing::warn!("collab: sealing legacy rows deferred: {error:#}");
                        }
                    });
                if let Err(error) = spawned {
                    tracing::warn!("collab: could not start the sealing pass: {error}");
                }
            } else {
                Self::migrate_path(&path, &store.cipher, &key_state, true)?;
            }
        }
        Ok(store)
    }

    fn migrate_path(
        path: &Path,
        cipher: &ContentCipher,
        key_state: &StoreKeyState,
        inline_vacuum: bool,
    ) -> Result<seal::MigrationReport> {
        let mut conn = Connection::open(path)
            .with_context(|| format!("opening collab db {}", path.display()))?;
        seal::migrate(&mut conn, Some(path), cipher, key_state, inline_vacuum)
    }

    /// Open an in-memory store (used by tests), keyed from the process.
    pub fn open_in_memory() -> Result<Self> {
        let cipher = ryu_crypto::content_cipher(seal::STORE).context("resolving the collab key")?;
        Self::open_in_memory_with_cipher(cipher)
    }

    /// An in-memory store under an explicit content cipher.
    pub fn open_in_memory_with_cipher(cipher: ContentCipher) -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory collab db")?;
        Self::from_connection(conn, None, cipher)
    }

    fn from_connection(
        conn: Connection,
        path: Option<&Path>,
        cipher: ContentCipher,
    ) -> Result<Self> {
        content_sqlite::enable_secure_delete(&conn)?;
        conn.busy_timeout(std::time::Duration::from_secs(30))?;
        Self::init_schema(&conn)?;
        let key_state = content_sqlite::check_store_key(&conn, &cipher)
            .context("checking the collab store key")?;
        let writable = key_state.writable();
        if !writable {
            tracing::error!(
                "collab.db is sealed under a key this process does not hold; document edits \
                 are refused and the data is left untouched"
            );
        } else if let Some(path) = path {
            // A compaction a previous migration deferred runs now, before the
            // store serves requests, when the store is small enough.
            if let Err(error) = content_sqlite::run_pending_vacuum_gated(&conn, path, seal::STORE) {
                tracing::warn!("collab: compaction deferred: {error:#}");
            }
        }
        let compaction_owed = writable
            && path.is_some()
            && content_sqlite::compaction_owed(&conn, seal::STORE).unwrap_or(false);
        let conn = Arc::new(Mutex::new(conn));
        if let (true, Some(path)) = (compaction_owed, path) {
            // Too large to compact while it opens: the background worker runs it
            // later under this store's lock.
            let weak = Arc::downgrade(&conn);
            let path = path.to_path_buf();
            content_sqlite::defer_compaction(
                seal::STORE,
                Box::new(move || {
                    let conn = weak.upgrade()?;
                    let conn = conn.lock().unwrap_or_else(|e| e.into_inner());
                    Some(content_sqlite::compact_deferred(&conn, &path, seal::STORE))
                }),
            );
        }
        Ok(Self {
            conn,
            cipher,
            writable,
            unreadable: AtomicU64::new(0),
        })
    }

    /// Values that did not open on read (since this process opened the store).
    /// Surfaced as a health item.
    pub fn unreadable_rows(&self) -> u64 {
        self.unreadable.load(Ordering::Relaxed)
    }

    /// False when the store was sealed under a key this process does not hold.
    pub fn writable(&self) -> bool {
        self.writable
    }

    fn ensure_writable(&self) -> Result<()> {
        if self.writable {
            Ok(())
        } else {
            Err(content_sqlite::mismatch_error(seal::STORE))
        }
    }

    fn count_unreadable<T>(&self, result: Result<T>) -> Result<T> {
        if let Err(error) = &result {
            if ryu_crypto::content::is_content_seal_error(error) {
                self.unreadable.fetch_add(1, Ordering::Relaxed);
            }
        }
        result
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS doc_updates (
                 doc_id  TEXT    NOT NULL,
                 seq     INTEGER NOT NULL,
                 bytes   BLOB    NOT NULL,
                 PRIMARY KEY (doc_id, seq)
             );
             CREATE TABLE IF NOT EXISTS doc_snapshots (
                 doc_id              TEXT PRIMARY KEY,
                 state_vector        BLOB NOT NULL,
                 snapshot            BLOB NOT NULL,
                 materialized_source TEXT,
                 updated_at          INTEGER NOT NULL,
                 seal_epoch          INTEGER
             );
             CREATE TABLE IF NOT EXISTS doc_seed_claims (
                 doc_id     TEXT PRIMARY KEY,
                 claimed_at INTEGER NOT NULL,
                 claimed_by TEXT NOT NULL DEFAULT ''
			 );
			 CREATE TABLE IF NOT EXISTS doc_epochs (
				 doc_id TEXT PRIMARY KEY,
				 epoch  INTEGER NOT NULL
			 );",
        )
        .context("initializing collab schema")?;

        // The epoch a snapshot row is sealed under (AAD). Rows written before
        // sealing take the document's current epoch, which is the epoch they
        // were written under (a reset deletes the row).
        let has_seal_epoch = conn
            .prepare("PRAGMA table_info(doc_snapshots)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(|column| column.ok())
            .any(|column| column == "seal_epoch");
        if !has_seal_epoch {
            conn.execute_batch("ALTER TABLE doc_snapshots ADD COLUMN seal_epoch INTEGER")
                .context("adding the snapshot seal epoch")?;
        }
        conn.execute(
            "UPDATE doc_snapshots SET seal_epoch = COALESCE(
                 (SELECT epoch FROM doc_epochs e WHERE e.doc_id = doc_snapshots.doc_id), 0)
             WHERE seal_epoch IS NULL",
            [],
        )
        .context("recording snapshot seal epochs")?;

        // Upgrade stores created before claims were owner-scoped. Unowned rows
        // are legacy leftovers from a process that could not safely release a
        // claim after a pre-seed disconnect, so they are safe to discard here.
        let has_claimed_by = conn
            .prepare("PRAGMA table_info(doc_seed_claims)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(|column| column.ok())
            .any(|column| column == "claimed_by");
        if !has_claimed_by {
            conn.execute_batch(
                "ALTER TABLE doc_seed_claims
                 ADD COLUMN claimed_by TEXT NOT NULL DEFAULT ''",
            )
            .context("adding seed claim owner")?;
        }
        conn.execute("DELETE FROM doc_seed_claims WHERE claimed_by = ''", [])
            .context("discarding legacy unowned seed claims")?;
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Load (and open) the persisted snapshot bytes for a doc, if any. A sealed
    /// snapshot that does not open is an error, never an empty document.
    fn load_snapshot(&self, doc_id: &str) -> Result<Option<Vec<u8>>> {
        let row = {
            let conn = self.lock();
            conn.query_row(
                "SELECT snapshot, seal_epoch FROM doc_snapshots WHERE doc_id = ?1",
                params![doc_id],
                |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Option<i64>>(1)?)),
            )
            .optional()
            .context("loading doc snapshot")?
        };
        let Some((stored, epoch)) = row else {
            return Ok(None);
        };
        let epoch = epoch.unwrap_or(0).to_string();
        let opened = self
            .count_unreadable(
                self.cipher
                    .open_bytes(&stored, &seal::snapshot_context(doc_id, &epoch)),
            )
            .with_context(|| format!("opening the snapshot of {doc_id}"))?;
        Ok(Some(opened.value))
    }

    /// Load (and open) the full append-only update log for a doc, ordered by
    /// `seq`. An update that does not open is an error: replaying a log with a
    /// hole would silently drop edits.
    fn load_updates(&self, doc_id: &str) -> Result<Vec<Vec<u8>>> {
        let rows = {
            let conn = self.lock();
            let mut stmt = conn
                .prepare("SELECT seq, bytes FROM doc_updates WHERE doc_id = ?1 ORDER BY seq ASC")
                .context("preparing update-log query")?;
            let rows = stmt
                .query_map(params![doc_id], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .context("querying update log")?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .context("reading update-log row")?
        };
        let mut out = Vec::with_capacity(rows.len());
        for (seq, stored) in rows {
            let opened = self
                .count_unreadable(
                    self.cipher
                        .open_bytes(&stored, &seal::update_context(doc_id, seq)),
                )
                .with_context(|| format!("opening update {seq} of {doc_id}"))?;
            out.push(opened.value);
        }
        Ok(out)
    }

    /// Atomically allocate the next `seq` for a doc AND append the update, so two
    /// concurrent `apply_remote_update` calls for the SAME doc can never read the
    /// same `MAX(seq)` and collide on the `(doc_id, seq)` primary key. The `seq`
    /// is read, the update sealed under `(doc_id, seq)`, and the row inserted
    /// while the single connection `Mutex` is held, so no other append can run in
    /// between.
    fn append_next_update(&self, doc_id: &str, bytes: &[u8]) -> Result<()> {
        self.ensure_writable()?;
        let conn = self.lock();
        let seq: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(seq) + 1, 0) FROM doc_updates WHERE doc_id = ?1",
                params![doc_id],
                |row| row.get(0),
            )
            .context("allocating the next update seq")?;
        let sealed = self
            .cipher
            .seal_bytes(bytes, &seal::update_context(doc_id, seq))
            .context("sealing update")?;
        conn.execute(
            "INSERT INTO doc_updates (doc_id, seq, bytes) VALUES (?1, ?2, ?3)",
            params![doc_id, seq, sealed],
        )
        .context("appending update to log")?;
        Ok(())
    }

    /// Number of log rows held for a doc (diagnostic / test helper).
    fn update_count(&self, doc_id: &str) -> Result<i64> {
        let conn = self.lock();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM doc_updates WHERE doc_id = ?1",
                params![doc_id],
                |row| row.get(0),
            )
            .context("counting update log")?;
        Ok(n)
    }

    /// The document epoch inside an open transaction or connection.
    fn epoch_in(conn: &Connection, doc_id: &str) -> Result<i64> {
        Ok(conn
            .query_row(
                "SELECT epoch FROM doc_epochs WHERE doc_id = ?1",
                params![doc_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .context("loading document epoch")?
            .unwrap_or(0))
    }

    /// Compaction write: store the merged `snapshot` + `state_vector` for a doc and
    /// delete the folded log rows, in one transaction. Safe to delete ALL log rows
    /// because the caller holds the per-doc engine lock (single writer — no
    /// concurrent appends). Touches only the snapshot/SV columns, leaving any
    /// `materialized_source` intact (`ON CONFLICT` targets just these columns)
    /// unless it was sealed under another epoch. The snapshot is sealed under
    /// `(doc_id, epoch)`; this rewrite is also how legacy plaintext snapshots and
    /// logs get sealed.
    fn write_snapshot_and_prune(
        &self,
        doc_id: &str,
        state_vector: &[u8],
        snapshot: &[u8],
    ) -> Result<()> {
        self.ensure_writable()?;
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting compaction tx")?;
        let epoch = Self::epoch_in(&tx, doc_id)?;
        let sealed = self
            .cipher
            .seal_bytes(
                snapshot,
                &seal::snapshot_context(doc_id, &epoch.to_string()),
            )
            .context("sealing snapshot")?;
        tx.execute(
            "INSERT INTO doc_snapshots
                 (doc_id, state_vector, snapshot, materialized_source, updated_at, seal_epoch)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5)
             ON CONFLICT(doc_id) DO UPDATE SET
                 state_vector        = excluded.state_vector,
                 snapshot            = excluded.snapshot,
                 materialized_source = CASE WHEN doc_snapshots.seal_epoch IS excluded.seal_epoch
                                            THEN doc_snapshots.materialized_source END,
                 updated_at          = excluded.updated_at,
                 seal_epoch          = excluded.seal_epoch",
            params![doc_id, state_vector, sealed, now_millis(), epoch],
        )
        .context("upserting doc snapshot")?;
        tx.execute("DELETE FROM doc_updates WHERE doc_id = ?1", params![doc_id])
            .context("pruning folded log rows")?;
        tx.commit().context("committing compaction")?;
        Ok(())
    }

    /// Materialize write: store the opaque snapshot + state vector AND the
    /// best-effort `materialized_source` projection in one row, both sealed under
    /// `(doc_id, epoch)`. Does NOT prune the log (materialize is a
    /// read-projection hook, not a compaction). `ON CONFLICT` updates all columns
    /// so it co-exists with [`Self::write_snapshot_and_prune`].
    fn write_materialized(
        &self,
        doc_id: &str,
        state_vector: &[u8],
        snapshot: &[u8],
        source: Option<&str>,
    ) -> Result<()> {
        self.ensure_writable()?;
        let conn = self.lock();
        let epoch = Self::epoch_in(&conn, doc_id)?;
        let epoch_text = epoch.to_string();
        let sealed_snapshot = self
            .cipher
            .seal_bytes(snapshot, &seal::snapshot_context(doc_id, &epoch_text))
            .context("sealing snapshot")?;
        let sealed_source = source
            .map(|source| {
                self.cipher
                    .seal_text(source, &seal::source_context(doc_id, &epoch_text))
            })
            .transpose()
            .context("sealing materialized source")?;
        conn.execute(
            "INSERT INTO doc_snapshots
                 (doc_id, state_vector, snapshot, materialized_source, updated_at, seal_epoch)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(doc_id) DO UPDATE SET
                 state_vector        = excluded.state_vector,
                 snapshot            = excluded.snapshot,
                 materialized_source = excluded.materialized_source,
                 updated_at          = excluded.updated_at,
                 seal_epoch          = excluded.seal_epoch",
            params![
                doc_id,
                state_vector,
                sealed_snapshot,
                sealed_source,
                now_millis(),
                epoch
            ],
        )
        .context("upserting materialized snapshot")?;
        Ok(())
    }

    /// Read back (and open) the stored `materialized_source` for a doc
    /// (diagnostic / test).
    fn load_materialized_source(&self, doc_id: &str) -> Result<Option<String>> {
        let row = {
            let conn = self.lock();
            conn.query_row(
                "SELECT materialized_source, seal_epoch FROM doc_snapshots WHERE doc_id = ?1",
                params![doc_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                    ))
                },
            )
            .optional()
            .context("loading materialized source")?
        };
        let Some((Some(stored), epoch)) = row else {
            return Ok(None);
        };
        let epoch = epoch.unwrap_or(0).to_string();
        let opened = self
            .count_unreadable(
                self.cipher
                    .open_text(&stored, &seal::source_context(doc_id, &epoch)),
            )
            .with_context(|| format!("opening the materialized source of {doc_id}"))?;
        Ok(Some(opened.value))
    }

    /// Atomically claim the one-shot right to seed `doc_id` from a client's local
    /// `source`. The FIRST caller wins (returns `true`); every later caller for the
    /// same doc returns `false`. The claim is a single `INSERT ... ON CONFLICT DO
    /// NOTHING` under the connection `Mutex`, so two clients racing to seed a
    /// brand-new empty room can never BOTH win — exactly one seeds, eliminating the
    /// double-seed (duplicated body / duplicated `col_name` columns) corruption.
    ///
    /// "Won the claim" is necessary but the caller still gates on emptiness +
    /// write-access before honoring it (see Core's `server::realtime_ws`).
    fn claim_seed(&self, doc_id: &str, owner_id: &str) -> Result<bool> {
        let conn = self.lock();
        let inserted = conn
            .execute(
                "INSERT INTO doc_seed_claims (doc_id, claimed_at, claimed_by) VALUES (?1, ?2, ?3)
                 ON CONFLICT(doc_id) DO NOTHING",
                params![doc_id, now_millis(), owner_id],
            )
            .context("claiming seed")?;
        Ok(inserted == 1)
    }

    /// Release a previously-won seed claim so a future session may re-claim it. Used
    /// on last-leave when the doc is STILL empty (the winner left before its seed
    /// update landed), so a crashed-before-seed claim does not permanently lock the
    /// room out of seeding. Idempotent (a missing row is a no-op).
    fn release_seed_claim(&self, doc_id: &str, owner_id: &str) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "DELETE FROM doc_seed_claims WHERE doc_id = ?1 AND claimed_by = ?2",
            params![doc_id, owner_id],
        )
        .context("releasing seed claim")?;
        Ok(())
    }

    fn current_epoch(&self, doc_id: &str) -> Result<u64> {
        let conn = self.lock();
        let epoch = conn
            .query_row(
                "SELECT epoch FROM doc_epochs WHERE doc_id = ?1",
                params![doc_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .context("loading document epoch")?
            .unwrap_or(0);
        Ok(epoch.max(0) as u64)
    }

    fn reset_document(&self, doc_id: &str) -> Result<u64> {
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting document reset")?;
        let current = tx
            .query_row(
                "SELECT epoch FROM doc_epochs WHERE doc_id = ?1",
                params![doc_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .context("loading reset epoch")?
            .unwrap_or(0);
        let next = current.saturating_add(1);
        tx.execute(
            "INSERT INTO doc_epochs (doc_id, epoch) VALUES (?1, ?2)
			 ON CONFLICT(doc_id) DO UPDATE SET epoch = excluded.epoch",
            params![doc_id, next],
        )
        .context("advancing document epoch")?;
        tx.execute("DELETE FROM doc_updates WHERE doc_id = ?1", params![doc_id])
            .context("clearing updates during document reset")?;
        tx.execute(
            "DELETE FROM doc_snapshots WHERE doc_id = ?1",
            params![doc_id],
        )
        .context("clearing snapshot during document reset")?;
        tx.execute(
            "DELETE FROM doc_seed_claims WHERE doc_id = ?1",
            params![doc_id],
        )
        .context("clearing seed claim during document reset")?;
        tx.commit().context("committing document reset")?;
        Ok(next as u64)
    }
}

// ── Live document entry ──────────────────────────────────────────────────────

/// One live document: the authoritative `yrs` replica behind a per-doc `Mutex`
/// (single-writer) plus the running update counter used to trigger compaction.
struct DocEntry {
    /// The authoritative CRDT replica. `yrs::Doc` is `Send` but not `Sync`; the
    /// `Mutex` serializes all mutation/read so the engine is one logical writer.
    doc: Mutex<Doc>,
    epoch: AtomicU64,
    /// Updates appended since the last snapshot (drives compaction).
    updates_since_snapshot: Mutex<usize>,
}

// ── Registry ─────────────────────────────────────────────────────────────────

/// Process-shared registry of live authoritative documents. Cheap to clone (an
/// `Arc` bag) so stage 2 can park it in `ServerState`. `Send + Sync`: every field
/// is a `Mutex`/`Arc`, and `Mutex<Doc>` is `Sync` because `Doc: Send`.
#[derive(Clone)]
pub struct DocRegistry {
    store: Arc<CollabStore>,
    docs: Arc<Mutex<HashMap<String, Arc<DocEntry>>>>,
    compact_threshold: usize,
}

impl DocRegistry {
    /// A registry over `store` with the default compaction threshold.
    pub fn new(store: Arc<CollabStore>) -> Self {
        Self::with_compact_threshold(store, DEFAULT_COMPACT_THRESHOLD)
    }

    /// A registry with a custom compaction threshold (tests use a small value to
    /// exercise the fold without thousands of updates).
    pub fn with_compact_threshold(store: Arc<CollabStore>, compact_threshold: usize) -> Self {
        Self {
            store,
            docs: Arc::new(Mutex::new(HashMap::new())),
            compact_threshold: compact_threshold.max(1),
        }
    }

    fn docs(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<DocEntry>>> {
        self.docs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Get the live [`DocEntry`] for `doc_id`, rehydrating it from persistence
    /// (snapshot, then replayed log in `seq` order) on first access. Idempotent:
    /// repeated calls return the same in-memory replica until it is dropped via
    /// [`Self::flush_and_drop`].
    fn entry(&self, doc_id: &str) -> Result<Arc<DocEntry>> {
        // Fast path: already live.
        if let Some(entry) = self.docs().get(doc_id) {
            return Ok(Arc::clone(entry));
        }
        // Rehydrate outside the registry lock (DB I/O + CRDT replay can be slow),
        // then insert under the lock with a double-check so a racing rehydrate of
        // the same doc resolves to one shared replica.
        let rehydrated = self.rehydrate(doc_id)?;
        let mut map = self.docs();
        if let Some(entry) = map.get(doc_id) {
            return Ok(Arc::clone(entry));
        }
        let entry = Arc::new(rehydrated);
        map.insert(doc_id.to_string(), Arc::clone(&entry));
        Ok(entry)
    }

    /// Build a fresh [`DocEntry`] from persistence: apply the snapshot (if any),
    /// then replay the remaining append-only log in `seq` order.
    fn rehydrate(&self, doc_id: &str) -> Result<DocEntry> {
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            if let Some(snapshot) = self.store.load_snapshot(doc_id)? {
                let update = Update::decode_v1(&snapshot).context("decoding persisted snapshot")?;
                txn.apply_update(update)
                    .map_err(|e| anyhow::anyhow!("applying persisted snapshot: {e}"))?;
            }
            for bytes in self.store.load_updates(doc_id)? {
                let update = Update::decode_v1(&bytes).context("decoding persisted log update")?;
                txn.apply_update(update)
                    .map_err(|e| anyhow::anyhow!("replaying persisted log update: {e}"))?;
            }
        }
        Ok(DocEntry {
            doc: Mutex::new(doc),
            epoch: AtomicU64::new(self.store.current_epoch(doc_id)?),
            updates_since_snapshot: Mutex::new(0),
        })
    }

    /// Apply a client's incremental update to the authoritative replica, append it
    /// to the durable log, and return the canonical bytes to rebroadcast to the
    /// other room members.
    ///
    /// The returned bytes are the client's update **verbatim** — Yjs updates are
    /// idempotent and commutative, so relaying them as-is is the correct
    /// "authoritative" fan-out (re-encoding a server diff would drop ops the server
    /// already held). Apply happens FIRST; the log append + return only run if
    /// apply succeeds (a malformed update never enters the log).
    pub fn apply_remote_update(&self, doc_id: &str, update: &[u8]) -> Result<Vec<u8>> {
        let epoch = self.epoch(doc_id)?;
        self.apply_remote_update_at_epoch(doc_id, epoch, update)
    }

    /// Apply an update only when the connection joined the current document
    /// epoch. A restore advances the epoch and fences every pre-restore socket.
    pub fn apply_remote_update_at_epoch(
        &self,
        doc_id: &str,
        expected_epoch: u64,
        update: &[u8],
    ) -> Result<Vec<u8>> {
        // Reject oversized updates before decode (amplification/OOM guard). This is
        // defense-in-depth behind the gateway's own frame cap; all DocSync updates
        // funnel through here, so every caller is covered.
        if update.len() > MAX_UPDATE_BYTES {
            anyhow::bail!(
                "rejected oversized CRDT update: {} bytes (max {})",
                update.len(),
                MAX_UPDATE_BYTES
            );
        }
        let entry = self.entry(doc_id)?;
        // Hold the per-doc lock across apply AND the log append AND compaction (no
        // `.await` inside). This is the single-writer critical section: because the
        // append and any prune both happen under this lock, a compaction can never
        // delete a row that was appended after its snapshot was encoded, and two
        // concurrent applies to the same doc serialize cleanly.
        let doc = entry.doc.lock().unwrap_or_else(|e| e.into_inner());
        let current_epoch = entry.epoch.load(Ordering::Acquire);
        if current_epoch != expected_epoch {
            anyhow::bail!(
                "stale document epoch: expected {expected_epoch}, current {current_epoch}"
            );
        }
        {
            let decoded = Update::decode_v1(update).context("decoding remote update")?;
            let mut txn = doc.transact_mut();
            txn.apply_update(decoded)
                .map_err(|e| anyhow::anyhow!("applying remote update: {e}"))?;
        }
        // Persist to the append-only log under the doc lock. Seq allocation + insert
        // are also a single atomic SQL statement, so concurrent applies cannot
        // collide on `(doc_id, seq)`.
        self.store.append_next_update(doc_id, update)?;

        // Compaction trigger (still under the doc lock): fold the log into a snapshot
        // once enough updates accumulate, so rehydration replay stays bounded.
        let should_compact = {
            let mut n = entry
                .updates_since_snapshot
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            *n += 1;
            *n >= self.compact_threshold
        };
        if should_compact {
            self.compact_locked(doc_id, &doc)?;
            *entry
                .updates_since_snapshot
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = 0;
        }

        Ok(update.to_vec())
    }

    pub fn epoch(&self, doc_id: &str) -> Result<u64> {
        Ok(self.entry(doc_id)?.epoch.load(Ordering::Acquire))
    }

    /// Atomically discard the CRDT state and advance its epoch. Connections that
    /// joined before this call can no longer apply updates.
    pub fn reset(&self, doc_id: &str) -> Result<u64> {
        let entry = self.entry(doc_id)?;
        let mut doc = entry.doc.lock().unwrap_or_else(|error| error.into_inner());
        let epoch = self.store.reset_document(doc_id)?;
        *doc = Doc::new();
        entry.epoch.store(epoch, Ordering::Release);
        *entry
            .updates_since_snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = 0;
        Ok(epoch)
    }

    /// The authoritative doc's state vector (`SyncStep1` payload to a peer).
    pub fn state_vector(&self, doc_id: &str) -> Result<Vec<u8>> {
        let entry = self.entry(doc_id)?;
        let doc = entry.doc.lock().unwrap_or_else(|e| e.into_inner());
        let txn = doc.transact();
        Ok(txn.state_vector().encode_v1())
    }

    /// The diff that brings a peer at `client_sv` up to the authoritative state
    /// (`SyncStep2` payload). An EMPTY `client_sv` means "send full state" for a
    /// late joiner (decoded as [`StateVector::default`]).
    pub fn diff_since(&self, doc_id: &str, client_sv: &[u8]) -> Result<Vec<u8>> {
        let sv = if client_sv.is_empty() {
            StateVector::default()
        } else {
            StateVector::decode_v1(client_sv).context("decoding client state vector")?
        };
        let entry = self.entry(doc_id)?;
        let doc = entry.doc.lock().unwrap_or_else(|e| e.into_inner());
        let txn = doc.transact();
        Ok(txn.encode_state_as_update_v1(&sv))
    }

    /// Force a snapshot + compaction now: fold the live doc + log into a single
    /// stored snapshot and prune the folded log rows. Idempotent.
    pub fn snapshot(&self, doc_id: &str) -> Result<()> {
        let entry = self.entry(doc_id)?;
        self.compact_entry(doc_id, &entry)
    }

    /// Inner compaction over an already-resolved entry: encode + persist + prune
    /// under the per-doc lock, then reset the per-doc update counter.
    fn compact_entry(&self, doc_id: &str, entry: &DocEntry) -> Result<()> {
        {
            let doc = entry.doc.lock().unwrap_or_else(|e| e.into_inner());
            self.compact_locked(doc_id, &doc)?;
        }
        let mut n = entry
            .updates_since_snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *n = 0;
        Ok(())
    }

    /// Encode the full state + state vector and persist+prune, with the caller
    /// ALREADY holding the per-doc lock. Holding the lock across BOTH the encode
    /// and the `DELETE`-all prune is what makes pruning safe: every `append` also
    /// runs under this lock (see [`Self::apply_remote_update`]), so no update can be
    /// appended between the snapshot encode and the prune and then be deleted
    /// before it was folded in. Does NOT touch the update counter (the caller does).
    fn compact_locked(&self, doc_id: &str, doc: &Doc) -> Result<()> {
        let (snapshot, sv) = {
            let txn = doc.transact();
            (
                txn.encode_state_as_update_v1(&StateVector::default()),
                txn.state_vector().encode_v1(),
            )
        };
        self.store.write_snapshot_and_prune(doc_id, &sv, &snapshot)
    }

    /// Persist the opaque snapshot + state vector and decode the `source`
    /// projection for the embed/search readers ([`projection::project`]).
    ///
    /// The snapshot + state vector are always produced. `source` is `Some` only
    /// when the doc has a projection Core can produce **without risking the user's
    /// content** — today that is database docs. A page/whiteboard/unseeded room
    /// yields `None`, which the caller must treat as "leave `documents.source`
    /// alone" (see [`Materialized::source`]).
    ///
    /// The projection runs under the SAME per-doc lock and its own read
    /// transaction, and only ever uses non-mutating root getters — inspecting a
    /// doc must never add root types to the state we are about to persist and
    /// rebroadcast.
    pub fn materialize(&self, doc_id: &str) -> Result<Materialized> {
        let entry = self.entry(doc_id)?;
        let (snapshot, sv, source) = {
            let doc = entry.doc.lock().unwrap_or_else(|e| e.into_inner());
            let (snapshot, sv) = {
                let txn = doc.transact();
                (
                    txn.encode_state_as_update_v1(&StateVector::default()),
                    txn.state_vector().encode_v1(),
                )
            };
            // Separate read txn: `project` opens its own (yrs forbids two live
            // transactions on one doc, so the encode txn above must drop first).
            let source = projection::project(&doc);
            (snapshot, sv, source)
        };
        self.store
            .write_materialized(doc_id, &sv, &snapshot, source.as_deref())?;
        Ok(Materialized {
            snapshot,
            state_vector: sv,
            source,
        })
    }

    /// Flush a final snapshot for `doc_id` and drop its in-memory replica (the
    /// hibernation / last-leave path). The next access rehydrates from
    /// persistence. No-op if the doc is not live.
    pub fn flush_and_drop(&self, doc_id: &str) -> Result<()> {
        // Hold the registry lock across BOTH the remove AND the compaction, so a
        // concurrent `entry()` cannot rehydrate a SECOND replica from the store
        // while this flush is mid-prune (which would let that replica's later
        // append be deleted by our prune — a lost update). Eviction is rare (idle
        // hibernation), so the brief stall on other docs' `entry()` calls during the
        // single compaction transaction is an acceptable trade for correctness.
        let mut map = self.docs();
        if let Some(entry) = map.remove(doc_id) {
            self.compact_entry(doc_id, &entry)?;
        }
        Ok(())
    }

    /// Whether `doc_id` currently has an in-memory replica (diagnostic / test).
    pub fn is_live(&self, doc_id: &str) -> bool {
        self.docs().contains_key(doc_id)
    }

    /// True when the authoritative doc has NO state yet — no client has contributed
    /// any update, so the room is brand-new and safe to seed. Checks the state
    /// vector: a fresh `yrs::Doc` (and one rehydrated from no updates) has an empty
    /// state vector. A doc whose content was deliberately deleted is NOT empty (its
    /// clock advanced), so this never green-lights a reseed of a cleared doc.
    pub fn is_empty(&self, doc_id: &str) -> Result<bool> {
        let entry = self.entry(doc_id)?;
        let doc = entry.doc.lock().unwrap_or_else(|e| e.into_inner());
        let txn = doc.transact();
        Ok(txn.state_vector().is_empty())
    }

    /// Atomically claim the one-shot right to seed an empty `doc_id` (see
    /// [`CollabStore::claim_seed`]). The document lock is held across the
    /// emptiness check and SQL insert, so an update cannot land between the
    /// check and claim. Exactly one caller wins per doc; race-proof.
    pub fn claim_seed(&self, doc_id: &str, owner_id: &str) -> Result<bool> {
        let entry = self.entry(doc_id)?;
        let doc = entry.doc.lock().unwrap_or_else(|e| e.into_inner());
        if !doc.transact().state_vector().is_empty() {
            return Ok(false);
        }
        self.store.claim_seed(doc_id, owner_id)
    }

    /// Release a seed claim so a future session may re-claim an unseeded empty doc
    /// (see [`CollabStore::release_seed_claim`]).
    pub fn release_seed_claim(&self, doc_id: &str, owner_id: &str) -> Result<()> {
        self.store.release_seed_claim(doc_id, owner_id)
    }

    /// Release an owner’s seed claim only while the authoritative document is still
    /// empty. The document mutex is held across the emptiness check and SQL delete,
    /// so a concurrent update cannot make an owner’s stale disconnect release a
    /// claim after the first seed has landed. Returns whether the owner's claim was
    /// actually deleted.
    pub fn release_seed_claim_if_empty(&self, doc_id: &str, owner_id: &str) -> Result<bool> {
        let entry = self.entry(doc_id)?;
        let doc = entry.doc.lock().unwrap_or_else(|e| e.into_inner());
        if !doc.transact().state_vector().is_empty() {
            return Ok(false);
        }
        let conn = self.store.lock();
        let deleted = conn
            .execute(
                "DELETE FROM doc_seed_claims WHERE doc_id = ?1 AND claimed_by = ?2",
                params![doc_id, owner_id],
            )
            .context("releasing seed claim")?;
        Ok(deleted == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{GetString, Text};

    /// Build a standalone Yjs update that sets a root text type named `name` to a
    /// given string appended at the end, encoded as a diff against `base_sv`
    /// (empty SV => the update carries the whole insert). Mirrors what the client
    /// provider would emit on the wire.
    fn make_text_update(name: &str, insert_at: u32, text: &str, base_sv: &StateVector) -> Vec<u8> {
        let doc = Doc::new();
        let txt = doc.get_or_insert_text(name);
        let mut txn = doc.transact_mut();
        txt.insert(&mut txn, insert_at, text);
        txn.encode_diff_v1(base_sv)
    }

    fn registry() -> DocRegistry {
        DocRegistry::new(Arc::new(CollabStore::open_in_memory().unwrap()))
    }

    /// Decode an encoded state vector into a sorted `(client_id, clock)` list so
    /// two logically-equal SVs compare equal regardless of the non-deterministic
    /// `HashMap` iteration order baked into `encode_v1`.
    fn sv_norm(bytes: &[u8]) -> Vec<String> {
        let sv = StateVector::decode_v1(bytes).unwrap();
        let mut v: Vec<String> = sv.iter().map(|(c, clk)| format!("{c:?}:{clk}")).collect();
        v.sort();
        v
    }

    #[test]
    fn oversized_update_is_rejected_before_apply() {
        let reg = registry();
        let oversized = vec![0u8; MAX_UPDATE_BYTES + 1];
        let err = reg.apply_remote_update("doc-big", &oversized);
        assert!(err.is_err(), "an update over the size cap must be rejected");
        // Rejected before touching the store: no log row was appended.
        assert_eq!(reg.store.update_count("doc-big").unwrap(), 0);
    }

    #[test]
    fn docsync_framing_round_trips() {
        let cases = [
            DocSyncMessage::SyncStep1(vec![1, 2, 3]),
            DocSyncMessage::SyncStep2(vec![]),
            DocSyncMessage::Update(vec![9, 8, 7, 6]),
            DocSyncMessage::Awareness(vec![4, 2, 0]),
        ];
        for msg in cases {
            let wire = msg.encode();
            assert_eq!(wire[0], msg.tag());
            let decoded = DocSyncMessage::decode(&wire).expect("decode");
            assert_eq!(decoded, msg);
        }
        // Empty frame and unknown tag fail-closed.
        assert!(DocSyncMessage::decode(&[]).is_err());
        assert!(DocSyncMessage::decode(&[0xFF, 1, 2]).is_err());
    }

    #[test]
    fn read_only_member_update_is_rejected() {
        // The deliverable's explicitly-required ACL test: a read-only connection's
        // mutating DocSync frame (an Update, and its SyncStep2 variant) is DROPPED
        // before it can reach `apply_remote_update`. A writer's identical frame is
        // applied. The drop is fail-closed and lives in a pure classifier so it is
        // testable without a live socket.
        let update = DocSyncMessage::Update(vec![1, 2, 3]).encode();
        assert_eq!(classify_doc_sync(&update, false), DocSyncAction::Drop);
        assert_eq!(
            classify_doc_sync(&update, true),
            DocSyncAction::Apply(vec![1, 2, 3])
        );

        // A client SyncStep2 is the diff response to a SyncStep1: it carries updates
        // and so is gated identically to an Update.
        let step2 = DocSyncMessage::SyncStep2(vec![4, 5]).encode();
        assert_eq!(classify_doc_sync(&step2, false), DocSyncAction::Drop);
        assert_eq!(
            classify_doc_sync(&step2, true),
            DocSyncAction::Apply(vec![4, 5])
        );

        // A SyncStep1 (a READ: "here is my state vector, send me the diff") is
        // ungated — a read-only viewer must still be able to sync the doc DOWN.
        let step1 = DocSyncMessage::SyncStep1(vec![9]).encode();
        assert_eq!(
            classify_doc_sync(&step1, false),
            DocSyncAction::ReplyDiff(vec![9])
        );

        // An awareness frame (the member's own cursor/selection) is RELAYED for any
        // member — read OR write — and is never applied to the doc or persisted.
        let awareness = DocSyncMessage::Awareness(vec![7, 7]).encode();
        assert_eq!(
            classify_doc_sync(&awareness, false),
            DocSyncAction::Relay(vec![7, 7])
        );
        assert_eq!(
            classify_doc_sync(&awareness, true),
            DocSyncAction::Relay(vec![7, 7])
        );

        // An unparseable frame fails closed for everyone.
        assert_eq!(classify_doc_sync(&[], true), DocSyncAction::Drop);
        assert_eq!(classify_doc_sync(&[0xFF, 1], true), DocSyncAction::Drop);
    }

    #[test]
    fn concurrent_updates_converge_fresh() {
        let reg = registry();
        let doc_id = "doc-converge";

        // Two independent clients each produce an update from the empty baseline
        // (concurrent edits to disjoint root text fields).
        let u1 = make_text_update("a", 0, "hello", &StateVector::default());
        let u2 = make_text_update("b", 0, "world", &StateVector::default());

        // Apply in one order to the authoritative doc.
        reg.apply_remote_update(doc_id, &u1).unwrap();
        reg.apply_remote_update(doc_id, &u2).unwrap();
        let sv_order1 = reg.state_vector(doc_id).unwrap();

        // A second authoritative doc applies them in the OPPOSITE order; CRDT
        // convergence => identical state vector.
        let reg2 = registry();
        let doc_id2 = "doc-converge-2";
        reg2.apply_remote_update(doc_id2, &u2).unwrap();
        reg2.apply_remote_update(doc_id2, &u1).unwrap();
        let sv_order2 = reg2.state_vector(doc_id2).unwrap();

        assert_eq!(
            sv_norm(&sv_order1),
            sv_norm(&sv_order2),
            "order-independent convergence"
        );
    }

    #[test]
    fn concurrent_same_field_inserts_converge() {
        // The hard CRDT case: two clients insert into the SAME root text at the SAME
        // index from the same empty baseline. Yjs resolves the tie deterministically
        // by client id, so applying in either order yields identical state AND
        // identical content (not just an identical state vector).
        let u1 = make_text_update("body", 0, "AAA", &StateVector::default());
        let u2 = make_text_update("body", 0, "BBB", &StateVector::default());

        let read_body = |reg: &DocRegistry, doc_id: &str| -> String {
            let full = reg.diff_since(doc_id, &[]).unwrap();
            let doc = Doc::new();
            let txt = doc.get_or_insert_text("body");
            {
                let mut txn = doc.transact_mut();
                txn.apply_update(Update::decode_v1(&full).unwrap()).unwrap();
            }
            let txn = doc.transact();
            txt.get_string(&txn)
        };

        let reg_a = registry();
        reg_a.apply_remote_update("d", &u1).unwrap();
        reg_a.apply_remote_update("d", &u2).unwrap();

        let reg_b = registry();
        reg_b.apply_remote_update("d", &u2).unwrap();
        reg_b.apply_remote_update("d", &u1).unwrap();

        assert_eq!(
            sv_norm(&reg_a.state_vector("d").unwrap()),
            sv_norm(&reg_b.state_vector("d").unwrap()),
            "same-field concurrent inserts converge (state vector)"
        );
        let content_a = read_body(&reg_a, "d");
        let content_b = read_body(&reg_b, "d");
        assert_eq!(content_a, content_b, "converge to identical content");
        assert!(
            content_a == "AAABBB" || content_a == "BBBAAA",
            "both inserts present, deterministically ordered: {content_a}"
        );
    }

    #[test]
    fn concurrent_updates_converge_persisted() {
        // Same convergence guarantee must hold after a rehydrate from persistence.
        let store = Arc::new(CollabStore::open_in_memory().unwrap());
        let reg = DocRegistry::new(Arc::clone(&store));
        let doc_id = "doc-persist-converge";

        let u1 = make_text_update("a", 0, "hello", &StateVector::default());
        let u2 = make_text_update("b", 0, "world", &StateVector::default());
        reg.apply_remote_update(doc_id, &u1).unwrap();
        reg.apply_remote_update(doc_id, &u2).unwrap();
        let sv_live = reg.state_vector(doc_id).unwrap();

        // Drop in-memory; rehydrate through a fresh registry over the same store.
        reg.flush_and_drop(doc_id).unwrap();
        assert!(!reg.is_live(doc_id));
        let reg_rehydrated = DocRegistry::new(store);
        let sv_rehydrated = reg_rehydrated.state_vector(doc_id).unwrap();

        assert_eq!(
            sv_norm(&sv_live),
            sv_norm(&sv_rehydrated),
            "state survives persist + rehydrate"
        );
    }

    #[test]
    fn state_vector_diff_round_trips() {
        let reg = registry();
        let doc_id = "doc-diff";

        // Seed the authoritative doc with the first edit.
        let u1 = make_text_update("name", 0, "Hello ", &StateVector::default());
        reg.apply_remote_update(doc_id, &u1).unwrap();

        // A late joiner with NOTHING asks for full state via an empty SV.
        let full = reg.diff_since(doc_id, &[]).unwrap();
        let joiner = Doc::new();
        {
            let mut txn = joiner.transact_mut();
            txn.apply_update(Update::decode_v1(&full).unwrap()).unwrap();
        }
        let joiner_txt = joiner.get_or_insert_text("name");
        {
            let txn = joiner.transact();
            assert_eq!(joiner_txt.get_string(&txn), "Hello ");
        }

        // Now the server advances; the joiner asks for ONLY the missing bytes via
        // its current state vector.
        let u2 = {
            // Build an update that appends to the existing "name" text. Encode the
            // current server SV so the update is the minimal incremental delta.
            let server_sv = reg.state_vector(doc_id).unwrap();
            let sv = StateVector::decode_v1(&server_sv).unwrap();
            // Reconstruct a doc at server state to author the append, then diff.
            let scratch = Doc::new();
            {
                let mut txn = scratch.transact_mut();
                txn.apply_update(Update::decode_v1(&reg.diff_since(doc_id, &[]).unwrap()).unwrap())
                    .unwrap();
            }
            let txt = scratch.get_or_insert_text("name");
            let mut txn = scratch.transact_mut();
            txt.insert(&mut txn, 6, "world");
            let _ = sv; // server SV already captured below for the joiner ask
            txn.encode_diff_v1(&StateVector::default())
        };
        reg.apply_remote_update(doc_id, &u2).unwrap();

        let joiner_sv = {
            let txn = joiner.transact();
            txn.state_vector().encode_v1()
        };
        let delta = reg.diff_since(doc_id, &joiner_sv).unwrap();
        {
            let mut txn = joiner.transact_mut();
            txn.apply_update(Update::decode_v1(&delta).unwrap())
                .unwrap();
        }
        {
            let txn = joiner.transact();
            assert_eq!(
                joiner_txt.get_string(&txn),
                "Hello world",
                "late joiner converges via SV diff"
            );
        }
    }

    #[test]
    fn reset_advances_epoch_discards_state_and_fences_stale_updates() {
        let store = Arc::new(CollabStore::open_in_memory().unwrap());
        let reg = DocRegistry::new(Arc::clone(&store));
        let doc_id = "doc-reset";
        let old_update = make_text_update("name", 0, "stale", &StateVector::default());

        assert_eq!(reg.epoch(doc_id).unwrap(), 0);
        reg.apply_remote_update_at_epoch(doc_id, 0, &old_update)
            .unwrap();
        assert_eq!(reg.reset(doc_id).unwrap(), 1);
        assert_eq!(reg.epoch(doc_id).unwrap(), 1);
        assert!(reg
            .apply_remote_update_at_epoch(doc_id, 0, &old_update)
            .unwrap_err()
            .to_string()
            .contains("stale document epoch"));

        let full = reg.diff_since(doc_id, &[]).unwrap();
        let restored = Doc::new();
        {
            let mut txn = restored.transact_mut();
            txn.apply_update(Update::decode_v1(&full).unwrap()).unwrap();
        }
        let text = restored.get_or_insert_text("name");
        assert_eq!(text.get_string(&restored.transact()), "");

        reg.flush_and_drop(doc_id).unwrap();
        let rehydrated = DocRegistry::new(store);
        assert_eq!(rehydrated.epoch(doc_id).unwrap(), 1);
    }

    #[test]
    fn persistence_round_trip_compact_rehydrate() {
        // apply -> compact -> rehydrate -> same state vector, and post-rehydrate
        // appends do not collide on the (doc_id, seq) primary key.
        let store = Arc::new(CollabStore::open_in_memory().unwrap());
        let reg = DocRegistry::with_compact_threshold(Arc::clone(&store), 100);
        let doc_id = "doc-roundtrip";

        let u1 = make_text_update("a", 0, "alpha", &StateVector::default());
        let u2 = make_text_update("b", 0, "beta", &StateVector::default());
        reg.apply_remote_update(doc_id, &u1).unwrap();
        reg.apply_remote_update(doc_id, &u2).unwrap();
        assert_eq!(
            store.update_count(doc_id).unwrap(),
            2,
            "log holds both updates"
        );

        // Compaction folds the log into a snapshot and prunes the rows.
        reg.snapshot(doc_id).unwrap();
        assert_eq!(
            store.update_count(doc_id).unwrap(),
            0,
            "log pruned after compact"
        );
        let sv_before = reg.state_vector(doc_id).unwrap();

        // Rehydrate from snapshot-only (log is empty) on a fresh registry.
        reg.flush_and_drop(doc_id).unwrap();
        let reg2 = DocRegistry::new(Arc::clone(&store));
        let sv_after = reg2.state_vector(doc_id).unwrap();
        assert_eq!(
            sv_norm(&sv_before),
            sv_norm(&sv_after),
            "SV survives compact + rehydrate"
        );

        // seq numbering resumes from the log MAX, not from a snapshot-only state:
        // after a prune the log is empty so next_seq is 0 and the append succeeds.
        let u3 = make_text_update("c", 0, "gamma", &StateVector::default());
        reg2.apply_remote_update(doc_id, &u3)
            .expect("post-rehydrate append must not collide on (doc_id, seq)");
        assert_eq!(store.update_count(doc_id).unwrap(), 1);
    }

    #[test]
    fn next_seq_resumes_after_rehydrate_without_compaction() {
        // When updates are NOT compacted, a rehydrate must continue seq numbering
        // from MAX(seq)+1 so a new append does not collide with a replayed row.
        let store = Arc::new(CollabStore::open_in_memory().unwrap());
        let reg = DocRegistry::with_compact_threshold(Arc::clone(&store), 100_000);
        let doc_id = "doc-seq";

        let u1 = make_text_update("a", 0, "one", &StateVector::default());
        let u2 = make_text_update("b", 0, "two", &StateVector::default());
        reg.apply_remote_update(doc_id, &u1).unwrap();
        reg.apply_remote_update(doc_id, &u2).unwrap();
        assert_eq!(store.update_count(doc_id).unwrap(), 2);

        // Drop without compaction (flush_and_drop compacts, so emulate hibernation
        // of just the in-memory map by building a fresh registry over the store).
        let reg2 = DocRegistry::with_compact_threshold(Arc::clone(&store), 100_000);
        let u3 = make_text_update("c", 0, "three", &StateVector::default());
        reg2.apply_remote_update(doc_id, &u3)
            .expect("append after rehydrate must continue seq from MAX+1");
        assert_eq!(
            store.update_count(doc_id).unwrap(),
            3,
            "third row appended at seq 2"
        );
    }

    #[test]
    fn auto_compaction_folds_log_at_threshold() {
        // The specified "compact after N updates" trigger fires from inside
        // apply_remote_update (not just the manual snapshot() entry point).
        let store = Arc::new(CollabStore::open_in_memory().unwrap());
        let reg = DocRegistry::with_compact_threshold(Arc::clone(&store), 2);
        let doc_id = "doc-autocompact";

        let u1 = make_text_update("a", 0, "x", &StateVector::default());
        let u2 = make_text_update("b", 0, "y", &StateVector::default());
        reg.apply_remote_update(doc_id, &u1).unwrap();
        // The 2nd apply reaches the threshold and auto-folds the log.
        reg.apply_remote_update(doc_id, &u2).unwrap();
        let sv_pre = reg.state_vector(doc_id).unwrap();
        assert_eq!(
            store.update_count(doc_id).unwrap(),
            0,
            "log auto-folded into snapshot at threshold"
        );

        // The folded snapshot rehydrates to the same state.
        reg.flush_and_drop(doc_id).unwrap();
        let reg2 = DocRegistry::new(store);
        assert_eq!(
            sv_norm(&sv_pre),
            sv_norm(&reg2.state_vector(doc_id).unwrap()),
            "auto-compacted state survives rehydrate"
        );
    }

    #[test]
    fn claim_seed_single_winner_sequential() {
        // The seed claim is one-shot per doc: the first caller wins, every later
        // caller for the same doc loses. A different doc is independent.
        let store = CollabStore::open_in_memory().unwrap();
        assert!(
            store.claim_seed("doc", "alice").unwrap(),
            "first caller wins"
        );
        assert!(
            !store.claim_seed("doc", "bob").unwrap(),
            "second caller loses"
        );
        assert!(
            !store.claim_seed("doc", "carol").unwrap(),
            "third caller loses"
        );
        assert!(
            store.claim_seed("other-doc", "alice").unwrap(),
            "a different doc is an independent claim"
        );
    }

    #[test]
    fn claim_seed_single_winner_concurrent() {
        // The blocker fix: two (here, many) clients racing to seed the SAME
        // brand-new room must resolve to EXACTLY ONE winner — otherwise both seed
        // and the doc gets duplicated body content / duplicated `col_name` columns.
        let store = Arc::new(CollabStore::open_in_memory().unwrap());
        const RACERS: usize = 8;
        let barrier = Arc::new(std::sync::Barrier::new(RACERS));
        let mut handles = Vec::with_capacity(RACERS);
        for racer in 0..RACERS {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                // Release all threads at once so the claims genuinely contend.
                barrier.wait();
                store
                    .claim_seed("race-doc", &format!("member-{racer}"))
                    .unwrap()
            }));
        }
        let wins = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|won| *won)
            .count();
        assert_eq!(wins, 1, "exactly one concurrent caller may seed");
    }

    #[test]
    fn release_seed_claim_allows_reclaim() {
        // A winner that left before seeding (doc still empty) releases its claim so
        // a future session can re-claim and seed. Release is idempotent.
        let store = CollabStore::open_in_memory().unwrap();
        assert!(store.claim_seed("doc", "alice").unwrap());
        assert!(!store.claim_seed("doc", "bob").unwrap());
        store.release_seed_claim("doc", "bob").unwrap();
        assert!(!store.claim_seed("doc", "bob").unwrap());
        store.release_seed_claim("doc", "alice").unwrap();
        assert!(
            store.claim_seed("doc", "bob").unwrap(),
            "after release the next caller may re-claim"
        );
        // Releasing a non-existent claim is a no-op.
        store.release_seed_claim("never-claimed", "nobody").unwrap();
    }

    #[test]
    fn owner_scoped_empty_release_cannot_remove_another_claim() {
        let reg = registry();
        assert!(reg.claim_seed("doc", "alice").unwrap());
        assert!(
            !reg.release_seed_claim_if_empty("doc", "bob").unwrap(),
            "a stale disconnect cannot release another owner's claim"
        );
        assert!(!reg.claim_seed("doc", "bob").unwrap());
        assert!(reg.release_seed_claim_if_empty("doc", "alice").unwrap());
        assert!(reg.claim_seed("doc", "bob").unwrap());
    }

    #[test]
    fn seed_claim_rechecks_empty_under_the_document_lock() {
        let reg = registry();
        let update = make_text_update("body", 0, "seeded", &StateVector::default());
        reg.apply_remote_update("doc", &update).unwrap();
        assert!(
            !reg.claim_seed("doc", "alice").unwrap(),
            "a document with applied state cannot acquire a seed claim"
        );
    }

    #[test]
    fn fresh_doc_is_empty_seeded_doc_is_not() {
        // `is_empty` green-lights seeding only for a doc with no state; once any
        // update lands it is non-empty and a (racing) reseed is refused.
        let reg = registry();
        assert!(reg.is_empty("blank").unwrap(), "a brand-new doc is empty");
        let u1 = make_text_update("body", 0, "hello", &StateVector::default());
        reg.apply_remote_update("blank", &u1).unwrap();
        assert!(
            !reg.is_empty("blank").unwrap(),
            "a doc with applied state is not empty"
        );
    }

    #[test]
    fn materialize_persists_snapshot_and_leaves_unprojectable_source_none() {
        let store = Arc::new(CollabStore::open_in_memory().unwrap());
        let reg = DocRegistry::new(Arc::clone(&store));
        let doc_id = "doc-materialize";

        // A plain text root — not a database, so there is no projection Core can
        // safely produce (this is the page/whiteboard shape).
        let u1 = make_text_update("name", 0, "content", &StateVector::default());
        reg.apply_remote_update(doc_id, &u1).unwrap();

        let mat = reg.materialize(doc_id).unwrap();
        assert!(
            !mat.snapshot.is_empty(),
            "opaque snapshot is always produced"
        );
        assert!(
            !mat.state_vector.is_empty(),
            "state vector is always produced"
        );
        // `None` = "do not write" — the caller must leave `documents.source` alone
        // rather than clobber it with an empty projection.
        assert!(
            mat.source.is_none(),
            "a non-database doc has no Core-side projection"
        );
        assert!(store.load_materialized_source(doc_id).unwrap().is_none());

        // The persisted snapshot rehydrates to the same state vector.
        let reg2 = DocRegistry::new(store);
        assert_eq!(
            sv_norm(&reg2.state_vector(doc_id).unwrap()),
            sv_norm(&mat.state_vector)
        );
    }

    #[test]
    fn materialize_projects_a_database_doc_into_source() {
        // The vertical slice: a collaborative database edit arrives as a CRDT
        // update, and materialize decodes it into the `{columns, rows, views}` JSON
        // that `documents.source` holds — which is what the desktop editor stops
        // PUTting once the room goes collaborative, and what feeds RAG/search.
        let store = Arc::new(CollabStore::open_in_memory().unwrap());
        let reg = DocRegistry::new(Arc::clone(&store));
        let doc_id = "doc-database";

        // Author the update the way a client does: seed columns + one row.
        let update = {
            use yrs::{Any, Array, MapPrelim};
            let doc = Doc::new();
            let columns = doc.get_or_insert_array("columns");
            let rows = doc.get_or_insert_array("rows");
            let mut txn = doc.transact_mut();
            columns.push_back(
                &mut txn,
                MapPrelim::from([
                    ("id", Any::from("col_name")),
                    ("label", Any::from("Name")),
                    (
                        "cell",
                        Any::from_json(r#"{"variant":"short-text"}"#).unwrap(),
                    ),
                ]),
            );
            rows.push_back(
                &mut txn,
                MapPrelim::from([
                    ("__id", Any::from("row_1")),
                    ("__order", Any::from("a0")),
                    ("col_name", Any::from("Ada")),
                ]),
            );
            txn.encode_diff_v1(&StateVector::default())
        };
        reg.apply_remote_update(doc_id, &update).unwrap();

        let mat = reg.materialize(doc_id).unwrap();
        let source = mat.source.expect("a database doc must project a source");
        let value: serde_json::Value = serde_json::from_str(&source).unwrap();
        assert_eq!(value["columns"][0]["id"], "col_name");
        assert_eq!(value["rows"][0]["col_name"], "Ada");
        assert_eq!(value["views"][0]["kind"], "table");

        // And it is durable: the projection is persisted alongside the snapshot, so
        // the embed write-back and any later reader see the same text.
        assert_eq!(
            store.load_materialized_source(doc_id).unwrap().as_deref(),
            Some(source.as_str()),
            "the projection must be persisted, not just returned"
        );
    }

    // ── Encryption at rest ────────────────────────────────────────────────────

    fn test_cipher(root: u8) -> ContentCipher {
        ContentCipher::from_root(&[root; 32], seal::STORE)
    }

    fn file_contains(path: &Path, needle: &[u8]) -> bool {
        std::fs::read(path)
            .map(|bytes| bytes.windows(needle.len()).any(|w| w == needle))
            .unwrap_or(false)
    }

    fn text_of(reg: &DocRegistry, doc_id: &str, name: &str) -> String {
        let full = reg.diff_since(doc_id, &[]).unwrap();
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            txn.apply_update(Update::decode_v1(&full).unwrap()).unwrap();
        }
        let text = doc.get_or_insert_text(name);
        let value = text.get_string(&doc.transact());
        value
    }

    #[test]
    fn updates_snapshots_and_sources_are_sealed_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("collab.db");
        let store = Arc::new(CollabStore::open_with_cipher(path.clone(), test_cipher(7)).unwrap());
        let reg = DocRegistry::with_compact_threshold(Arc::clone(&store), 1_000);
        let doc_id = "doc-sealed";
        let update = make_text_update("body", 0, "quillfeather-update", &StateVector::default());
        reg.apply_remote_update(doc_id, &update).unwrap();
        let raw: Vec<u8> = store
            .lock()
            .query_row("SELECT bytes FROM doc_updates", [], |row| row.get(0))
            .unwrap();
        assert!(raw.starts_with(b"RYU-CB01"));
        reg.snapshot(doc_id).unwrap();
        store
            .write_materialized(doc_id, b"sv", &update, Some("quillfeather-source"))
            .unwrap();
        let update2 = make_text_update("other", 0, "quillfeather-log", &StateVector::default());
        reg.apply_remote_update(doc_id, &update2).unwrap();
        for file in [path.clone(), dir.path().join("collab.db-wal")] {
            for needle in [
                "quillfeather-update",
                "quillfeather-source",
                "quillfeather-log",
            ] {
                assert!(
                    !file_contains(&file, needle.as_bytes()),
                    "{needle} in {}",
                    file.display()
                );
            }
        }
        assert_eq!(
            store.load_materialized_source(doc_id).unwrap().as_deref(),
            Some("quillfeather-source")
        );
        reg.flush_and_drop(doc_id).unwrap();
        let fresh = DocRegistry::new(Arc::clone(&store));
        assert_eq!(text_of(&fresh, doc_id, "body"), "quillfeather-update");
        assert_eq!(text_of(&fresh, doc_id, "other"), "quillfeather-log");
    }

    #[test]
    fn an_update_copied_to_another_seq_or_doc_does_not_open() {
        let store = Arc::new(CollabStore::open_in_memory_with_cipher(test_cipher(7)).unwrap());
        let reg = DocRegistry::with_compact_threshold(Arc::clone(&store), 1_000);
        let u1 = make_text_update("a", 0, "one", &StateVector::default());
        let u2 = make_text_update("b", 0, "two", &StateVector::default());
        reg.apply_remote_update("doc-a", &u1).unwrap();
        reg.apply_remote_update("doc-a", &u2).unwrap();
        {
            let conn = store.lock();
            conn.execute(
                "INSERT INTO doc_updates (doc_id, seq, bytes)
                 SELECT 'doc-b', 0, bytes FROM doc_updates WHERE doc_id = 'doc-a' AND seq = 0",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE doc_updates SET bytes =
                     (SELECT bytes FROM doc_updates WHERE doc_id = 'doc-a' AND seq = 0)
                 WHERE doc_id = 'doc-a' AND seq = 1",
                [],
            )
            .unwrap();
        }
        assert!(
            store.load_updates("doc-a").is_err(),
            "a swapped seq must not open"
        );
        assert!(
            store.load_updates("doc-b").is_err(),
            "another doc's update must not open"
        );
        assert_eq!(store.unreadable_rows(), 2);
    }

    fn legacy_store(path: &Path, update: &[u8], snapshot: &[u8], source: &str) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE doc_updates (doc_id TEXT NOT NULL, seq INTEGER NOT NULL,
                 bytes BLOB NOT NULL, PRIMARY KEY (doc_id, seq));
             CREATE TABLE doc_snapshots (doc_id TEXT PRIMARY KEY, state_vector BLOB NOT NULL,
                 snapshot BLOB NOT NULL, materialized_source TEXT, updated_at INTEGER NOT NULL);
             CREATE TABLE doc_epochs (doc_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL);",
        )
        .unwrap();
        conn.execute("INSERT INTO doc_epochs VALUES ('legacy-doc', 3)", [])
            .unwrap();
        conn.execute(
            "INSERT INTO doc_snapshots VALUES ('legacy-doc', X'00', ?1, ?2, 1)",
            params![snapshot, source],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO doc_updates VALUES ('legacy-doc', 0, ?1)",
            params![update],
        )
        .unwrap();
    }

    #[test]
    fn legacy_plaintext_reads_and_is_sealed_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("collab.db");
        let snapshot = make_text_update("body", 0, "legacy-snapshot-text", &StateVector::default());
        let update = make_text_update("tail", 0, "legacy-update-text", &StateVector::default());
        legacy_store(&path, &update, &snapshot, "legacy-source-text");

        let store = Arc::new(CollabStore::open_with_cipher(path.clone(), test_cipher(7)).unwrap());
        let raw: (Vec<u8>, Vec<u8>, String) = store
            .lock()
            .query_row(
                "SELECT u.bytes, s.snapshot, s.materialized_source
                 FROM doc_updates u JOIN doc_snapshots s USING (doc_id)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert!(raw.0.starts_with(b"RYU-CB01"));
        assert!(raw.1.starts_with(b"RYU-CB01"));
        assert!(raw.2.starts_with("encb:v1:"));
        let reg = DocRegistry::new(Arc::clone(&store));
        assert_eq!(reg.epoch("legacy-doc").unwrap(), 3);
        assert_eq!(text_of(&reg, "legacy-doc", "body"), "legacy-snapshot-text");
        assert_eq!(text_of(&reg, "legacy-doc", "tail"), "legacy-update-text");
        assert_eq!(
            store
                .load_materialized_source("legacy-doc")
                .unwrap()
                .as_deref(),
            Some("legacy-source-text")
        );
        drop(reg);
        drop(store);
        for file in [path.clone(), dir.path().join("collab.db-wal")] {
            for needle in [
                "legacy-snapshot-text",
                "legacy-update-text",
                "legacy-source-text",
            ] {
                assert!(
                    !file_contains(&file, needle.as_bytes()),
                    "{needle} in {}",
                    file.display()
                );
            }
        }
        // A second open changes nothing.
        let again = CollabStore::open_with_cipher(path.clone(), test_cipher(7)).unwrap();
        let raw_again: (Vec<u8>, Vec<u8>, String) = again
            .lock()
            .query_row(
                "SELECT u.bytes, s.snapshot, s.materialized_source
                 FROM doc_updates u JOIN doc_snapshots s USING (doc_id)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(raw, raw_again);
        content_sqlite::assert_all_open(
            &again.lock(),
            &test_cipher(7),
            &seal::snapshot_plans().unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn a_store_sealed_under_another_key_refuses_edits_and_keeps_its_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("collab.db");
        {
            let store =
                Arc::new(CollabStore::open_with_cipher(path.clone(), test_cipher(7)).unwrap());
            let reg = DocRegistry::new(store);
            reg.apply_remote_update(
                "doc",
                &make_text_update("a", 0, "kept", &StateVector::default()),
            )
            .unwrap();
        }
        let store = Arc::new(CollabStore::open_with_cipher(path.clone(), test_cipher(9)).unwrap());
        assert!(!store.writable());
        assert!(store.append_next_update("doc", b"x").is_err());
        assert_eq!(store.update_count("doc").unwrap(), 1);
        assert!(store.load_updates("doc").is_err());
    }

    /// Timing note for the append budget (< 50 µs per update added): sealing a
    /// typical keystroke-sized update is a few microseconds; printed, not
    /// asserted, because debug builds and shared CI runners vary widely.
    #[test]
    fn append_seal_overhead_is_reported() {
        let cipher = test_cipher(7);
        let update = vec![1u8; 512];
        let started = std::time::Instant::now();
        for seq in 0..2_000 {
            cipher
                .seal_bytes(&update, &seal::update_context("doc", seq))
                .unwrap();
        }
        let per_update = started.elapsed() / 2_000;
        eprintln!("collab: sealing a 512-byte update took {per_update:?} on average");
    }
}
