//! **The one path that puts an uploaded file's *contents* into a Space index.**
//!
//! # The gap this closes
//!
//! [`ryu_spaces::SpaceStore::create_file`] stores exactly one chunk per file — the
//! `{title}\n{mime}` descriptor. The bytes went to the content-addressed blob store
//! and were never chunked, embedded, or graph-extracted. So uploading a PDF to a
//! Space and asking a question about it matched the *filename* and nothing else:
//! vector search scored the descriptor, graph mode built entities out of the
//! filename, and every retrieval improvement above sat on an index that did not
//! contain the documents.
//!
//! Meanwhile [`crate::document_parse`] — the complete `document.parse` extraction
//! facade, with `markitdown` default-ON precisely so the capability has a provider
//! out of the box — had no caller. It was worse than that: it shipped with **no
//! `mod` line in `main.rs`**, so it was not in the module tree and had never been
//! compiled. Declaring it (and widening two `ext_proxy` items to `pub(crate)`) was
//! step zero of this change.
//!
//! # The seam
//!
//! There are three `create_file` callers — `POST /api/uploads`, `POST
//! /api/spaces/:id/files`, and the `artifact.create` MCP tool. They all route
//! through [`create_file_indexed`] rather than parsing in three places, because two
//! wired and one not is the state a later reader cannot tell from "this file type
//! just isn't extractable".
//!
//! ## Layering: parse is Core-side, the store is not
//!
//! `ryu-spaces` has zero dependency on `apps/core` and must keep it, so extraction
//! cannot move into the crate. `create_file_blocking` also runs inside
//! `spawn_blocking` while `document_parse` is async HTTP to a sidecar, so the parse
//! could not live inside that transaction even if the layering allowed it. The order
//! is therefore: **store the file, then parse, then re-chunk.** Storing first is not
//! merely convenient — the provider reads the blob *by path* (Space files reach
//! 200 MiB; the ext-proxy caps a forwarded body at 10 MiB), so the blob has to be on
//! disk before a provider can be asked about it.
//!
//! ## Failure posture: store the file, record that it is not indexed, say so
//!
//! A parse can fail for reasons that are not the user's fault and not each other:
//! no provider enabled, a sidecar that will not wake, a host with no Python, an
//! encrypted PDF, an unsupported binary. Two postures are available and both are
//! wrong:
//!
//! - **Fail the upload.** The user still wants the file stored. A `.pptx` that
//!   cannot be text-extracted is still a `.pptx` they want to download later.
//! - **Fall back to descriptor-only, silently.** This is this program's signature
//!   defect: the user believes the document is searchable, it is not, and nothing
//!   anywhere says so. It is exactly the bug being closed, one layer up.
//!
//! So: the file is **always** stored (extraction never fails an upload), and the
//! outcome is recorded in [`FileIndexStore`] as a durable per-document row. Three
//! surfaces carry it, all under the key `index` and all holding the identical
//! [`FileIndexRecord::to_json`] object, so a client needs one reader:
//!
//! - the **create** responses (`POST /api/uploads`, `POST /api/spaces/:id/files`),
//!   inline in the reply;
//! - `GET /api/spaces/:id/documents/:doc_id/index`, on demand for one document;
//! - `GET /api/spaces/:id/documents`, joined onto every `kind = 'file'` row by
//!   [`attach_index_states`] — one store read for the whole list, which is what
//!   lets a document list render searchability badges without one request per row.
//!
//! Four states, and the split between them is *what the user can do about it*:
//!
//! | state | meaning | user action |
//! |---|---|---|
//! | `pending` | extraction is running (a provider job) | wait — bounded, see below |
//! | `indexed` | contents are chunked and searchable | none |
//! | `skipped` | nothing on this node can read this format | install a `document.parse` app |
//! | `failed` | something tried and could not | read `message`; retry or fix the host |
//!
//! ## `pending` is a promise, and only the provider path may make it
//!
//! `pending` is written **immediately before the background task is spawned**, so a
//! client that reads the status the instant the upload returns sees "running" rather
//! than an absent row it would have to guess about — and so that nothing else can
//! claim it.
//!
//! That second half was the bug. The row used to be written right after the file was
//! stored, ahead of *both* branches and ahead of the `index_store()` lookup's own
//! early return; when that lookup came back `None` the function returned a `pending`
//! record having started nothing at all, and no later writer existed to correct it. A
//! client polled forever and a badge said "indexing…" about work that was never going
//! to happen. A status that reports healthy-in-progress for a dead thing is the exact
//! defect this module was built to remove, so it does not get to live inside it.
//!
//! The rule the code now keeps: **a row claims `pending` only on the one path that
//! goes on to spawn**. The floor branch never writes one (it is terminal before it
//! returns), and the no-status-store case no longer suppresses the extraction it
//! cannot record — see [`mark_pending`].
//!
//! ## …and a promise nobody is left to keep is broken on read
//!
//! Writing `pending` only where something spawns is necessary and not sufficient: the
//! spawned task is the *only* writer of the terminal row, and it dies with the process.
//! A Core restart or a panicked parse task leaves a row that says "indexing…" with
//! nothing behind it, forever — the same lie the paragraph above removes, arriving by a
//! different door.
//!
//! There is no sweeper and no boot hook. A row is judged where it is read: past
//! [`STALE_PENDING_AFTER`] (the poller's own hard ceiling plus the work it does outside
//! that ceiling) a `pending` row cannot have a live poller behind it, so
//! [`FileIndexStore::record_from_row`] — which **both** readers go through, so the
//! single-document view and the list view cannot disagree — reports it as `failed` with
//! [`REASON_PENDING_ABANDONED`]. Nothing is written back; see that constant.
//!
//! ## Inline vs background — one function, two floor signals
//!
//! [`crate::document_parse::ParseSubmission`] already makes the split: the builtin
//! floor (`.txt`/`.md`/`.csv`/…) is in-process, no network, milliseconds; a provider
//! parse is a submit-then-poll job that can run for minutes. So the floor is awaited
//! inline and the file is searchable the instant the upload returns, while a provider
//! parse is spawned and reported through the status row. That is one status writer
//! ([`record_parse_result`]) reached by two entry points, not two implementations.
//!
//! The floor is reached by two *signals*, not one: the filename extension, and — for a
//! name that carries no extension at all — the declared MIME type
//! ([`crate::document_parse::mime_floor_name`]). Two of the three callers pass a
//! **title** (`notes`), not a filename, and an extension-only floor sent those to a
//! provider that could only refuse them.
//!
//! ## What is testable, and the seam that makes it so
//!
//! [`index_store`] is hard-`None` under `cfg(test)` so no test can create
//! `~/.ryu/space-file-index.db` in a live profile. The cost is that
//! [`create_file_indexed`] — which also needs a whole [`ServerState`] — cannot be
//! called in-process at all. So every decision it makes lives in a function that can
//! be: [`crate::document_parse::mime_floor_name`] (pure), [`index_on_the_floor`]
//! (takes its store and its Spaces store), [`mark_pending`] (takes its store), and
//! [`record_parse_result`] (already did). What is left in `create_file_indexed` is
//! glue that decides nothing on its own.

use std::sync::{Arc, OnceLock};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::activity::sealed_store::{core_cipher, StoreSeal};
use crate::document_parse::{
    self, ParseFailure, ParseFailureReason, ParseOutcome, ParseSubmission,
};
use crate::server::spaces::{DocOwner, SpaceStore};
use crate::server::ServerState;
use ryu_crypto::content_sqlite::{ColumnPlan, KeyKind};
use ryu_crypto::ContentContext;

/// How long to wait between polls of a provider parse job.
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// Total wall-clock budget for a provider parse job before it is recorded as
/// [`ParseFailureReason::ProviderTimeout`].
///
/// Generous on purpose: OCR over a scanned 300-page report legitimately takes
/// minutes, and giving up early would write a `failed` row for a parse that was
/// about to succeed. Bounded all the same, because a job that never terminates must
/// not leave a `pending` row forever — an honest `failed` beats a permanent "still
/// working on it".
const POLL_BUDGET: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// Back-off between re-submissions of a parse whose provider answered
/// [`ParseFailureReason::ProviderTimeout`] at SUBMIT time — almost always a lazy
/// provider sidecar still provisioning its first start (venv + `pip install`, which
/// the sidecar manager keeps running detached). Bounded: after the last delay the
/// timeout is recorded as `failed` like any other. The total (~23 min, plus a wake
/// wait per attempt) sits inside the manager's 30-minute start budget, so a start
/// that will succeed is waited out and one that will not is not retried forever.
///
/// Only the submit is retried. A job that was accepted and then outran
/// [`POLL_BUDGET`] already cost a quarter hour; running it again is not a retry, it
/// is a second identical failure.
const SUBMIT_RETRY_DELAYS: &[std::time::Duration] = &[
    std::time::Duration::from_secs(15),
    std::time::Duration::from_secs(30),
    std::time::Duration::from_secs(60),
    std::time::Duration::from_secs(120),
    std::time::Duration::from_secs(240),
    std::time::Duration::from_secs(300),
    std::time::Duration::from_secs(300),
    std::time::Duration::from_secs(300),
];

/// Head-room added to [`POLL_BUDGET`] before a `pending` row is read as abandoned —
/// the work a provider parse legitimately does OUTSIDE the poll deadline.
///
/// Counted rather than guessed, because the whole demotion rests on it. From the
/// instant [`mark_pending`] writes the row to the instant [`record_parse_result`]
/// writes the terminal one, a live job can spend:
///
/// - `submit_blob`: up to `WAKE_TIMEOUT` (20 s) waking a lazy provider sidecar plus
///   one `PROVIDER_TIMEOUT` hop (30 s) — 50 s, all before the poll loop starts;
/// - the poll loop's own tail: [`poll_to_completion`] checks the deadline *after* the
///   call, so the last iteration may begin a millisecond under it and still cost
///   `POLL_INTERVAL` + a wake + a hop — another 52 s past `POLL_BUDGET`;
/// - `record_parse_result`: re-chunking and embedding up to 400 KB of extracted text,
///   which is seconds to low minutes on a busy local embedder.
///
/// Five minutes covers all three with room over. Erring long is the cheap direction:
/// a too-short margin demotes jobs that are still running, while a too-long one only
/// delays the honest answer for a row that is already dead.
const STALE_PENDING_GRACE: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// How old a `pending` row must be before a read reports it as abandoned.
///
/// **Derived from [`POLL_BUDGET`], never restated.** The demotion is only sound
/// because the poller has a hard ceiling and writes its own terminal row; if someone
/// raised the budget to 30 minutes and this were a literal `20 * 60`, the read path
/// would start declaring live parses dead and no test would notice.
const STALE_PENDING_AFTER: std::time::Duration = POLL_BUDGET.saturating_add(STALE_PENDING_GRACE);

/// Reason code for "the parser returned no text at all".
///
/// Not a [`ParseFailureReason`] variant: the parse *succeeded*, the document simply
/// has no extractable prose (an empty `.txt`, a `.csv` with only a header row that
/// trims to nothing). Recorded as `skipped` rather than `failed` because nothing
/// went wrong and there is nothing to retry.
pub const REASON_EMPTY_DOCUMENT: &str = "empty_document";

/// Reason code for a call site with no [`ServerState`] wired.
///
/// The `artifact.create` MCP tool reaches this module through
/// [`crate::learning::global_state`], which is `None` in test and CLI contexts. That
/// is "extraction was never attempted", NOT "extraction failed" — writing a `failed`
/// row here would make a bare CLI look like a broken parser install.
pub const REASON_NO_PARSE_CONTEXT: &str = "no_parse_context";

/// Reason code carried on a `pending` record when the status store could not be
/// opened: the parse **is** running, but its outcome will never be recorded.
///
/// The state is honestly `pending` — something was genuinely spawned, which is the
/// whole rule this module now keeps. What the code cannot honestly imply is that
/// polling will ever answer: with no store, every read of
/// `GET /api/spaces/:id/documents/:doc_id/index` degrades to `unattempted`, which is
/// that store's pre-existing contract for an unopenable db and not a new lie. This
/// code exists so a client can tell "poll me" from "polling will never answer".
///
/// Deliberately NOT a fifth [`IndexState`]: `as_str` is the one definition of the
/// stored wire spellings and a mirror test in the desktop client pins it to exactly
/// four. `unattempted` is synthesised by [`unknown_json`] for a document with no row
/// and has never been a stored state.
pub const REASON_STATUS_UNAVAILABLE: &str = "status_unavailable";

