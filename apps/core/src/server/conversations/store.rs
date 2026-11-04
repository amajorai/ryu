//! The [`ConversationStore`] handle, its run-status and harness event
//! channels, and the constructors that open the database.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

/// SQLite-backed conversation store. Cheap to clone (wraps an `Arc<Mutex<Connection>>`).
///
/// Message bodies are encrypted at rest via [`ryu_crypto::FieldCipher`]: the
/// `content` column holds the `enc:v1:` envelope, written on append and decrypted
/// transparently on read. Rows written before encryption was introduced have no
/// envelope and are passed through unchanged (lazy migration). Metadata (ids,
/// roles, timestamps) stays plaintext so listing/ordering/sync still work.
#[derive(Clone)]
pub struct ConversationStore {
    pub(super) conn: Arc<Mutex<Connection>>,
    pub(super) cipher: ryu_crypto::FieldCipher,
    /// Whether chat messages are opted into the Memory app's source index.
    /// The preference is process-local here so the search UI and background
    /// Dream routes share one gate without reopening the preferences database.
    pub(super) chat_memory_enabled: Arc<AtomicBool>,
    /// Optional semantic index over message bodies, backing the
    /// `search_conversations` builtin tool. `None` in contexts that don't wire it
    /// (tests, CLI, headless). Indexing on append and lazy backfill on search are
    /// both best-effort: a failure here never affects message CRUD.
    pub(super) message_index: Option<ryu_search::MessageIndex>,
    /// Optional full-text (FTS5) index over message bodies — the lexical/keyword
    /// complement to `message_index` (semantic KNN), backing the FTS session-search
    /// recall layer. `None` in contexts that don't wire it (tests, CLI, headless).
    /// Unlike the semantic index it needs NO embedder, so its lazy backfill on
    /// search is network-free. Population is DEFAULT-OFF: it only ever runs when the
    /// FTS recall pref is enabled (search is the sole writer, via lazy backfill), so
    /// the on-disk term index materializes only for users who opt in.
    pub(super) message_fts: Option<ryu_search::MessageFtsIndex>,
    pub(super) semantic_backfill: Arc<Mutex<bool>>,
    pub(super) fts_backfill: Arc<Mutex<bool>>,
    /// Source messages the search-index backfill skipped because their sealed
    /// body did not open (never indexed as placeholder text).
    pub(super) index_unreadable: Arc<AtomicU64>,
    /// Harness-run rows a list skipped because a sealed field did not open.
    pub(super) harness_unreadable: Arc<AtomicU64>,
    #[cfg(test)]
    pub(super) content_reads: Arc<std::sync::atomic::AtomicUsize>,
    /// Optional room-keyed realtime registry (Phase 1 of the multi-user epic).
    /// When wired, [`append_message`] publishes an `Events` frame keyed by the
    /// conversation id so other live viewers see new turns immediately. `None` in
    /// contexts without realtime fan-out (tests, CLI). Cloned from the same
    /// instance held by `ServerState` so publishes reach the WS handler's
    /// subscribers (see `main.rs` wiring). Best-effort: publishing to a room with
    /// no members is a harmless no-op.
    pub(super) realtime: Option<ryu_realtime::RoomRegistry>,
    /// Conversations that were still `running` when this store was opened, i.e.
    /// turns the previous process died in the middle of. Captured once at boot,
    /// before reconciliation flips them to `interrupted`, and drained by the
    /// boot auto-resume task. A live Kill Switch pause never adds to it.
    pub(super) boot_interrupted: Arc<std::sync::Mutex<Vec<String>>>,
}

/// Outcome of [`ConversationStore::claim_interrupted_run_for_auto_resume`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoResumeClaim {
    /// The run moved from `interrupted` to `running` at `claimed_at` (the
    /// conversation's new `updated_at`); this is `attempt` n for the turn.
    Claimed { attempt: u32, claimed_at: i64 },
    /// Something else already moved the run off `interrupted` (a desktop
    /// retry, a new user turn, a deletion).
    NotInterrupted,
    /// This user turn already used its automatic-resume budget.
    Exhausted,
    /// The conversation belongs to a person (`owner_user_id` or `org_id` is
    /// set). A detached resume has no verified caller, JWT, or author to run
    /// it as, so it would run with node authority instead of the author's;
    /// the run stays `interrupted` for the author to retry.
    Attributed,
}

