//! Server-side conversation/session store (spec unit U10).
//!
//! Persists chat history in a local SQLite database (`~/.ryu/conversations.db`)
//! keyed by `conversation_id`. This replaces the per-client localStorage/in-memory
//! history that previously lived in each frontend (desktop, web, CLI, extension).
//!
//! The [`Session`] type (spec unit U004/#118) extends this store: it wraps an
//! existing conversation (reusing [`ConversationStore`] from spec unit #15) and
//! adds run-ownership — a binding to a [`crate::runnable::RunnableKind`] + id and
//! a status/state field. Sessions and conversations share the same SQLite file and
//! the same `Arc<Mutex<Connection>>`, so there is exactly one store and no data
//! duplication across message CRUD.
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): conversation/session
//! state is part of *what runs* (orchestration), not *what is allowed/measured/paid*,
//! so it belongs in Core.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::runnable::RunnableKind;

/// A persisted chat message belonging to a conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    /// The agent that produced this message (None for user messages).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// The verified human author of this message (None for agent messages or
    /// when no verified identity was present). Distinct from `agent_id`, which
    /// names the AI agent. Populated by the JWT identity layer in a later stage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_user_id: Option<String>,
    /// Display name of the (possibly unverified) sender for group/channel chats,
    /// e.g. a Telegram first name or Discord username. Distinct from
    /// `author_user_id` (a *verified* Ryu identity): this is connector-supplied
    /// and is NOT trusted for auth — it exists so a multi-participant group thread
    /// can show and reason about who said what. None for 1:1 / anonymous turns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
}

/// A semantic-search hit over past conversation messages. The snippet is
/// re-decrypted from `conversations.db` at search time (the index never stores
/// message text).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageSearchHit {
    pub conversation_id: String,
    pub message_id: String,
    pub role: String,
    /// Decrypted message text (may be truncated by the caller).
    pub content: String,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Relevance score in `[0, 1]` (higher is more relevant), derived from the
    /// squared-L2 KNN distance.
    pub score: f32,
}

/// Lightweight conversation summary used by the list endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSummary {
    pub id: String,
    pub title: Option<String>,
    pub agent_id: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds.
    pub updated_at: i64,
    pub message_count: i64,
    /// Active working folder for the run (M1 git-native parity).
    pub folder_path: Option<String>,
    /// Git branch active at run start.
    pub branch: Option<String>,
    /// Per-run worktree path (populated when a dedicated worktree was created).
    pub worktree_path: Option<String>,
    /// Run lifecycle status: "running" | "completed" | "failed" | null.
    pub run_status: Option<String>,
    /// All agent ids participating in this conversation (multi-agent, #414).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub participants: Vec<String>,
    /// Pinned by a coordinator thread to keep it surfaced. Defaults false.
    #[serde(default)]
    pub pinned: bool,
    /// Archived by a coordinator thread to hide a finished worker. Defaults false.
    #[serde(default)]
    pub archived: bool,
}

/// Detail view of a conversation, including messages and participants.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationDetail {
    pub id: String,
    pub title: Option<String>,
    pub agent_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub messages: Vec<StoredMessage>,
    /// All agent ids participating in this conversation.
    #[serde(default)]
    pub participants: Vec<String>,
}

/// A persisted `/btw` side question + its answer, keyed to the conversation it
/// was asked about. These are lightweight asides (single Q&A, no tools) that the
/// "Side chats" surfaces list under their parent conversation. `question` and
/// `answer` are sealed at rest like message content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BtwEntry {
    pub id: String,
    pub conversation_id: String,
    pub question: String,
    pub answer: String,
    /// The model that produced the answer (None if unknown).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
}

/// The run status of a [`Session`]. Tracks the lifecycle of a single agent/workflow run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// The session has been created but no run has started yet.
    #[default]
    Idle,
    /// A run is actively in progress.
    Running,
    /// The most recent run completed successfully.
    Completed,
    /// The most recent run ended with an error.
    Failed,
}

impl SessionStatus {
    fn as_str(&self) -> &'static str {
        match self {
            SessionStatus::Idle => "idle",
            SessionStatus::Running => "running",
            SessionStatus::Completed => "completed",
            SessionStatus::Failed => "failed",
        }
    }

    fn from_str(s: &str) -> Self {
        match s {
            "running" => SessionStatus::Running,
            "completed" => SessionStatus::Completed,
            "failed" => SessionStatus::Failed,
            _ => SessionStatus::Idle,
        }
    }
}

/// A Session wraps an existing conversation and adds run-ownership.
///
/// Extends the conversation store from spec unit #15: reuses the same
/// [`ConversationStore`] (same SQLite file, same connection) and adds a
/// runnable binding (which agent/workflow/tool/skill is being run) plus a
/// lifecycle status. Message CRUD is unchanged — use [`ConversationStore`]
/// methods on the `conversation_id` directly.
///
/// Per the Core-vs-Gateway rule: session state is *what runs* (orchestration),
/// not *what is allowed/measured/paid*, so it lives in Core.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    /// The conversation this session owns. Reuses the existing conversation row.
    pub conversation_id: String,
    /// The id of the Runnable being run (agent id, workflow id, etc.).
    pub runnable_id: String,
    /// The kind of Runnable (agent, workflow, tool, skill).
    pub runnable_kind: RunnableKind,
    /// Current lifecycle status of the run.
    pub status: SessionStatus,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds.
    pub updated_at: i64,
}

/// SQLite-backed conversation store. Cheap to clone (wraps an `Arc<Mutex<Connection>>`).
///
/// Message bodies are encrypted at rest via [`crate::crypto::FieldCipher`]: the
/// `content` column holds the `enc:v1:` envelope, written on append and decrypted
/// transparently on read. Rows written before encryption was introduced have no
/// envelope and are passed through unchanged (lazy migration). Metadata (ids,
/// roles, timestamps) stays plaintext so listing/ordering/sync still work.
#[derive(Clone)]
pub struct ConversationStore {
    conn: Arc<Mutex<Connection>>,
    cipher: crate::crypto::FieldCipher,
    /// Optional semantic index over message bodies, backing the
    /// `search_conversations` builtin tool. `None` in contexts that don't wire it
    /// (tests, CLI, headless). Indexing on append and lazy backfill on search are
    /// both best-effort: a failure here never affects message CRUD.
    message_index: Option<super::message_index::MessageIndex>,
    /// Optional full-text (FTS5) index over message bodies — the lexical/keyword
    /// complement to `message_index` (semantic KNN), backing the FTS session-search
    /// recall layer. `None` in contexts that don't wire it (tests, CLI, headless).
    /// Unlike the semantic index it needs NO embedder, so its lazy backfill on
    /// search is network-free. Population is DEFAULT-OFF: it only ever runs when the
    /// FTS recall pref is enabled (search is the sole writer, via lazy backfill), so
    /// the on-disk term index materializes only for users who opt in.
    message_fts: Option<super::message_fts::MessageFtsIndex>,
    /// Optional sink for conversation ids that just received their *first* user
    /// message and so are candidates for a background auto-rename. `None` in
    /// contexts without a server loop to consume them (tests, CLI). The server
    /// wires a consumer that asks the default local model for a concise title and
    /// calls [`auto_set_title`]. Best-effort: a closed/absent channel just means
    /// the conversation keeps its first-message-derived title.
    auto_title_tx: Option<tokio::sync::mpsc::UnboundedSender<String>>,
    /// Optional room-keyed realtime registry (Phase 1 of the multi-user epic).
    /// When wired, [`append_message`] publishes an `Events` frame keyed by the
    /// conversation id so other live viewers see new turns immediately. `None` in
    /// contexts without realtime fan-out (tests, CLI). Cloned from the same
    /// instance held by `ServerState` so publishes reach the WS handler's
    /// subscribers (see `main.rs` wiring). Best-effort: publishing to a room with
    /// no members is a harmless no-op.
    realtime: Option<crate::realtime::RoomRegistry>,
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Default on-disk location for the conversation database (`~/.ryu/conversations.db`).
fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("conversations.db")
}