/// Reason code for a `pending` row that nothing is ever coming back to finish.
///
/// # The row that outlived its parse
///
/// `pending` is written immediately before the parse task is spawned, and the *only*
/// writer of the terminal row is that task. Two ordinary events kill it without a
/// word: **Core restarts** (the task is in-process; the row is on disk), and **the
/// task panics** (nothing joins it, so the panic is swallowed by the runtime). Either
/// way the document reads "indexing…" forever — a status that reports healthy work in
/// progress for a thing that is not running, which is the precise defect this module
/// was built to remove, surviving inside it.
///
/// # Why a read can decide this, and why it is a read that does
///
/// [`poll_to_completion`] has a hard ceiling ([`POLL_BUDGET`]) and writes its own
/// terminal row when it expires, so a row still saying `pending` well past that
/// ceiling ([`STALE_PENDING_AFTER`], which adds the work done outside the poll loop)
/// cannot have a live poller behind it. The inference needs no scheduler, no sweeper
/// and no boot hook — only the row's own `updated_at` — so it is made lazily, in
/// [`FileIndexStore::record_from_row`], where **every** reader inherits it.
///
/// Nothing is written back. The demotion is a synthesis over stored bytes, so a job
/// that somehow does finish later still overwrites the row with the truth, and the
/// next read stops demoting. Persisting it would put a write behind every list render
/// and turn a recoverable mis-timing into a stored lie.
///
/// Deliberately NOT a fifth [`IndexState`] — same constraint as
/// [`REASON_STATUS_UNAVAILABLE`]: `as_str` is the one definition of the stored wire
/// spellings and a desktop mirror test pins it to exactly four. The state is `failed`
/// ("something attempted the parse and could not finish it", which is exactly true)
/// and this code is what tells that apart from a parser that answered with an error.
pub const REASON_PENDING_ABANDONED: &str = "pending_abandoned";

// ── The record ────────────────────────────────────────────────────────────────

/// What happened to a file document's *contents* (as opposed to its descriptor).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexState {
    /// Extraction is in flight on a provider job.
    Pending,
    /// Contents are chunked, embedded, and (in graph mode) graph-extracted.
    Indexed,
    /// Nothing on this node can read this format. Not an error — a missing install.
    Skipped,
    /// Something attempted the parse and could not finish it.
    Failed,
}

impl IndexState {
    /// The stable wire string. Clients branch on this.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Indexed => "indexed",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
        }
    }

    fn from_str(s: &str) -> Self {
        match s {
            "indexed" => Self::Indexed,
            "skipped" => Self::Skipped,
            "failed" => Self::Failed,
            _ => Self::Pending,
        }
    }
}

/// One document's content-index status, with enough provenance that a future
/// re-index can tell rows extracted by an old backend from rows extracted by the
/// current one. Swapping the bound `document.parse` provider changes the extracted
/// text; a chunk set with no backend stamp cannot know which of its rows are stale.
#[derive(Debug, Clone)]
pub struct FileIndexRecord {
    pub doc_id: String,
    pub state: IndexState,
    /// Stable machine code — [`ParseFailureReason::code`] for a real parse failure,
    /// or one of this module's own ([`REASON_EMPTY_DOCUMENT`],
    /// [`REASON_NO_PARSE_CONTEXT`]). `None` when indexed.
    pub reason_code: Option<String>,
    /// Human-readable detail. Never the document's contents.
    pub message: Option<String>,
    /// `"builtin"` for the in-process floor, otherwise the provider's plugin id.
    pub backend_id: Option<String>,
    pub backend_version: Option<String>,
    /// Chunks written by the extraction, descriptor chunk included. `0` whenever the
    /// document is still descriptor-only.
    pub chunk_count: i64,
    /// Non-fatal notes from the parse: a lossy decode, a missing OCR tool, a
    /// truncated result. Surfaced rather than swallowed — a degraded parse the user
    /// cannot see is the silent-drop bug wearing a hat.
    pub warnings: Vec<String>,
    /// Unix milliseconds of the last state change.
    pub updated_at: i64,
}

impl FileIndexRecord {
    /// The wire shape carried by the create responses and the status route.
    pub fn to_json(&self) -> Value {
        json!({
            "document_id": self.doc_id,
            "state": self.state.as_str(),
            "reason_code": self.reason_code,
            "message": self.message,
            "backend_id": self.backend_id,
            "backend_version": self.backend_version,
            "chunk_count": self.chunk_count,
            "warnings": self.warnings,
            "updated_at": self.updated_at,
        })
    }

    fn pending(doc_id: &str) -> Self {
        Self {
            doc_id: doc_id.to_owned(),
            state: IndexState::Pending,
            reason_code: None,
            message: None,
            backend_id: None,
            backend_version: None,
            chunk_count: 0,
            warnings: Vec::new(),
            updated_at: now_millis(),
        }
    }
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Turn a `pending` row that nothing can still be working on into the `failed` row it
/// really is. Every other record passes through untouched.
///
/// The whole of [`REASON_PENDING_ABANDONED`] in one pure function: `now_ms` is a
/// parameter rather than a call so the rule is testable without sleeping for twenty
/// minutes, and so the two store readers cannot acquire different notions of "now".
///
/// Three deliberate non-behaviours:
///
/// - **Only `pending` is touched.** A terminal row is a recorded fact and ages into
///   nothing else, however old it gets.
/// - **`updated_at` keeps the stored value.** It is when the state last *changed*, and
///   the state changed when the parse was promised; stamping it with the read's clock
///   would tell a client this just happened and destroy the one piece of evidence
///   (how long ago) that explains the demotion.
/// - **A backwards clock demotes nothing.** An `updated_at` in the future gives a
///   NEGATIVE age, which is checked for explicitly (and before the `u128` cast, where
///   it would otherwise wrap into an enormous positive one and demote every row on the
///   node at once). A host whose clock jumped back reports "still running" until it
///   catches up.
fn demote_abandoned_pending(record: FileIndexRecord, now_ms: i64) -> FileIndexRecord {
    if record.state != IndexState::Pending {
        return record;
    }
    let age_ms = now_ms.saturating_sub(record.updated_at);
    if age_ms < 0 || (age_ms as u128) < STALE_PENDING_AFTER.as_millis() {
        return record;
    }
    let minutes = age_ms / 60_000;
    FileIndexRecord {
        state: IndexState::Failed,
        reason_code: Some(REASON_PENDING_ABANDONED.to_owned()),
        message: Some(format!(
            "extraction was started {minutes} minutes ago and never finished — the \
             node restarted, or the parse task died. Nothing is still running; \
             re-upload the file to try again."
        )),
        ..record
    }
}

// ── The store ─────────────────────────────────────────────────────────────────

/// SQLite-backed per-document index status (`~/.ryu/space-file-index.db`).
///
/// # Why a Core-side store rather than a `documents` column
///
/// "Were this document's contents extracted, by which backend, and if not why" is a
/// fact about the **`document.parse` capability**, which is Core-side and
/// hot-swappable. `ryu-spaces` knows nothing about parsers and must keep knowing
/// nothing (it has zero dependency on `apps/core`); teaching its schema a
/// parser-provenance vocabulary would invert that. Core already keeps ~10 small
/// single-purpose stores on this exact pattern (`apps.db`, `preferences.db`,
/// `activity.db`, `support-access-audit.db`); this is the eleventh.
///
/// Cheap to clone (wraps `Arc<Mutex<Connection>>`), mirroring
/// [`crate::support_access::SupportAccessStore`].
///
/// **Known gap, stated rather than hidden:** `SpaceStore::delete_document` lives in
/// the spaces crate and cannot call back here, so deleting a document leaves its
/// status row behind. The Core-side delete *route* clears it ([`forget`]), which
/// covers the user-facing path; a document deleted through any other in-process
/// caller orphans one row. Orphans are inert (ids are uuids, so a recycled id cannot
/// pick up a stale row) but they do accumulate.
///
/// `message` and `warnings` are sealed (`encb:v1:`, content key
/// `space-file-index.db`, AAD = the column and `doc_id`): provider errors and
/// parser notes can quote file names or contents. Messages this module writes
/// never name the file.
#[derive(Clone)]
pub struct FileIndexStore {
    conn: Arc<Mutex<Connection>>,
    seal: StoreSeal,
}

/// The content store name of `db/space-file-index.db`.
const FILE_INDEX_STORE: &str = "space-file-index.db";
const MESSAGE_PURPOSE: &str = "file_index_status.message";
const WARNINGS_PURPOSE: &str = "file_index_status.warnings";

/// The sealed columns, bound to `doc_id` (the migration's context must equal
/// the read/write path's: `ContentContext::for_id(<purpose>, doc_id)`).
fn file_index_plans() -> Result<Vec<ColumnPlan>> {
    Ok(vec![
        ColumnPlan::text("file_index_status", "message", "doc_id", KeyKind::Text)?
            .with_context(&[], |row| {
                ContentContext::for_id(MESSAGE_PURPOSE, row.key())
            })?,
        ColumnPlan::text("file_index_status", "warnings", "doc_id", KeyKind::Text)?
            .with_context(&[], |row| {
                ContentContext::for_id(WARNINGS_PURPOSE, row.key())
            })?,
    ])
}

/// One `file_index_status` row as stored (sealed columns not yet opened).
struct StoredRecord {
    record: FileIndexRecord,
    message: Option<String>,
    warnings: String,
}

fn default_db_path() -> std::path::PathBuf {
    crate::paths::db_path("space-file-index.db")
}

impl FileIndexStore {
    /// Open (or create) the store at the default on-disk path.
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path())
    }

    /// Open (or create) the store at a specific path.
    pub fn open(path: std::path::PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating space-file-index dir {}", parent.display()))?;
        }
        let mut conn = Connection::open(&path)
            .with_context(|| format!("opening space-file-index db {}", path.display()))?;
        Self::init_schema(&conn)?;
        // Seals legacy plaintext messages once (secure_delete first) and
        // scrubs the freed pages.
        let seal = StoreSeal::prepare(
            &mut conn,
            Some(&path),
            core_cipher(FILE_INDEX_STORE)?,
            &file_index_plans()?,
        )?;
        let conn = Arc::new(Mutex::new(conn));
        seal.defer_compaction(&conn, Some(&path));
        Ok(Self { conn, seal })
    }

    /// Open an in-memory store. A plain `pub fn` — not `#[cfg(test)]` — so the
    /// module's own tests and any future in-process harness can build one without
    /// touching `~/.ryu`, which no test may ever write to.
    ///
    /// Only tests call it today, hence the gate; `#[cfg(test)]` is deliberately NOT
    /// the gate, because that would make the next in-process harness re-add it and
    /// re-argue the same point.
    #[allow(dead_code)]
    pub fn open_in_memory() -> Result<Self> {
        let mut conn =
            Connection::open_in_memory().context("opening in-memory space-file-index db")?;
        Self::init_schema(&conn)?;
        let seal = StoreSeal::prepare(
            &mut conn,
            None,
            core_cipher(FILE_INDEX_STORE)?,
            &file_index_plans()?,
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            seal,
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS file_index_status (
                 doc_id          TEXT PRIMARY KEY,
                 state           TEXT NOT NULL,
                 reason_code     TEXT,
                 message         TEXT,
                 backend_id      TEXT,
                 backend_version TEXT,
                 chunk_count     INTEGER NOT NULL DEFAULT 0,
                 warnings        TEXT NOT NULL DEFAULT '[]',
                 updated_at      INTEGER NOT NULL
             );",
        )
        .context("initializing space-file-index schema")?;
        Ok(())
    }

    /// Write (or overwrite) a document's status. Last write wins: a `pending` row is
    /// replaced by the terminal state, never appended to.
    pub async fn put(&self, record: &FileIndexRecord) -> Result<()> {
        let warnings = serde_json::to_string(&record.warnings).unwrap_or_else(|_| "[]".to_owned());
        let warnings = self.seal.seal(
            &warnings,
            &ContentContext::for_id(WARNINGS_PURPOSE, &record.doc_id),
        )?;
        let message = self.seal.seal_opt(
            record.message.as_deref(),
            &ContentContext::for_id(MESSAGE_PURPOSE, &record.doc_id),
        )?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO file_index_status
                 (doc_id, state, reason_code, message, backend_id, backend_version,
                  chunk_count, warnings, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(doc_id) DO UPDATE SET
                 state           = excluded.state,
                 reason_code     = excluded.reason_code,
                 message         = excluded.message,
                 backend_id      = excluded.backend_id,
                 backend_version = excluded.backend_version,
                 chunk_count     = excluded.chunk_count,
                 warnings        = excluded.warnings,
                 updated_at      = excluded.updated_at",
            params![
                record.doc_id,
                record.state.as_str(),
                record.reason_code,
                message,
                record.backend_id,
                record.backend_version,
                record.chunk_count,
                warnings,
                record.updated_at,
            ],
        )
        .context("writing file index status")?;
        Ok(())
    }

    /// Decode one `file_index_status` row — **the single row decoder, and the single
    /// place the stale-`pending` demotion happens.**
    ///
    /// Both readers go through here, and that is structural rather than tidy: the
    /// per-document view ([`Self::get`]) and the list view ([`Self::get_many`]) render
    /// the same file, so a demotion applied in one and not the other would have them
    /// disagree about it — the badge saying "indexing…" next to a detail pane saying
    /// "failed", with no way for a user to tell which is lying. Two copies of the
    /// decode is how that drift starts.
    ///
    /// Split in two: [`Self::stored_from_row`] reads the columns (inside
    /// rusqlite's row closure), [`Self::record_from_row`] opens the sealed
    /// `message`/`warnings` and applies the demotion.
    fn stored_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRecord> {
        Ok(StoredRecord {
            record: FileIndexRecord {
                doc_id: row.get(0)?,
                state: IndexState::from_str(&row.get::<_, String>(1)?),
                reason_code: row.get(2)?,
                message: None,
                backend_id: row.get(4)?,
                backend_version: row.get(5)?,
                chunk_count: row.get(6)?,
                warnings: Vec::new(),
                updated_at: row.get(8)?,
            },
            message: row.get(3)?,
            warnings: row.get(7)?,
        })
    }

    fn record_from_row(&self, stored: StoredRecord) -> Result<FileIndexRecord> {
        let StoredRecord {
            mut record,
            message,
            warnings,
        } = stored;
        record.message = self.seal.open_opt(
            message.as_deref(),
            &ContentContext::for_id(MESSAGE_PURPOSE, &record.doc_id),
        )?;
        let warnings = self.seal.open(
            &warnings,
            &ContentContext::for_id(WARNINGS_PURPOSE, &record.doc_id),
        )?;
        record.warnings = serde_json::from_str(&warnings).unwrap_or_default();
        Ok(demote_abandoned_pending(record, now_millis()))
    }

    /// Read a document's status. `Ok(None)` means no extraction was ever attempted
    /// for this id — which is the honest answer for every file stored before this
    /// change shipped, and is deliberately distinct from `skipped`.
    ///
    /// A `pending` row older than [`STALE_PENDING_AFTER`] reads as `failed` — see
    /// [`REASON_PENDING_ABANDONED`] and [`Self::record_from_row`].
    pub async fn get(&self, doc_id: &str) -> Result<Option<FileIndexRecord>> {
        let conn = self.conn.lock().await;
        let record = conn
            .query_row(
                "SELECT doc_id, state, reason_code, message, backend_id, backend_version,
                        chunk_count, warnings, updated_at
                 FROM file_index_status WHERE doc_id = ?1",
                params![doc_id],
                Self::stored_from_row,
            )
            .optional()
            .context("reading file index status")?;
        drop(conn);
        record
            .map(|stored| self.record_from_row(stored))
            .transpose()
    }

    /// Read many documents' statuses in **one pass**, keyed by document id.
    ///
    /// The list surface's read. Without it, a Space's document list costs one HTTP
    /// round trip *per file row* to render a searchability badge — the desktop
    /// really did fan out like that, batched eight at a time, because [`Self::get`]
    /// was the only reader this store had.
    ///
    /// A missing id is simply **absent from the map**, never an error and never a
    /// zero value: the join that consumes this is a left join done in Rust
    /// ([`merge_index_into_documents`]), so "no row" has to stay distinguishable
    /// from "a row that says nothing happened". Those are `unattempted` and
    /// `skipped` respectively, and collapsing them is the defect this module exists
    /// to remove.
    ///
    /// Chunked, because the id list is unbounded: the **Uploads** system space
    /// collects every chat attachment and every editor paste on the node and is
    /// nothing but file rows, so a single `IN (…)` would eventually cross SQLite's
    /// host-parameter limit (999 on builds before 3.32) and start failing on
    /// exactly the nodes that use the product most.
    ///
    /// Rows come back through [`Self::record_from_row`], so an abandoned `pending`
    /// reads as `failed` here exactly as it does in [`Self::get`] — the list badge and
    /// the document's own status pane are the same file, and they must not disagree.
    pub async fn get_many(
        &self,
        doc_ids: &[String],
    ) -> Result<std::collections::HashMap<String, FileIndexRecord>> {
        /// Ids per `IN (…)`. Comfortably under the 999-parameter floor rather than
        /// tuned to it — the round trips are in-process and cost nothing worth
        /// trading a portability cliff for.
        const CHUNK: usize = 400;

        let mut out = std::collections::HashMap::with_capacity(doc_ids.len());
        if doc_ids.is_empty() {
            return Ok(out);
        }
        let conn = self.conn.lock().await;
        let mut skipped = 0u64;
        for chunk in doc_ids.chunks(CHUNK) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT doc_id, state, reason_code, message, backend_id, backend_version,
                        chunk_count, warnings, updated_at
                 FROM file_index_status WHERE doc_id IN ({placeholders})"
            );
            let mut stmt = conn
                .prepare(&sql)
                .context("preparing bulk file index status read")?;
            let rows = stmt
                .query_map(
                    rusqlite::params_from_iter(chunk.iter()),
                    Self::stored_from_row,
                )
                .context("reading bulk file index status")?;
            for stored in rows {
                let stored = stored.context("decoding bulk file index status row")?;
                // A row whose sealed detail does not open is skipped (the
                // document reads as unattempted) and counted.
                match self.record_from_row(stored) {
                    Ok(record) => {
                        out.insert(record.doc_id.clone(), record);
                    }
                    Err(_) => skipped += 1,
                }
            }
        }
        self.seal.count_unreadable(skipped);
        Ok(out)
    }

    /// Drop a document's status row. Called from the Core-side delete route so the
    /// common path does not orphan.
    pub async fn forget(&self, doc_id: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM file_index_status WHERE doc_id = ?1",
            params![doc_id],
        )
        .context("deleting file index status")?;
        Ok(())
    }
}

