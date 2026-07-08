//! Two-tier memory for chat (spec unit U11), with multi-level scoping.
//!
//! Ryu assembles two kinds of context for each chat request:
//!
//! * **Short-term memory** — the recent turns of the *current* conversation.
//!   This is derived directly from U10's conversation store
//!   (`ConversationStore::get_recent_messages`) and assembled into a prompt
//!   prefix. It needs no separate storage.
//! * **Long-term memory** — durable facts carried *across* conversations. This is
//!   **opt-in** per the privacy-by-default principle: nothing is recorded or
//!   recalled unless the request explicitly enables it.
//!
//! Long-term facts carry a **scope level** — [`MemoryScope`] — describing how
//! broadly they apply:
//!
//! * `User`    — facts about the user, visible everywhere (broadest).
//! * `Node`    — facts scoped to this Core node / machine.
//! * `Project` — facts scoped to one working folder (`scope_id` = the folder path).
//!
//! Which levels a given agent may read is governed by its `MemorySlot`
//! (`crate::agents::MemorySlot.read_levels`); the retrieval layer
//! (`crate::server::retrieval`) enforces the level + active-project filter at
//! recall time. Each fact is also classified by [`MemoryCategory`] and carries an
//! `importance`, optional `when_to_use` hint, and free-form `tags` — all editable
//! from the desktop Memory Library.
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): memory is part of
//! *what runs* (orchestration / session state), not *what is allowed, shared,
//! measured, or paid for*, so it belongs in Core alongside the conversation
//! store from U10.
//!
//! Long-term entries are stored **encrypted-at-rest** with ChaCha20-Poly1305 via
//! the shared [`crate::crypto`] master key (resolved from env → OS keychain →
//! file fallback, see `docs/encryption-at-rest.md`). The sensitive payload
//! (`content` + `when_to_use`) is bundled as JSON inside the ciphertext; the
//! filterable metadata (`scope`, `scope_id`, `category`, `importance`, `tags`)
//! lives in plaintext columns so it can be filtered in SQL.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// Default number of recent turns assembled as short-term context.
pub const DEFAULT_SHORT_TERM_LIMIT: usize = 10;
/// Default number of long-term entries recalled per request.
pub const DEFAULT_LONG_TERM_LIMIT: usize = 5;
/// Default importance for a fact when none is supplied (1..=5 scale).
pub const DEFAULT_IMPORTANCE: i32 = 3;
/// Sentinel user id used while Core is local-first/single-user.
///
/// `AuthState` only carries a device token, not a stable user id, so long-term
/// memory is scoped by `(LOCAL_USER, agent_id)`. When a real user identity is
/// introduced this constant becomes the request's user id.
pub const LOCAL_USER: &str = "local";

/// How broadly a long-term fact applies. Serialized snake_case (`"user"`,
/// `"node"`, `"project"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    /// About the user; visible across every node and project.
    User,
    /// Scoped to this Core node / machine.
    Node,
    /// Scoped to one working folder; `scope_id` holds the folder path.
    Project,
}

impl MemoryScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Node => "node",
            Self::Project => "project",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "node" => Self::Node,
            "project" => Self::Project,
            _ => Self::User,
        }
    }
}

impl Default for MemoryScope {
    fn default() -> Self {
        Self::User
    }
}

/// What kind of fact a memory holds. Drives filtering and how the model is told
/// to use it. Serialized snake_case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryCategory {
    /// A stable fact about the user (name, role, location, environment).
    UserFact,
    /// How the user likes things done (style, tone, defaults, do/don't).
    Preference,
    /// Subject-matter knowledge the agent should ground on.
    DomainKnowledge,
    /// The user's company / team / org structure and processes.
    Organization,
    /// Facts about the current project / codebase (conventions, layout, decisions).
    ProjectContext,
    /// A specific person the user works with.
    Relationship,
    /// A standing instruction the agent must follow ("always X").
    Directive,
    /// A reusable how-to / workflow the agent learned.
    Procedure,
    /// A time-bound episodic fact ("decided X on date").
    Event,
    /// Anything that doesn't fit the categories above.
    Other,
}