impl ConversationStore {
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
        let conn = Connection::open(&path)
            .with_context(|| format!("opening conversation db {}", path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: crate::crypto::global_cipher()?,
            message_index: None,
            message_fts: None,
            auto_title_tx: None,
            realtime: None,
        })
    }

    /// Wire the semantic message index (backing the `search_conversations` builtin
    /// tool) into the store. Cheap to clone (`Arc` inside). Must be called after
    /// construction to enable indexing-on-append + searchable history.
    pub fn with_message_index(mut self, index: super::message_index::MessageIndex) -> Self {
        self.message_index = Some(index);
        self
    }

    /// Wire the full-text (FTS5) message index (backing the FTS session-search
    /// recall layer) into the store. Cheap to clone (`Arc` inside). Mirrors
    /// [`with_message_index`]. Population is lazy-on-search and default-OFF, so
    /// wiring the index alone materializes nothing until a search runs under the
    /// enabled FTS recall pref.
    pub fn with_message_fts_index(mut self, index: super::message_fts::MessageFtsIndex) -> Self {
        self.message_fts = Some(index);
        self
    }

    /// Wire the auto-rename sink: each conversation that gets its first user
    /// message is sent on `tx` so a server-side consumer can generate a concise
    /// title with the default local model. Must be called after construction.
    pub fn with_auto_title(mut self, tx: tokio::sync::mpsc::UnboundedSender<String>) -> Self {
        self.auto_title_tx = Some(tx);
        self
    }

    /// Wire the room-keyed realtime registry so [`append_message`] publishes a
    /// live `Events` frame (keyed by conversation id) for every persisted turn.
    /// Pass a clone of the same [`crate::realtime::RoomRegistry`] held by
    /// `ServerState` so the frames reach the WS handler's subscribers. Must be
    /// called after construction.
    pub fn with_realtime(mut self, realtime: crate::realtime::RoomRegistry) -> Self {
        self.realtime = Some(realtime);
        self
    }

    /// Open an in-memory store (used by tests). Uses an ephemeral key so tests
    /// never touch the real keychain or `~/.ryu`.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: crate::crypto::FieldCipher::new(&[0x11; 32]),
            message_index: None,
            message_fts: None,
            auto_title_tx: None,
            realtime: None,
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS conversations (
                 id          TEXT PRIMARY KEY,
                 title       TEXT,
                 agent_id    TEXT,
                 created_at  INTEGER NOT NULL,
                 updated_at  INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS messages (
                 id              TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 role            TEXT NOT NULL,
                 content         TEXT NOT NULL,
                 created_at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_messages_conversation
                 ON messages(conversation_id, created_at);
             CREATE TABLE IF NOT EXISTS sessions (
                 id              TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 runnable_id     TEXT NOT NULL,
                 runnable_kind   TEXT NOT NULL,
                 status          TEXT NOT NULL DEFAULT 'idle',
                 created_at      INTEGER NOT NULL,
                 updated_at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_sessions_conversation
                 ON sessions(conversation_id);
             CREATE TABLE IF NOT EXISTS btw_entries (
                 id              TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL,
                 question        TEXT NOT NULL,
                 answer          TEXT NOT NULL,
                 model           TEXT,
                 created_at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_btw_conversation
                 ON btw_entries(conversation_id, created_at);",
        )
        .context("initializing conversation schema")?;

        // Additive migration: add run-metadata columns to `conversations` that
        // may not exist on databases created before this unit (U013). Each ALTER
        // is guarded by a PRAGMA table_info check so the call is a no-op when
        // the column already exists — safe to run on every startup.
        let existing_conv_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(conversations)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        for (col, ddl) in [
            (
                "folder_path",
                "ALTER TABLE conversations ADD COLUMN folder_path   TEXT",
            ),
            (
                "branch",
                "ALTER TABLE conversations ADD COLUMN branch        TEXT",
            ),
            (
                "worktree_path",
                "ALTER TABLE conversations ADD COLUMN worktree_path TEXT",
            ),
            (
                "run_status",
                "ALTER TABLE conversations ADD COLUMN run_status    TEXT",
            ),
            // Multi-agent participants (#414): JSON array of agent_ids.
            // Existing single-agent conversations are back-filled by a trigger in
            // add_participant; new conversations start empty and the primary agent
            // is added on first message.
            (
                "participants",
                "ALTER TABLE conversations ADD COLUMN participants  TEXT NOT NULL DEFAULT '[]'",
            ),
            // Coordinator threads (Codex-style cross-thread orchestration): a
            // coordinator agent can pin a thread to keep it surfaced and archive
            // a finished one to hide it. Both default off so existing
            // conversations are neither pinned nor archived.
            (
                "pinned",
                "ALTER TABLE conversations ADD COLUMN pinned        INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "archived",
                "ALTER TABLE conversations ADD COLUMN archived      INTEGER NOT NULL DEFAULT 0",
            ),
            // Auto-rename (ChatGPT/Claude-style): a conversation's title is first
            // derived from the first user message, then a background task asks the
            // default local model for a concise title and overwrites it. A manual
            // rename (REST/coordinator) sets `title_custom = 1` so the auto-namer
            // never clobbers a user-chosen title. Defaults off → existing
            // conversations are eligible for a one-time auto-name on their next
            // first-user-message (none, since they already have messages).
            (
                "title_custom",
                "ALTER TABLE conversations ADD COLUMN title_custom  INTEGER NOT NULL DEFAULT 0",
            ),
            // Multi-user tenancy (collaboration epic, Phase 0): the verified
            // human owner of the conversation, the org it belongs to, its
            // sharing visibility, and an optional owning team. All nullable
            // except `visibility`, which defaults to 'private' so existing
            // single-tenant conversations stay private. ACL enforcement is wired
            // in a later stage; these are schema-only for now.
            (
                "owner_user_id",
                "ALTER TABLE conversations ADD COLUMN owner_user_id TEXT",
            ),
            (
                "org_id",
                "ALTER TABLE conversations ADD COLUMN org_id        TEXT",
            ),
            (
                "visibility",
                "ALTER TABLE conversations ADD COLUMN visibility    TEXT NOT NULL DEFAULT 'private'",
            ),
            (
                "team_id",
                "ALTER TABLE conversations ADD COLUMN team_id       TEXT",
            ),
        ] {
            if !existing_conv_columns.contains(col) {
                conn.execute_batch(ddl)
                    .with_context(|| format!("adding column {col}"))?;
            }
        }

        // Additive migration: add agent_id column to messages (#414).
        let existing_msg_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(messages)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        if !existing_msg_columns.contains("agent_id") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN agent_id TEXT")
                .context("adding agent_id column to messages")?;
        }

        // Additive migration: the verified human author of a message (multi-user
        // collaboration epic, Phase 0). Distinct from `agent_id` (the AI agent).
        // Nullable — existing rows and agent messages carry NULL.
        if !existing_msg_columns.contains("author_user_id") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN author_user_id TEXT")
                .context("adding author_user_id column to messages")?;
        }

        // Additive migration: connector-supplied display name of the sender for
        // group/channel chats (Telegram first name, Discord username, etc.).
        // Nullable; unverified (NOT for auth) — distinct from author_user_id.
        if !existing_msg_columns.contains("author_name") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN author_name TEXT")
                .context("adding author_name column to messages")?;
        }

        Ok(())
    }

    /// Ensure a conversation row exists, creating it on first use. Optionally
    /// records the agent and a title (only set when not already present).
    pub async fn ensure_conversation(
        &self,
        conversation_id: &str,
        agent_id: Option<&str>,
        title: Option<&str>,
    ) -> Result<()> {
        let now = now_millis();
        let title = self.seal_opt(title)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO conversations (id, title, agent_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET
                 agent_id = COALESCE(excluded.agent_id, conversations.agent_id),
                 title    = COALESCE(conversations.title, excluded.title)",
            params![conversation_id, title, agent_id, now],
        )
        .context("ensuring conversation")?;
        Ok(())
    }

    /// Record run metadata (folder_path, branch, worktree_path) on the
    /// conversation row at run start. Call after `ensure_conversation` so the
    /// row is guaranteed to exist.
    pub async fn set_run_metadata(
        &self,
        conversation_id: &str,
        folder_path: Option<&str>,
        branch: Option<&str>,
        worktree_path: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations
             SET folder_path  = COALESCE(?2, folder_path),
                 branch       = COALESCE(?3, branch),
                 worktree_path = COALESCE(?4, worktree_path)
             WHERE id = ?1",
            params![conversation_id, folder_path, branch, worktree_path],
        )
        .context("setting run metadata")?;
        Ok(())
    }

    /// Update the run_status column of a conversation.
    pub async fn set_run_status(&self, conversation_id: &str, status: &str) -> Result<()> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations SET run_status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now, conversation_id],
        )
        .context("setting run status")?;
        Ok(())
    }

    /// Set (or replace) the title of a conversation. The title is sealed at rest
    /// like every other title write. Used by the coordinator `set_thread_title`
    /// tool so an orchestrator can label its worker threads, and by the desktop
    /// manual-rename endpoint.
    ///
    /// This is an explicit, human-driven rename, so it marks the title
    /// `title_custom = 1` — the background auto-namer ([`auto_set_title`]) checks
    /// that flag and never overwrites a title a user (or coordinator) chose.
    pub async fn set_title(&self, conversation_id: &str, title: &str) -> Result<()> {
        let now = now_millis();
        let sealed = self.seal_opt(Some(title))?;
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations SET title = ?1, title_custom = 1, updated_at = ?2 WHERE id = ?3",
            params![sealed, now, conversation_id],
        )
        .context("setting conversation title")?;
        Ok(())
    }

    /// Apply an auto-generated title (from the background auto-namer) to a
    /// conversation, but **only** when the user hasn't chosen one themselves
    /// (`title_custom = 0`). The guard makes the write a no-op if a manual rename
    /// raced ahead, so an LLM title can never clobber a deliberate one.
    ///
    /// Unlike [`set_title`] this does NOT set `title_custom` — an auto title stays
    /// replaceable, and a later manual rename still locks it. Returns whether a
    /// row was actually updated.
    pub async fn auto_set_title(&self, conversation_id: &str, title: &str) -> Result<bool> {
        let now = now_millis();
        let sealed = self.seal_opt(Some(title))?;
        let conn = self.conn.lock().await;
        let changed = conn
            .execute(
                "UPDATE conversations SET title = ?1, updated_at = ?2
                 WHERE id = ?3 AND title_custom = 0",
                params![sealed, now, conversation_id],
            )
            .context("auto-setting conversation title")?;
        Ok(changed > 0)
    }

    /// Whether a conversation's title is user-chosen (locked against auto-rename).
    /// Used by the auto-namer to skip conversations the user already renamed.
    pub async fn title_is_custom(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let custom: Option<i64> = conn
            .query_row(
                "SELECT title_custom FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading title_custom")?;
        Ok(custom.unwrap_or(0) != 0)
    }

    /// Pin or unpin a conversation (coordinator `set_thread_pinned`).
    pub async fn set_pinned(&self, conversation_id: &str, pinned: bool) -> Result<()> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations SET pinned = ?1, updated_at = ?2 WHERE id = ?3",
            params![i64::from(pinned), now, conversation_id],
        )
        .context("setting pinned flag")?;
        Ok(())
    }

    /// Archive or unarchive a conversation (coordinator `set_thread_archived`).
    pub async fn set_archived(&self, conversation_id: &str, archived: bool) -> Result<()> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations SET archived = ?1, updated_at = ?2 WHERE id = ?3",
            params![i64::from(archived), now, conversation_id],
        )
        .context("setting archived flag")?;
        Ok(())
    }

    /// Append a message and bump the conversation's `updated_at`. Returns the new
    /// message id. Creates the conversation if it does not exist yet.
    pub async fn append_message(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        author_user_id: Option<&str>,
        author_name: Option<&str>,
    ) -> Result<String> {
        let now = now_millis();
        let message_id = uuid::Uuid::new_v4().to_string();

        // Index the message body for semantic search — best-effort, fail-open.
        // We spawn BEFORE taking the DB lock and embed the *plaintext* (pre-seal)
        // in the spawned task, so the network embed never holds the conversation
        // mutex and a down embed sidecar can never block or slow the chat write.
        if let Some(index) = self.message_index.clone() {
            if !content.trim().is_empty() {
                let index_msg_id = message_id.clone();
                let index_conv_id = conversation_id.to_owned();
                let index_role = role.to_owned();
                let index_content = content.to_owned();
                tokio::spawn(async move {
                    let embedder = index.embedder();
                    match embedder.embed(&index_content).await {
                        Ok(vec) => {
                            if let Err(e) = index
                                .index_message(
                                    &index_msg_id,
                                    &index_conv_id,
                                    &index_role,
                                    &vec,
                                    embedder.model_id(),
                                    now,
                                )
                                .await
                            {
                                tracing::warn!(
                                    "message-index write failed for {index_msg_id}: {e:#}"
                                );
                            }
                        }
                        Err(e) => tracing::warn!(
                            "message-index embed failed for {index_msg_id} (sidecar down?): {e:#}"
                        ),
                    }
                });
            }
        }

        let conn = self.conn.lock().await;
        // Derive a first-pass title from the first user message (sealed at rest).
        let title = if role == "user" {
            self.seal_opt(Some(&derive_title(content)))?
        } else {
            None
        };
        conn.execute(
            "INSERT INTO conversations (id, title, agent_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET
                 updated_at = ?4,
                 agent_id   = COALESCE(excluded.agent_id, conversations.agent_id),
                 title      = COALESCE(conversations.title, excluded.title)",
            params![conversation_id, title, agent_id, now],
        )
        .context("upserting conversation on append")?;
        let sealed = self.cipher.seal(content)?;
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, agent_id, author_user_id, author_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![message_id, conversation_id, role, sealed, agent_id, author_user_id, author_name, now],
        )
        .context("inserting message")?;

        // Auto-rename trigger: when this is the conversation's *first* user
        // message and the title hasn't been user-locked, hand the id to the
        // server-side auto-namer (ChatGPT/Claude-style). We fire exactly once per
        // conversation (guarded on user-message count == 1) so the model is asked
        // for a title only at the start; the consumer re-checks `title_custom`
        // before writing, so a manual rename that races still wins.
        if role == "user" {
            if let Some(tx) = &self.auto_title_tx {
                let user_count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM messages
                         WHERE conversation_id = ?1 AND role = 'user'",
                        params![conversation_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                let already_custom: i64 = conn
                    .query_row(
                        "SELECT title_custom FROM conversations WHERE id = ?1",
                        params![conversation_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                if user_count == 1 && already_custom == 0 {
                    // Best-effort: a full/closed channel just skips auto-naming.
                    let _ = tx.send(conversation_id.to_owned());
                }
            }
        }
        // Release the conversation DB lock before fanning out — the publish is a
        // non-blocking broadcast send on a different mutex, but there is no reason
        // to hold the conn lock across it.
        drop(conn);

        // Room-keyed realtime fan-out (Phase 1): make this turn appear live for
        // every other viewer of the conversation. We publish the *plaintext*
        // `content` (the same value `GET /api/conversations/:id` returns after
        // decrypting the sealed column) — never the sealed blob — and reuse `now`
        // (the exact `created_at` written to the row) so the live frame matches the
        // persisted/GET shape. The gateway wraps this INNER value as
        // `{"channel":"events","data":<value>}`; do not pre-wrap with "channel".
        // No-op when realtime is unwired (tests/CLI) or the room has no members.
        if let Some(realtime) = &self.realtime {
            realtime.publish_event(
                conversation_id,
                serde_json::json!({
                    "type": "message",
                    "conversation_id": conversation_id,
                    "message": {
                        "id": message_id,
                        "role": role,
                        "content": content,
                        "author_user_id": author_user_id,
                        "author_name": author_name,
                        "created_at": now,
                        "agent_id": agent_id,
                    }
                }),
            );
        }
        Ok(message_id)
    }

    /// List conversations, most-recently-updated first.
    pub async fn list_conversations(&self) -> Result<Vec<ConversationSummary>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT c.id, c.title, c.agent_id, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id),
                    c.folder_path, c.branch, c.worktree_path, c.run_status,
                    c.participants, c.pinned, c.archived
             FROM conversations c
             ORDER BY c.updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let participants_json: Option<String> = row.get(10)?;
            let participants = parse_participants_json(participants_json.as_deref());
            Ok(ConversationSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                agent_id: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                message_count: row.get(5)?,
                folder_path: row.get(6)?,
                branch: row.get(7)?,
                worktree_path: row.get(8)?,
                run_status: row.get(9)?,
                participants,
                pinned: row.get::<_, i64>(11)? != 0,
                archived: row.get::<_, i64>(12)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            let mut summary = row?;
            summary.title = self.open_opt(summary.title);
            out.push(summary);
        }
        Ok(out)
    }

    /// List conversations that have an active or recently-finished run (i.e.
    /// run_status is not NULL), ordered most-recently-updated first.  Used by
    /// the background-runs view (issue #128) and the sidebar runs section.
    pub async fn list_runs(&self) -> Result<Vec<ConversationSummary>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT c.id, c.title, c.agent_id, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id),
                    c.folder_path, c.branch, c.worktree_path, c.run_status,
                    c.participants, c.pinned, c.archived
             FROM conversations c
             WHERE c.run_status IS NOT NULL
             ORDER BY c.updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let participants_json: Option<String> = row.get(10)?;
            let participants = parse_participants_json(participants_json.as_deref());
            Ok(ConversationSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                agent_id: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                message_count: row.get(5)?,
                folder_path: row.get(6)?,
                branch: row.get(7)?,
                worktree_path: row.get(8)?,
                run_status: row.get(9)?,
                participants,
                pinned: row.get::<_, i64>(11)? != 0,
                archived: row.get::<_, i64>(12)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            let mut summary = row?;
            summary.title = self.open_opt(summary.title);
            out.push(summary);
        }
        Ok(out)
    }

    /// Decrypt a stored `content` value, degrading gracefully: a row that fails
    /// to decrypt (corrupt/wrong-key) is replaced with a marker rather than
    /// failing the whole conversation load. Legacy plaintext passes through.
    fn open_content(&self, stored: String) -> String {
        self.cipher.open(&stored).unwrap_or_else(|e| {
            tracing::warn!("could not decrypt message content: {e}");
            "[unable to decrypt message]".to_owned()
        })
    }

    /// Seal an optional field (e.g. a conversation title) for storage. `None`
    /// stays `None` so SQL `COALESCE`/null semantics are preserved.
    fn seal_opt(&self, value: Option<&str>) -> Result<Option<String>> {
        value.map(|v| self.cipher.seal(v)).transpose()
    }

    /// Decrypt an optional stored field, with the same graceful degradation as
    /// [`Self::open_content`]. Legacy plaintext passes through.
    fn open_opt(&self, stored: Option<String>) -> Option<String> {
        stored.map(|s| {
            self.cipher.open(&s).unwrap_or_else(|e| {
                tracing::warn!("could not decrypt conversation title: {e}");
                "[unable to decrypt]".to_owned()
            })
        })
    }

    /// Fetch all messages of a conversation in chronological order.
    pub async fn get_messages(&self, conversation_id: &str) -> Result<Vec<StoredMessage>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, role, content, agent_id, created_at, author_user_id, author_name
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = stmt.query_map([conversation_id], |row| {
            Ok(StoredMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                agent_id: row.get(3)?,
                created_at: row.get(4)?,
                author_user_id: row.get(5)?,
                author_name: row.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            let mut msg = row?;
            msg.content = self.open_content(std::mem::take(&mut msg.content));
            out.push(msg);
        }
        Ok(out)
    }

    /// The decrypted text of a conversation's earliest user message, if any.
    /// Used by the auto-namer to seed a concise title from what the user first
    /// asked. Returns `None` for conversations with no user turn yet.
    pub async fn get_first_user_message(&self, conversation_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        let sealed: Option<String> = conn
            .query_row(
                "SELECT content FROM messages
                 WHERE conversation_id = ?1 AND role = 'user'
                 ORDER BY created_at ASC, rowid ASC
                 LIMIT 1",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading first user message")?;
        Ok(sealed.map(|s| self.open_content(s)))
    }

    /// Semantic search over past conversation messages (the `search_conversations`
    /// builtin tool). Returns `None` when no message index is wired.
    ///
    /// Performs a **lazy backfill** first: any stored message not yet in the index
    /// is decrypted and embedded so the feature returns hits for chats already on
    /// disk, not just future ones. A failed embed during backfill is non-fatal —
    /// that message is skipped this round (the next search retries it). Then runs a
    /// KNN over the index and re-reads + decrypts each hit's snippet from this db
    /// (the index stores only vectors + metadata, never message text). Hits whose
    /// message id no longer resolves (e.g. a deleted conversation orphaned its
    /// vector) are dropped.
    pub async fn search_messages(
        &self,
        query: &str,
        limit: usize,
        conversation_ids: Option<&[String]>,
    ) -> Result<Option<Vec<MessageSearchHit>>> {
        let Some(index) = self.message_index.clone() else {
            return Ok(None);
        };

        // ── Lazy backfill ───────────────────────────────────────────────────
        // Compute the set of not-yet-indexed messages, decrypt each, embed, and
        // index. Best-effort: a single embed failure skips that one message.
        let already = index.indexed_ids().await.unwrap_or_default();
        let unindexed = {
            let conn = self.conn.lock().await;
            let mut stmt = conn
                .prepare("SELECT id, conversation_id, role, content, created_at FROM messages")?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?;
            let mut pending: Vec<(String, String, String, String, i64)> = Vec::new();
            for row in rows {
                let (id, conv, role, sealed, created) = row?;
                if already.contains(&id) {
                    continue;
                }
                let plaintext = self.open_content(sealed);
                if plaintext.trim().is_empty() {
                    continue;
                }
                pending.push((id, conv, role, plaintext, created));
            }
            pending
        };
        if !unindexed.is_empty() {
            let bg_index = index.clone();
            tokio::spawn(async move {
                let embedder = bg_index.embedder();
                let model = embedder.model_id().to_string();
                let mut consecutive_failures: u32 = 0;
                for (id, conv, role, content, created) in unindexed {
                    if consecutive_failures >= 3 {
                        tracing::warn!(
                            "backfill embed: aborting after {consecutive_failures} consecutive \
                             failures — sidecar likely down, will retry on next search"
                        );
                        break;
                    }
                    match embedder.embed(&content).await {
                        Ok(vec) => {
                            consecutive_failures = 0;
                            if let Err(e) = bg_index
                                .index_message(&id, &conv, &role, &vec, &model, created)
                                .await
                            {
                                tracing::warn!("backfill index write failed for {id}: {e:#}");
                            }
                        }
                        Err(e) => {
                            consecutive_failures += 1;
                            tracing::warn!("backfill embed failed for {id} (sidecar down?): {e:#}");
                        }
                    }
                }
            });
        }

        // ── KNN + snippet re-read ────────────────────────────────────────────
        let hits = index.search(query, limit, conversation_ids).await?;
        let mut out = Vec::with_capacity(hits.len());
        for hit in hits {
            let sealed: Option<String> = {
                let conn = self.conn.lock().await;
                conn.query_row(
                    "SELECT content FROM messages WHERE id = ?1",
                    [&hit.message_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            };
            // Drop orphaned vectors (message deleted out from under the index).
            let Some(sealed) = sealed else { continue };
            out.push(MessageSearchHit {
                conversation_id: hit.conversation_id,
                message_id: hit.message_id,
                role: hit.role,
                content: self.open_content(sealed),
                created_at: hit.created_at,
                // vec0's default metric is L2 (Euclidean) distance. The embedder
                // L2-normalizes its vectors, so distance lies in [0, 2] (0 =
                // identical, 2 = opposite). Map it to a monotonic [0, 1] relevance
                // hint — this preserves ranking and gives a bounded score; it is a
                // relevance indicator, not an exact cosine value.
                score: (1.0 - hit.distance / 2.0).clamp(0.0, 1.0),
            });
        }
        Ok(Some(out))
    }

    /// Full-text (FTS5) search over past conversation messages — the lexical/keyword
    /// complement to [`search_messages`] (semantic KNN). Returns `None` when no FTS
    /// index is wired.
    ///
    /// Performs a **lazy backfill** first: any stored message not yet in the FTS
    /// index is decrypted and indexed so the feature returns hits for chats already
    /// on disk, not just future ones. Unlike the semantic backfill this is
    /// network-free (no embedder), so it runs INLINE (awaited) rather than spawned —
    /// a down embed sidecar can never affect it. Then runs the FTS MATCH and
    /// re-reads + decrypts each hit's snippet from this db (the FTS index stores only
    /// the tokenized inverted index + metadata, never message text). Hits whose
    /// message id no longer resolves (e.g. a deleted conversation orphaned its FTS
    /// row) are dropped.
    pub async fn fts_search_messages(
        &self,
        query: &str,
        limit: usize,
        conversation_ids: Option<&[String]>,
    ) -> Result<Option<Vec<MessageSearchHit>>> {
        let Some(index) = self.message_fts.clone() else {
            return Ok(None);
        };

        // ── Lazy backfill (inline, network-free) ─────────────────────────────
        let already = index.indexed_ids().await.unwrap_or_default();
        let unindexed = {
            let conn = self.conn.lock().await;
            let mut stmt = conn
                .prepare("SELECT id, conversation_id, role, content, created_at FROM messages")?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?;
            let mut pending: Vec<(String, String, String, String, i64)> = Vec::new();
            for row in rows {
                let (id, conv, role, sealed, created) = row?;
                if already.contains(&id) {
                    continue;
                }
                let plaintext = self.open_content(sealed);
                if plaintext.trim().is_empty() {
                    continue;
                }
                pending.push((id, conv, role, plaintext, created));
            }
            pending
        };
        for (id, conv, role, content, created) in unindexed {
            if let Err(e) = index
                .index_message(&id, &conv, &role, &content, created)
                .await
            {
                tracing::warn!("fts backfill index write failed for {id}: {e:#}");
            }
        }

        // ── FTS MATCH + snippet re-read ──────────────────────────────────────
        let hits = index.search(query, limit, conversation_ids).await?;
        let mut out = Vec::with_capacity(hits.len());
        for hit in hits {
            let sealed: Option<String> = {
                let conn = self.conn.lock().await;
                conn.query_row(
                    "SELECT content FROM messages WHERE id = ?1",
                    [&hit.message_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            };
            // Drop orphaned rows (message deleted out from under the index).
            let Some(sealed) = sealed else { continue };
            out.push(MessageSearchHit {
                conversation_id: hit.conversation_id,
                message_id: hit.message_id,
                role: hit.role,
                content: self.open_content(sealed),
                created_at: hit.created_at,
                score: hit.score,
            });
        }
        Ok(Some(out))
    }

    /// Fetch the most recent `limit` messages of a conversation, returned in
    /// chronological order (oldest first). Used by short-term memory (spec unit
    /// U11) to assemble recent session context for each request without
    /// replaying the entire history.
    pub async fn get_recent_messages(
        &self,
        conversation_id: &str,
        limit: usize,
    ) -> Result<Vec<StoredMessage>> {
        let conn = self.conn.lock().await;
        // Select the newest `limit` rows, then reverse to chronological order.
        let mut stmt = conn.prepare(
            "SELECT id, role, content, agent_id, created_at, author_user_id, author_name
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![conversation_id, limit as i64], |row| {
            Ok(StoredMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                agent_id: row.get(3)?,
                created_at: row.get(4)?,
                author_user_id: row.get(5)?,
                author_name: row.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            let mut msg = row?;
            msg.content = self.open_content(std::mem::take(&mut msg.content));
            out.push(msg);
        }
        out.reverse();
        Ok(out)
    }

    /// Update conversation metadata only when `incoming_updated_at` is strictly
    /// newer than the stored `updated_at` value (last-writer-wins).
    /// Used by the cross-device sync client (`server/sync.rs`).
    pub async fn update_metadata_if_newer(
        &self,
        conversation_id: &str,
        title: Option<&str>,
        agent_id: Option<&str>,
        folder_path: Option<&str>,
        branch: Option<&str>,
        worktree_path: Option<&str>,
        run_status: Option<&str>,
        incoming_updated_at: i64,
    ) -> Result<()> {
        let title = self.seal_opt(title)?;
        let conn = self.conn.lock().await;
        // Only overwrite when the incoming timestamp is >= the stored one (LWW).
        conn.execute(
            "UPDATE conversations
             SET title         = COALESCE(?2, title),
                 agent_id      = COALESCE(?3, agent_id),
                 folder_path   = COALESCE(?4, folder_path),
                 branch        = COALESCE(?5, branch),
                 worktree_path = COALESCE(?6, worktree_path),
                 run_status    = COALESCE(?7, run_status),
                 updated_at    = ?8
             WHERE id = ?1 AND updated_at <= ?8",
            params![
                conversation_id,
                title,
                agent_id,
                folder_path,
                branch,
                worktree_path,
                run_status,
                incoming_updated_at,
            ],
        )
        .context("update_metadata_if_newer")?;
        Ok(())
    }

    /// Append a message with an explicit stable id (used by the sync client to
    /// replay messages from a remote payload without generating new ids).
    /// Skips the insert silently when a message with the given id already
    /// exists (idempotent — union-merge semantics for cross-device sync).
    pub async fn append_message_with_id(
        &self,
        conversation_id: &str,
        message_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        created_at_ms: i64,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        // Upsert the conversation row so the message FK is satisfied.
        conn.execute(
            "INSERT INTO conversations (id, agent_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(id) DO UPDATE SET
                 agent_id   = COALESCE(excluded.agent_id, conversations.agent_id),
                 updated_at = MAX(conversations.updated_at, excluded.updated_at)",
            params![conversation_id, agent_id, created_at_ms],
        )
        .context("upserting conversation for append_with_id")?;

        // INSERT OR IGNORE: skip when the message id already exists (idempotent).
        let sealed = self.cipher.seal(content)?;
        conn.execute(
            "INSERT OR IGNORE INTO messages (id, conversation_id, role, content, agent_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![message_id, conversation_id, role, sealed, agent_id, created_at_ms],
        )
        .context("inserting message with explicit id")?;
        Ok(())
    }

    /// Fetch full conversation detail including messages and participants.
    pub async fn get_conversation_detail(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ConversationDetail>> {
        let messages = self.get_messages(conversation_id).await?;
        let conn = self.conn.lock().await;
        let row: Option<(Option<String>, Option<String>, i64, i64, Option<String>)> = conn
            .query_row(
                "SELECT title, agent_id, created_at, updated_at, participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        match row {
            None => Ok(None),
            Some((title, agent_id, created_at, updated_at, participants_json)) => {
                let participants = parse_participants_json(participants_json.as_deref());
                Ok(Some(ConversationDetail {
                    id: conversation_id.to_owned(),
                    title: self.open_opt(title),
                    agent_id,
                    created_at,
                    updated_at,
                    messages,
                    participants,
                }))
            }
        }
    }

    /// Fork (branch) a conversation into a brand-new conversation, copying every
    /// message up to and including `up_to_message_id` (ChatGPT-style "Branch in
    /// new chat"). When `up_to_message_id` is `None` the entire history is copied.
    ///
    /// The new conversation is fully independent: it gets a fresh id and fresh
    /// per-message ids, so continuing the branch never touches the source. Run
    /// metadata (folder/branch/worktree) and participants are carried over, but
    /// `run_status` and any goal are intentionally left unset on the copy.
    ///
    /// Returns the new conversation's summary, or `None` when the source does not
    /// exist or `up_to_message_id` is not a message of that conversation.
    pub async fn fork_conversation(
        &self,
        source_id: &str,
        up_to_message_id: Option<&str>,
    ) -> Result<Option<ConversationSummary>> {
        // Read the source history (chronological) before taking the write lock so
        // the cut-point lookup stays simple.
        let messages = self.get_messages(source_id).await?;
        let slice: Vec<&StoredMessage> = match up_to_message_id {
            Some(mid) => {
                let Some(idx) = messages.iter().position(|m| m.id == mid) else {
                    return Ok(None);
                };
                messages[..=idx].iter().collect()
            }
            None => messages.iter().collect(),
        };

        let now = now_millis();
        let new_id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock().await;

        // Carry over the source's metadata; bail if the row is missing.
        type SourceRow = (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let source: Option<SourceRow> = conn
            .query_row(
                "SELECT title, agent_id, folder_path, branch, worktree_path, participants
                 FROM conversations WHERE id = ?1",
                params![source_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((title, agent_id, folder_path, branch, worktree_path, participants_json)) = source
        else {
            return Ok(None);
        };
        // The stored title is sealed; decrypt before deriving the branch title,
        // then re-seal for the new row (and return the plaintext in the summary).
        let forked_title = self
            .open_opt(title)
            .map(|t| format!("{t} (branch)"))
            .or_else(|| Some("Branch".to_owned()));
        let forked_title_sealed = self.seal_opt(forked_title.as_deref())?;
        let participants_json = participants_json.unwrap_or_else(|| "[]".to_owned());

        conn.execute(
            "INSERT INTO conversations
                (id, title, agent_id, created_at, updated_at,
                 folder_path, branch, worktree_path, participants)
             VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8)",
            params![
                new_id,
                forked_title_sealed,
                agent_id,
                now,
                folder_path,
                branch,
                worktree_path,
                participants_json
            ],
        )
        .context("inserting forked conversation")?;

        // Copy each message with a fresh id, preserving role/content/agent/ordering.
        // `m.content` is already decrypted (get_messages opened it), so re-seal it
        // for the new row.
        for m in &slice {
            let copy_id = uuid::Uuid::new_v4().to_string();
            let sealed = self.cipher.seal(&m.content)?;
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, agent_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![copy_id, new_id, m.role, sealed, m.agent_id, m.created_at],
            )
            .context("copying message into fork")?;
        }

        Ok(Some(ConversationSummary {
            id: new_id,
            title: forked_title,
            agent_id,
            created_at: now,
            updated_at: now,
            message_count: slice.len() as i64,
            folder_path,
            branch,
            worktree_path,
            run_status: None,
            participants: parse_participants_json(Some(&participants_json)),
            pinned: false,
            archived: false,
        }))
    }

    /// Add an agent as a participant in a conversation. Idempotent — adding an
    /// agent that is already in the list is a no-op. Creates the conversation row
    /// if it does not yet exist.
    pub async fn add_participant(
        &self,
        conversation_id: &str,
        agent_id: &str,
    ) -> Result<Vec<String>> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        // Ensure the conversation row exists.
        conn.execute(
            "INSERT INTO conversations (id, created_at, updated_at, participants)
             VALUES (?1, ?2, ?2, '[]')
             ON CONFLICT(id) DO NOTHING",
            params![conversation_id, now],
        )
        .context("ensuring conversation for add_participant")?;
        // Load current participants.
        let participants_json: Option<String> = conn
            .query_row(
                "SELECT participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let mut participants = parse_participants_json(participants_json.as_deref());
        if !participants.iter().any(|p| p == agent_id) {
            participants.push(agent_id.to_owned());
            let new_json = serde_json::to_string(&participants).unwrap_or_else(|_| "[]".to_owned());
            conn.execute(
                "UPDATE conversations SET participants = ?2, updated_at = ?3 WHERE id = ?1",
                params![conversation_id, new_json, now],
            )
            .context("updating participants in add_participant")?;
        }
        Ok(participants)
    }

    /// Remove an agent from a conversation's participant list. Idempotent — if
    /// the agent is not present the list is returned unchanged.
    pub async fn remove_participant(
        &self,
        conversation_id: &str,
        agent_id: &str,
    ) -> Result<Vec<String>> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        let participants_json: Option<String> = conn
            .query_row(
                "SELECT participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let mut participants = parse_participants_json(participants_json.as_deref());
        let before_len = participants.len();
        participants.retain(|p| p != agent_id);
        if participants.len() != before_len {
            let new_json = serde_json::to_string(&participants).unwrap_or_else(|_| "[]".to_owned());
            conn.execute(
                "UPDATE conversations SET participants = ?2, updated_at = ?3 WHERE id = ?1",
                params![conversation_id, new_json, now],
            )
            .context("updating participants in remove_participant")?;
        }
        Ok(participants)
    }

    /// Return the current participant list for a conversation.
    pub async fn get_participants(&self, conversation_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let participants_json: Option<String> = conn
            .query_row(
                "SELECT participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        Ok(parse_participants_json(participants_json.as_deref()))
    }

    /// Load the tenancy quartet (owner / org / visibility / team) for a
    /// conversation, for the realtime WS gateway's access decision. Returns
    /// `Ok(None)` when the conversation row does not exist (an as-yet-uncreated
    /// chat — conversations are upserted lazily on the first message). These
    /// columns are plaintext (only `title` and message `content` are sealed at
    /// rest), so a raw `SELECT` compares correctly against a verified caller's id.
    pub async fn get_access_meta(
        &self,
        conversation_id: &str,
    ) -> Result<Option<crate::identity_verify::ResourceTenancy>> {
        let conn = self.conn.lock().await;
        let meta = conn
            .query_row(
                "SELECT owner_user_id, org_id, visibility, team_id
                 FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| {
                    Ok(crate::identity_verify::ResourceTenancy {
                        owner_user_id: row.get(0)?,
                        org_id: row.get(1)?,
                        // NOT NULL DEFAULT 'private' in the schema, so always present.
                        visibility: row.get(2)?,
                        team_id: row.get(3)?,
                    })
                },
            )
            .optional()
            .context("reading conversation access metadata")?;
        Ok(meta)
    }

    /// Delete a conversation and its messages. Returns true if a row was removed.
    pub async fn delete_conversation(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        // FK enforcement is off (deletes are manual), so drop side chats here too.
        conn.execute(
            "DELETE FROM btw_entries WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        let removed = conn.execute(
            "DELETE FROM conversations WHERE id = ?1",
            params![conversation_id],
        )?;
        Ok(removed > 0)
    }

    // ── Side questions (`/btw`) ───────────────────────────────────────────────

    /// Persist a `/btw` side question + answer against its parent conversation.
    /// `question`/`answer` are sealed at rest. Returns the stored entry (with the
    /// plaintext fields, for an immediate echo back to the client).
    pub async fn append_btw(
        &self,
        conversation_id: &str,
        question: &str,
        answer: &str,
        model: Option<&str>,
    ) -> Result<BtwEntry> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        let sealed_q = self.cipher.seal(question)?;
        let sealed_a = self.cipher.seal(answer)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO btw_entries (id, conversation_id, question, answer, model, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, conversation_id, sealed_q, sealed_a, model, now],
        )
        .context("persisting btw entry")?;
        Ok(BtwEntry {
            id,
            conversation_id: conversation_id.to_owned(),
            question: question.to_owned(),
            answer: answer.to_owned(),
            model: model.map(str::to_owned),
            created_at: now,
        })
    }

    /// All side questions for a conversation, newest first.
    pub async fn list_btw(&self, conversation_id: &str) -> Result<Vec<BtwEntry>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, question, answer, model, created_at
             FROM btw_entries
             WHERE conversation_id = ?1
             ORDER BY created_at DESC, rowid DESC",
        )?;
        let rows = stmt.query_map([conversation_id], |row| {
            Ok(BtwEntry {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                question: row.get(2)?,
                answer: row.get(3)?,
                model: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            let mut entry = row?;
            entry.question = self.open_content(std::mem::take(&mut entry.question));
            entry.answer = self.open_content(std::mem::take(&mut entry.answer));
            out.push(entry);
        }
        Ok(out)
    }

    /// Delete a single side question by id. Returns true when a row was removed.
    pub async fn delete_btw(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let removed = conn.execute("DELETE FROM btw_entries WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }

    /// Total number of conversations (for the danger-zone "Delete all 42 chats?"
    /// preview). Cheap `COUNT(*)`, no row materialization.
    pub async fn count_conversations(&self) -> Result<u64> {
        let conn = self.conn.lock().await;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0))?;
        Ok(n.max(0) as u64)
    }

    /// Delete **every** conversation and all chat-scoped state: messages and
    /// sessions (both keyed by `conversation_id`) plus the conversation rows
    /// themselves (which carry the goal columns). Returns the number of
    /// conversations removed. This goes further than [`Self::delete_conversation`],
    /// which leaves sessions orphaned — a full wipe should not.
    pub async fn clear_all_conversations(&self) -> Result<u64> {
        let conn = self.conn.lock().await;
        conn.execute("DELETE FROM messages", [])?;
        conn.execute("DELETE FROM sessions", [])?;
        conn.execute("DELETE FROM btw_entries", [])?;
        let removed = conn.execute("DELETE FROM conversations", [])?;
        Ok(removed as u64)
    }

    // ── Session methods ──────────────────────────────────────────────────────

    /// Create a new Session bound to a Runnable, reusing the existing
    /// conversation create path. The conversation is upserted via
    /// [`Self::ensure_conversation`] so no message data is duplicated.
    pub async fn create_session(
        &self,
        runnable_id: &str,
        runnable_kind: RunnableKind,
        agent_id: Option<&str>,
        title: Option<&str>,
    ) -> Result<Session> {
        let session_id = format!("sess_{}", uuid::Uuid::new_v4().simple());
        let conversation_id = format!("conv_{}", uuid::Uuid::new_v4().simple());
        let now = now_millis();

        // Reuse the existing conversation create path — no duplicate message store.
        let title = self.seal_opt(title)?;
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "INSERT INTO conversations (id, title, agent_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(id) DO NOTHING",
                params![conversation_id, title, agent_id, now],
            )
            .context("creating conversation for session")?;

            conn.execute(
                "INSERT INTO sessions (id, conversation_id, runnable_id, runnable_kind, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![
                    session_id,
                    conversation_id,
                    runnable_id,
                    runnable_kind.as_str(),
                    SessionStatus::Idle.as_str(),
                    now,
                ],
            )
            .context("inserting session")?;
        }

        Ok(Session {
            id: session_id,
            conversation_id,
            runnable_id: runnable_id.to_string(),
            runnable_kind,
            status: SessionStatus::Idle,
            created_at: now,
            updated_at: now,
        })
    }

    /// Load a session by id.
    pub async fn get_session(&self, session_id: &str) -> Result<Option<Session>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, runnable_id, runnable_kind, status, created_at, updated_at
             FROM sessions WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?;
        match rows.next() {
            None => Ok(None),
            Some(row) => {
                let (
                    id,
                    conversation_id,
                    runnable_id,
                    runnable_kind_str,
                    status_str,
                    created_at,
                    updated_at,
                ) = row?;
                let runnable_kind = parse_runnable_kind(&runnable_kind_str);
                Ok(Some(Session {
                    id,
                    conversation_id,
                    runnable_id,
                    runnable_kind,
                    status: SessionStatus::from_str(&status_str),
                    created_at,
                    updated_at,
                }))
            }
        }
    }

    /// Update the status of a session.
    pub async fn update_session_status(
        &self,
        session_id: &str,
        status: SessionStatus,
    ) -> Result<bool> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE sessions SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status.as_str(), now, session_id],
        )?;
        Ok(updated > 0)
    }

    /// List sessions for a conversation, most-recently-updated first.
    pub async fn list_sessions_for_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<Session>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, runnable_id, runnable_kind, status, created_at, updated_at
             FROM sessions WHERE conversation_id = ?1
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([conversation_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (
                id,
                conversation_id,
                runnable_id,
                runnable_kind_str,
                status_str,
                created_at,
                updated_at,
            ) = row?;
            let runnable_kind = parse_runnable_kind(&runnable_kind_str);
            out.push(Session {
                id,
                conversation_id,
                runnable_id,
                runnable_kind,
                status: SessionStatus::from_str(&status_str),
                created_at,
                updated_at,
            });
        }
        Ok(out)
    }
}

/// Parse a stored `runnable_kind` string back to a [`RunnableKind`].
/// Unknown strings default to `Agent` (the most common kind in practice).
fn parse_runnable_kind(s: &str) -> RunnableKind {
    match s {
        "workflow" => RunnableKind::Workflow,
        "tool" => RunnableKind::Tool,
        "skill" => RunnableKind::Skill,
        _ => RunnableKind::Agent,
    }
}

/// Parse a JSON array of agent id strings from the `participants` column.
/// Returns an empty vec on null/empty/malformed input.
fn parse_participants_json(json: Option<&str>) -> Vec<String> {
    json.filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default()
}

/// Build a short conversation title from the first user message.
fn derive_title(content: &str) -> String {
    const MAX: usize = 60;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return "New Chat".to_owned();
    }
    let first_line = trimmed.lines().next().unwrap_or(trimmed).trim();
    if first_line.chars().count() <= MAX {
        return first_line.to_owned();
    }
    let truncated: String = first_line.chars().take(MAX).collect();
    format!("{truncated}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn append_message_publishes_live_event_to_room() {
        // The make-or-break wiring: a store sharing the SAME registry instance a
        // viewer subscribes against must deliver a `message` Events frame on every
        // persisted turn, shaped to match the GET read path (plaintext content,
        // role, ids, created_at). This is the only way to catch a "wrong registry
        // instance" regression without a live WS client.
        let registry = crate::realtime::RoomRegistry::new();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_realtime(registry.clone());

        // A subscribed viewer makes the room live (publish is a no-op otherwise).
        let mut rx = registry.get_or_create("conv-live").subscribe();

        let id = store
            .append_message(
                "conv-live",
                "user",
                "hello live",
                None,
                Some("user-7"),
                None,
            )
            .await
            .unwrap();

        let frame = rx.recv().await.expect("frame delivered");
        let crate::realtime::Frame::Event(value) = frame else {
            panic!("expected an Events frame, got {frame:?}");
        };
        assert_eq!(value["type"], "message");
        assert_eq!(value["conversation_id"], "conv-live");
        assert_eq!(value["message"]["id"], id);
        assert_eq!(value["message"]["role"], "user");
        assert_eq!(value["message"]["content"], "hello live");
        assert_eq!(value["message"]["author_user_id"], "user-7");
        assert!(value["message"]["created_at"].is_i64());
    }

    #[tokio::test]
    async fn append_message_without_realtime_is_silent() {
        // Unwired store (tests/CLI) must persist exactly as before — no panic, no
        // dependency on a registry.
        let store = ConversationStore::open_in_memory().unwrap();
        let id = store
            .append_message("c-silent", "user", "hi", None, None, None)
            .await
            .unwrap();
        assert!(!id.is_empty());
    }

    #[tokio::test]
    async fn search_messages_none_without_index() {
        // No index wired (open_in_memory) → search returns None, never errors.
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("c1", "user", "hello world", None, None, None)
            .await
            .unwrap();
        let res = store.search_messages("hello", 5, None).await.unwrap();
        assert!(res.is_none());
    }

    #[tokio::test]
    async fn search_messages_backfills_and_finds_existing() {
        // Wire an in-memory index, append messages, then search. Even if the
        // append-time spawned indexing hasn't run, the lazy backfill on the
        // first search embeds the stored (decrypted) messages and finds them.
        // Uses the local (network-free) embedder, so no embed sidecar is needed.
        let index = crate::server::message_index::MessageIndex::open_in_memory().unwrap();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_index(index);
        store
            .append_message(
                "c1",
                "user",
                "rust ownership and lifetimes are tricky",
                None,
                None,
                None,
            )
            .await
            .unwrap();
        store
            .append_message(
                "c1",
                "assistant",
                "favourite pizza toppings list",
                None,
                None,
                None,
            )
            .await
            .unwrap();

        let hits = store
            .search_messages("rust lifetimes", 5, None)
            .await
            .unwrap()
            .expect("index wired");
        assert!(!hits.is_empty(), "expected a hit after backfill");
        assert!(
            hits[0].content.contains("ownership"),
            "rust message should rank first, got: {}",
            hits[0].content
        );
        // The decrypted snippet is returned (proves snippet re-read + cipher.open).
        assert!(hits[0].content.contains("lifetimes"));
    }

    #[tokio::test]
    async fn fts_search_none_without_index() {
        // No FTS index wired (open_in_memory) → search returns None, never errors.
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("c1", "user", "hello world", None, None, None)
            .await
            .unwrap();
        let res = store.fts_search_messages("hello", 5, None).await.unwrap();
        assert!(res.is_none());
    }

    #[tokio::test]
    async fn fts_search_backfills_existing_and_returns_decrypted_snippet() {
        // Append messages to an FTS-wired store, then search. The inline lazy
        // backfill on the first search indexes the stored (decrypted) messages and
        // finds them — and the returned snippet is the decrypted plaintext, not the
        // sealed blob. Network-free (no embedder).
        let index = crate::server::message_fts::MessageFtsIndex::open_in_memory().unwrap();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_fts_index(index);
        store
            .append_message(
                "c1",
                "user",
                "rust ownership and lifetimes are tricky",
                None,
                None,
                None,
            )
            .await
            .unwrap();
        store
            .append_message(
                "c2",
                "assistant",
                "favourite pizza toppings pepperoni",
                None,
                None,
                None,
            )
            .await
            .unwrap();

        let hits = store
            .fts_search_messages("pizza", 5, None)
            .await
            .unwrap()
            .expect("fts index wired");
        assert!(!hits.is_empty(), "expected a hit after backfill");
        assert_eq!(hits[0].conversation_id, "c2");
        // Proves snippet re-read + cipher.open (decrypted, not the sealed blob).
        assert!(hits[0].content.contains("pepperoni"));
        assert!(!hits[0].content.starts_with("enc:v1:"));
    }

    #[tokio::test]
    async fn fts_search_scopes_to_conversation_ids() {
        let index = crate::server::message_fts::MessageFtsIndex::open_in_memory().unwrap();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_fts_index(index);
        store
            .append_message("c1", "user", "alpha beta gamma", None, None, None)
            .await
            .unwrap();
        store
            .append_message("c2", "user", "alpha beta gamma", None, None, None)
            .await
            .unwrap();
        let hits = store
            .fts_search_messages("alpha beta", 5, Some(&["c2".to_owned()]))
            .await
            .unwrap()
            .expect("fts index wired");
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|h| h.conversation_id == "c2"));
    }

    #[tokio::test]
    async fn message_content_is_encrypted_on_disk() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("c1", "user", "my secret diary entry", None, None, None)
            .await
            .unwrap();

        // The stored column must be a sealed envelope, never the plaintext.
        let raw: String = {
            let conn = store.conn.lock().await;
            conn.query_row(
                "SELECT content FROM messages WHERE conversation_id = ?1",
                params!["c1"],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert!(
            raw.starts_with("enc:v1:"),
            "expected sealed content, got {raw}"
        );
        assert!(!raw.contains("secret diary"));

        // And it round-trips transparently on read.
        let msgs = store.get_messages("c1").await.unwrap();
        assert_eq!(msgs[0].content, "my secret diary entry");
    }

    #[tokio::test]
    async fn legacy_plaintext_messages_still_readable() {
        // A row written before encryption was introduced has no envelope prefix.
        let store = ConversationStore::open_in_memory().unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "INSERT INTO conversations (id, created_at, updated_at) VALUES ('c1', 0, 0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, created_at)
                 VALUES ('m1', 'c1', 'user', 'old plaintext message', 0)",
                [],
            )
            .unwrap();
        }
        let msgs = store.get_messages("c1").await.unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content, "old plaintext message");
    }

    #[tokio::test]
    async fn conversation_title_is_encrypted_on_disk() {
        let store = ConversationStore::open_in_memory().unwrap();
        // The first user message derives the title from its content.
        store
            .append_message(
                "c1",
                "user",
                "Plan the secret acquisition",
                None,
                None,
                None,
            )
            .await
            .unwrap();

        let raw: Option<String> = {
            let conn = store.conn.lock().await;
            conn.query_row(
                "SELECT title FROM conversations WHERE id = ?1",
                params!["c1"],
                |r| r.get(0),
            )
            .unwrap()
        };
        let raw = raw.expect("title should be set");
        assert!(
            raw.starts_with("enc:v1:"),
            "expected sealed title, got {raw}"
        );
        assert!(!raw.contains("secret acquisition"));

        // Both list and detail return the decrypted title.
        let list = store.list_conversations().await.unwrap();
        assert_eq!(
            list[0].title.as_deref(),
            Some("Plan the secret acquisition")
        );
        let detail = store.get_conversation_detail("c1").await.unwrap().unwrap();
        assert_eq!(detail.title.as_deref(), Some("Plan the secret acquisition"));
    }

    #[tokio::test]
    async fn auto_set_title_overwrites_derived_but_not_custom() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("c1", "user", "how do I center a div", None, None, None)
            .await
            .unwrap();
        // Provisional title is the derived first message; not yet user-locked.
        assert!(!store.title_is_custom("c1").await.unwrap());

        // The auto-namer may overwrite the derived title.
        assert!(store.auto_set_title("c1", "Centering a div").await.unwrap());
        let list = store.list_conversations().await.unwrap();
        assert_eq!(list[0].title.as_deref(), Some("Centering a div"));

        // A manual rename locks the title.
        store.set_title("c1", "CSS layout help").await.unwrap();
        assert!(store.title_is_custom("c1").await.unwrap());

        // A later auto-name is a no-op once the user has chosen a title.
        assert!(!store.auto_set_title("c1", "Robot title").await.unwrap());
        let list = store.list_conversations().await.unwrap();
        assert_eq!(list[0].title.as_deref(), Some("CSS layout help"));
    }

    #[tokio::test]
    async fn first_user_message_fires_auto_title_once() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_auto_title(tx);

        // First user message fires the auto-rename signal.
        store
            .append_message("c1", "user", "first question", None, None, None)
            .await
            .unwrap();
        assert_eq!(rx.try_recv().ok(), Some("c1".to_owned()));

        // Assistant reply + a second user turn must NOT fire again.
        store
            .append_message("c1", "assistant", "an answer", None, None, None)
            .await
            .unwrap();
        store
            .append_message("c1", "user", "follow-up", None, None, None)
            .await
            .unwrap();
        assert!(rx.try_recv().is_err(), "auto-title should fire only once");

        // `get_first_user_message` returns the earliest user turn.
        assert_eq!(
            store.get_first_user_message("c1").await.unwrap().as_deref(),
            Some("first question")
        );
    }

    #[tokio::test]
    async fn append_and_fetch_round_trips() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-1", "user", "Hello there", Some("default"), None, None)
            .await
            .unwrap();
        store
            .append_message("conv-1", "assistant", "Hi!", Some("default"), None, None)
            .await
            .unwrap();

        let msgs = store.get_messages("conv-1").await.unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, "Hello there");
        assert_eq!(msgs[1].role, "assistant");
    }

    #[tokio::test]
    async fn list_orders_by_recency_and_counts() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-a", "user", "first", None, None, None)
            .await
            .unwrap();
        store
            .append_message("conv-b", "user", "second", None, None, None)
            .await
            .unwrap();
        store
            .append_message("conv-a", "assistant", "reply", None, None, None)
            .await
            .unwrap();

        let list = store.list_conversations().await.unwrap();
        assert_eq!(list.len(), 2);
        // conv-a was updated last, so it sorts first.
        assert_eq!(list[0].id, "conv-a");
        assert_eq!(list[0].message_count, 2);
        assert_eq!(list[0].title.as_deref(), Some("first"));
    }

    #[tokio::test]
    async fn delete_removes_conversation_and_messages() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-x", "user", "to delete", None, None, None)
            .await
            .unwrap();
        assert!(store.delete_conversation("conv-x").await.unwrap());
        assert!(store.get_messages("conv-x").await.unwrap().is_empty());
        assert!(!store.delete_conversation("conv-x").await.unwrap());
    }

    #[tokio::test]
    async fn clear_all_removes_every_conversation() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-a", "user", "hi", None, None, None)
            .await
            .unwrap();
        store
            .append_message("conv-b", "user", "yo", None, None, None)
            .await
            .unwrap();
        assert_eq!(store.count_conversations().await.unwrap(), 2);

        let removed = store.clear_all_conversations().await.unwrap();
        assert_eq!(removed, 2);
        assert_eq!(store.count_conversations().await.unwrap(), 0);
        assert!(store.list_conversations().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn fork_copies_history_up_to_message_into_new_conversation() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("src", "user", "q1", None, None, None)
            .await
            .unwrap();
        let cut = store
            .append_message("src", "assistant", "a1", Some("default"), None, None)
            .await
            .unwrap();
        store
            .append_message("src", "user", "q2", None, None, None)
            .await
            .unwrap();

        let forked = store
            .fork_conversation("src", Some(&cut))
            .await
            .unwrap()
            .expect("fork should succeed");
        assert_ne!(forked.id, "src");
        assert_eq!(forked.message_count, 2);
        assert_eq!(forked.title.as_deref(), Some("q1 (branch)"));

        // The fork has exactly the first two messages, with fresh ids.
        let copied = store.get_messages(&forked.id).await.unwrap();
        assert_eq!(copied.len(), 2);
        assert_eq!(copied[0].content, "q1");
        assert_eq!(copied[1].content, "a1");
        assert_ne!(copied[1].id, cut, "copied messages get fresh ids");

        // The source is untouched; continuing the fork never touches it.
        assert_eq!(store.get_messages("src").await.unwrap().len(), 3);
        store
            .append_message(&forked.id, "user", "branch-only", None, None, None)
            .await
            .unwrap();
        assert_eq!(store.get_messages("src").await.unwrap().len(), 3);
        assert_eq!(store.get_messages(&forked.id).await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn fork_missing_source_or_message_returns_none() {
        let store = ConversationStore::open_in_memory().unwrap();
        assert!(store
            .fork_conversation("nope", None)
            .await
            .unwrap()
            .is_none());
        store
            .append_message("src2", "user", "hi", None, None, None)
            .await
            .unwrap();
        assert!(store
            .fork_conversation("src2", Some("not-a-real-id"))
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn get_recent_returns_tail_in_order() {
        let store = ConversationStore::open_in_memory().unwrap();
        for n in 0..5 {
            store
                .append_message("conv-r", "user", &format!("msg {n}"), None, None, None)
                .await
                .unwrap();
        }
        let recent = store.get_recent_messages("conv-r", 2).await.unwrap();
        assert_eq!(recent.len(), 2);
        // Newest two, in chronological order.
        assert_eq!(recent[0].content, "msg 3");
        assert_eq!(recent[1].content, "msg 4");
    }

    #[test]
    fn title_truncates_long_first_line() {
        let long = "a".repeat(100);
        let title = derive_title(&long);
        assert!(title.chars().count() <= 61); // 60 chars + ellipsis
        assert!(title.ends_with('…'));
    }

    #[tokio::test]
    async fn session_round_trip_with_existing_conversation_store() {
        let store = ConversationStore::open_in_memory().unwrap();

        // Create a session bound to an agent Runnable.
        let session = store
            .create_session(
                "agent-abc",
                RunnableKind::Agent,
                Some("agent-abc"),
                Some("Test session"),
            )
            .await
            .unwrap();

        assert_eq!(session.runnable_id, "agent-abc");
        assert_eq!(session.runnable_kind, RunnableKind::Agent);
        assert_eq!(session.status, SessionStatus::Idle);

        // Append a message via the existing ConversationStore path (no duplicate store).
        store
            .append_message(
                &session.conversation_id,
                "user",
                "Hello from session test",
                Some("agent-abc"),
                None,
                None,
            )
            .await
            .unwrap();

        // Reload session and verify state.
        let reloaded = store.get_session(&session.id).await.unwrap().unwrap();
        assert_eq!(reloaded.id, session.id);
        assert_eq!(reloaded.runnable_kind, RunnableKind::Agent);
        assert_eq!(reloaded.status, SessionStatus::Idle);

        // Verify the message is accessible through the existing store.
        let msgs = store.get_messages(&session.conversation_id).await.unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content, "Hello from session test");

        // Update status and verify round-trip.
        let updated = store
            .update_session_status(&session.id, SessionStatus::Running)
            .await
            .unwrap();
        assert!(updated);

        let after_update = store.get_session(&session.id).await.unwrap().unwrap();
        assert_eq!(after_update.status, SessionStatus::Running);
    }

    #[tokio::test]
    async fn session_runnable_kind_round_trips_for_workflow() {
        let store = ConversationStore::open_in_memory().unwrap();
        let session = store
            .create_session("wf-xyz", RunnableKind::Workflow, None, None)
            .await
            .unwrap();
        let reloaded = store.get_session(&session.id).await.unwrap().unwrap();
        assert_eq!(reloaded.runnable_kind, RunnableKind::Workflow);
    }

    #[tokio::test]
    async fn run_metadata_round_trips_and_migration_is_idempotent() {
        // Build a store via the normal path (exercises init_schema including the
        // ALTER TABLE migration).
        let store = ConversationStore::open_in_memory().unwrap();

        // Verify that calling init_schema a second time on the same connection
        // (the migration no-op path) does not error and leaves existing data intact.
        {
            let conn = store.conn.lock().await;
            ConversationStore::init_schema(&conn).expect("second init_schema must be a no-op");
        }

        // Create a conversation and set run metadata.
        store
            .append_message("conv-run", "user", "hello", Some("agent-1"), None, None)
            .await
            .unwrap();

        store
            .set_run_metadata("conv-run", Some("/home/user/project"), Some("main"), None)
            .await
            .unwrap();
        store.set_run_status("conv-run", "running").await.unwrap();

        // list_conversations must return the new fields.
        let list = store.list_conversations().await.unwrap();
        assert_eq!(list.len(), 1);
        let summary = &list[0];
        assert_eq!(summary.folder_path.as_deref(), Some("/home/user/project"));
        assert_eq!(summary.branch.as_deref(), Some("main"));
        assert!(summary.worktree_path.is_none());
        assert_eq!(summary.run_status.as_deref(), Some("running"));

        // Update status to completed.
        store.set_run_status("conv-run", "completed").await.unwrap();
        let list2 = store.list_conversations().await.unwrap();
        assert_eq!(list2[0].run_status.as_deref(), Some("completed"));
    }

    #[tokio::test]
    async fn run_metadata_null_fields_preserved_when_unset() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-null", "user", "hi", None, None, None)
            .await
            .unwrap();

        // No metadata set — all new fields must be None.
        let list = store.list_conversations().await.unwrap();
        assert_eq!(list[0].folder_path, None);
        assert_eq!(list[0].branch, None);
        assert_eq!(list[0].worktree_path, None);
        assert_eq!(list[0].run_status, None);
    }

    // ── Multi-agent participants (#414) ───────────────────────────────────────

    #[tokio::test]
    async fn participants_add_remove_roundtrip() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message(
                "conv-multi",
                "user",
                "hello",
                Some("agent-alpha"),
                None,
                None,
            )
            .await
            .unwrap();

        // Start with no participants.
        let initial = store.get_participants("conv-multi").await.unwrap();
        assert!(initial.is_empty(), "new conversation has no participants");

        // Add two agents.
        let after_add1 = store
            .add_participant("conv-multi", "agent-alpha")
            .await
            .unwrap();
        assert_eq!(after_add1, vec!["agent-alpha"]);

        let after_add2 = store
            .add_participant("conv-multi", "agent-beta")
            .await
            .unwrap();
        assert_eq!(after_add2, vec!["agent-alpha", "agent-beta"]);

        // Idempotent: adding agent-alpha again changes nothing.
        let after_dup = store
            .add_participant("conv-multi", "agent-alpha")
            .await
            .unwrap();
        assert_eq!(after_dup, vec!["agent-alpha", "agent-beta"]);

        // Remove one.
        let after_remove = store
            .remove_participant("conv-multi", "agent-alpha")
            .await
            .unwrap();
        assert_eq!(after_remove, vec!["agent-beta"]);

        // Verify via get_participants.
        let final_list = store.get_participants("conv-multi").await.unwrap();
        assert_eq!(final_list, vec!["agent-beta"]);
    }

    #[tokio::test]
    async fn messages_carry_agent_id() {
        let store = ConversationStore::open_in_memory().unwrap();

        // Two agents in one conversation each produce a message.
        store
            .append_message("conv-agents", "user", "question", None, None, None)
            .await
            .unwrap();
        store
            .append_message(
                "conv-agents",
                "assistant",
                "reply from alpha",
                Some("agent-alpha"),
                None,
                None,
            )
            .await
            .unwrap();
        store
            .append_message(
                "conv-agents",
                "assistant",
                "reply from beta",
                Some("agent-beta"),
                None,
                None,
            )
            .await
            .unwrap();

        let msgs = store.get_messages("conv-agents").await.unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].agent_id, None, "user message has no agent_id");
        assert_eq!(msgs[1].agent_id.as_deref(), Some("agent-alpha"));
        assert_eq!(msgs[2].agent_id.as_deref(), Some("agent-beta"));
    }

    #[tokio::test]
    async fn messages_carry_author_name() {
        // Group/channel support: a connector-supplied sender display name is
        // persisted on the user message and read back, while agent/1:1 messages
        // carry no author_name. (`author_user_id` stays None — author_name is the
        // unverified display label, distinct from a verified identity.)
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message(
                "conv-grp",
                "user",
                "Alice: hi team",
                None,
                None,
                Some("Alice"),
            )
            .await
            .unwrap();
        store
            .append_message(
                "conv-grp",
                "assistant",
                "hello",
                Some("agent-x"),
                None,
                None,
            )
            .await
            .unwrap();

        let msgs = store.get_messages("conv-grp").await.unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].author_name.as_deref(), Some("Alice"));
        assert_eq!(
            msgs[0].author_user_id, None,
            "display name is not a verified id"
        );
        assert_eq!(
            msgs[1].author_name, None,
            "agent message has no author_name"
        );
    }

    #[tokio::test]
    async fn get_conversation_detail_includes_participants() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-detail", "user", "hi", Some("agent-x"), None, None)
            .await
            .unwrap();
        store
            .add_participant("conv-detail", "agent-x")
            .await
            .unwrap();
        store
            .add_participant("conv-detail", "agent-y")
            .await
            .unwrap();

        let detail = store
            .get_conversation_detail("conv-detail")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.id, "conv-detail");
        assert_eq!(detail.participants.len(), 2);
        assert!(detail.participants.contains(&"agent-x".to_owned()));
        assert!(detail.participants.contains(&"agent-y".to_owned()));
        assert_eq!(detail.messages.len(), 1);
    }
}