/// The process-wide status store, opened lazily on first use.
///
/// A global rather than a `ServerState` field because [`ServerState`] is built in
/// `main.rs` and the `artifact.create` tool reaches this module with no `State` at
/// all — the same shape, and the same reason, as
/// [`crate::learning::global_state`]. `None` when the db cannot be opened, which
/// degrades to "status is not recorded" and never to "the upload failed".
static INDEX_STORE: OnceLock<Option<FileIndexStore>> = OnceLock::new();

/// The lazily-opened global store.
///
/// **Hard-`None` under `cfg(test)`, and that is not a convenience.** This is reached
/// transitively — `artifact.create`'s own test calls `dispatch` →
/// [`create_file_indexed_detached`] → here — so without the gate a plain `cargo test`
/// creates `~/.ryu/space-file-index.db` (plus its `-wal`/`-shm`) in the *active
/// profile*, which is a real user's node. Tests that need a store construct
/// [`FileIndexStore::open_in_memory`] and pass it explicitly; every caller here
/// already degrades to "status is not recorded", never to a failed upload, so the
/// gate changes nothing else.
pub fn index_store() -> Option<&'static FileIndexStore> {
    #[cfg(test)]
    {
        return None;
    }
    #[cfg(not(test))]
    INDEX_STORE
        .get_or_init(|| match FileIndexStore::open_default() {
            Ok(store) => Some(store),
            Err(e) => {
                tracing::warn!("space file index status unavailable: {e:#}");
                None
            }
        })
        .as_ref()
}

// ── Recording an outcome ──────────────────────────────────────────────────────

/// Which state a parse failure lands in.
///
/// The split is *what the user can do about it*, not severity. `NoProvider` and
/// `Unsupported` mean nothing on this node claims the format — the fix is to install
/// a `document.parse` app, and calling that a failure would blame the file. The rest
/// mean something tried and could not.
///
/// [`ParseFailureReason::BlobUnavailable`] is on the `failed` side precisely because
/// of that split: it used to arrive as `Unsupported` (an empty `sha256` made
/// `blob_input_path` reject the address), so a document with a broken storage row was
/// reported as `skipped` — "install a `document.parse` app". No parser fixes a
/// missing blob.
///
/// [`ParseFailureReason::NotText`] is on it for the same reason. "The name said text
/// and the bytes are not" is not a missing install — installing every parser in the
/// Store would not make a mislabelled file readable by the *text floor* — so sending
/// the user shopping for one would be the same confidently-wrong remedy. The fix is
/// the file's name or declared type, which `message` names.
const fn state_for(reason: ParseFailureReason) -> IndexState {
    match reason {
        ParseFailureReason::NoProvider | ParseFailureReason::Unsupported => IndexState::Skipped,
        ParseFailureReason::ProviderTimeout
        | ParseFailureReason::ProviderError
        | ParseFailureReason::TooLarge
        | ParseFailureReason::PythonMissing
        | ParseFailureReason::BlobUnavailable
        | ParseFailureReason::NotText => IndexState::Failed,
    }
}

/// The descriptor text [`ryu_spaces::SpaceStore::create_file`] embeds as a file's
/// only chunk. Reproduced here — not imported — because it is that method's private
/// format and this module's job is to *preserve* it, not to share ownership of it.
/// A drift between the two costs filename retrieval on extracted documents only,
/// which is why `descriptor_is_chunk_zero_so_filename_retrieval_survives` pins it.
fn descriptor(title: &str, mime: &str) -> String {
    format!("{title}\n{mime}")
}