/// A run's lifecycle status changed. Carries the FULL run summary (not just id +
/// status) so a snapshot-first `/api/runs/stream` subscriber can render completion
/// notifications (title/folder/branch) with no follow-up fetch, and so runs that
/// start *after* a client connects still arrive with complete metadata.
#[derive(Clone, Debug, Serialize)]
pub struct RunStatusEvent {
    pub run: ConversationSummary,
}

/// Process-global run-status broadcast. Self-initialises on first use (nothing to
/// wire at startup), mirroring [`crate::events`]. [`ConversationStore::set_run_status`]
/// publishes here; the `/api/runs/stream` SSE endpoint subscribes.
pub(super) fn run_events_sender() -> &'static tokio::sync::broadcast::Sender<RunStatusEvent> {
    static RUN_EVENTS: OnceLock<tokio::sync::broadcast::Sender<RunStatusEvent>> = OnceLock::new();
    RUN_EVENTS.get_or_init(|| tokio::sync::broadcast::channel(128).0)
}

/// Subscribe to run lifecycle status changes (used by the `/api/runs/stream` SSE
/// endpoint). A missed delta self-heals from the stream's opening snapshot.
pub fn subscribe_run_events() -> tokio::sync::broadcast::Receiver<RunStatusEvent> {
    run_events_sender().subscribe()
}

/// A replay notification for the versioned harness event journal. The SQLite
/// row is the source of truth; this process-local bus only wakes live SSE
/// subscribers so they can fetch the next durable cursor without polling.
pub(super) fn harness_events_sender() -> &'static tokio::sync::broadcast::Sender<RunEventEnvelope> {
    static HARNESS_EVENTS: OnceLock<tokio::sync::broadcast::Sender<RunEventEnvelope>> =
        OnceLock::new();
    HARNESS_EVENTS.get_or_init(|| tokio::sync::broadcast::channel(256).0)
}

/// Subscribe to durable harness event notifications.
pub fn subscribe_harness_events() -> tokio::sync::broadcast::Receiver<RunEventEnvelope> {
    harness_events_sender().subscribe()
}

pub(super) fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Whether `message_id` names a persisted message *of this conversation*. The
/// existence gate every `message_reactions` write runs first: FK enforcement is
/// off on this database (deletes are manual), so without it any string would
/// insert an orphan reaction row, and a cross-conversation id would react into a
/// thread the caller was never authorized against.
pub(super) fn message_in_conversation(
    conn: &Connection,
    conversation_id: &str,
    message_id: &str,
) -> Result<bool> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM messages WHERE id = ?1 AND conversation_id = ?2",
            params![message_id, conversation_id],
            |row| row.get(0),
        )
        .optional()
        .context("checking message membership")?;
    Ok(found.is_some())
}

/// The `ryu_content_seal` store name under which `conversations.db` records the
/// scrub owed for run text older builds kept in plaintext.
pub(super) const RUN_TEXT_STORE: &str = "conversations.db";

/// Default on-disk location for the conversation database (`~/.ryu/conversations.db`).
pub(super) fn default_db_path() -> PathBuf {
    crate::paths::db_path("conversations.db")
}

impl ConversationStore {
    /// Isolated file-backed test storage using the same fixed test cipher as
    /// `open_in_memory`, without touching the global host/keychain.
    #[cfg(test)]
    pub(crate) fn open_hook_test_file(path: PathBuf) -> Result<Self> {
        let mut store = Self::open_in_memory()?;
        let conn = Connection::open(path)?;
        Self::init_schema(&conn)?;
        store.conn = Arc::new(Mutex::new(conn));
        Ok(store)
    }

