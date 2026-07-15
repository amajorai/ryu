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

/// The SQL twin of the memory per-caller ACL — the ONE place memory read
/// visibility is expressed (mirrors `conversations.rs::TENANCY_VISIBLE_PREDICATE`,
/// but keyed on SCOPE, since memory sharing is scope-based, not org/visibility-based):
///   - `:bound = 0` (node UNBOUND / personal): no restriction. One principal; the
///     node token is the boundary — byte-identical to the pre-ACL behaviour.
///   - node ORG-BOUND: a `user`-scope fact is PRIVATE — visible only to its owner
///     (`user_id = :uid`). `node`/`project`-scope facts are the shared "company
///     brain" — visible to every member. A `user`-scope row whose `user_id` is the
///     legacy `'local'` sentinel matches no real caller (fail closed) until the
///     bind-time backfill re-stamps it to the real owner.
const MEMORY_VISIBLE_PREDICATE: &str = "(
        :bound = 0
        OR scope IN ('node', 'project')
        OR (:uid IS NOT NULL AND scope = 'user' AND user_id = :uid)
     )";

/// The caller context a tenancy-filtered memory query is evaluated against.
#[derive(Clone, Copy)]
pub struct MemoryVisibility<'a> {
    /// Whether THIS node is bound to an org. Unbound → no filtering.
    pub node_bound: bool,
    /// The verified caller's user id, or `None` for an anonymous caller.
    pub caller_user_id: Option<&'a str>,
}

impl<'a> MemoryVisibility<'a> {
    /// The in-process, full-trust filter (used internally / on an unbound node).
    pub fn unrestricted() -> Self {
        Self {
            node_bound: false,
            caller_user_id: None,
        }
    }