/// **The single status writer.** Apply a finished parse to a stored file document:
/// re-chunk on success, leave the descriptor alone on failure, record either way.
///
/// Both entry points (the inline floor and the background provider job) end here, so
/// there is exactly one place that decides what a given parse result means for the
/// index and for the row a client reads.
///
/// "Single writer" is scoped to *parse results*, and the two rows that are not one say
/// so in their own vocabulary: [`mark_pending`] writes the promise that a parse is
/// about to start, and [`create_file_indexed_detached`] writes
/// [`REASON_NO_PARSE_CONTEXT`] for a call site where no parse was ever attempted.
/// Neither has a [`ParseOutcome`] or a [`ParseFailure`] to interpret, which is exactly
/// why routing them through here would mean inventing one.
///
/// # What "failure" does to the chunk set: nothing
///
/// On any failure the document keeps the single descriptor chunk
/// [`ryu_spaces::SpaceStore::create_file`] wrote — byte-identical, because this
/// function simply does not call the store. That is the behaviour the pre-existing
/// upload path had for *every* file, and it stays exactly that for files whose
/// contents cannot be extracted. The only thing that changes for them is that
/// somebody can now find out.
///
/// # Why `store` is optional
///
/// The status store is bookkeeping; the **re-chunk is the product**. When
/// [`index_store`] cannot be opened this still runs the extraction and still writes
/// the chunks — it simply has nowhere to persist the row. Taking `Option` here rather
/// than growing a second writer keeps the "one place decides what a parse result
/// means" property that the rest of this module's honesty rests on.
pub async fn record_parse_result(
    store: Option<&FileIndexStore>,
    spaces: &SpaceStore,
    doc_id: &str,
    title: &str,
    mime: &str,
    result: Result<ParseOutcome, ParseFailure>,
) -> FileIndexRecord {
    let record = match result {
        Err(failure) => FileIndexRecord {
            doc_id: doc_id.to_owned(),
            state: state_for(failure.reason),
            reason_code: Some(failure.reason.code().to_owned()),
            message: Some(failure.message),
            backend_id: None,
            backend_version: None,
            chunk_count: 0,
            warnings: Vec::new(),
            updated_at: now_millis(),
        },
        Ok(outcome) if outcome.markdown.trim().is_empty() => FileIndexRecord {
            doc_id: doc_id.to_owned(),
            state: IndexState::Skipped,
            reason_code: Some(REASON_EMPTY_DOCUMENT.to_owned()),
            // Never the title: this row lives outside spaces.db, which seals it.
            message: Some("this file contains no extractable text".to_owned()),
            backend_id: Some(outcome.backend_id),
            backend_version: Some(outcome.backend_version),
            chunk_count: 0,
            warnings: outcome.warnings,
            updated_at: now_millis(),
        },
        Ok(outcome) => {
            // The descriptor leads as its own paragraph. `chunk_text` flushes at
            // every `\n\n`, so it becomes chunk zero verbatim-in-content and the
            // filename stays as findable as it was before extraction — extraction
            // ADDS reach, it never trades one kind of hit for another.
            let indexed_text =
                format!("{}\n\n{}", descriptor(title, mime), outcome.markdown.trim());
            match spaces.replace_file_chunks(doc_id, &indexed_text).await {
                Ok(chunk_count) => FileIndexRecord {
                    doc_id: doc_id.to_owned(),
                    state: IndexState::Indexed,
                    reason_code: None,
                    message: None,
                    backend_id: Some(outcome.backend_id),
                    backend_version: Some(outcome.backend_version),
                    chunk_count: chunk_count as i64,
                    warnings: outcome.warnings,
                    updated_at: now_millis(),
                },
                // The text was extracted but could not be stored (the document was
                // deleted mid-parse, the embedder is down). A parse-shaped code
                // would be a lie, so this reuses `provider_error` only for its
                // vocabulary and says what actually happened in `message`.
                Err(e) => FileIndexRecord {
                    doc_id: doc_id.to_owned(),
                    state: IndexState::Failed,
                    reason_code: Some(ParseFailureReason::ProviderError.code().to_owned()),
                    message: Some(format!("extracted text could not be indexed: {e:#}")),
                    backend_id: Some(outcome.backend_id),
                    backend_version: Some(outcome.backend_version),
                    chunk_count: 0,
                    warnings: outcome.warnings,
                    updated_at: now_millis(),
                },
            }
        }
    };

    if let Some(store) = store {
        if let Err(e) = store.put(&record).await {
            // A status row that cannot be written must not take the upload down with it.
            tracing::warn!("recording index status for {doc_id}: {e:#}");
        }
    }
    record
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/// The result of an indexed file creation: the new document id plus what is known
/// about its contents *right now*. For a floor-readable file that is already
/// terminal; for a provider parse it is `pending`.
#[derive(Debug, Clone)]
pub struct IndexedFile {
    pub document_id: String,
    pub index: FileIndexRecord,
}

/// **Store a file in a Space and index its contents.** The one path all three
/// `create_file` callers take.
///
/// Never fails because of extraction: the returned `Err` can only come from the
/// store call that persists the bytes. If parsing is impossible, unavailable, or
/// broken, the file is still stored and `index` says which.
///
/// # Where the decisions live
///
/// Nothing here decides anything by itself, on purpose: this function needs a whole
/// [`ServerState`] and the process-wide [`index_store`], so no test can call it (see
/// the module doc). Every branch it takes is computed by something that a test *can*
/// call — [`document_parse::is_builtin_readable`] and
/// [`document_parse::mime_floor_name`] for the route, [`index_on_the_floor`] for the
/// terminal record, [`mark_pending`] for the promise.
pub async fn create_file_indexed(
    state: &ServerState,
    space_id: &str,
    title: &str,
    bytes: &[u8],
    mime: &str,
    tenancy: &DocOwner,
) -> Result<IndexedFile> {
    // 1. Store first. This writes the blob (which a provider will read by path) and
    //    the descriptor chunk, and it is the only step allowed to fail the caller.
    let document_id = state
        .spaces
        .create_file(space_id, title, bytes, mime, tenancy)
        .await?;
    let meta = state
        .spaces
        .get_file_meta(&document_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("stored file '{document_id}' disappeared"))?;
    index_stored_file(state, document_id, title, bytes, mime, &meta.sha256).await
}

/// Replace a stored file revision, then index exactly that revision.
///
/// The expected SHA follows the async provider job so a slower parse of an older
/// save can never overwrite chunks or status belonging to a newer save.
pub async fn replace_file_indexed(
    state: &ServerState,
    document_id: &str,
    bytes: &[u8],
    mime: &str,
) -> Result<IndexedFile> {
    let meta = state
        .spaces
        .replace_file_blob(document_id, bytes, mime)
        .await?;
    index_stored_file(
        state,
        document_id.to_owned(),
        &meta.title,
        bytes,
        mime,
        &meta.sha256,
    )
    .await
}

async fn index_stored_file(
    state: &ServerState,
    document_id: String,
    title: &str,
    bytes: &[u8],
    mime: &str,
    expected_sha256: &str,
) -> Result<IndexedFile> {
    // `None` when the status db could not be opened. That degrades reporting only:
    // it must never decide whether the contents get extracted, which is the coupling
    // that used to strand a document at `pending` forever.
    let store = index_store();

    // 2a. The builtin floor, by extension: in-process, no network, milliseconds.
    //     Awaited, so a `.md`/`.csv`/`.txt` upload is searchable by its contents the
    //     moment the response is written — and terminal, so it never writes a
    //     `pending` row at all.
    if document_parse::is_builtin_readable(title) {
        return Ok(index_on_the_floor(
            store,
            &state.spaces,
            document_id,
            title,
            title,
            mime,
            bytes,
        )
        .await);
    }

    // 2b. The same floor, reached by MIME. Two of the three callers pass a *title*
    //     (`notes`) rather than a filename, and the floor keys on the extension, so
    //     without this a `text/plain` note is handed to a provider that will refuse
    //     it — `skipped/no_provider`, "install a document parser", for a file Core
    //     reads itself. Only fires when the title carries no extension at all; see
    //     [`document_parse::mime_floor_name`] for why a title that HAS one is never
    //     overruled by its mime.
    if let Some(floor_name) = document_parse::mime_floor_name(title, mime) {
        return Ok(index_on_the_floor(
            store,
            &state.spaces,
            document_id,
            &floor_name,
            title,
            mime,
            bytes,
        )
        .await);
    }

    // 3. Everything else goes to the bound provider as a job. Spawned, because a
    //    scanned 300-page PDF is minutes of OCR and no upload request may hold a
    //    connection open for that — and this is the ONLY path allowed to promise
    //    `pending`, which is why the mark sits here, one statement above the spawn,
    //    instead of ahead of the branches.
    let index = mark_pending(store, &document_id).await;
    let task_state = state.clone();
    let (doc, t, m) = (document_id.clone(), title.to_owned(), mime.to_owned());
    let expected_sha256 = expected_sha256.to_owned();
    let size = bytes.len() as u64;
    tokio::spawn(async move {
        index_via_provider(&task_state, store, &doc, &t, &m, size, &expected_sha256).await;
    });

    Ok(IndexedFile { document_id, index })
}

/// Read a stored file with the in-process floor and record what that produced.
///
/// # The two names are not the same name
///
/// `floor_name` is what the floor **judges** the bytes by — `notes.txt` for a
/// `text/plain` document titled `notes` — and it decides both the decode and the HTML
/// tag-strip. `title` is the document's own title and must stay untouched: it is half
/// of the `{title}\n{mime}` descriptor [`ryu_spaces::SpaceStore::create_file`] already
/// wrote, and [`record_parse_result`] has to reproduce it byte-for-byte or the
/// filename stops being retrievable. Swapping the two would silently re-point the
/// descriptor at a synthesised filename for exactly the mime-fallback case.
async fn index_on_the_floor(
    store: Option<&FileIndexStore>,
    spaces: &SpaceStore,
    document_id: String,
    floor_name: &str,
    title: &str,
    mime: &str,
    bytes: &[u8],
) -> IndexedFile {
    let parsed = document_parse::builtin_parse(floor_name, bytes);
    let index = record_parse_result(store, spaces, &document_id, title, mime, parsed).await;
    IndexedFile { document_id, index }
}

/// Write the `pending` row for a parse that is about to be spawned, and return the
/// record the create response carries inline.
///
/// **Only call this immediately before spawning.** `pending` is a promise that
/// something is running; the previous version of this module made that promise ahead
/// of the branch that decides whether anything runs at all, and nothing ever came back
/// to break it.
///
/// With no store the promise is still true — the caller spawns either way — but it
/// cannot be *observed*, because every status read will answer `unattempted`. That is
/// reported in-band with [`REASON_STATUS_UNAVAILABLE`] rather than papered over:
/// silently handing back a bare `pending` a client can poll forever is the same defect
/// in a different costume.
async fn mark_pending(store: Option<&FileIndexStore>, doc_id: &str) -> FileIndexRecord {
    let mut pending = FileIndexRecord::pending(doc_id);
    match store {
        Some(store) => {
            if let Err(e) = store.put(&pending).await {
                tracing::warn!("marking {doc_id} pending: {e:#}");
            }
        }
        None => {
            pending.reason_code = Some(REASON_STATUS_UNAVAILABLE.to_owned());
            pending.message = Some(
                "extraction is running, but this node cannot record its outcome, so \
                 polling this document's index status will keep reporting 'unattempted'"
                    .to_owned(),
            );
        }
    }
    pending
}

/// The `artifact.create` variant: same path, reached without a [`ServerState`].
///
/// The MCP registry holds a [`SpaceStore`] but no `ServerState`, so it borrows the
/// published handle ([`crate::learning::global_state`]) the way `mcp/mod.rs` already
/// does for other tools. When that is unset — test and CLI contexts — the file is
/// still stored and the status says extraction was never *attempted*
/// ([`REASON_NO_PARSE_CONTEXT`]), which a bare CLI must not be able to confuse with
/// a broken parser install.
pub async fn create_file_indexed_detached(
    spaces: &SpaceStore,
    space_id: &str,
    title: &str,
    bytes: &[u8],
    mime: &str,
    tenancy: &DocOwner,
) -> Result<IndexedFile> {
    if let Some(state) = crate::learning::global_state() {
        return create_file_indexed(&state, space_id, title, bytes, mime, tenancy).await;
    }

    let document_id = spaces
        .create_file(space_id, title, bytes, mime, tenancy)
        .await?;
    let record = FileIndexRecord {
        doc_id: document_id.clone(),
        state: IndexState::Skipped,
        reason_code: Some(REASON_NO_PARSE_CONTEXT.to_owned()),
        message: Some("no server context is wired here, so contents were not extracted".to_owned()),
        backend_id: None,
        backend_version: None,
        chunk_count: 0,
        warnings: Vec::new(),
        updated_at: now_millis(),
    };
    if let Some(store) = index_store() {
        if let Err(e) = store.put(&record).await {
            tracing::warn!("recording index status for {document_id}: {e:#}");
        }
    }
    Ok(IndexedFile {
        document_id,
        index: record,
    })
}

/// Submit a stored blob to the bound provider and poll it to a terminal state.
///
/// Resolves the blob address from the document row rather than carrying the bytes
/// into the task: the provider opens the file itself (see
/// [`document_parse::submit_blob`]), so holding a 200 MiB `Vec<u8>` alive for the
/// duration of an OCR job would be pure waste.
async fn index_via_provider(
    state: &ServerState,
    store: Option<&FileIndexStore>,
    doc_id: &str,
    title: &str,
    mime: &str,
    size: u64,
    expected_sha256: &str,
) {
    let meta = match state.spaces.get_file_meta(doc_id).await {
        Ok(Some(m)) if m.sha256 == expected_sha256 => m,
        Ok(Some(_)) => return,
        Ok(None) | Err(_) => {
            let failure = ParseFailure::new(
                ParseFailureReason::ProviderError,
                "the file document disappeared before extraction started",
            );
            record_parse_result(store, &state.spaces, doc_id, title, mime, Err(failure)).await;
            return;
        }
    };

    // A provider still starting answers `provider_timeout` at submit; re-submit with
    // back-off instead of writing a `failed` row nothing would ever revisit. Each
    // retry first re-checks that this revision is still current (a replaced or
    // deleted document ends the loop; the final sha check below then drops it) and
    // re-writes `pending`, which restarts the clock `STALE_PENDING_AFTER` is
    // measured on so a long wait for the provider is not read as abandoned.
    let submission = retry_submit_while_provider_starting(SUBMIT_RETRY_DELAYS, |attempt| {
        let sha256 = meta.sha256.clone();
        async move {
            if attempt > 0 {
                match state.spaces.get_file_meta(doc_id).await {
                    Ok(Some(current)) if current.sha256 == expected_sha256 => {}
                    _ => {
                        return Err(ParseFailure::new(
                            ParseFailureReason::ProviderError,
                            "the file changed while waiting for the document parser",
                        ))
                    }
                }
                mark_pending(store, doc_id).await;
            }
            document_parse::submit_blob(state, &sha256, title, mime, size).await
        }
    })
    .await;
    let result = match submission {
        Err(failure) => Err(failure),
        Ok(ParseSubmission::Done(outcome)) => Ok(*outcome),
        Ok(ParseSubmission::Job { job_id, .. }) => {
            poll_to_completion(state, &job_id, &meta.sha256).await
        }
    };
    match state.spaces.get_file_meta(doc_id).await {
        Ok(Some(current)) if current.sha256 == expected_sha256 => {}
        _ => return,
    }
    record_parse_result(store, &state.spaces, doc_id, title, mime, result).await;
}

/// Run `submit` (called with the 0-based attempt number) and, while it fails with
/// [`ParseFailureReason::ProviderTimeout`], sleep the next of `delays` and run it
/// again. Any other outcome — success, a different failure, or the delays running
/// out — is returned as is.
async fn retry_submit_while_provider_starting<T, F, Fut>(
    delays: &[std::time::Duration],
    mut submit: F,
) -> Result<T, ParseFailure>
where
    F: FnMut(usize) -> Fut,
    Fut: std::future::Future<Output = Result<T, ParseFailure>>,
{
    let mut attempt = 0;
    loop {
        match submit(attempt).await {
            Err(failure) if failure.reason == ParseFailureReason::ProviderTimeout => {
                let Some(delay) = delays.get(attempt) else {
                    return Err(failure);
                };
                tracing::info!(
                    "document parser not ready (attempt {}): {}; retrying in {}s",
                    attempt + 1,
                    failure.message,
                    delay.as_secs()
                );
                tokio::time::sleep(*delay).await;
                attempt += 1;
            }
            other => return other,
        }
    }
}

/// Poll a provider job until it terminates or [`POLL_BUDGET`] runs out.
///
/// A budget expiry is reported as [`ParseFailureReason::ProviderTimeout`] — a real,
/// retryable answer — rather than leaving the row `pending` forever, which would be
/// indistinguishable from "still working" and therefore useless.
async fn poll_to_completion(
    state: &ServerState,
    job_id: &str,
    source_sha256: &str,
) -> Result<ParseOutcome, ParseFailure> {
    let deadline = std::time::Instant::now() + POLL_BUDGET;
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        match document_parse::job_outcome(state, job_id, source_sha256).await {
            Ok(Some(outcome)) => return Ok(outcome),
            // Still running.
            Ok(None) => {}
            Err(failure) => return Err(failure),
        }
        if std::time::Instant::now() >= deadline {
            // Abandoned: delete the decrypted input now.
            document_parse::release_input(job_id);
            return Err(ParseFailure::new(
                ParseFailureReason::ProviderTimeout,
                format!(
                    "extraction did not finish within {} seconds",
                    POLL_BUDGET.as_secs()
                ),
            ));
        }
    }
}