    /// Open (or create) the conversation store at the default path and run migrations.
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path())
    }

    /// Open (or create) the conversation store at a specific path.
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let mut conn = Connection::open(&path)
            .with_context(|| format!("opening conversation db {}", path.display()))?;
        // Deleted and rewritten cells (sealed or legacy plaintext) are zeroed
        // from now on. What older builds freed without it is scrubbed below.
        conn.pragma_update(None, "secure_delete", "ON")
            .context("enabling secure_delete on the conversation db")?;
        Self::init_schema(&conn)?;
        let cipher = ryu_crypto::global_cipher()?;
        // One-shot tenancy backfill for rows that pre-date the per-resource ACL.
        // Deliberately NOT in `init_schema` (which the in-memory test store also
        // runs — it must never read the real account vault) and best-effort: a
        // failure here must never stop the node from opening its chat db.
        if let Err(e) = Self::backfill_tenancy(&conn) {
            tracing::warn!("conversation tenancy backfill skipped: {e:#}");
        }
        // Nothing else can close the books on a turn the node died in the middle
        // of: `set_run_status` only ever runs from the turn lifecycle, so a killed
        // process leaves the conversation at `running` and its half-written
        // assistant row looking finished. Same placement + best-effort rule as the
        // backfill above (out of `init_schema`, warn on failure, never blocks the
        // node opening its chat db), but deliberately NOT marker-gated: every crash
        // produces new stuck rows, so this has to run on every boot.
        //
        // Remember which conversations those were first, so the boot auto-resume
        // task can pick their turns back up once the runtime is ready.
        let boot_interrupted = Self::list_running_conversations(&conn).unwrap_or_else(|e| {
            tracing::warn!("could not list interrupted runs for auto-resume: {e:#}");
            Vec::new()
        });
        if let Err(e) = Self::reconcile_interrupted_runs(&mut conn, &cipher) {
            tracing::warn!("interrupted-run reconciliation skipped: {e:#}");
        }
        // Run errors and fallback warnings written before they were sealed,
        // then the scrub of the plaintext they and older deletes left behind.
        // Best-effort: reads accept both forms, and an unfinished scrub stays
        // recorded, so a failure only defers the work to the next start.
        if let Err(e) = Self::seal_and_scrub_legacy_run_text(&conn, &path, &cipher) {
            tracing::warn!("sealing legacy run errors deferred: {e:#}");
        }
        let compaction_owed =
            ryu_crypto::content_sqlite::compaction_owed(&conn, RUN_TEXT_STORE).unwrap_or(false);
        let conn = Arc::new(Mutex::new(conn));
        if compaction_owed {
            Self::defer_compaction(&conn, path);
        }
        Ok(Self {
            conn,
            cipher,
            chat_memory_enabled: Arc::new(AtomicBool::new(false)),
            message_index: None,
            message_fts: None,
            semantic_backfill: Arc::new(Mutex::new(false)),
            fts_backfill: Arc::new(Mutex::new(false)),
            index_unreadable: Arc::new(AtomicU64::new(0)),
            harness_unreadable: Arc::new(AtomicU64::new(0)),
            #[cfg(test)]
            content_reads: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            realtime: None,
            boot_interrupted: Arc::new(std::sync::Mutex::new(boot_interrupted)),
        })
    }

    /// Open an in-memory store (used by tests). Uses an ephemeral key so tests
    /// never touch the real keychain or `~/.ryu`.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: ryu_crypto::FieldCipher::new(&[0x11; 32]),
            chat_memory_enabled: Arc::new(AtomicBool::new(false)),
            message_index: None,
            message_fts: None,
            semantic_backfill: Arc::new(Mutex::new(false)),
            fts_backfill: Arc::new(Mutex::new(false)),
            index_unreadable: Arc::new(AtomicU64::new(0)),
            harness_unreadable: Arc::new(AtomicU64::new(0)),
            content_reads: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            realtime: None,
            boot_interrupted: Arc::new(std::sync::Mutex::new(Vec::new())),
        })
    }
}