    /// The filter for an HTTP caller on a possibly-bound node.
    pub fn for_caller(caller_user_id: Option<&'a str>, node_bound: bool) -> Self {
        Self {
            node_bound,
            caller_user_id,
        }
    }
}

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
    /// The verified human OWNER of this fact (the `memory_entries.user_id` column).
    /// This is the per-user tenancy key: on an org-bound node a `User`-scope fact is
    /// private to this owner (a `Node`/`Project`-scope fact is shared). `"local"` is
    /// the pre-attribution sentinel (unbound / single-user), which the bind-time
    /// backfill re-stamps to the real owner. Provenance for the ACL, not display.
    #[serde(default)]
    pub owner_user_id: Option<String>,
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
        // One-shot owner backfill: pre-ACL memory rows carry `user_id = 'local'`.
        // Best-effort; never blocks opening the store. Deliberately NOT in
        // `init_schema` (the in-memory test store runs that and must never read the
        // real account vault).
        if let Err(e) = Self::backfill_owner(&conn) {
            tracing::warn!("memory owner backfill skipped: {e:#}");
        }
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: crate::crypto::global_cipher()?,
        })
    }

    /// Attribute pre-ACL `user_id = 'local'` memory rows to the local owner once the
    /// node binds — the memory twin of `ConversationStore::backfill_tenancy`. Note
    /// the transition is `'local' → owner` (memory's single-user sentinel), NOT
    /// `NULL → owner` (memory's `user_id` is NOT NULL).
    ///
    ///   - **Node UNBOUND**: return immediately (no marker). One principal; the node
    ///     token is the boundary — the `'local'` rows stay as they are, and
    ///     `MEMORY_VISIBLE_PREDICATE` (`:bound = 0`) shows them all. Reruns if the
    ///     node later joins an org.
    ///   - **Node ORG-BOUND**: `UPDATE memory_entries SET user_id = <owner> WHERE
    ///     user_id = 'local'`, so the owner keeps recalling their own facts (else a
    ///     `user`-scope `'local'` row matches no real caller → lockout). Idempotent
    ///     via a `memory_meta` marker.
    ///   - **Node ORG-BOUND with no local account**: leave them + warn. Fail closed.
    fn backfill_owner(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT)",
        )
        .context("creating memory_meta")?;
        let done: Option<String> = {
            let mut stmt = conn.prepare("SELECT value FROM memory_meta WHERE key = 'owner_backfill_v1'")?;
            let mut rows = stmt.query([])?;
            match rows.next()? {
                Some(r) => Some(r.get(0)?),
                None => None,
            }
        };
        if done.is_some() {
            return Ok(());
        }
        let Some(org) = crate::sidecar::control_plane::registered_org() else {
            return Ok(());
        };
        let Some(owner) = crate::auth::load_accounts()
            .active()
            .map(|a| a.user_id.clone())
        else {
            tracing::warn!(
                "memory owner backfill: org-bound node with no signed-in local account — \
                 leaving pre-ACL 'local' memory rows unattributed (fail closed)."
            );
            return Ok(());
        };
        let _ = org; // org is not stored on memory rows (scope-based, not org-based).
        let claimed = conn
            .execute(
                "UPDATE memory_entries SET user_id = ?1 WHERE user_id = ?2",
                params![owner, LOCAL_USER],
            )
            .context("backfilling memory owner")?;
        conn.execute(
            "INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('owner_backfill_v1', ?1)",
            params![owner],
        )?;
        tracing::info!("memory owner backfill: attributed {claimed} pre-ACL memory row(s)");
        Ok(())
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
                        category, importance, tags, agent_id, updated_at, user_id
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
                    category, importance, tags, agent_id, updated_at, user_id
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
                        category, importance, tags, agent_id, updated_at, user_id
                 FROM memory_entries
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?1",
            )?;
            Self::collect_rows(&mut stmt, params![limit as i64])?
        };
        Ok(self.decrypt_rows(rows))
    }

    /// List entries for the management UI, filtered and newest-first. **Unfiltered
    /// by tenancy** — the in-process / unbound full listing. See
    /// [`list_visible`](Self::list_visible) for the per-caller form.
    pub async fn list(&self, filter: &MemoryFilter) -> Result<Vec<LongTermEntry>> {
        self.list_visible(filter, MemoryVisibility::unrestricted())
            .await
    }

    /// List entries the caller may READ, applying [`MEMORY_VISIBLE_PREDICATE`].
    /// On an UNBOUND node this is byte-identical to [`list`](Self::list) (`:bound = 0`
    /// disables the owner filter). On a BOUND node a `user`-scope fact is returned
    /// only to its owner; `node`/`project`-scope facts stay visible to every member
    /// (the shared "company brain").
    pub async fn list_visible(
        &self,
        filter: &MemoryFilter,
        vis: MemoryVisibility<'_>,
    ) -> Result<Vec<LongTermEntry>> {
        let limit = filter.limit.unwrap_or(500) as i64;
        let sql = format!(
            "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                    category, importance, tags, agent_id, updated_at, user_id
             FROM memory_entries
             WHERE (:scope IS NULL OR scope = :scope)
               AND (:scope_id IS NULL OR scope_id = :scope_id)
               AND (:category IS NULL OR category = :category)
               AND {MEMORY_VISIBLE_PREDICATE}
             ORDER BY created_at DESC, rowid DESC
             LIMIT :limit"
        );
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(&sql)?;
            Self::collect_rows(
                &mut stmt,
                rusqlite::named_params! {
                    ":scope": filter.scope.map(|s| s.as_str()),
                    ":scope_id": filter.scope_id,
                    ":category": filter.category.map(|c| c.as_str()),
                    ":bound": i64::from(vis.node_bound),
                    ":uid": vis.caller_user_id,
                    ":limit": limit,
                },
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
                        category, importance, tags, agent_id, updated_at, user_id
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

    /// The ids of every entry carrying `tag` (an exact element of the plaintext
    /// `tags` JSON array). The array is stored as `["a","b"]`, so a quoted-substring
    /// match is exact per element. Used to find (and then delete + un-index) the
    /// prior feedback-derived facts for a message before re-recording, so a changed
    /// or cleared thumbs vote never leaves contradictory facts. `tags` is a
    /// non-encrypted column, so this needs no decryption.
    pub async fn ids_with_tag(&self, tag: &str) -> Result<Vec<String>> {
        let needle = format!("%{}%", serde_json::Value::String(tag.to_string()));
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT id FROM memory_entries WHERE tags LIKE ?1")?;
        let rows = stmt.query_map(params![needle], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
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
                owner_user_id: row.get(11)?,
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
                        owner_user_id: r.owner_user_id,
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
    owner_user_id: Option<String>,
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

    /// Per-caller tenancy (the `MEMORY_VISIBLE_PREDICATE`): on a bound node a
    /// `user`-scope fact is private to its owner while `node`/`project` facts stay
    /// shared. Driven with `MemoryVisibility::for_caller(node_bound = true)` so no
    /// org registration is needed (the caller tenancy is passed IN).
    #[tokio::test]
    async fn list_visible_scopes_user_facts_per_owner_on_bound_node() {
        let store = MemoryStore::open_in_memory().unwrap();
        // Alice's private user fact.
        store
            .record_full("alice", "a", NewMemory::user_fact("alice private secret"))
            .await
            .unwrap();
        // Bob's private user fact.
        store
            .record_full("bob", "a", NewMemory::user_fact("bob private secret"))
            .await
            .unwrap();
        // A shared node-scope fact (the company brain).
        store
            .record_full("alice", "a", {
                let mut m = NewMemory::user_fact("shared org policy");
                m.scope = MemoryScope::Node;
                m
            })
            .await
            .unwrap();

        let filter = MemoryFilter::default();

        // Bob (bound node): sees his own user fact + the shared node fact, NOT Alice's.
        let bob = store
            .list_visible(&filter, MemoryVisibility::for_caller(Some("bob"), true))
            .await
            .unwrap();
        let bob_contents: Vec<&str> = bob.iter().map(|e| e.content.as_str()).collect();
        assert!(!bob_contents.contains(&"alice private secret"), "Bob must not read Alice's user memory");
        assert!(bob_contents.contains(&"bob private secret"));
        assert!(bob_contents.contains(&"shared org policy"), "node-scope memory is shared");

        // Alice (bound node): her own + shared, not Bob's — no lockout on her data.
        let alice = store
            .list_visible(&filter, MemoryVisibility::for_caller(Some("alice"), true))
            .await
            .unwrap();
        let alice_contents: Vec<&str> = alice.iter().map(|e| e.content.as_str()).collect();
        assert!(alice_contents.contains(&"alice private secret"));
        assert!(alice_contents.contains(&"shared org policy"));
        assert!(!alice_contents.contains(&"bob private secret"));

        // UNBOUND node: byte-identical — every fact visible regardless of owner.
        let unbound = store
            .list_visible(&filter, MemoryVisibility::unrestricted())
            .await
            .unwrap();
        assert_eq!(unbound.len(), 3, "unbound node sees all facts (no filtering)");
    }

    /// The bind-time `'local' → owner` backfill (the memory twin of the conversation
    /// backfill). Driven directly against the SQL so it needs no org registration:
    /// a pre-ACL `'local'` user row is invisible to a real caller until re-stamped.
    #[tokio::test]
    async fn local_rows_backfill_to_owner() {
        let store = MemoryStore::open_in_memory().unwrap();
        let id = store
            .record(LOCAL_USER, "a", "legacy fact recorded before ACL")
            .await
            .unwrap()
            .unwrap();

        // Before backfill, a bound-node caller "alice" cannot see the 'local' row.
        let before = store
            .list_visible(
                &MemoryFilter::default(),
                MemoryVisibility::for_caller(Some("alice"), true),
            )
            .await
            .unwrap();
        assert!(before.is_empty(), "pre-backfill 'local' user row is invisible to a real caller (fail closed)");

        // Simulate the backfill's UPDATE ('local' → the local owner) directly.
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE memory_entries SET user_id = ?1 WHERE user_id = ?2",
                params!["alice", LOCAL_USER],
            )
            .unwrap();
        }

        let after = store
            .list_visible(
                &MemoryFilter::default(),
                MemoryVisibility::for_caller(Some("alice"), true),
            )
            .await
            .unwrap();
        assert_eq!(after.len(), 1, "after backfill the owner reaches their legacy fact");
        assert_eq!(after[0].id, id);
        assert_eq!(after[0].owner_user_id.as_deref(), Some("alice"));
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