/// The status a client sees for a document with no row: extraction was never
/// attempted. Every file stored before this change is in that state, and it is
/// deliberately not `skipped` — nobody looked, as opposed to nobody could read it.
pub fn unknown_json(doc_id: &str) -> Value {
    json!({
        "document_id": doc_id,
        "state": "unattempted",
        "reason_code": Value::Null,
        "message": "no content extraction has been attempted for this document",
        "backend_id": Value::Null,
        "backend_version": Value::Null,
        "chunk_count": 0,
        "warnings": [],
        "updated_at": Value::Null,
    })
}

/// The status JSON for `doc_id`, falling back to [`unknown_json`].
pub async fn status_json(doc_id: &str) -> Value {
    match index_store() {
        Some(store) => match store.get(doc_id).await {
            Ok(Some(record)) => record.to_json(),
            _ => unknown_json(doc_id),
        },
        None => unknown_json(doc_id),
    }
}

// ── The list join ─────────────────────────────────────────────────────────────

/// The `kind` discriminator [`ryu_spaces::SpaceStore::create_file`] writes.
///
/// The join below keys off this and nothing else. Restated here rather than
/// imported because the spaces crate stores it as a bare string literal in an
/// `INSERT`; if that ever becomes a constant over there, this is the single place
/// to re-point.
pub const FILE_DOCUMENT_KIND: &str = "file";

/// The key a joined status is serialized under on a document list row.
///
/// The **same key** the create responses already use (`"index"` in `create_file` /
/// `upload_file`), holding the **same object** ([`FileIndexRecord::to_json`]), so a
/// client needs one reader for both. Re-spelling it here without re-spelling it
/// there would give the desktop two shapes to maintain for one fact.
pub const LIST_INDEX_KEY: &str = "index";

/// Attach each file row's status to a serialized document list, in place.
///
/// The pure half of the join, separated from the I/O so it is testable: the global
/// [`index_store`] is hard-`None` under `cfg(test)`, so a test that went through the
/// async wrapper would assert nothing at all while passing.
///
/// Two rules, and both are load-bearing:
///
/// 1. **Only `kind == "file"` rows are touched.** A page, database, whiteboard or
///    app document is re-chunked from its own source on every save, so it has no
///    status row and never will. Stamping `unattempted` on one would be a fresh
///    overclaim of exactly the kind this module exists to remove — the desktop reads
///    an absent field as "say nothing" and renders the row as it always did, which
///    is the correct answer for a document the question does not apply to.
/// 2. **A file with no row gets [`unknown_json`], never omission.** "No extraction
///    was attempted" is a real, distinct answer (every file stored before extraction
///    shipped is in it), and a dropped field would be indistinguishable from an old
///    Core that cannot answer at all.
///
/// # The records must already have come through the store
///
/// This takes a map rather than reading one, which means it inherits — and cannot
/// enforce — the stale-`pending` demotion in [`FileIndexStore::record_from_row`].
/// [`attach_index_states`] is the sanctioned source and gets its map from
/// [`FileIndexStore::get_many`], so the rows it passes here are already judged. A
/// second caller that assembles records some other way would hand a client the
/// `pending`-forever row this module removes, and nothing here would catch it.
pub fn merge_index_into_documents(
    rows: &mut [Value],
    records: &std::collections::HashMap<String, FileIndexRecord>,
) {
    for row in rows.iter_mut() {
        let Some(object) = row.as_object_mut() else {
            continue;
        };
        if object.get("kind").and_then(Value::as_str) != Some(FILE_DOCUMENT_KIND) {
            continue;
        }
        let Some(doc_id) = object.get("id").and_then(Value::as_str).map(str::to_owned) else {
            continue;
        };
        let index = records
            .get(&doc_id)
            .map_or_else(|| unknown_json(&doc_id), FileIndexRecord::to_json);
        object.insert(LIST_INDEX_KEY.to_owned(), index);
    }
}

/// Join content-index state onto a serialized `GET /api/spaces/:id/documents`
/// payload — **one store read for the whole list**.
///
/// # Why this exists rather than a per-document fetch
///
/// The status is a fact about the [`crate::document_parse`] capability and lives in
/// this module's own SQLite store, not in the `documents` table (`ryu-spaces` has
/// zero dependency on `apps/core` and must keep it — see this module's header). So a
/// list surface that wants to say anything true about searchability had to ask per
/// row, and the desktop did: one HTTP request per file, batched eight at a time,
/// against a Space whose size is bounded by nothing. One badge per row cost one
/// round trip per row.
///
/// This is that join done once: collect the file rows' ids, one chunked
/// [`FileIndexStore::get_many`], then a left join in memory.
///
/// # Access
///
/// Deliberately **no ACL of its own.** The caller has already filtered the list
/// through `caller_doc_filter`, so every row reaching this function is a row the
/// caller may read; state is attached to those rows and no others. Adding a second
/// check here would be a different, weaker copy of the one that already ran.
///
/// # Degradation
///
/// No store (it failed to open, or `cfg(test)`) means every file row reads
/// `unattempted` rather than the list failing — the filenames are why the user
/// opened the Space, and a status column must never be able to take them away. Same
/// posture as [`status_json`].
pub async fn attach_index_states(rows: &mut [Value]) {
    let file_ids: Vec<String> = rows
        .iter()
        .filter_map(|row| {
            let object = row.as_object()?;
            if object.get("kind").and_then(Value::as_str) != Some(FILE_DOCUMENT_KIND) {
                return None;
            }
            object.get("id").and_then(Value::as_str).map(str::to_owned)
        })
        .collect();
    if file_ids.is_empty() {
        return;
    }
    let records = match index_store() {
        Some(store) => store.get_many(&file_ids).await.unwrap_or_else(|e| {
            tracing::warn!("bulk file index status read failed: {e:#}");
            std::collections::HashMap::new()
        }),
        None => std::collections::HashMap::new(),
    };
    merge_index_into_documents(rows, &records);
}