impl MemoryCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserFact => "user_fact",
            Self::Preference => "preference",
            Self::DomainKnowledge => "domain_knowledge",
            Self::Organization => "organization",
            Self::ProjectContext => "project_context",
            Self::Relationship => "relationship",
            Self::Directive => "directive",
            Self::Procedure => "procedure",
            Self::Event => "event",
            Self::Other => "other",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "preference" => Self::Preference,
            "domain_knowledge" => Self::DomainKnowledge,
            "organization" => Self::Organization,
            "project_context" => Self::ProjectContext,
            "relationship" => Self::Relationship,
            "directive" => Self::Directive,
            "procedure" => Self::Procedure,
            "event" => Self::Event,
            "other" => Self::Other,
            _ => Self::UserFact,
        }
    }
}

impl Default for MemoryCategory {
    fn default() -> Self {
        Self::UserFact
    }
}

/// A persisted long-term memory entry (decrypted form).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LongTermEntry {
    pub id: String,
    pub content: String,
    /// Breadth of applicability (user / node / project).
    #[serde(default)]
    pub scope: MemoryScope,
    /// Project folder path when `scope == Project`; node id when `Node`; `None`
    /// for `User`.
    #[serde(default)]
    pub scope_id: Option<String>,
    /// Classification of the fact.
    #[serde(default)]
    pub category: MemoryCategory,
    /// 1..=5; higher is recalled first and boosted in ranking.
    #[serde(default = "default_importance")]
    pub importance: i32,
    /// Optional guidance on when this fact is relevant.
    #[serde(default)]
    pub when_to_use: Option<String>,
    /// Free-form tags.
    #[serde(default)]
    pub tags: Vec<String>,
    /// The agent that recorded this fact (provenance only, not an access filter).
    #[serde(default)]
    pub author_agent_id: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds of the last edit (equals `created_at` when never edited).
    #[serde(default)]
    pub updated_at: i64,
}

fn default_importance() -> i32 {
    DEFAULT_IMPORTANCE
}

/// Input for recording a rich long-term fact (`record_full`).
#[derive(Debug, Clone)]
pub struct NewMemory {
    pub content: String,
    pub scope: MemoryScope,
    pub scope_id: Option<String>,
    pub category: MemoryCategory,
    pub importance: i32,
    pub when_to_use: Option<String>,
    pub tags: Vec<String>,
    pub author_agent_id: Option<String>,
}

impl NewMemory {
    /// A minimal user-level fact with default classification.
    pub fn user_fact(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            scope: MemoryScope::User,
            scope_id: None,
            category: MemoryCategory::UserFact,
            importance: DEFAULT_IMPORTANCE,
            when_to_use: None,
            tags: Vec::new(),
            author_agent_id: None,
        }
    }
}

/// A partial update to an existing memory (all fields optional).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MemoryPatch {
    pub content: Option<String>,
    pub scope: Option<MemoryScope>,
    pub scope_id: Option<Option<String>>,
    pub category: Option<MemoryCategory>,
    pub importance: Option<i32>,
    pub when_to_use: Option<Option<String>>,
    pub tags: Option<Vec<String>>,
}

/// Filter for listing memories (all fields optional / AND-combined).
#[derive(Debug, Clone, Default)]
pub struct MemoryFilter {
    pub scope: Option<MemoryScope>,
    pub scope_id: Option<String>,
    pub category: Option<MemoryCategory>,
    pub limit: Option<usize>,
}

/// SQLite-backed long-term memory store. Cheap to clone (wraps `Arc`s).
///
/// Reuses the same on-disk database as the conversation store (a new table),
/// so there is a single `~/.ryu` database file.
#[derive(Clone)]
pub struct MemoryStore {
    conn: Arc<Mutex<Connection>>,
    cipher: crate::crypto::FieldCipher,
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("conversations.db")
}