/// Best-effort removal of a deleted document's status row. Never surfaces an error:
/// failing a delete because a status row would not drop would be absurd.
pub async fn forget(doc_id: &str) {
    if let Some(store) = index_store() {
        if let Err(e) = store.forget(doc_id).await {
            tracing::debug!("clearing index status for {doc_id}: {e:#}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::spaces::RetrievalMode;

    /// A prose fixture whose distinctive terms appear ONLY in the contents. If a
    /// query for one of these hits, it hit the extracted text — the filename cannot
    /// have produced it.
    const CONTENTS: &str =
        "Quokkas are small macropods native to Rottnest Island. The colony there \
         subsists largely on native grasses and succulents.";

    fn file_contains(path: &std::path::Path, needle: &str) -> bool {
        let mut bytes = std::fs::read(path).unwrap_or_default();
        let mut wal = path.as_os_str().to_owned();
        wal.push("-wal");
        bytes.extend(std::fs::read(std::path::PathBuf::from(wal)).unwrap_or_default());
        bytes
            .windows(needle.len())
            .any(|window| window == needle.as_bytes())
    }

    #[tokio::test]
    async fn status_detail_is_sealed_on_disk_and_legacy_rows_still_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("space-file-index.db");
        // A row an older build wrote in plaintext, title in the message.
        {
            let conn = Connection::open(&path).unwrap();
            FileIndexStore::init_schema(&conn).unwrap();
            conn.execute(
                "INSERT INTO file_index_status (doc_id, state, message, warnings, updated_at)
                 VALUES ('legacy', 'skipped', 'Secret Merger Plan contains no extractable text',
                         '[\"Secret Merger lossy decode\"]', 1)",
                [],
            )
            .unwrap();
        }
        let store = FileIndexStore::open(path.clone()).unwrap();
        let legacy = store.get("legacy").await.unwrap().unwrap();
        assert_eq!(
            legacy.message.as_deref(),
            Some("Secret Merger Plan contains no extractable text")
        );
        assert_eq!(
            legacy.warnings,
            vec!["Secret Merger lossy decode".to_owned()]
        );

        let record = FileIndexRecord {
            doc_id: "new".to_owned(),
            state: IndexState::Failed,
            reason_code: Some("provider_error".to_owned()),
            message: Some("the provider rejected Quarterly Kumquat.docx".to_owned()),
            backend_id: None,
            backend_version: None,
            chunk_count: 0,
            warnings: vec!["Kumquat page 3 unreadable".to_owned()],
            updated_at: now_millis(),
        };
        store.put(&record).await.unwrap();
        let read = store.get("new").await.unwrap().unwrap();
        assert_eq!(read.message, record.message);
        assert_eq!(read.warnings, record.warnings);

        {
            let conn = store.conn.lock().await;
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
                .unwrap();
        }
        for secret in ["Secret Merger", "Kumquat"] {
            assert!(!file_contains(&path, secret), "{secret:?} is on disk");
        }

        // A sealed value moved to another row does not open: a read by id
        // fails, a list skips the row.
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE file_index_status
                 SET message = (SELECT message FROM file_index_status WHERE doc_id = 'new')
                 WHERE doc_id = 'legacy'",
                [],
            )
            .unwrap();
        }
        assert!(store.get("legacy").await.is_err());
        let many = store
            .get_many(&["legacy".to_owned(), "new".to_owned()])
            .await
            .unwrap();
        assert!(many.contains_key("new"));
        assert!(!many.contains_key("legacy"));
        drop(store);

        // Reopening runs the migration again and changes nothing.
        let again = FileIndexStore::open(path).unwrap();
        assert_eq!(
            again.get("new").await.unwrap().unwrap().message,
            record.message
        );
    }

    #[tokio::test]
    async fn an_empty_extraction_message_does_not_name_the_file() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let store = FileIndexStore::open_in_memory().unwrap();
        let (_space, doc) = stored_file(&spaces, RetrievalMode::Vector).await;
        let record = record_parse_result(
            Some(&store),
            &spaces,
            &doc,
            "Confidential Kumquat Notes",
            "text/markdown",
            floor_outcome("   "),
        )
        .await;
        let message = record.message.unwrap_or_default();
        assert!(!message.contains("Kumquat"), "{message}");
    }

    /// Build a stored `.md` file whose filename shares no term with its contents.
    async fn stored_file(spaces: &SpaceStore, mode: RetrievalMode) -> (String, String) {
        let space = spaces
            .create_space_with_mode("S", None, mode, &DocOwner::unattributed())
            .await
            .unwrap();
        let doc = spaces
            .create_file(
                &space,
                "attachment-7.md",
                CONTENTS.as_bytes(),
                "text/markdown",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        (space, doc)
    }

    fn floor_outcome(text: &str) -> Result<ParseOutcome, ParseFailure> {
        document_parse::builtin_parse("attachment-7.md", text.as_bytes())
    }

    // ── The gap itself ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn create_file_alone_indexes_only_the_filename() {
        // The status quo this unit exists to change, pinned so the two tests below
        // are demonstrably about extraction and not about some other difference.
        let spaces = SpaceStore::open_in_memory().unwrap();
        let (space, _doc) = stored_file(&spaces, RetrievalMode::Vector).await;

        let by_name = spaces.search(&space, "attachment-7.md", 5).await.unwrap();
        assert!(!by_name.is_empty(), "the descriptor was always findable");
        let by_contents = spaces.search(&space, "Rottnest quokkas", 5).await.unwrap();
        assert!(
            by_contents.iter().all(|c| !c.content.contains("Rottnest")),
            "before indexing, no chunk can contain the file's contents: {by_contents:?}"
        );
    }

    #[tokio::test]
    async fn uploaded_file_becomes_searchable_by_its_contents_in_vector_mode() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let store = FileIndexStore::open_in_memory().unwrap();
        let (space, doc) = stored_file(&spaces, RetrievalMode::Vector).await;

        let record = record_parse_result(
            Some(&store),
            &spaces,
            &doc,
            "attachment-7.md",
            "text/markdown",
            floor_outcome(CONTENTS),
        )
        .await;

        assert_eq!(record.state, IndexState::Indexed);
        assert_eq!(record.backend_id.as_deref(), Some("builtin"));
        assert!(record.chunk_count >= 2, "descriptor + contents: {record:?}");

        let hits = spaces
            .search(&space, "quokkas Rottnest grasses", 5)
            .await
            .unwrap();
        assert!(
            hits.iter().any(|c| c.content.contains("Rottnest")),
            "contents must be retrievable, got: {hits:?}"
        );
    }

    /// A three-paragraph fixture — so [`chunk_text`](ryu_spaces) flushes it into three
    /// chunks — shaped for multi-hop traversal, mirroring the crate's own
    /// Alice→Acme→Paris graph test:
    ///
    /// - chunk A: `Quokka`, `works`, `Acme`
    /// - chunk B: `Acme`, `based`, `Perth`
    /// - chunk C: `Perth`, `Rottnest`, `ferry`
    ///
    /// Querying `Quokka` reaches chunk C only via `Quokka → Acme → Perth`. Chunk C
    /// shares **zero tokens** with the query, so a hit on it cannot have come from
    /// nearest-neighbour scoring — which is what makes this discriminate.
    const GRAPH_CONTENTS: &str = "Quokka works at Acme.\n\n\
         Acme is based in Perth.\n\n\
         Perth has the Rottnest ferry.";

    #[tokio::test]
    async fn uploaded_file_becomes_searchable_by_its_contents_in_graph_mode() {
        // Graph mode needs its own assertion because `insert_chunks` branches on the
        // Space's `RetrievalMode` read inside its transaction: writing chunks is not
        // enough, the entity/edge rows have to exist too or traversal finds nothing.
        //
        // Asserting "a chunk containing the query term came back" would NOT prove
        // that — the chunk exists either way and the reranker would surface it. So
        // the assertion is a chunk the query cannot reach except by traversal.
        let spaces = SpaceStore::open_in_memory().unwrap();
        let store = FileIndexStore::open_in_memory().unwrap();
        let space = spaces
            .create_space_with_mode("G", None, RetrievalMode::Graph, &DocOwner::unattributed())
            .await
            .unwrap();
        let doc = spaces
            .create_file(
                &space,
                "attachment-7.md",
                GRAPH_CONTENTS.as_bytes(),
                "text/markdown",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();

        record_parse_result(
            Some(&store),
            &spaces,
            &doc,
            "attachment-7.md",
            "text/markdown",
            document_parse::builtin_parse("attachment-7.md", GRAPH_CONTENTS.as_bytes()),
        )
        .await;

        let hits = spaces.search(&space, "Quokka", 10).await.unwrap();
        assert!(
            hits.iter().any(|c| c.content.contains("Rottnest")),
            "graph traversal must reach chunk C (Quokka→Acme→Perth) inside the \
             EXTRACTED text; without entity rows built from it there is nothing to \
             traverse. got: {hits:?}"
        );

        // The contrast that makes the claim above about traversal and not about
        // similarity: the same file in a VECTOR-mode Space, nearest-neighbour only,
        // does not return chunk C for "Quokka".
        let vector_space = spaces
            .create_space_with_mode("V", None, RetrievalMode::Vector, &DocOwner::unattributed())
            .await
            .unwrap();
        let vector_doc = spaces
            .create_file(
                &vector_space,
                "attachment-7.md",
                GRAPH_CONTENTS.as_bytes(),
                "text/markdown",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        record_parse_result(
            Some(&store),
            &spaces,
            &vector_doc,
            "attachment-7.md",
            "text/markdown",
            document_parse::builtin_parse("attachment-7.md", GRAPH_CONTENTS.as_bytes()),
        )
        .await;
        let vector_top1 = spaces.search(&vector_space, "Quokka", 1).await.unwrap();
        assert_eq!(vector_top1.len(), 1);
        assert!(
            !vector_top1[0].content.contains("Rottnest"),
            "top-1 vector result for 'Quokka' should be chunk A, got: {:?}",
            vector_top1[0].content
        );
    }

    // ── Failure posture ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_parse_failure_still_stores_the_file_and_leaves_the_descriptor_alone() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let store = FileIndexStore::open_in_memory().unwrap();
        let space = spaces
            .create_space("S", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let doc = spaces
            .create_file(
                &space,
                "report.pdf",
                b"%PDF-1.7 binary",
                "application/pdf",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        let before = spaces.get_document(&doc).await.unwrap().unwrap();

        let record = record_parse_result(
            Some(&store),
            &spaces,
            &doc,
            "report.pdf",
            "application/pdf",
            Err(ParseFailure::new(
                ParseFailureReason::NoProvider,
                "no document parser is installed that can read .pdf",
            )),
        )
        .await;

        // The file is still there, byte-for-byte.
        let blob = spaces.read_file_blob(&doc).await.unwrap();
        assert_eq!(blob.unwrap().1, b"%PDF-1.7 binary".to_vec());

        // And the descriptor chunk behaviour is UNCHANGED: still exactly one chunk,
        // still `{title}\n{mime}`. Not "at least one" — identical.
        let after = spaces.get_document(&doc).await.unwrap().unwrap();
        assert_eq!(after.chunk_count, before.chunk_count);
        assert_eq!(after.chunk_count, 1);
        assert_eq!(after.source, before.source);
        assert_eq!(after.source, "report.pdf\napplication/pdf");

        // A failure is distinguishable from a success, and says what to do.
        assert_eq!(record.state, IndexState::Skipped);
        assert_eq!(record.reason_code.as_deref(), Some("no_provider"));
        assert_eq!(store.get(&doc).await.unwrap().unwrap().state, record.state);
    }

    fn timeout() -> ParseFailure {
        ParseFailure::new(ParseFailureReason::ProviderTimeout, "still starting")
    }

    /// A provider still starting at submit time is retried with back-off, not
    /// recorded as a terminal `failed` that nothing ever revisits.
    #[tokio::test]
    async fn a_provider_still_starting_at_submit_is_retried_until_it_answers() {
        let delays = [std::time::Duration::from_millis(1); 5];
        let calls = std::cell::Cell::new(0);
        let result = retry_submit_while_provider_starting(&delays, |attempt| {
            calls.set(calls.get() + 1);
            async move {
                if attempt < 2 {
                    Err(timeout())
                } else {
                    Ok("parsed")
                }
            }
        })
        .await;
        assert_eq!(result.unwrap(), "parsed");
        assert_eq!(calls.get(), 3);
    }

    #[tokio::test]
    async fn submit_retries_are_bounded_and_end_as_the_timeout() {
        let delays = [std::time::Duration::from_millis(1); 3];
        let calls = std::cell::Cell::new(0);
        let result: Result<(), ParseFailure> =
            retry_submit_while_provider_starting(&delays, |_| {
                calls.set(calls.get() + 1);
                async { Err(timeout()) }
            })
            .await;
        assert_eq!(
            result.unwrap_err().reason,
            ParseFailureReason::ProviderTimeout
        );
        assert_eq!(calls.get(), 4, "one attempt plus one per delay");
    }

    #[tokio::test]
    async fn a_real_provider_failure_is_not_retried() {
        let delays = [std::time::Duration::from_millis(1); 3];
        let calls = std::cell::Cell::new(0);
        let result: Result<(), ParseFailure> =
            retry_submit_while_provider_starting(&delays, |_| {
                calls.set(calls.get() + 1);
                async { Err(ParseFailure::new(ParseFailureReason::ProviderError, "boom")) }
            })
            .await;
        assert_eq!(
            result.unwrap_err().reason,
            ParseFailureReason::ProviderError
        );
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn submit_retries_fit_inside_the_managers_start_budget() {
        let total: std::time::Duration = SUBMIT_RETRY_DELAYS.iter().sum();
        assert!(total < crate::sidecar::manager::WAKE_START_BUDGET);
    }

    #[test]
    fn failure_reasons_split_by_what_the_user_can_do_about_them() {
        // Nothing on this node claims the format ⇒ install a parser, not "broken".
        assert_eq!(
            state_for(ParseFailureReason::NoProvider),
            IndexState::Skipped
        );
        assert_eq!(
            state_for(ParseFailureReason::Unsupported),
            IndexState::Skipped
        );
        // Something tried and could not.
        for reason in [
            ParseFailureReason::ProviderTimeout,
            ParseFailureReason::ProviderError,
            ParseFailureReason::TooLarge,
            ParseFailureReason::PythonMissing,
            // A broken blob reference. It used to arrive here as `Unsupported` (that
            // is what `blob_input_path` returned for an empty `sha256`) and therefore
            // as `skipped`, whose remedy text is "install a `document.parse` app" —
            // a confidently wrong instruction about a storage fault.
            ParseFailureReason::BlobUnavailable,
            // The name (or the declared mime) said text and the bytes are binary. No
            // parser install fixes that either — the floor is Core's own reader — so
            // `skipped`'s "get one from the Store" would be equally wrong.
            ParseFailureReason::NotText,
        ] {
            assert_eq!(state_for(reason), IndexState::Failed, "{reason:?}");
        }
    }

    #[tokio::test]
    async fn binary_bytes_under_a_text_mime_are_recorded_as_failed_not_indexed_as_mojibake() {
        // End to end through the arm that could reach the decoder: an extensionless
        // TITLE plus a declared text mime, which is what `POST /api/spaces/:id/files`
        // and `artifact.create` hand this module. The file is still stored; what it
        // must NOT do is chunk a page of replacement characters as its contents.
        let spaces = SpaceStore::open_in_memory().unwrap();
        let store = FileIndexStore::open_in_memory().unwrap();
        let space = spaces
            .create_space("S", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let bytes = b"PK\x03\x04\x14\x00\x00\x00deck.xml".to_vec();
        let doc = spaces
            .create_file(
                &space,
                "notes",
                &bytes,
                "text/plain",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();

        let floor_name = document_parse::mime_floor_name("notes", "text/plain")
            .expect("an extensionless title is still given a floor name");
        let created = index_on_the_floor(
            Some(&store),
            &spaces,
            doc.clone(),
            &floor_name,
            "notes",
            "text/plain",
            &bytes,
        )
        .await;

        assert_eq!(created.index.state, IndexState::Failed);
        assert_eq!(created.index.reason_code.as_deref(), Some("not_text"));
        // The bytes are kept — extraction never fails an upload — and the chunk set is
        // untouched, so the document is still exactly as findable as before.
        assert!(spaces.read_file_blob(&doc).await.unwrap().is_some());
        let after = spaces.get_document(&doc).await.unwrap().unwrap();
        assert_eq!(after.chunk_count, 1);
        assert_eq!(after.source, "notes\ntext/plain");
    }

    #[tokio::test]
    async fn a_missing_blob_reads_as_a_storage_fault_not_a_missing_parser() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let store = FileIndexStore::open_in_memory().unwrap();
        let space = spaces
            .create_space("S", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let doc = spaces
            .create_file(
                &space,
                "report.pdf",
                b"%PDF-1.7",
                "application/pdf",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();

        let record = record_parse_result(
            Some(&store),
            &spaces,
            &doc,
            "report.pdf",
            "application/pdf",
            // Exactly what `submit_blob` now produces for a document row whose
            // `sha256` is empty.
            Err(document_parse::blob_input_path("").expect_err("empty is not an address")),
        )
        .await;

        assert_eq!(record.state, IndexState::Failed);
        assert_eq!(record.reason_code.as_deref(), Some("blob_unavailable"));
        assert_ne!(
            record.reason_code.as_deref(),
            Some("unsupported_format"),
            "a broken blob must not send the user to the Store for a parser"
        );
    }

    #[tokio::test]
    async fn an_empty_document_is_skipped_not_indexed_and_keeps_its_descriptor() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let store = FileIndexStore::open_in_memory().unwrap();
        let space = spaces
            .create_space("S", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let doc = spaces
            .create_file(
                &space,
                "blank.txt",
                b"   \n\n  ",
                "text/plain",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();

        let record = record_parse_result(
            Some(&store),
            &spaces,
            &doc,
            "blank.txt",
            "text/plain",
            document_parse::builtin_parse("blank.txt", b"   \n\n  "),
        )
        .await;

        assert_eq!(record.state, IndexState::Skipped);
        assert_eq!(record.reason_code.as_deref(), Some(REASON_EMPTY_DOCUMENT));
        // Replacing the descriptor with a blank chunk would make the file LESS
        // findable than before, so the chunk set is untouched.
        assert_eq!(
            spaces
                .get_document(&doc)
                .await
                .unwrap()
                .unwrap()
                .chunk_count,
            1
        );
    }

    // ── Invariants of the new store method ────────────────────────────────────

    #[tokio::test]
    async fn descriptor_is_chunk_zero_so_filename_retrieval_survives() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let store = FileIndexStore::open_in_memory().unwrap();
        let (space, doc) = stored_file(&spaces, RetrievalMode::Vector).await;

        record_parse_result(
            Some(&store),
            &spaces,
            &doc,
            "attachment-7.md",
            "text/markdown",
            floor_outcome(CONTENTS),
        )
        .await;

        // Indexing ADDS reach; it must not trade filename hits for content hits.
        let by_name = spaces.search(&space, "attachment-7.md", 5).await.unwrap();
        assert!(
            by_name
                .iter()
                .any(|c| c.content.contains("attachment-7.md")),
            "the descriptor must survive as a chunk, got: {by_name:?}"
        );
    }

    #[tokio::test]
    async fn indexing_never_rewrites_the_documents_source_column() {
        // The reason `replace_file_chunks` exists instead of `update_document`: for a
        // file, `source` is the descriptor and clients read it. Extraction must not
        // repoint it at the document's prose.
        let spaces = SpaceStore::open_in_memory().unwrap();
        let store = FileIndexStore::open_in_memory().unwrap();
        let (_space, doc) = stored_file(&spaces, RetrievalMode::Vector).await;

        record_parse_result(
            Some(&store),
            &spaces,
            &doc,
            "attachment-7.md",
            "text/markdown",
            floor_outcome(CONTENTS),
        )
        .await;

        let after = spaces.get_document(&doc).await.unwrap().unwrap();
        assert_eq!(after.source, "attachment-7.md\ntext/markdown");
        assert!(after.chunk_count >= 2, "but the chunks did change");
    }

    #[tokio::test]
    async fn replace_file_chunks_refuses_a_page_and_refuses_empty_text() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let space = spaces
            .create_space("S", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let page = spaces
            .ingest_document(&space, "Page", "some prose", &DocOwner::unattributed())
            .await
            .unwrap();
        // A page's `source` IS its chunks' origin; re-chunking without rewriting it
        // would desync the row from its own index.
        assert!(spaces.replace_file_chunks(&page, "text").await.is_err());

        let doc = spaces
            .create_file(
                &space,
                "a.md",
                b"x",
                "text/markdown",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        assert!(spaces.replace_file_chunks(&doc, "  \n ").await.is_err());
        assert!(spaces
            .replace_file_chunks("no-such-doc", "text")
            .await
            .is_err());
    }

    // ── The dispatch ──────────────────────────────────────────────────────────
    //
    // `create_file_indexed` itself needs a whole `ServerState` and the process-wide
    // `index_store()` (hard-`None` under `cfg(test)` so no test can write into a live
    // profile), so it cannot be called here. These exercise the functions it delegates
    // every one of its decisions to, which is what makes that glue safe to leave
    // uncovered.

    #[tokio::test]
    async fn a_title_with_no_extension_is_read_by_the_floor_through_its_mime() {
        // The `POST /api/spaces/:id/files` and `artifact.create` shape: a TITLE, not
        // a filename. Extension-keyed, `notes` is unreadable and went to a provider
        // that would answer `no_provider` — "install a document parser" — for a file
        // Core reads itself.
        let spaces = SpaceStore::open_in_memory().unwrap();
        let store = FileIndexStore::open_in_memory().unwrap();
        let space = spaces
            .create_space_with_mode("S", None, RetrievalMode::Vector, &DocOwner::unattributed())
            .await
            .unwrap();
        let doc = spaces
            .create_file(
                &space,
                "notes",
                CONTENTS.as_bytes(),
                "text/plain",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();

        assert!(!document_parse::is_builtin_readable("notes"));
        let floor_name =
            document_parse::mime_floor_name("notes", "text/plain").expect("mime names the floor");
        let created = index_on_the_floor(
            Some(&store),
            &spaces,
            doc.clone(),
            &floor_name,
            "notes",
            "text/plain",
            CONTENTS.as_bytes(),
        )
        .await;

        assert_eq!(created.index.state, IndexState::Indexed);
        assert_eq!(created.index.backend_id.as_deref(), Some("builtin"));

        // THE trap in this fix: `floor_name` is what the floor judges the bytes by,
        // `title` is what the descriptor chunk is made of. Swap them and the document
        // silently starts claiming a filename (`notes.txt`) that nothing else in the
        // system uses — and the existing descriptor test would not catch it, because
        // it exercises a `.md` name that never takes this arm.
        let after = spaces.get_document(&doc).await.unwrap().unwrap();
        assert_eq!(after.source, "notes\ntext/plain");
        assert!(after.chunk_count >= 2, "contents were chunked: {after:?}");

        let hits = spaces
            .search(&space, "quokkas Rottnest grasses", 5)
            .await
            .unwrap();
        assert!(
            hits.iter().any(|c| c.content.contains("Rottnest")),
            "the contents must be retrievable: {hits:?}"
        );
    }

    #[tokio::test]
    async fn extraction_runs_even_when_the_status_store_is_gone() {
        // The decoupling behind the `pending`-forever fix. The status row is
        // bookkeeping; the re-chunk is the product. A node whose status db will not
        // open must still get searchable documents — the old code returned early
        // instead, so an unopenable db silently cost every upload its contents.
        let spaces = SpaceStore::open_in_memory().unwrap();
        let (space, doc) = stored_file(&spaces, RetrievalMode::Vector).await;

        let created = index_on_the_floor(
            None,
            &spaces,
            doc.clone(),
            "attachment-7.md",
            "attachment-7.md",
            "text/markdown",
            CONTENTS.as_bytes(),
        )
        .await;

        assert_eq!(created.index.state, IndexState::Indexed);
        let hits = spaces
            .search(&space, "quokkas Rottnest grasses", 5)
            .await
            .unwrap();
        assert!(
            hits.iter().any(|c| c.content.contains("Rottnest")),
            "no store must not mean no index: {hits:?}"
        );
    }

    #[tokio::test]
    async fn the_floor_leaves_no_pending_row_behind() {
        // The floor is terminal before it returns, so it never makes the `pending`
        // promise at all. Asserted on the failing case as well as the succeeding one:
        // an empty `.txt` is `skipped`, and the row a client reads must be that —
        // never a `pending` nobody will come back to overwrite.
        let spaces = SpaceStore::open_in_memory().unwrap();
        let store = FileIndexStore::open_in_memory().unwrap();
        let space = spaces
            .create_space("S", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let doc = spaces
            .create_file(
                &space,
                "blank.txt",
                b"   \n\n  ",
                "text/plain",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();

        let created = index_on_the_floor(
            Some(&store),
            &spaces,
            doc.clone(),
            "blank.txt",
            "blank.txt",
            "text/plain",
            b"   \n\n  ",
        )
        .await;

        assert_ne!(created.index.state, IndexState::Pending);
        let row = store.get(&doc).await.unwrap().expect("a row was written");
        assert_eq!(row.state, IndexState::Skipped);
        assert_eq!(row.reason_code.as_deref(), Some(REASON_EMPTY_DOCUMENT));
    }

    #[tokio::test]
    async fn pending_is_written_only_where_it_can_be_kept() {
        let store = FileIndexStore::open_in_memory().unwrap();

        // With a store: the promise is durable, and a client that reads the instant
        // the upload returns sees "running" rather than an absent row.
        let promised = mark_pending(Some(&store), "d-provider").await;
        assert_eq!(promised.state, IndexState::Pending);
        assert_eq!(promised.reason_code, None);
        assert_eq!(
            store.get("d-provider").await.unwrap().unwrap().state,
            IndexState::Pending
        );

        // Without one: the parse still runs (the caller spawns either way), so
        // `pending` is TRUE — but every status read will answer `unattempted`, and
        // handing back a bare `pending` a client could poll forever is the same
        // defect this module exists to remove. The reason code is how a client tells
        // "poll me" from "polling will never answer".
        let unreportable = mark_pending(None, "d-nostore").await;
        assert_eq!(unreportable.state, IndexState::Pending);
        assert_eq!(
            unreportable.reason_code.as_deref(),
            Some(REASON_STATUS_UNAVAILABLE)
        );
        assert!(unreportable
            .message
            .is_some_and(|m| m.contains("unattempted")));
        assert!(store.get("d-nostore").await.unwrap().is_none());
    }

    // ── The status surface ────────────────────────────────────────────────────

    #[tokio::test]
    async fn status_round_trips_and_a_missing_row_reads_as_unattempted() {
        let store = FileIndexStore::open_in_memory().unwrap();
        assert!(store.get("nope").await.unwrap().is_none());
        assert_eq!(unknown_json("nope")["state"], "unattempted");

        let mut record = FileIndexRecord::pending("d1");
        store.put(&record).await.unwrap();
        assert_eq!(
            store.get("d1").await.unwrap().unwrap().state,
            IndexState::Pending
        );

        // The terminal state replaces the pending row rather than appending.
        record.state = IndexState::Indexed;
        record.chunk_count = 4;
        record.backend_id = Some("@ryu/markitdown".to_owned());
        record.warnings = vec!["output was truncated".to_owned()];
        store.put(&record).await.unwrap();
        let read = store.get("d1").await.unwrap().unwrap();
        assert_eq!(read.state, IndexState::Indexed);
        assert_eq!(read.chunk_count, 4);
        assert_eq!(read.warnings, vec!["output was truncated".to_owned()]);
        assert_eq!(read.to_json()["backend_id"], "@ryu/markitdown");

        store.forget("d1").await.unwrap();
        assert!(store.get("d1").await.unwrap().is_none());
    }

    // ── The `pending` row that outlived its parse ──────────────────────────────

    /// Write a `pending` row aged by `age` — the shape a restart or a panicked parse
    /// task leaves behind, since nothing ever comes back to overwrite it.
    async fn aged_pending(store: &FileIndexStore, doc_id: &str, age: std::time::Duration) {
        let mut record = FileIndexRecord::pending(doc_id);
        record.updated_at = now_millis() - age.as_millis() as i64;
        store.put(&record).await.unwrap();
    }

    #[tokio::test]
    async fn a_pending_row_older_than_the_poll_ceiling_reads_as_failed_in_both_readers() {
        // The defect: `pending` is written immediately before the parse task is
        // spawned, and that task is the ONLY writer of the terminal row. Restart Core
        // (or let the task panic) and the document says "indexing…" forever.
        //
        // Both readers, in one test, because they render the same file: the list badge
        // comes from `get_many` and the document's status pane from `get`, and a
        // demotion in one but not the other is a UI that contradicts itself.
        let store = FileIndexStore::open_in_memory().unwrap();
        aged_pending(&store, "abandoned", STALE_PENDING_AFTER + POLL_INTERVAL).await;
        aged_pending(&store, "still-running", std::time::Duration::from_secs(30)).await;

        let one = store.get("abandoned").await.unwrap().unwrap();
        assert_eq!(one.state, IndexState::Failed);
        assert_eq!(one.reason_code.as_deref(), Some(REASON_PENDING_ABANDONED));
        assert!(
            one.message
                .as_deref()
                .is_some_and(|m| m.contains("never finished")),
            "the row has to say what happened: {:?}",
            one.message
        );

        let ids = vec!["abandoned".to_owned(), "still-running".to_owned()];
        let many = store.get_many(&ids).await.unwrap();
        assert_eq!(many["abandoned"].state, one.state);
        assert_eq!(many["abandoned"].reason_code, one.reason_code);

        // A parse that is genuinely in flight is untouched by either reader. Demoting
        // one of those would badge a live upload as broken within seconds of it
        // starting, which is the opposite error and just as wrong.
        assert_eq!(
            store.get("still-running").await.unwrap().unwrap().state,
            IndexState::Pending
        );
        assert_eq!(many["still-running"].state, IndexState::Pending);
    }

    #[test]
    fn only_pending_ages_and_the_demotion_never_rewrites_the_row() {
        let ancient = now_millis() - (STALE_PENDING_AFTER.as_millis() as i64) * 10;

        // A terminal row is a recorded fact. However old it gets, it is still what
        // happened — ageing `indexed` into `failed` would un-index working documents
        // on a node that simply has not been touched in a month.
        for state in [IndexState::Indexed, IndexState::Skipped, IndexState::Failed] {
            let mut record = FileIndexRecord::pending("d");
            record.state = state;
            record.updated_at = ancient;
            record.chunk_count = 9;
            let after = demote_abandoned_pending(record, now_millis());
            assert_eq!(after.state, state, "{state:?} must not age");
            assert_eq!(after.reason_code, None);
        }

        // The demoted row keeps everything the stored row said, `updated_at` first:
        // it is when the state last CHANGED, and stamping it with the read's clock
        // would both claim this just happened and destroy the only evidence (how long
        // ago the parse was promised) that explains the demotion at all.
        let mut stale = FileIndexRecord::pending("d");
        stale.updated_at = ancient;
        let demoted = demote_abandoned_pending(stale.clone(), now_millis());
        assert_eq!(demoted.state, IndexState::Failed);
        assert_eq!(demoted.updated_at, ancient);
        assert_eq!(demoted.doc_id, stale.doc_id);
        assert_eq!(demoted.chunk_count, 0);

        // Exactly at the threshold is stale; a millisecond under it is not.
        let threshold = STALE_PENDING_AFTER.as_millis() as i64;
        let mut edge = FileIndexRecord::pending("d");
        edge.updated_at = 1_000_000;
        assert_eq!(
            demote_abandoned_pending(edge.clone(), 1_000_000 + threshold).state,
            IndexState::Failed
        );
        assert_eq!(
            demote_abandoned_pending(edge.clone(), 1_000_000 + threshold - 1).state,
            IndexState::Pending
        );

        // A host whose clock jumped backwards reads every row as being from the
        // future. Age clamps at zero, so it reports "still running" until the clock
        // catches up rather than declaring every in-flight parse dead at once.
        assert_eq!(demote_abandoned_pending(edge, 0).state, IndexState::Pending);
    }

    #[test]
    fn the_stale_pending_threshold_clears_the_pollers_own_ceiling() {
        // The demotion is sound only because `poll_to_completion` has a hard ceiling
        // and writes its own terminal row when it expires. So the threshold has to sit
        // beyond that ceiling PLUS everything a live job does outside the poll loop —
        // the wake and hop in `submit_blob`, the last iteration's overshoot (the
        // deadline is checked after the call, not before), and the re-chunk in
        // `record_parse_result`.
        //
        // Derived, not restated: if this were a literal and someone raised
        // `POLL_BUDGET`, the read path would start declaring live parses dead with no
        // test failing. That is what this assertion guards.
        assert!(STALE_PENDING_AFTER > POLL_BUDGET);
        assert_eq!(STALE_PENDING_AFTER, POLL_BUDGET + STALE_PENDING_GRACE);
        // The overshoot the grace has to swallow, counted from the constants that
        // produce it rather than from a comment: one poll interval plus the two hops
        // the final `job_outcome` call can take, and the same again for the submit.
        //
        // The 20 + 30 are `WAKE_TIMEOUT` and `PROVIDER_TIMEOUT`, both PRIVATE to
        // `document_parse.rs` — so unlike the line above this one is a restatement,
        // not a derivation, and widening their visibility to fix that would be a
        // worse trade. If either moves, this is the test that has to move with it.
        let overshoot = POLL_INTERVAL * 2 + std::time::Duration::from_secs(20 + 30) * 2;
        assert!(
            STALE_PENDING_GRACE > overshoot,
            "the grace must cover the work a live job does outside POLL_BUDGET"
        );
    }

    // ── The list join ─────────────────────────────────────────────────────────

    /// A serialized `spaces::Document` row, trimmed to the fields the join reads.
    fn doc_row(id: &str, kind: &str) -> Value {
        json!({ "id": id, "space_id": "s1", "title": id, "kind": kind, "chunk_count": 1 })
    }

    /// One read for the whole list, and every id answered — including ids with no
    /// row, which must come back **absent** rather than as an empty record.
    #[tokio::test]
    async fn get_many_reads_a_whole_list_and_omits_the_ids_it_has_never_seen() {
        let store = FileIndexStore::open_in_memory().unwrap();
        let mut indexed = FileIndexRecord::pending("d1");
        indexed.state = IndexState::Indexed;
        indexed.chunk_count = 7;
        store.put(&indexed).await.unwrap();
        let mut skipped = FileIndexRecord::pending("d2");
        skipped.state = IndexState::Skipped;
        skipped.reason_code = Some("no_provider".to_owned());
        store.put(&skipped).await.unwrap();

        let ids = vec!["d1".to_owned(), "d2".to_owned(), "d3".to_owned()];
        let map = store.get_many(&ids).await.unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(map["d1"].state, IndexState::Indexed);
        assert_eq!(map["d1"].chunk_count, 7);
        assert_eq!(map["d2"].state, IndexState::Skipped);
        assert!(
            !map.contains_key("d3"),
            "an id with no row must be ABSENT — the join turns absence into \
             `unattempted`, which is a different answer from `skipped`"
        );
        assert!(store.get_many(&[]).await.unwrap().is_empty());
    }

    /// The `IN (…)` list is chunked, so a Space with more files than SQLite's
    /// host-parameter floor (999) still reads in one call. The **Uploads** system
    /// space collects every chat attachment on the node, so this is the ordinary
    /// case on a well-used node, not a synthetic one.
    #[tokio::test]
    async fn get_many_survives_more_ids_than_sqlites_parameter_limit() {
        let store = FileIndexStore::open_in_memory().unwrap();
        let ids: Vec<String> = (0..2500).map(|i| format!("d{i}")).collect();
        for id in ids.iter().take(1300) {
            let mut record = FileIndexRecord::pending(id);
            record.state = IndexState::Indexed;
            store.put(&record).await.unwrap();
        }
        let map = store.get_many(&ids).await.unwrap();
        assert_eq!(map.len(), 1300);
        assert_eq!(map["d0"].state, IndexState::Indexed);
        assert_eq!(map["d1299"].state, IndexState::Indexed);
        assert!(!map.contains_key("d1300"));
    }

    /// The two rules the join must keep: a file with no row renders `unattempted`
    /// (it does not vanish and it is not an error), and a non-file row is left
    /// **untouched** so the client keeps reading "say nothing" for it.
    #[test]
    fn the_join_answers_every_file_row_and_never_speaks_for_a_page() {
        let mut records = std::collections::HashMap::new();
        let mut indexed = FileIndexRecord::pending("f1");
        indexed.state = IndexState::Indexed;
        records.insert("f1".to_owned(), indexed);

        let mut rows = vec![
            doc_row("f1", FILE_DOCUMENT_KIND),
            doc_row("f2", FILE_DOCUMENT_KIND),
            doc_row("p1", "page"),
            doc_row("a1", "app:@ryu/whiteboard"),
        ];
        merge_index_into_documents(&mut rows, &records);

        assert_eq!(rows[0][LIST_INDEX_KEY]["state"], "indexed");
        // Present, not omitted: "nobody looked" is a real answer, and a dropped key
        // would be indistinguishable from a Core that cannot answer at all.
        assert_eq!(rows[1][LIST_INDEX_KEY]["state"], "unattempted");
        assert_eq!(rows[1][LIST_INDEX_KEY]["document_id"], "f2");
        // A page is re-chunked from its own source on every save, so the question
        // does not apply to it. Stamping `unattempted` here would make the desktop
        // render "Name only" on every page in the Space.
        assert!(rows[2].get(LIST_INDEX_KEY).is_none());
        assert!(rows[3].get(LIST_INDEX_KEY).is_none());
    }

    /// The joined object is the SAME shape the create responses and the per-document
    /// status route carry, so a client needs one reader for all three. Re-spelling it
    /// on the list row is what would force the desktop to maintain two.
    #[test]
    fn the_joined_object_is_the_record_the_other_two_routes_already_send() {
        let mut records = std::collections::HashMap::new();
        let mut failed = FileIndexRecord::pending("f1");
        failed.state = IndexState::Failed;
        failed.message = Some("the reader stopped at page 3".to_owned());
        failed.warnings = vec!["lossy decode".to_owned()];
        records.insert("f1".to_owned(), failed.clone());

        let mut rows = vec![doc_row("f1", FILE_DOCUMENT_KIND)];
        merge_index_into_documents(&mut rows, &records);
        assert_eq!(rows[0][LIST_INDEX_KEY], failed.to_json());
        // And the row it decorates is intact — the join adds, never rewrites.
        assert_eq!(rows[0]["title"], "f1");
        assert_eq!(rows[0]["chunk_count"], 1);
    }

    /// With no status store the list still renders: every file row reads
    /// `unattempted` and nothing fails. The filenames are why the user opened the
    /// Space; a status column must never be able to take them away.
    #[tokio::test]
    async fn without_a_store_the_join_degrades_to_unattempted_rather_than_failing() {
        // `index_store()` is hard-`None` under `cfg(test)`, so this exercises exactly
        // the degraded path a node with an unopenable db takes.
        let mut rows = vec![doc_row("f1", FILE_DOCUMENT_KIND), doc_row("p1", "page")];
        attach_index_states(&mut rows).await;
        assert_eq!(rows[0][LIST_INDEX_KEY]["state"], "unattempted");
        assert!(rows[1].get(LIST_INDEX_KEY).is_none());
    }

    #[tokio::test]
    async fn the_global_store_is_unreachable_from_tests() {
        // Regression guard for a real violation: `artifact.create`'s own test reaches
        // `create_file_indexed_detached` → `index_store()`, and before the `cfg(test)`
        // gate a plain `cargo test` created `space-file-index.db` (+ `-wal`/`-shm`) in
        // the ACTIVE PROFILE — a real user's node. No test may write there.
        assert!(index_store().is_none());
    }

    #[tokio::test]
    async fn no_server_context_still_stores_the_file_and_says_so() {
        // The `artifact.create` path in a test/CLI process. "Never attempted" must not
        // be dressed up as a parser failure, and the artifact must still be saved.
        let spaces = SpaceStore::open_in_memory().unwrap();
        let space = spaces
            .create_space("S", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let created = create_file_indexed_detached(
            &spaces,
            &space,
            "deck.pptx",
            b"PK\x03\x04",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            &DocOwner::unattributed(),
        )
        .await
        .unwrap();

        assert_eq!(created.index.state, IndexState::Skipped);
        assert_eq!(
            created.index.reason_code.as_deref(),
            Some(REASON_NO_PARSE_CONTEXT)
        );
        assert!(spaces
            .read_file_blob(&created.document_id)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn warnings_from_a_degraded_parse_are_recorded_not_swallowed() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let store = FileIndexStore::open_in_memory().unwrap();
        let space = spaces
            .create_space("S", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let bytes = b"quokka\xff colony";
        let doc = spaces
            .create_file(
                &space,
                "notes.txt",
                bytes,
                "text/plain",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();

        let record = record_parse_result(
            Some(&store),
            &spaces,
            &doc,
            "notes.txt",
            "text/plain",
            document_parse::builtin_parse("notes.txt", bytes),
        )
        .await;

        assert_eq!(record.state, IndexState::Indexed);
        assert!(
            record
                .warnings
                .iter()
                .any(|w| w.contains("not valid UTF-8")),
            "a lossy decode must be visible: {record:?}"
        );
        assert!(store.get(&doc).await.unwrap().unwrap().warnings.len() == 1);
    }
}