/// Serialize the sensitive payload (content + when_to_use) to JSON for encryption.
fn encode_payload(content: &str, when_to_use: Option<&str>) -> Vec<u8> {
    serde_json::json!({ "content": content, "when_to_use": when_to_use })
        .to_string()
        .into_bytes()
}

/// Decode a decrypted payload back into `(content, when_to_use)`. Falls back to
/// treating the whole plaintext as `content` for legacy rows that stored the raw
/// string (pre-JSON payloads).
fn decode_payload(plain: &[u8]) -> (String, Option<String>) {
    let text = String::from_utf8_lossy(plain).into_owned();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(content) = v.get("content").and_then(|c| c.as_str()) {
            let when = v
                .get("when_to_use")
                .and_then(|w| w.as_str())
                .map(str::to_string);
            return (content.to_string(), when);
        }
    }
    (text, None)
}

fn encode_tags(tags: &[String]) -> String {
    serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string())
}

fn decode_tags(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

impl MemoryStore {
    /// Open (or create) the long-term memory store at the default path, using the
    /// shared at-rest master key.
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path())
    }

    /// Open (or create) the store at a specific db path. Encryption uses the
    /// shared [`crate::crypto`] master key.
    pub fn open(db_path: PathBuf) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&db_path)
            .with_context(|| format!("opening memory db {}", db_path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: crate::crypto::global_cipher()?,
        })
    }

    /// Open an in-memory store with an ephemeral key (used by tests). Never
    /// touches the real keychain or `~/.ryu`.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: crate::crypto::FieldCipher::new(&[0x22; 32]),
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS memory_entries (
                 id          TEXT PRIMARY KEY,
                 user_id     TEXT NOT NULL,
                 agent_id    TEXT NOT NULL,
                 nonce       BLOB NOT NULL,
                 ciphertext  BLOB NOT NULL,
                 created_at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_memory_scope
                 ON memory_entries(user_id, agent_id, created_at);",
        )
        .context("initializing memory schema")?;

        // Multi-level metadata columns (added incrementally; idempotent). Existing
        // rows default to user-level / user_fact / importance 3, keeping prior
        // facts readable and broadly visible.
        Self::add_column_if_missing(conn, "scope", "TEXT NOT NULL DEFAULT 'user'")?;
        Self::add_column_if_missing(conn, "scope_id", "TEXT")?;
        Self::add_column_if_missing(conn, "category", "TEXT NOT NULL DEFAULT 'user_fact'")?;
        Self::add_column_if_missing(conn, "importance", "INTEGER NOT NULL DEFAULT 3")?;
        Self::add_column_if_missing(conn, "tags", "TEXT NOT NULL DEFAULT '[]'")?;
        Self::add_column_if_missing(conn, "updated_at", "INTEGER NOT NULL DEFAULT 0")?;

        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_memory_scope_level
                 ON memory_entries(scope, scope_id, category);",
        )
        .context("creating memory level index")?;
        Ok(())
    }

    /// Add `memory_entries.<name>` when it is not already present. `PRAGMA
    /// table_info` is the in-repo migration pattern (see `agents::AgentStore`).
    fn add_column_if_missing(conn: &Connection, name: &str, decl: &str) -> Result<()> {
        let exists = {
            let mut stmt = conn.prepare("PRAGMA table_info(memory_entries)")?;
            let cols = stmt.query_map([], |row| row.get::<_, String>(1))?;
            let mut found = false;
            for col in cols {
                if col? == name {
                    found = true;
                    break;
                }
            }
            found
        };
        if !exists {
            conn.execute(
                &format!("ALTER TABLE memory_entries ADD COLUMN {name} {decl}"),
                [],
            )
            .with_context(|| format!("adding memory column {name}"))?;
        }
        Ok(())
    }

    /// Record a plain long-term memory entry for `(user_id, agent_id)`, at
    /// user-level with default classification. Content is encrypted before it
    /// touches disk. Empty content is ignored. Back-compat entry point; richer
    /// captures use [`record_full`](Self::record_full).
    pub async fn record(
        &self,
        user_id: &str,
        agent_id: &str,
        content: &str,
    ) -> Result<Option<String>> {
        let mut mem = NewMemory::user_fact(content);
        mem.author_agent_id = Some(agent_id.to_string());
        self.record_full(user_id, agent_id, mem).await
    }

    /// Record a fully-classified long-term fact. Empty content is ignored.
    pub async fn record_full(
        &self,
        user_id: &str,
        agent_id: &str,
        mem: NewMemory,
    ) -> Result<Option<String>> {
        let trimmed = mem.content.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let when = mem
            .when_to_use
            .as_deref()
            .map(str::trim)
            .filter(|w| !w.is_empty());
        let (nonce, ciphertext) = self.encrypt(&encode_payload(trimmed, when))?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        let importance = mem.importance.clamp(1, 5);
        let tags = encode_tags(&mem.tags);
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO memory_entries
                (id, user_id, agent_id, nonce, ciphertext, created_at,
                 scope, scope_id, category, importance, tags, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id,
                user_id,
                agent_id,
                nonce,
                ciphertext,
                now,
                mem.scope.as_str(),
                mem.scope_id,
                mem.category.as_str(),
                importance,
                tags,
                now,
            ],
        )
        .context("inserting memory entry")?;
        Ok(Some(id))
    }

    /// Recall the most recent `limit` long-term entries for `(user_id, agent_id)`,
    /// newest first. Back-compat recency path (agent-scoped); the level-aware
    /// recall is [`recall_scoped`](Self::recall_scoped).
    pub async fn recall(
        &self,
        user_id: &str,
        agent_id: &str,
        limit: usize,
    ) -> Result<Vec<LongTermEntry>> {
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                        category, importance, tags, agent_id, updated_at
                 FROM memory_entries
                 WHERE user_id = ?1 AND agent_id = ?2
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?3",
            )?;
            Self::collect_rows(&mut stmt, params![user_id, agent_id, limit as i64])?
        };
        Ok(self.decrypt_rows(rows))
    }

    /// Recall recent entries visible to an agent granted `read_levels`, within the
    /// active `project_id`. Ordered by importance then recency. When `read_levels`
    /// is empty all three levels are visible (back-compat / unconfigured agent).
    /// Project-scoped facts are only returned when their `scope_id` matches the
    /// active project.
    pub async fn recall_scoped(
        &self,
        read_levels: &[MemoryScope],
        project_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<LongTermEntry>> {
        let levels = Self::effective_levels(read_levels);
        // Inline the level set as quoted literals. Values come from
        // `MemoryScope::as_str()` (a closed set of `'user'/'node'/'project'`), so
        // this is injection-safe and avoids depending on the json1 extension.
        let level_list = levels
            .iter()
            .map(|l| format!("'{}'", l.as_str()))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                    category, importance, tags, agent_id, updated_at
             FROM memory_entries
             WHERE scope IN ({level_list})
               AND (scope != 'project' OR scope_id IS ?1)
             ORDER BY importance DESC, created_at DESC, rowid DESC
             LIMIT ?2"
        );
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(&sql)?;
            Self::collect_rows(&mut stmt, params![project_id, limit as i64])?
        };
        Ok(self.decrypt_rows(rows))
    }

    /// Enumerate up to `limit` entries (all scopes) for backfilling the retrieval
    /// index; per-agent filtering happens at retrieve time.
    pub async fn all_for_backfill(&self, limit: usize) -> Result<Vec<LongTermEntry>> {
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                        category, importance, tags, agent_id, updated_at
                 FROM memory_entries
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?1",
            )?;
            Self::collect_rows(&mut stmt, params![limit as i64])?
        };
        Ok(self.decrypt_rows(rows))
    }

    /// List entries for the management UI, filtered and newest-first.
    pub async fn list(&self, filter: &MemoryFilter) -> Result<Vec<LongTermEntry>> {
        let limit = filter.limit.unwrap_or(500) as i64;
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                        category, importance, tags, agent_id, updated_at
                 FROM memory_entries
                 WHERE (?1 IS NULL OR scope = ?1)
                   AND (?2 IS NULL OR scope_id = ?2)
                   AND (?3 IS NULL OR category = ?3)
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?4",
            )?;
            Self::collect_rows(
                &mut stmt,
                params![
                    filter.scope.map(|s| s.as_str()),
                    filter.scope_id,
                    filter.category.map(|c| c.as_str()),
                    limit,
                ],
            )?
        };
        Ok(self.decrypt_rows(rows))
    }

    /// Fetch a single entry by id.
    pub async fn get(&self, id: &str) -> Result<Option<LongTermEntry>> {
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                        category, importance, tags, agent_id, updated_at
                 FROM memory_entries WHERE id = ?1",
            )?;
            Self::collect_rows(&mut stmt, params![id])?
        };
        Ok(self.decrypt_rows(rows).into_iter().next())
    }

    /// Apply a partial update to an entry. Returns the updated entry, or `None`
    /// when the id does not exist.
    pub async fn update(&self, id: &str, patch: MemoryPatch) -> Result<Option<LongTermEntry>> {
        let Some(existing) = self.get(id).await? else {
            return Ok(None);
        };
        let content = patch.content.unwrap_or(existing.content);
        let when_to_use = match patch.when_to_use {
            Some(w) => w,
            None => existing.when_to_use,
        };
        let scope = patch.scope.unwrap_or(existing.scope);
        let scope_id = match patch.scope_id {
            Some(s) => s,
            None => existing.scope_id,
        };
        let category = patch.category.unwrap_or(existing.category);
        let importance = patch.importance.unwrap_or(existing.importance).clamp(1, 5);
        let tags = patch.tags.unwrap_or(existing.tags);

        let when = when_to_use
            .as_deref()
            .map(str::trim)
            .filter(|w| !w.is_empty());
        let (nonce, ciphertext) = self.encrypt(&encode_payload(content.trim(), when))?;
        let now = now_millis();
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE memory_entries
                 SET nonce = ?1, ciphertext = ?2, scope = ?3, scope_id = ?4,
                     category = ?5, importance = ?6, tags = ?7, updated_at = ?8
                 WHERE id = ?9",
                params![
                    nonce,
                    ciphertext,
                    scope.as_str(),
                    scope_id,
                    category.as_str(),
                    importance,
                    encode_tags(&tags),
                    now,
                    id,
                ],
            )
            .context("updating memory entry")?;
        }
        self.get(id).await
    }

    /// Delete a single entry. Returns whether a row was removed.
    pub async fn delete(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let removed = conn.execute("DELETE FROM memory_entries WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }

    /// Total number of stored long-term memory entries across every scope.
    /// Backs the danger-zone count preview.
    pub async fn count(&self) -> Result<u64> {
        let conn = self.conn.lock().await;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM memory_entries", [], |r| r.get(0))?;
        Ok(n.max(0) as u64)
    }

    /// Delete **every** long-term memory entry (all users/agents). Single-tenant
    /// today (`LOCAL_USER`), so this is the "forget everything" wipe. Returns the
    /// number of rows removed. The encryption key is untouched, so new memories
    /// recorded afterward stay readable.
    pub async fn clear_all(&self) -> Result<u64> {
        let conn = self.conn.lock().await;
        let removed = conn.execute("DELETE FROM memory_entries", [])?;
        Ok(removed as u64)
    }

    /// Empty `read_levels` means "all three levels" (unconfigured agent).
    fn effective_levels(read_levels: &[MemoryScope]) -> Vec<MemoryScope> {
        if read_levels.is_empty() {
            vec![MemoryScope::User, MemoryScope::Node, MemoryScope::Project]
        } else {
            read_levels.to_vec()
        }
    }

    /// Raw encrypted+metadata row as read from SQL, before decryption.
    fn collect_rows(
        stmt: &mut rusqlite::Statement<'_>,
        params: impl rusqlite::Params,
    ) -> Result<Vec<EncryptedRow>> {
        let mapped = stmt.query_map(params, |row| {
            Ok(EncryptedRow {
                id: row.get(0)?,
                nonce: row.get(1)?,
                ciphertext: row.get(2)?,
                created_at: row.get(3)?,
                scope: row.get(4)?,
                scope_id: row.get(5)?,
                category: row.get(6)?,
                importance: row.get(7)?,
                tags: row.get(8)?,
                author_agent_id: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })?;
        let mut out = Vec::new();
        for row in mapped {
            out.push(row?);
        }
        Ok(out)
    }

    /// Decrypt a batch of rows, skipping any that fail to decrypt.
    fn decrypt_rows(&self, rows: Vec<EncryptedRow>) -> Vec<LongTermEntry> {
        let mut out = Vec::new();
        for r in rows {
            match self.decrypt(&r.nonce, &r.ciphertext) {
                Ok(plain) => {
                    let (content, when_to_use) = decode_payload(&plain);
                    out.push(LongTermEntry {
                        id: r.id,
                        content,
                        scope: MemoryScope::from_str(&r.scope),
                        scope_id: r.scope_id,
                        category: MemoryCategory::from_str(&r.category),
                        importance: r.importance,
                        when_to_use,
                        tags: decode_tags(&r.tags),
                        author_agent_id: r.author_agent_id,
                        created_at: r.created_at,
                        updated_at: if r.updated_at == 0 {
                            r.created_at
                        } else {
                            r.updated_at
                        },
                    });
                }
                Err(e) => tracing::warn!("skipping undecryptable memory entry {}: {e}", r.id),
            }
        }
        out
    }

    fn encrypt(&self, plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
        self.cipher.encrypt(plaintext)
    }

    fn decrypt(&self, nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
        self.cipher.decrypt(nonce, ciphertext)
    }
}

/// An encrypted row + its plaintext metadata, straight from SQL.
struct EncryptedRow {
    id: String,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    created_at: i64,
    scope: String,
    scope_id: Option<String>,
    category: String,
    importance: i32,
    tags: String,
    author_agent_id: Option<String>,
    updated_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn record_and_recall_round_trips() {
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .record(LOCAL_USER, "default", "User prefers dark mode")
            .await
            .unwrap();
        store
            .record(LOCAL_USER, "default", "User is based in Singapore")
            .await
            .unwrap();

        let recalled = store.recall(LOCAL_USER, "default", 10).await.unwrap();
        assert_eq!(recalled.len(), 2);
        // Newest first.
        assert_eq!(recalled[0].content, "User is based in Singapore");
        assert_eq!(recalled[1].content, "User prefers dark mode");
    }

    #[tokio::test]
    async fn recall_is_scoped_by_agent() {
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .record(LOCAL_USER, "agent-a", "fact for a")
            .await
            .unwrap();
        store
            .record(LOCAL_USER, "agent-b", "fact for b")
            .await
            .unwrap();

        let a = store.recall(LOCAL_USER, "agent-a", 10).await.unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].content, "fact for a");

        let none = store.recall(LOCAL_USER, "agent-c", 10).await.unwrap();
        assert!(none.is_empty());
    }

    #[tokio::test]
    async fn clear_all_forgets_every_entry() {
        let store = MemoryStore::open_in_memory().unwrap();
        store.record(LOCAL_USER, "agent-a", "fact a").await.unwrap();
        store.record(LOCAL_USER, "agent-b", "fact b").await.unwrap();
        assert_eq!(store.count().await.unwrap(), 2);

        let removed = store.clear_all().await.unwrap();
        assert_eq!(removed, 2);
        assert_eq!(store.count().await.unwrap(), 0);
        // The key is intact, so new memories still record + recall afterward.
        store.record(LOCAL_USER, "agent-a", "fresh").await.unwrap();
        let recalled = store.recall(LOCAL_USER, "agent-a", 10).await.unwrap();
        assert_eq!(recalled.len(), 1);
        assert_eq!(recalled[0].content, "fresh");
    }

    #[tokio::test]
    async fn empty_content_is_not_recorded() {
        let store = MemoryStore::open_in_memory().unwrap();
        assert!(store
            .record(LOCAL_USER, "default", "   ")
            .await
            .unwrap()
            .is_none());
        assert!(store
            .recall(LOCAL_USER, "default", 10)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn record_full_persists_metadata() {
        let store = MemoryStore::open_in_memory().unwrap();
        let id = store
            .record_full(
                LOCAL_USER,
                "agent-a",
                NewMemory {
                    content: "Uses pnpm not npm".into(),
                    scope: MemoryScope::Project,
                    scope_id: Some("/work/ryu".into()),
                    category: MemoryCategory::Preference,
                    importance: 5,
                    when_to_use: Some("when installing deps".into()),
                    tags: vec!["tooling".into()],
                    author_agent_id: Some("agent-a".into()),
                },
            )
            .await
            .unwrap()
            .unwrap();
        let got = store.get(&id).await.unwrap().unwrap();
        assert_eq!(got.content, "Uses pnpm not npm");
        assert_eq!(got.scope, MemoryScope::Project);
        assert_eq!(got.scope_id.as_deref(), Some("/work/ryu"));
        assert_eq!(got.category, MemoryCategory::Preference);
        assert_eq!(got.importance, 5);
        assert_eq!(got.when_to_use.as_deref(), Some("when installing deps"));
        assert_eq!(got.tags, vec!["tooling".to_string()]);
    }

    #[tokio::test]
    async fn recall_scoped_filters_by_level_and_project() {
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .record_full(LOCAL_USER, "a", {
                let mut m = NewMemory::user_fact("global user fact");
                m.scope = MemoryScope::User;
                m
            })
            .await
            .unwrap();
        store
            .record_full(LOCAL_USER, "a", {
                let mut m = NewMemory::user_fact("fact for project X");
                m.scope = MemoryScope::Project;
                m.scope_id = Some("/proj/x".into());
                m
            })
            .await
            .unwrap();
        store
            .record_full(LOCAL_USER, "a", {
                let mut m = NewMemory::user_fact("fact for project Y");
                m.scope = MemoryScope::Project;
                m.scope_id = Some("/proj/y".into());
                m
            })
            .await
            .unwrap();

        // User-only agent: sees just the global fact.
        let user_only = store
            .recall_scoped(&[MemoryScope::User], Some("/proj/x"), 10)
            .await
            .unwrap();
        assert_eq!(user_only.len(), 1);
        assert_eq!(user_only[0].content, "global user fact");

        // Project-enabled agent in project X: global + X, not Y.
        let in_x = store
            .recall_scoped(
                &[MemoryScope::User, MemoryScope::Project],
                Some("/proj/x"),
                10,
            )
            .await
            .unwrap();
        let contents: Vec<_> = in_x.iter().map(|e| e.content.as_str()).collect();
        assert!(contents.contains(&"global user fact"));
        assert!(contents.contains(&"fact for project X"));
        assert!(!contents.contains(&"fact for project Y"));
    }

    #[tokio::test]
    async fn update_and_delete() {
        let store = MemoryStore::open_in_memory().unwrap();
        let id = store
            .record(LOCAL_USER, "a", "original")
            .await
            .unwrap()
            .unwrap();
        let updated = store
            .update(
                &id,
                MemoryPatch {
                    content: Some("edited".into()),
                    importance: Some(5),
                    category: Some(MemoryCategory::Directive),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.content, "edited");
        assert_eq!(updated.importance, 5);
        assert_eq!(updated.category, MemoryCategory::Directive);

        assert!(store.delete(&id).await.unwrap());
        assert!(store.get(&id).await.unwrap().is_none());
    }

    #[test]
    fn stored_ciphertext_is_not_plaintext() {
        // The encrypt step must not leave the content readable.
        let store = MemoryStore::open_in_memory().unwrap();
        let secret = b"super secret memory";
        let (nonce, ciphertext) = store.encrypt(secret).unwrap();
        assert_ne!(ciphertext.as_slice(), secret);
        let decrypted = store.decrypt(&nonce, &ciphertext).unwrap();
        assert_eq!(decrypted, secret);
    }
}
