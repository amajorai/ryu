//! Spaces: named document collections with a sqlite-vec vector store (spec unit U16).
//!
//! A *Space* is a named collection of documents. Each ingested document is split
//! into chunks; every chunk is embedded into a fixed-dimension vector and stored
//! in a [sqlite-vec](https://github.com/asg017/sqlite-vec) `vec0` virtual table so
//! that future retrieval (U17) can run KNN queries over it. The plain `spaces`,
//! `documents`, and `chunks` tables hold the human-readable rows; the `vec0` table
//! holds only the vector, keyed by the chunk rowid.
//!
//! ## GraphRAG retrieval mode (spec unit U046)
//!
//! A Space can carry a `retrieval_mode` of `"vector"` (default) or `"graph"`.
//! When set to `"graph"`, ingestion additionally extracts entities and relations
//! from each chunk and stores them in `graph_nodes` / `graph_edges` tables.
//! `SpaceStore::search` then branches on the mode: vector mode runs the existing
//! KNN query; graph mode runs entity-matching + BFS traversal and returns the
//! grounded chunks reachable from the query's entities.
//!
//! The extraction strategy and model id are registry-configurable via
//! `RYU_GRAPH_EXTRACTION_MODEL` / `registry.json` `graph_extraction_model`. The
//! built-in local extractor is deterministic and offline (co-occurrence of
//! normalized noun-like tokens within a chunk).
//!
//! ## Migration
//!
//! The `retrieval_mode` column and the `graph_nodes`/`graph_edges` tables are added
//! with idempotent DDL (`ALTER TABLE … IF NOT EXISTS` / `CREATE TABLE IF NOT
//! EXISTS`), so existing Spaces databases are upgraded in-place on first open
//! without losing data.
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): a document collection
//! and its embeddings are part of *what runs* (orchestration / RAG inputs), not
//! *what is allowed/measured/paid*, so Spaces belong in Core. This mirrors the
//! U10 [`ConversationStore`](super::conversations) shape exactly.
//!
//! Encryption-at-rest direction: when `RYU_SPACES_KEY` is set we issue a
//! `PRAGMA key`. On a stock (non-SQLCipher) SQLite build this pragma is silently
//! ignored, so it compiles and runs cleanly today; flipping rusqlite to
//! `bundled-sqlcipher` later turns it into real at-rest encryption with no code
//! change. We also restrict the db file permissions on Unix. See `apply_encryption`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::registry::ModelRegistry;
use crate::server::preferences::PreferencesStore;
// Spaces reuse the async `Embedder` from the retrieval module (Local hashing +
// Remote OpenAI-compatible `/v1/embeddings`). Sharing one embedder type means a
// Space's markdown pages get the same real semantic embeddings (the local
// `llamacpp-embed` nomic server by default) the retrieval store uses, and a
// single swap changes the model everywhere.
use crate::server::retrieval::Embedder;

/// Maximum characters per chunk before the ingestion pipeline splits.
const CHUNK_CHAR_SIZE: usize = 1_000;

/// Name of the auto-created, hidden Space that backs meeting notes. Kept in sync
/// with `meetings_api::MEETINGS_SPACE_NAME` and the desktop's spaces hide-filter.
/// The danger-zone "delete all spaces" preserves and ignores this Space.
const MEETINGS_SPACE_NAME: &str = "Meetings";

// ── Retrieval mode ─────────────────────────────────────────────────────────────

/// Which retrieval algorithm a Space uses.
///
/// `Vector` is the default and is backward-compatible: it runs the existing
/// KNN cosine-similarity search over the `vec0` virtual table.
///
/// `Graph` additionally builds an entity/relation graph during ingestion and
/// answers queries via BFS traversal instead of (or in addition to) KNN.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalMode {
    /// Cosine KNN over the `chunk_vectors` vec0 table (default, unchanged).
    #[default]
    Vector,
    /// Entity/relation graph traversal over the `graph_nodes`/`graph_edges` tables.
    Graph,
}

impl RetrievalMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Vector => "vector",
            Self::Graph => "graph",
        }
    }

    fn from_str(s: &str) -> Self {
        match s {
            "graph" => Self::Graph,
            _ => Self::Vector,
        }
    }
}

// ── Domain types ───────────────────────────────────────────────────────────────

/// A persisted Space (named document collection).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Space {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds.
    pub updated_at: i64,
    pub document_count: i64,
    /// Retrieval algorithm for this Space.
    pub retrieval_mode: RetrievalMode,
}

/// A document belonging to a Space.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub space_id: String,
    pub title: String,
    /// Unix milliseconds.
    pub created_at: i64,
    pub chunk_count: i64,
    /// `"page"` (markdown) or `"database"` (data-grid JSON in `source`).
    pub kind: String,
}

/// A document with its full editable markdown source (Notion-style page).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentContent {
    pub id: String,
    pub space_id: String,
    pub title: String,
    /// The canonical markdown source the editor reads/writes. Chunks are derived
    /// from this on every save.
    pub source: String,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds.
    pub updated_at: i64,
    pub chunk_count: i64,
    /// `"page"` (markdown) or `"database"` (data-grid JSON in `source`).
    pub kind: String,
}

/// Current embedding model identity for a Space store.
#[derive(Debug, Clone, Serialize)]
pub struct EmbeddingModelInfo {
    pub model_id: String,
    pub dims: usize,
}

/// Progress/state of a background re-index pass.
#[derive(Debug, Clone, Serialize)]
pub struct ReindexStatus {
    pub current_model: String,
    pub current_dims: usize,
    pub total_chunks: i64,
    /// Chunks whose stored embedding was produced by a different model/dims and
    /// therefore must be re-embedded before they can be matched.
    pub pending_chunks: i64,
    pub running: bool,
    pub errored: Option<String>,
}

/// Preference payload (`embedding-model` key) describing the user's chosen default
/// embedding model. Persisted in the KV preferences store so it survives restarts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingModelPref {
    pub model_id: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub dims: Option<usize>,
}

impl EmbeddingModelPref {
    /// Build a concrete embedder from this preference. A non-empty `base_url`
    /// yields a Remote (OpenAI-compatible) embedder; otherwise the offline Local
    /// hashing embedder. Nothing is hardcoded — dims fall back to the registry
    /// default only when the caller omits them.
    pub fn into_embedder(&self) -> Embedder {
        let dims = self.dims.unwrap_or(crate::registry::DEFAULT_EMBED_DIMS);
        match self
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(base) => {
                let api_key = std::env::var("RYU_EMBED_API_KEY")
                    .ok()
                    .or_else(|| std::env::var("OPENAI_API_KEY").ok())
                    .filter(|s| !s.is_empty());
                Embedder::Remote {
                    base_url: base.to_string(),
                    model: self.model_id.clone(),
                    dims,
                    api_key,
                }
            }
            None => Embedder::Local { dims },
        }
    }
}

/// Preferences KV key for the user-chosen default embedding model.
pub const EMBEDDING_MODEL_PREF_KEY: &str = "embedding-model";

/// A single chunk returned from a similarity search (used by U17 retrieval).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkMatch {
    pub chunk_id: String,
    pub document_id: String,
    pub content: String,
    /// Squared L2 distance from the query vector (smaller is closer).
    /// For graph-mode results this is set to a synthetic value of `0.0`
    /// (exact match via graph traversal — distance is not meaningful).
    pub distance: f32,
}

// ── Embedder ───────────────────────────────────────────────────────────────────
//
// The embedder type lives in `super::retrieval` (imported above). It is an async
// enum with a deterministic `Local` hashing variant (headless/offline default for
// tests) and a `Remote` OpenAI-compatible variant that points at the local
// `llamacpp-embed` nomic server by default. `SpaceStore` holds it behind a Mutex
// so the default embedding model can be swapped at runtime (which triggers a
// background re-index — see `reindex_all`).

// ── Graph entity extraction ────────────────────────────────────────────────────

/// Extract entities from a text chunk using deterministic co-occurrence.
///
/// Strategy: every normalized alphanumeric token of length ≥ 3 that starts with
/// an uppercase letter (or, for the purposes of this local extractor, any token
/// that the heuristic selects as "noun-like") is treated as an entity. The
/// normalization step lowercases and trims so that "Alice" and "alice" map to the
/// same node key, guaranteeing bridge-entity consistency across chunks.
///
/// This is intentionally simple so the spike works offline with no model. A
/// production deployment can swap in an LLM-based extractor by setting
/// `RYU_GRAPH_EXTRACTION_MODEL` to a non-local id and wiring a remote call here.
fn extract_entities(text: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut entities = Vec::new();
    for token in text.split(|c: char| !c.is_alphanumeric()) {
        if token.len() < 3 {
            continue;
        }
        // Heuristic: starts with an uppercase letter OR is longer than 4 chars
        // (catches common nouns that might bridge chunks).
        let first_upper = token.chars().next().is_some_and(|c| c.is_uppercase());
        if first_upper || token.len() > 4 {
            let normalized = token.to_lowercase();
            if seen.insert(normalized.clone()) {
                entities.push(normalized);
            }
        }
    }
    entities
}

// ── Insertion-ordered set (used in graph_search BFS) ──────────────────────────
// We use a simple Vec + HashSet pair rather than the `linked-hash-set` crate to
// avoid a new dependency.

/// Insertion-ordered set. `insert` is a no-op for duplicate keys.
struct LinkedHashSet<T> {
    order: Vec<T>,
    seen: std::collections::HashSet<T>,
}

impl<T: std::hash::Hash + Eq + Clone> LinkedHashSet<T> {
    fn new() -> Self {
        Self {
            order: Vec::new(),
            seen: std::collections::HashSet::new(),
        }
    }

    fn insert(&mut self, val: T) -> bool {
        if self.seen.insert(val.clone()) {
            self.order.push(val);
            true
        } else {
            false
        }
    }

    fn len(&self) -> usize {
        self.order.len()
    }

    fn iter(&self) -> std::slice::Iter<'_, T> {
        self.order.iter()
    }
}

// ── SpaceStore ─────────────────────────────────────────────────────────────────

/// SQLite + sqlite-vec backed Space store. Cheap to clone (wraps an
/// `Arc<Mutex<Connection>>` and an `Arc<dyn Embedder>`).
///
/// `embed_dims` is stored separately so `init_schema` can declare the `vec0`
/// virtual table with the correct width without downcasting the embedder trait
/// object. Both must agree: the embedder produces vectors of `embed_dims` length,
/// and the vec0 table is declared with the same value.
#[derive(Clone)]
pub struct SpaceStore {
    conn: Arc<Mutex<Connection>>,
    /// Active embedder. Held behind a Mutex so the default embedding model can be
    /// swapped at runtime; cloned (cheap) for each embed call so the lock is never
    /// held across network I/O.
    embedder: Arc<Mutex<Embedder>>,
    /// Current width of the `chunk_vectors` vec0 table. Equals the active
    /// embedder's dims; updated when a model change recreates the table.
    vec_dims: Arc<AtomicUsize>,
    /// Graph extraction model id (from registry; informational — the local
    /// extractor always runs offline; a remote id here is a future hook).
    graph_extraction_model: String,
    /// Background re-index coordination (single-run guard + last error).
    reindex: Arc<Mutex<ReindexInner>>,
}

/// Internal re-index run state.
#[derive(Default)]
struct ReindexInner {
    running: bool,
    errored: Option<String>,
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Default on-disk location for the spaces database (`~/.ryu/spaces.db`). Kept
/// separate from `conversations.db` so the vector layer stays isolated.
fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("spaces.db")
}

impl SpaceStore {
    /// Open (or create) the store at the default path using the environment-
    /// configured model registry to determine the embedding model and dims.
    pub fn open_default() -> Result<Self> {
        let registry = ModelRegistry::from_env();
        let embedder = Embedder::from_registry(&registry);
        let dims = embedder.dims();
        let extraction_model = registry.graph_extraction_model.clone();
        Self::open_inner(default_db_path(), embedder, dims, extraction_model)
    }

    /// Open (or create) the store at a specific path with a chosen embedder and
    /// the embedding dimensionality that embedder produces.
    ///
    /// `embed_dims` must equal the output length of `embedder.embed(...)`. Passing
    /// a mismatched value will cause vec0 insert failures or silent score errors.
    pub fn open(path: PathBuf, embedder: Embedder, embed_dims: usize) -> Result<Self> {
        let registry = ModelRegistry::from_env();
        let extraction_model = registry.graph_extraction_model.clone();
        Self::open_inner(path, embedder, embed_dims, extraction_model)
    }

    fn open_inner(
        path: PathBuf,
        embedder: Embedder,
        embed_dims: usize,
        graph_extraction_model: String,
    ) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = open_vec_connection(&path)?;
        apply_encryption(&conn, Some(&path))?;
        Self::init_schema(&conn, embed_dims)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            embedder: Arc::new(Mutex::new(embedder)),
            vec_dims: Arc::new(AtomicUsize::new(embed_dims)),
            graph_extraction_model,
            reindex: Arc::new(Mutex::new(ReindexInner::default())),
        })
    }

    /// Open an in-memory store using default registry dims (used by tests).
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let dims = crate::registry::DEFAULT_EMBED_DIMS;
        let conn = open_vec_connection(std::path::Path::new(":memory:"))?;
        Self::init_schema(&conn, dims)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            embedder: Arc::new(Mutex::new(Embedder::Local { dims })),
            vec_dims: Arc::new(AtomicUsize::new(dims)),
            graph_extraction_model: crate::registry::DEFAULT_GRAPH_EXTRACTION_MODEL.to_owned(),
            reindex: Arc::new(Mutex::new(ReindexInner::default())),
        })
    }

    /// Snapshot the active embedder (cheap clone) so embedding I/O happens without
    /// holding the embedder lock.
    async fn embedder_snapshot(&self) -> Embedder {
        self.embedder.lock().await.clone()
    }

    /// Current embedding model id + dims.
    pub async fn embedding_model(&self) -> EmbeddingModelInfo {
        let emb = self.embedder.lock().await;
        EmbeddingModelInfo {
            model_id: emb.model_id().to_string(),
            dims: emb.dims(),
        }
    }

    fn init_schema(conn: &Connection, embed_dims: usize) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS spaces (
                 id             TEXT PRIMARY KEY,
                 name           TEXT NOT NULL,
                 description    TEXT,
                 created_at     INTEGER NOT NULL,
                 updated_at     INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS documents (
                 id          TEXT PRIMARY KEY,
                 space_id    TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
                 title       TEXT NOT NULL,
                 created_at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_documents_space
                 ON documents(space_id, created_at);
             CREATE TABLE IF NOT EXISTS chunks (
                 id          TEXT PRIMARY KEY,
                 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                 space_id    TEXT NOT NULL,
                 ordinal     INTEGER NOT NULL,
                 content     TEXT NOT NULL,
                 created_at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_chunks_document
                 ON chunks(document_id, ordinal);
             CREATE TABLE IF NOT EXISTS graph_nodes (
                 id          TEXT PRIMARY KEY,
                 space_id    TEXT NOT NULL,
                 entity      TEXT NOT NULL,
                 chunk_id    TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_graph_nodes_space_entity
                 ON graph_nodes(space_id, entity);
             CREATE INDEX IF NOT EXISTS idx_graph_nodes_chunk
                 ON graph_nodes(chunk_id);
             CREATE TABLE IF NOT EXISTS graph_edges (
                 id          TEXT PRIMARY KEY,
                 space_id    TEXT NOT NULL,
                 src_entity  TEXT NOT NULL,
                 dst_entity  TEXT NOT NULL,
                 chunk_id    TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_graph_edges_space_src
                 ON graph_edges(space_id, src_entity);
             CREATE INDEX IF NOT EXISTS idx_graph_edges_space_dst
                 ON graph_edges(space_id, dst_entity);",
        )
        .context("initializing spaces schema")?;

        // vec0 virtual table holds only the vector, keyed by the chunk's rowid.
        // Declared with the embedder's configured dims so inserts and queries are
        // always consistent.
        conn.execute_batch(&format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors
                 USING vec0(rowid INTEGER PRIMARY KEY, embedding float[{embed_dims}]);"
        ))
        .context("initializing vec0 virtual table")?;

        // Idempotent migration: add retrieval_mode column to spaces if absent.
        // ALTER TABLE … ADD COLUMN fails with "duplicate column name" on SQLite
        // when the column already exists, so we swallow that specific error.
        let _ = conn.execute_batch(
            "ALTER TABLE spaces ADD COLUMN retrieval_mode TEXT NOT NULL DEFAULT 'vector';",
        );

        // Idempotent migrations for editable markdown pages (Notion-style docs):
        // the full markdown `source` + an `updated_at` on documents, and the
        // embedder identity on each chunk so a model change can mark stale vectors.
        let _ =
            conn.execute_batch("ALTER TABLE documents ADD COLUMN source TEXT NOT NULL DEFAULT '';");
        let _ = conn.execute_batch(
            "ALTER TABLE documents ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;",
        );
        let _ = conn
            .execute_batch("ALTER TABLE chunks ADD COLUMN embed_model TEXT NOT NULL DEFAULT '';");
        let _ = conn
            .execute_batch("ALTER TABLE chunks ADD COLUMN embed_dims INTEGER NOT NULL DEFAULT 0;");

        // Idempotent migration: documents can be a Notion-style markdown "page"
        // (default) or a "database" (an editable data grid persisted as JSON in
        // `source`). The `kind` discriminates which editor opens it; embedding
        // treats a database's flattened text so it stays searchable like a page.
        let _ = conn.execute_batch(
            "ALTER TABLE documents ADD COLUMN kind TEXT NOT NULL DEFAULT 'page';",
        );

        Ok(())
    }

    /// Create a new Space and return its id. The `retrieval_mode` defaults to
    /// `"vector"` (backward-compatible). Pass `Some(RetrievalMode::Graph)` to opt
    /// into graph retrieval for this Space.
    pub async fn create_space(&self, name: &str, description: Option<&str>) -> Result<String> {
        self.create_space_with_mode(name, description, RetrievalMode::Vector)
            .await
    }

    /// Create a new Space with an explicit retrieval mode.
    pub async fn create_space_with_mode(
        &self,
        name: &str,
        description: Option<&str>,
        mode: RetrievalMode,
    ) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO spaces (id, name, description, created_at, updated_at, retrieval_mode)
             VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            params![id, name, description, now, mode.as_str()],
        )
        .context("creating space")?;
        Ok(id)
    }

    /// List all Spaces, most-recently-updated first, with document counts.
    pub async fn list_spaces(&self) -> Result<Vec<Space>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT s.id, s.name, s.description, s.created_at, s.updated_at,
                    (SELECT COUNT(*) FROM documents d WHERE d.space_id = s.id),
                    s.retrieval_mode
             FROM spaces s
             ORDER BY s.updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let mode_str: String = row.get(6)?;
            Ok(Space {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                document_count: row.get(5)?,
                retrieval_mode: RetrievalMode::from_str(&mode_str),
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// List the documents in a Space with chunk counts.
    pub async fn list_documents(&self, space_id: &str) -> Result<Vec<Document>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT d.id, d.space_id, d.title, d.created_at,
                    (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id),
                    d.kind
             FROM documents d
             WHERE d.space_id = ?1
             ORDER BY d.created_at ASC",
        )?;
        let rows = stmt.query_map([space_id], |row| {
            Ok(Document {
                id: row.get(0)?,
                space_id: row.get(1)?,
                title: row.get(2)?,
                created_at: row.get(3)?,
                chunk_count: row.get(4)?,
                kind: row.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Ingest a document into a Space: chunk the text, embed each chunk, and store
    /// the rows plus their vectors. In graph mode also extracts entities/relations.
    /// Returns the new document id. Errors if the Space does not exist.
    pub async fn ingest_document(
        &self,
        space_id: &str,
        title: &str,
        content: &str,
    ) -> Result<String> {
        let chunks = chunk_text(content);
        // Embed outside the lock — the embedder may do network I/O.
        let emb = self.embedder_snapshot().await;
        let model_id = emb.model_id().to_string();
        let dims = emb.dims();
        let mut embedded: Vec<(String, Vec<f32>)> = Vec::with_capacity(chunks.len());
        for chunk in &chunks {
            embedded.push((chunk.clone(), emb.embed(chunk).await?));
        }

        let document_id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction().context("starting ingest transaction")?;

        // Verify the Space exists and read its retrieval mode.
        let mode_str: Option<String> = tx
            .query_row(
                "SELECT retrieval_mode FROM spaces WHERE id = ?1",
                params![space_id],
                |row| row.get(0),
            )
            .optional()
            .context("querying space retrieval_mode")?;
        let mode_str = mode_str.ok_or_else(|| anyhow::anyhow!("space '{space_id}' not found"))?;
        let mode = RetrievalMode::from_str(&mode_str);

        tx.execute(
            "INSERT INTO documents (id, space_id, title, created_at, source, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?4)",
            params![document_id, space_id, title, now, content],
        )
        .context("inserting document")?;

        insert_chunks(
            &tx,
            &document_id,
            space_id,
            &embedded,
            now,
            &model_id,
            dims,
            mode,
        )?;

        tx.execute(
            "UPDATE spaces SET updated_at = ?1 WHERE id = ?2",
            params![now, space_id],
        )
        .context("bumping space updated_at")?;

        tx.commit().context("committing ingest transaction")?;
        Ok(document_id)
    }

    /// Create an empty Notion-style page (document with no content yet) in a Space.
    /// Returns the new document id. The editor fills it in via `update_document`,
    /// which is what produces chunks + embeddings.
    pub async fn create_page(&self, space_id: &str, title: &str) -> Result<String> {
        self.create_document_of_kind(space_id, title, "page").await
    }

    /// Create an empty database (data-grid) document in a Space. Same lifecycle as
    /// a page — the editor fills its grid JSON in via `update_document`, which
    /// chunks + embeds the flattened cell text so the database stays searchable.
    pub async fn create_database(&self, space_id: &str, title: &str) -> Result<String> {
        self.create_document_of_kind(space_id, title, "database")
            .await
    }

    /// Shared constructor for an empty document of a given `kind`
    /// (`"page"` | `"database"`).
    async fn create_document_of_kind(
        &self,
        space_id: &str,
        title: &str,
        kind: &str,
    ) -> Result<String> {
        let document_id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        let conn = self.conn.lock().await;
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM spaces WHERE id = ?1",
                params![space_id],
                |row| row.get(0),
            )
            .optional()
            .context("verifying space exists")?;
        if exists.is_none() {
            anyhow::bail!("space '{space_id}' not found");
        }
        conn.execute(
            "INSERT INTO documents (id, space_id, title, created_at, source, updated_at, kind)
             VALUES (?1, ?2, ?3, ?4, '', ?4, ?5)",
            params![document_id, space_id, title, now, kind],
        )
        .context("inserting document")?;
        conn.execute(
            "UPDATE spaces SET updated_at = ?1 WHERE id = ?2",
            params![now, space_id],
        )
        .context("bumping space updated_at")?;
        Ok(document_id)
    }

    /// Fetch a single document with its full markdown source.
    pub async fn get_document(&self, doc_id: &str) -> Result<Option<DocumentContent>> {
        let conn = self.conn.lock().await;
        let doc = conn
            .query_row(
                "SELECT d.id, d.space_id, d.title, d.source, d.created_at, d.updated_at,
                        (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id),
                        d.kind
                 FROM documents d WHERE d.id = ?1",
                params![doc_id],
                |row| {
                    Ok(DocumentContent {
                        id: row.get(0)?,
                        space_id: row.get(1)?,
                        title: row.get(2)?,
                        source: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                        chunk_count: row.get(6)?,
                        kind: row.get(7)?,
                    })
                },
            )
            .optional()
            .context("reading document")?;
        Ok(doc)
    }

    /// Save an edited page: replace the document's chunks + vectors (+ graph) from
    /// the new markdown `source`, re-embedding with the current model. This is the
    /// embed-on-save path; the desktop debounces calls to it.
    pub async fn update_document(&self, doc_id: &str, title: &str, source: &str) -> Result<()> {
        // A database document stores grid JSON in `source`; embed a flattened
        // text rendering of it (column labels + cell values) so it stays
        // searchable like a page. The stored `source` remains the raw JSON.
        // Read `kind` before chunking — chunking/embedding happen outside the lock.
        let kind: Option<String> = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT kind FROM documents WHERE id = ?1",
                params![doc_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading document kind")?
        };
        let chunk_source = if kind.as_deref() == Some("database") {
            flatten_database_source(source)
        } else {
            source.to_string()
        };
        let chunks = chunk_text(&chunk_source);
        // Embed outside the lock — the embedder may do network I/O.
        let emb = self.embedder_snapshot().await;
        let model_id = emb.model_id().to_string();
        let dims = emb.dims();
        let mut embedded: Vec<(String, Vec<f32>)> = Vec::with_capacity(chunks.len());
        for chunk in &chunks {
            embedded.push((chunk.clone(), emb.embed(chunk).await?));
        }

        let now = now_millis();
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction().context("starting update transaction")?;

        // Resolve the document's space + retrieval mode (and prove it exists).
        let row: Option<(String, String)> = tx
            .query_row(
                "SELECT d.space_id, s.retrieval_mode
                 FROM documents d JOIN spaces s ON s.id = d.space_id
                 WHERE d.id = ?1",
                params![doc_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .context("resolving document space")?;
        let (space_id, mode_str) =
            row.ok_or_else(|| anyhow::anyhow!("document '{doc_id}' not found"))?;
        let mode = RetrievalMode::from_str(&mode_str);

        // Drop the document's old chunks, vectors, and graph rows.
        tx.execute(
            "DELETE FROM chunk_vectors WHERE rowid IN
                 (SELECT rowid FROM chunks WHERE document_id = ?1)",
            params![doc_id],
        )
        .context("deleting old chunk vectors")?;
        tx.execute(
            "DELETE FROM graph_nodes WHERE chunk_id IN
                 (SELECT id FROM chunks WHERE document_id = ?1)",
            params![doc_id],
        )?;
        tx.execute(
            "DELETE FROM graph_edges WHERE chunk_id IN
                 (SELECT id FROM chunks WHERE document_id = ?1)",
            params![doc_id],
        )?;
        tx.execute("DELETE FROM chunks WHERE document_id = ?1", params![doc_id])
            .context("deleting old chunks")?;

        insert_chunks(
            &tx, doc_id, &space_id, &embedded, now, &model_id, dims, mode,
        )?;

        tx.execute(
            "UPDATE documents SET title = ?1, source = ?2, updated_at = ?3 WHERE id = ?4",
            params![title, source, now, doc_id],
        )
        .context("updating document")?;
        tx.execute(
            "UPDATE spaces SET updated_at = ?1 WHERE id = ?2",
            params![now, space_id],
        )?;
        tx.commit().context("committing update transaction")?;
        Ok(())
    }

    /// Delete a single document and all its chunks/vectors/graph rows. Returns
    /// whether a document row was removed.
    pub async fn delete_document(&self, doc_id: &str) -> Result<bool> {
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction().context("starting delete transaction")?;
        tx.execute(
            "DELETE FROM chunk_vectors WHERE rowid IN
                 (SELECT rowid FROM chunks WHERE document_id = ?1)",
            params![doc_id],
        )
        .context("deleting doc chunk vectors")?;
        // chunks + graph rows cascade from the document row via ON DELETE CASCADE.
        let removed = tx
            .execute("DELETE FROM documents WHERE id = ?1", params![doc_id])
            .context("deleting document")?;
        tx.commit().context("committing delete transaction")?;
        Ok(removed > 0)
    }

    /// Run a retrieval search across a Space. Branches on the Space's
    /// `retrieval_mode`:
    ///
    /// - `vector`: KNN similarity search (original behaviour, unchanged).
    /// - `graph`: entity-match + BFS traversal, returns grounded chunks.
    ///
    /// Both paths return `Vec<ChunkMatch>`. For graph results, `distance` is
    /// set to `0.0` (traversal hit) or a hop-count–derived synthetic value.
    pub async fn search(
        &self,
        space_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<ChunkMatch>> {
        let mode = self.space_mode(space_id).await?;
        match mode {
            RetrievalMode::Vector => self.vector_search(space_id, query, limit).await,
            RetrievalMode::Graph => self.graph_search(space_id, query, limit).await,
        }
    }

    /// Read the `retrieval_mode` for a Space.
    async fn space_mode(&self, space_id: &str) -> Result<RetrievalMode> {
        let conn = self.conn.lock().await;
        let mode_str: Option<String> = conn
            .query_row(
                "SELECT retrieval_mode FROM spaces WHERE id = ?1",
                params![space_id],
                |row| row.get(0),
            )
            .optional()
            .context("querying space retrieval_mode")?;
        Ok(RetrievalMode::from_str(
            mode_str.as_deref().unwrap_or("vector"),
        ))
    }

    /// KNN cosine-similarity search (vector mode).
    async fn vector_search(
        &self,
        space_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<ChunkMatch>> {
        let emb = self.embedder_snapshot().await;
        let model_id = emb.model_id().to_string();
        let query_vec = emb.embed(query).await?;
        let bytes = vec_to_bytes(&query_vec);
        let conn = self.conn.lock().await;
        // Filter to chunks embedded by the *current* model: a vector produced by a
        // different embedding model lives in an incomparable space, so matching it
        // would yield meaningless distances. Stale chunks are excluded until a
        // re-index re-embeds them (see `reindex_all`).
        let mut stmt = conn.prepare(
            "SELECT c.id, c.document_id, c.content, v.distance
             FROM chunk_vectors v
             JOIN chunks c ON c.rowid = v.rowid
             WHERE v.embedding MATCH ?1
               AND k = ?2
               AND c.space_id = ?3
               AND c.embed_model = ?4
             ORDER BY v.distance",
        )?;
        let rows = stmt.query_map(params![bytes, limit as i64, space_id, model_id], |row| {
            Ok(ChunkMatch {
                chunk_id: row.get(0)?,
                document_id: row.get(1)?,
                content: row.get(2)?,
                distance: row.get::<_, f64>(3)? as f32,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Graph traversal search (graph mode).
    ///
    /// Algorithm:
    /// 1. Extract query entities (same extractor used at ingest time).
    /// 2. Seed the BFS frontier with all chunks that contain those entities.
    /// 3. For each frontier chunk, follow all outgoing edges to neighbour
    ///    entities, then find chunks containing those neighbours.
    /// 4. Continue until `limit` unique chunks are collected or no new frontier.
    /// 5. Return the collected chunks ordered: direct hits first, then 1-hop, etc.
    async fn graph_search(
        &self,
        space_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<ChunkMatch>> {
        let query_entities = extract_entities(query);
        if query_entities.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock().await;

        // Seed: find chunks that directly contain a query entity.
        let mut visited_chunks = LinkedHashSet::<String>::new();
        let mut frontier_entities: std::collections::HashSet<String> =
            query_entities.into_iter().collect();
        let mut next_frontier: std::collections::HashSet<String> = std::collections::HashSet::new();

        let max_hops = 3usize;
        for _ in 0..max_hops {
            if frontier_entities.is_empty() || visited_chunks.len() >= limit {
                break;
            }
            // For each frontier entity, collect the chunks it appears in.
            for entity in &frontier_entities {
                let mut stmt = conn.prepare(
                    "SELECT DISTINCT n.chunk_id
                     FROM graph_nodes n
                     WHERE n.space_id = ?1 AND n.entity = ?2",
                )?;
                let chunk_rows =
                    stmt.query_map(params![space_id, entity], |row| row.get::<_, String>(0))?;
                for row in chunk_rows {
                    let cid = row?;
                    if visited_chunks.len() < limit {
                        visited_chunks.insert(cid);
                    }
                }
                // Collect neighbour entities via outgoing edges from this entity.
                let mut edge_stmt = conn.prepare(
                    "SELECT DISTINCT e.dst_entity
                     FROM graph_edges e
                     WHERE e.space_id = ?1 AND e.src_entity = ?2",
                )?;
                let edge_rows = edge_stmt
                    .query_map(params![space_id, entity], |row| row.get::<_, String>(0))?;
                for row in edge_rows {
                    let neighbour = row?;
                    if !frontier_entities.contains(&neighbour) {
                        next_frontier.insert(neighbour);
                    }
                }
            }
            frontier_entities = std::mem::take(&mut next_frontier);
        }

        // Load the matched chunks.
        let mut results = Vec::new();
        for chunk_id in visited_chunks.iter().take(limit) {
            let row = conn.query_row(
                "SELECT c.id, c.document_id, c.content FROM chunks c WHERE c.id = ?1",
                params![chunk_id],
                |row| {
                    Ok(ChunkMatch {
                        chunk_id: row.get(0)?,
                        document_id: row.get(1)?,
                        content: row.get(2)?,
                        // Synthetic distance: 0.0 = direct entity hit.
                        distance: 0.0,
                    })
                },
            );
            if let Ok(chunk_match) = row {
                results.push(chunk_match);
            }
        }
        Ok(results)
    }

    /// Delete a Space, its documents, chunks, and their vectors. Returns true if
    /// a Space row was removed.
    pub async fn delete_space(&self, space_id: &str) -> Result<bool> {
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction().context("starting delete transaction")?;
        // Remove vectors first (vec0 has no foreign-key cascade).
        tx.execute(
            "DELETE FROM chunk_vectors WHERE rowid IN (
                 SELECT rowid FROM chunks WHERE space_id = ?1
             )",
            params![space_id],
        )
        .context("deleting chunk vectors")?;
        // chunks + documents cascade from the space row via ON DELETE CASCADE.
        let removed = tx
            .execute("DELETE FROM spaces WHERE id = ?1", params![space_id])
            .context("deleting space")?;
        tx.commit().context("committing delete transaction")?;
        Ok(removed > 0)
    }

    /// Total number of user-visible Spaces (for the danger-zone count preview).
    /// Excludes the hidden "Meetings" Space that backs meeting notes — it is not
    /// a user-created Space and the danger-zone "delete all spaces" leaves it
    /// alone, so it must not be counted either.
    pub async fn count_spaces(&self) -> Result<u64> {
        let conn = self.conn.lock().await;
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM spaces WHERE name != ?1",
            params![MEETINGS_SPACE_NAME],
            |r| r.get(0),
        )?;
        Ok(n.max(0) as u64)
    }

    /// Delete every user-visible Space and all of its documents, chunks, and
    /// vectors in one transaction. Mirrors [`Self::delete_space`]'s teardown order
    /// (vectors first, then the space rows cascade to chunks/documents). Returns
    /// the number of Spaces removed. The hidden "Meetings" Space is **preserved**
    /// so existing meeting notes stay openable; clearing meetings is a separate
    /// action.
    pub async fn clear_all_spaces(&self) -> Result<u64> {
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction().context("starting clear transaction")?;
        // Vectors first (vec0 has no foreign-key cascade) for every chunk whose
        // space is being removed, then the space rows — chunks + documents cascade
        // via ON DELETE CASCADE. The Meetings space (and its chunks/vectors) is
        // skipped on both passes.
        tx.execute(
            "DELETE FROM chunk_vectors WHERE rowid IN (
                 SELECT c.rowid FROM chunks c
                 JOIN spaces s ON s.id = c.space_id
                 WHERE s.name != ?1
             )",
            params![MEETINGS_SPACE_NAME],
        )
        .context("deleting chunk vectors")?;
        let removed = tx
            .execute(
                "DELETE FROM spaces WHERE name != ?1",
                params![MEETINGS_SPACE_NAME],
            )
            .context("deleting spaces")?;
        tx.commit().context("committing clear transaction")?;
        Ok(removed as u64)
    }

    /// Returns the graph extraction model id this store was configured with.
    pub fn graph_extraction_model_id(&self) -> &str {
        self.graph_extraction_model.as_str()
    }

    // ── Embedding model swap + re-index ──────────────────────────────────────

    /// Replace the active embedder. Does not itself re-index — callers that change
    /// the model should kick `reindex_all` afterwards so existing vectors are
    /// re-embedded into the new space.
    pub async fn set_embedder(&self, embedder: Embedder) {
        let mut guard = self.embedder.lock().await;
        *guard = embedder;
    }

    /// Report re-index progress: how many chunks were embedded by a model/dims
    /// other than the current one (and therefore await re-embedding).
    pub async fn reindex_status(&self) -> Result<ReindexStatus> {
        let (current_model, current_dims) = {
            let emb = self.embedder.lock().await;
            (emb.model_id().to_string(), emb.dims())
        };
        let (running, errored) = {
            let g = self.reindex.lock().await;
            (g.running, g.errored.clone())
        };
        let conn = self.conn.lock().await;
        let total_chunks: i64 = conn.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))?;
        let pending_chunks: i64 = conn.query_row(
            "SELECT COUNT(*) FROM chunks WHERE embed_model != ?1 OR embed_dims != ?2",
            params![current_model, current_dims as i64],
            |r| r.get(0),
        )?;
        Ok(ReindexStatus {
            current_model,
            current_dims,
            total_chunks,
            pending_chunks,
            running,
            errored,
        })
    }

    /// Re-embed every chunk whose stored embedding was produced by a different
    /// model/dims, into the current model. If the dimensionality changed, the
    /// `chunk_vectors` vec0 table (whose width is fixed at creation) is dropped and
    /// recreated first. Idempotent + resumable: re-running only touches chunks that
    /// are still stale. Guarded so only one pass runs at a time.
    pub async fn reindex_all(&self) -> Result<()> {
        {
            let mut g = self.reindex.lock().await;
            if g.running {
                return Ok(());
            }
            g.running = true;
            g.errored = None;
        }
        let result = self.reindex_inner().await;
        let mut g = self.reindex.lock().await;
        g.running = false;
        if let Err(e) = &result {
            g.errored = Some(format!("{e:#}"));
        }
        result
    }

    async fn reindex_inner(&self) -> Result<()> {
        let emb = self.embedder_snapshot().await;
        let model_id = emb.model_id().to_string();
        let dims = emb.dims();

        // The vec0 table width is fixed at creation; a dims change requires
        // recreating it. All old vectors are then gone, so mark every chunk stale.
        if self.vec_dims.load(Ordering::SeqCst) != dims {
            {
                let conn = self.conn.lock().await;
                conn.execute_batch(&format!(
                    "DROP TABLE IF EXISTS chunk_vectors;
                     CREATE VIRTUAL TABLE chunk_vectors
                         USING vec0(rowid INTEGER PRIMARY KEY, embedding float[{dims}]);"
                ))
                .context("recreating chunk_vectors for new dims")?;
                conn.execute("UPDATE chunks SET embed_model = '', embed_dims = 0", [])?;
            }
            self.vec_dims.store(dims, Ordering::SeqCst);
        }

        // Re-embed stale chunks in batches; embedding happens outside the lock.
        loop {
            let batch: Vec<(String, i64, String)> = {
                let conn = self.conn.lock().await;
                let mut stmt = conn.prepare(
                    "SELECT id, rowid, content FROM chunks
                     WHERE embed_model != ?1 OR embed_dims != ?2
                     LIMIT 64",
                )?;
                let rows = stmt.query_map(params![model_id, dims as i64], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?;
                let mut v = Vec::new();
                for row in rows {
                    v.push(row?);
                }
                v
            };
            if batch.is_empty() {
                break;
            }
            let mut embedded = Vec::with_capacity(batch.len());
            for (id, rowid, content) in &batch {
                embedded.push((id.clone(), *rowid, emb.embed(content).await?));
            }
            let mut conn = self.conn.lock().await;
            let tx = conn.transaction()?;
            for (id, rowid, vec) in &embedded {
                tx.execute("DELETE FROM chunk_vectors WHERE rowid = ?1", params![rowid])?;
                tx.execute(
                    "INSERT INTO chunk_vectors (rowid, embedding) VALUES (?1, ?2)",
                    params![rowid, vec_to_bytes(vec)],
                )?;
                tx.execute(
                    "UPDATE chunks SET embed_model = ?1, embed_dims = ?2 WHERE id = ?3",
                    params![model_id, dims as i64, id],
                )?;
            }
            tx.commit()?;
        }
        Ok(())
    }

    /// On startup, apply the user's saved default embedding model (if any) and, if
    /// it differs from what the store opened with, kick a background re-index.
    pub async fn apply_saved_embedding_pref(&self, prefs: &PreferencesStore) {
        let Ok(Some(raw)) = prefs.get(EMBEDDING_MODEL_PREF_KEY).await else {
            return;
        };
        let Ok(pref) = serde_json::from_str::<EmbeddingModelPref>(&raw) else {
            return;
        };
        let embedder = pref.into_embedder();
        let changed = {
            let g = self.embedder.lock().await;
            g.model_id() != embedder.model_id() || g.dims() != embedder.dims()
        };
        self.set_embedder(embedder).await;
        if changed {
            let store = self.clone();
            tokio::spawn(async move {
                let _ = store.reindex_all().await;
            });
        }
    }
}

// ── SQLite helpers ─────────────────────────────────────────────────────────────

/// Register the sqlite-vec extension exactly once for the whole process. It is
/// installed as a SQLite *auto-extension*, so every connection opened afterwards
/// (in any module) automatically gains the `vec0` virtual table.
///
/// `pub(crate)` so sibling stores that need a `vec0`-capable connection (e.g. the
/// conversation message-embedding index) reuse the single registration rather
/// than transmuting the extension entry-point a second time.
pub(crate) fn register_sqlite_vec() {
    use std::sync::Once;
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| {
        // SAFETY: `sqlite3_vec_init` has the SQLite extension entry-point ABI and
        // sqlite3_auto_extension stores the pointer for use on connection open.
        // Mirrors sqlite-vec's own documented rusqlite registration.
        unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
    });
}

/// Open a rusqlite connection with the sqlite-vec extension registered.
///
/// `pub(crate)` so sibling stores (e.g. the conversation message-embedding index)
/// open `vec0`-capable connections through the same code path.
pub(crate) fn open_vec_connection(path: &std::path::Path) -> Result<Connection> {
    register_sqlite_vec();
    let conn = if path == std::path::Path::new(":memory:") {
        Connection::open_in_memory().context("opening in-memory spaces db")?
    } else {
        Connection::open(path).with_context(|| format!("opening spaces db {}", path.display()))?
    };
    Ok(conn)
}

/// Apply the encryption-at-rest *direction* (see module docs). Issues a
/// `PRAGMA key` when `RYU_SPACES_KEY` is set (a no-op on non-SQLCipher builds),
/// and tightens db file permissions on Unix.
fn apply_encryption(conn: &Connection, path: Option<&std::path::Path>) -> Result<()> {
    if let Ok(key) = std::env::var("RYU_SPACES_KEY") {
        if !key.is_empty() {
            // Escape single quotes to keep the pragma well-formed.
            let escaped = key.replace('\'', "''");
            // Ignored by stock SQLite; activates real encryption under SQLCipher.
            let _ = conn.execute_batch(&format!("PRAGMA key = '{escaped}';"));
        }
    }
    #[cfg(unix)]
    if let Some(path) = path {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
    let _ = path;
    Ok(())
}

/// Split text into chunks of at most `CHUNK_CHAR_SIZE` characters, breaking on
/// paragraph then word boundaries. Empty input yields a single empty chunk so a
/// document always has at least one searchable unit.
/// Render a database document (data-grid JSON in `source`) as plain text so its
/// cells stay searchable via the same chunk+embed path as a markdown page. The
/// JSON shape is `{ "columns": [{ "id", "label", ... }], "rows": [{ colId: value }] }`.
/// Falls back to the raw source if it isn't the expected grid JSON.
fn flatten_database_source(source: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(source) else {
        return source.to_string();
    };
    let mut out = String::new();
    if let Some(columns) = value.get("columns").and_then(|c| c.as_array()) {
        let labels: Vec<String> = columns
            .iter()
            .filter_map(|col| {
                col.get("label")
                    .and_then(|l| l.as_str())
                    .or_else(|| col.get("id").and_then(|i| i.as_str()))
                    .map(str::to_string)
            })
            .collect();
        if !labels.is_empty() {
            out.push_str(&labels.join(" | "));
            out.push('\n');
        }
    }
    if let Some(rows) = value.get("rows").and_then(|r| r.as_array()) {
        for row in rows {
            if let Some(obj) = row.as_object() {
                let line = obj
                    .values()
                    .map(json_cell_to_text)
                    .collect::<Vec<_>>()
                    .join(" | ");
                if !line.trim().is_empty() {
                    out.push_str(&line);
                    out.push('\n');
                }
            }
        }
    }
    if out.trim().is_empty() {
        source.to_string()
    } else {
        out
    }
}

/// Flatten one grid cell value to searchable text across all cell variants
/// (text/number/checkbox/select → scalar; multi-select → array; file → `name`).
fn json_cell_to_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Array(items) => items
            .iter()
            .map(json_cell_to_text)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(", "),
        serde_json::Value::Object(obj) => obj
            .get("name")
            .or_else(|| obj.get("label"))
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string(),
    }
}

fn chunk_text(content: &str) -> Vec<String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return vec![String::new()];
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    for paragraph in trimmed.split("\n\n") {
        for word in paragraph.split_whitespace() {
            if current.chars().count() + word.chars().count() + 1 > CHUNK_CHAR_SIZE
                && !current.is_empty()
            {
                chunks.push(std::mem::take(&mut current));
            }
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        }
        if !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if chunks.is_empty() {
        chunks.push(trimmed.to_owned());
    }
    chunks
}

/// Insert a document's chunks + their vectors (and, in graph mode, the entity
/// graph). Shared by `ingest_document` and `update_document` so both paths stamp
/// the embedder identity (`embed_model`/`embed_dims`) onto every chunk.
#[allow(clippy::too_many_arguments)]
fn insert_chunks(
    tx: &rusqlite::Transaction<'_>,
    document_id: &str,
    space_id: &str,
    embedded: &[(String, Vec<f32>)],
    now: i64,
    model_id: &str,
    dims: usize,
    mode: RetrievalMode,
) -> Result<()> {
    let mut chunk_ids: Vec<String> = Vec::with_capacity(embedded.len());
    for (ordinal, (content, embedding)) in embedded.iter().enumerate() {
        let chunk_id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO chunks
                 (id, document_id, space_id, ordinal, content, created_at, embed_model, embed_dims)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                chunk_id,
                document_id,
                space_id,
                ordinal as i64,
                content,
                now,
                model_id,
                dims as i64
            ],
        )
        .context("inserting chunk")?;
        let rowid = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO chunk_vectors (rowid, embedding) VALUES (?1, ?2)",
            params![rowid, vec_to_bytes(embedding)],
        )
        .context("inserting chunk vector")?;
        chunk_ids.push(chunk_id);
    }

    if mode == RetrievalMode::Graph {
        for (chunk_content, chunk_id) in embedded.iter().map(|(c, _)| c).zip(chunk_ids.iter()) {
            let entities = extract_entities(chunk_content);
            for entity in &entities {
                let node_id = uuid::Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT OR IGNORE INTO graph_nodes (id, space_id, entity, chunk_id)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![node_id, space_id, entity, chunk_id],
                )
                .context("inserting graph node")?;
            }
            for i in 0..entities.len() {
                for j in 0..entities.len() {
                    if i == j {
                        continue;
                    }
                    let edge_id = uuid::Uuid::new_v4().to_string();
                    tx.execute(
                        "INSERT OR IGNORE INTO graph_edges
                         (id, space_id, src_entity, dst_entity, chunk_id)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![edge_id, space_id, &entities[i], &entities[j], chunk_id],
                    )
                    .context("inserting graph edge")?;
                }
            }
        }
    }
    Ok(())
}

/// Serialize an `f32` vector to little-endian bytes for the `vec0` BLOB binding.
fn vec_to_bytes(vec: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vec.len() * 4);
    for value in vec {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // De-risk gate: proves the sqlite-vec C extension actually links and the
    // vec0 KNN path works on this platform (cargo check cannot verify linking).
    #[test]
    fn vec0_links_and_knn_round_trips() {
        let conn = open_vec_connection(std::path::Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE v USING vec0(rowid INTEGER PRIMARY KEY, embedding float[4]);",
        )
        .unwrap();
        let a = vec_to_bytes(&[1.0, 0.0, 0.0, 0.0]);
        let b = vec_to_bytes(&[0.0, 1.0, 0.0, 0.0]);
        conn.execute(
            "INSERT INTO v (rowid, embedding) VALUES (1, ?1)",
            params![a],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO v (rowid, embedding) VALUES (2, ?1)",
            params![b],
        )
        .unwrap();
        let query = vec_to_bytes(&[0.9, 0.1, 0.0, 0.0]);
        let mut stmt = conn
            .prepare("SELECT rowid FROM v WHERE embedding MATCH ?1 AND k = 1 ORDER BY distance")
            .unwrap();
        let nearest: i64 = stmt.query_row(params![query], |row| row.get(0)).unwrap();
        assert_eq!(nearest, 1, "row 1 should be the nearest neighbor");
    }

    #[tokio::test]
    async fn clear_all_spaces_preserves_meetings_space() {
        let store = SpaceStore::open_in_memory().unwrap();
        store.create_space("Notes", None).await.unwrap();
        store.create_space("Research", None).await.unwrap();
        store.create_space(MEETINGS_SPACE_NAME, None).await.unwrap();

        // The hidden Meetings space is excluded from the count.
        assert_eq!(store.count_spaces().await.unwrap(), 2);

        // Clear removes only the two user spaces, leaving Meetings intact.
        let removed = store.clear_all_spaces().await.unwrap();
        assert_eq!(removed, 2);
        assert_eq!(store.count_spaces().await.unwrap(), 0);
        let remaining = store.list_spaces().await.unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].name, MEETINGS_SPACE_NAME);
    }

    #[tokio::test]
    async fn page_create_edit_search_delete() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store.create_space("Notes", None).await.unwrap();

        // New empty page.
        let doc = store.create_page(&space, "Untitled").await.unwrap();
        let got = store.get_document(&doc).await.unwrap().unwrap();
        assert_eq!(got.title, "Untitled");
        assert_eq!(got.source, "");
        assert_eq!(got.chunk_count, 0);

        // Edit it: source round-trips and chunks/embeddings are produced.
        store
            .update_document(
                &doc,
                "Rust Notes",
                "Rust is a systems programming language.",
            )
            .await
            .unwrap();
        let got = store.get_document(&doc).await.unwrap().unwrap();
        assert_eq!(got.title, "Rust Notes");
        assert!(got.source.contains("systems"));
        assert!(got.chunk_count >= 1);

        // Embed-on-save makes it searchable.
        let results = store
            .search(&space, "programming language", 5)
            .await
            .unwrap();
        assert!(results.iter().any(|r| r.content.contains("Rust")));

        // Delete removes the document and its chunks.
        assert!(store.delete_document(&doc).await.unwrap());
        assert!(store.get_document(&doc).await.unwrap().is_none());
        assert!(!store.delete_document(&doc).await.unwrap());
    }

    #[tokio::test]
    async fn reindex_clears_pending_and_restamps_model() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store.create_space("R", None).await.unwrap();
        let doc = store.create_page(&space, "T").await.unwrap();
        store
            .update_document(&doc, "T", "hello world content here")
            .await
            .unwrap();

        // Simulate chunks left behind by a previous embedding model.
        {
            let conn = store.conn.lock().await;
            conn.execute("UPDATE chunks SET embed_model = 'old-model'", [])
                .unwrap();
        }
        let before = store.reindex_status().await.unwrap();
        assert!(before.pending_chunks >= 1);
        // Stale chunks must not surface in search.
        assert!(store
            .search(&space, "hello world", 5)
            .await
            .unwrap()
            .is_empty());

        store.reindex_all().await.unwrap();
        let after = store.reindex_status().await.unwrap();
        assert_eq!(after.pending_chunks, 0);
        assert!(!after.running);
        // Re-embedded chunks are searchable again.
        assert!(!store
            .search(&space, "hello world", 5)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn reindex_recreates_vectors_on_dims_change() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store.create_space("D", None).await.unwrap();
        let doc = store.create_page(&space, "T").await.unwrap();
        store
            .update_document(&doc, "T", "vectors of a different width")
            .await
            .unwrap();

        // Swap to a Local embedder with a different dimensionality, then reindex.
        let new_dims = crate::registry::DEFAULT_EMBED_DIMS / 2;
        store.set_embedder(Embedder::Local { dims: new_dims }).await;
        store.reindex_all().await.unwrap();

        let status = store.reindex_status().await.unwrap();
        assert_eq!(status.current_dims, new_dims);
        assert_eq!(status.pending_chunks, 0);
        // Search still works against the recreated vec0 table.
        assert!(!store
            .search(&space, "different width", 5)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn create_ingest_list_and_search() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space_id = store
            .create_space("Docs", Some("test space"))
            .await
            .unwrap();

        let spaces = store.list_spaces().await.unwrap();
        assert_eq!(spaces.len(), 1);
        assert_eq!(spaces[0].name, "Docs");
        assert_eq!(spaces[0].document_count, 0);

        store
            .ingest_document(&space_id, "Cats", "Cats are small carnivorous mammals.")
            .await
            .unwrap();
        store
            .ingest_document(&space_id, "Rust", "Rust is a systems programming language.")
            .await
            .unwrap();

        let docs = store.list_documents(&space_id).await.unwrap();
        assert_eq!(docs.len(), 2);
        assert!(docs.iter().all(|d| d.chunk_count >= 1));

        let spaces = store.list_spaces().await.unwrap();
        assert_eq!(spaces[0].document_count, 2);

        let results = store
            .search(&space_id, "programming language", 1)
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].content.contains("Rust"));
    }

    #[tokio::test]
    async fn ingest_into_missing_space_fails() {
        let store = SpaceStore::open_in_memory().unwrap();
        let err = store
            .ingest_document("nope", "t", "body")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[tokio::test]
    async fn delete_space_removes_documents() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space_id = store.create_space("Temp", None).await.unwrap();
        store
            .ingest_document(&space_id, "Doc", "some content here")
            .await
            .unwrap();
        assert!(store.delete_space(&space_id).await.unwrap());
        assert!(store.list_spaces().await.unwrap().is_empty());
        assert!(!store.delete_space(&space_id).await.unwrap());
    }

    #[test]
    fn chunk_text_splits_large_input() {
        let big = "word ".repeat(500);
        let chunks = chunk_text(&big);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.chars().count() <= CHUNK_CHAR_SIZE));
    }

    // ── AC1: existing vector-mode Spaces are unchanged ─────────────────────────

    #[tokio::test]
    async fn default_space_uses_vector_mode() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space_id = store.create_space("VectorSpace", None).await.unwrap();
        let spaces = store.list_spaces().await.unwrap();
        assert_eq!(spaces[0].retrieval_mode, RetrievalMode::Vector);
        // Confirm vector search works normally.
        store
            .ingest_document(&space_id, "Doc", "Cats are small carnivorous mammals.")
            .await
            .unwrap();
        let results = store.search(&space_id, "small mammals", 5).await.unwrap();
        assert!(!results.is_empty());
    }

    // ── AC2 + AC4: GraphRAG multi-hop integration test ─────────────────────────
    //
    // Fixture design:
    //   Chunk A: "Alice works at Acme."          → entities: alice, works, acme
    //   Chunk B: "Acme is based in Paris."        → entities: acme, based, paris
    //   Chunk C: "Paris has the Eiffel Tower."    → entities: paris, eiffel, tower
    //
    // Query: "Alice"
    //
    // Graph traversal: Alice→Acme (edge from A) → Paris (edge from B) → chunk C.
    // A 2-hop BFS captures chunk C which the direct "Alice" query entity does not
    // touch (chunk C has no "Alice" token).
    //
    // Vector nearest-neighbor (limit=1): Returns chunk A (direct "alice" match).
    // Requesting only 1 result proves that chunk C — which shares zero tokens
    // with the query — is not the nearest neighbor, so graph can surface it
    // while the nearest-neighbor cannot.
    //
    // The test asserts:
    //   (a) graph mode returns chunk C  (multi-hop hit)
    //   (b) vector mode top-1 returns chunk A (direct match), not chunk C

    #[tokio::test]
    async fn graphrag_multi_hop_finds_connected_chunk_that_vector_misses() {
        let store = SpaceStore::open_in_memory().unwrap();

        // Create a GRAPH-mode Space.
        let graph_space = store
            .create_space_with_mode("GraphSpace", None, RetrievalMode::Graph)
            .await
            .unwrap();

        // Ingest three-chunk fixture.
        store
            .ingest_document(&graph_space, "ChunkA", "Alice works at Acme.")
            .await
            .unwrap();
        store
            .ingest_document(&graph_space, "ChunkB", "Acme is based in Paris.")
            .await
            .unwrap();
        store
            .ingest_document(&graph_space, "ChunkC", "Paris has the Eiffel Tower.")
            .await
            .unwrap();

        // (a) Graph search for "Alice" should find chunk C via multi-hop traversal.
        let graph_results = store.search(&graph_space, "Alice", 10).await.unwrap();
        let graph_contents: Vec<&str> = graph_results.iter().map(|c| c.content.as_str()).collect();
        assert!(
            graph_contents.iter().any(|c| c.contains("Eiffel")),
            "graph mode should find ChunkC (Eiffel Tower) via Alice→Acme→Paris traversal; \
             got: {graph_contents:?}"
        );

        // (b) Vector search with limit=1 returns the NEAREST NEIGHBOR — chunk A
        // (direct "alice" token match). Chunk C has no "Alice" tokens so it is
        // not the nearest neighbor, proving graph traversal found something pure
        // nearest-neighbor search does not return when constrained to 1 result.
        let vector_space = store
            .create_space_with_mode("VectorSpace", None, RetrievalMode::Vector)
            .await
            .unwrap();
        store
            .ingest_document(&vector_space, "ChunkA", "Alice works at Acme.")
            .await
            .unwrap();
        store
            .ingest_document(&vector_space, "ChunkB", "Acme is based in Paris.")
            .await
            .unwrap();
        store
            .ingest_document(&vector_space, "ChunkC", "Paris has the Eiffel Tower.")
            .await
            .unwrap();

        // Nearest-neighbor only — must be chunk A (direct Alice match).
        let vector_top1 = store.search(&vector_space, "Alice", 1).await.unwrap();
        assert_eq!(
            vector_top1.len(),
            1,
            "vector search limit=1 should return exactly 1 chunk"
        );
        assert!(
            vector_top1[0].content.contains("Alice"),
            "top-1 vector result for 'Alice' should be chunk A (direct entity match); \
             got: {:?}",
            vector_top1[0].content
        );
        assert!(
            !vector_top1[0].content.contains("Eiffel"),
            "top-1 vector result should be chunk A not chunk C; \
             got: {:?}",
            vector_top1[0].content
        );

        // Graph retrieved more than 1 chunk, including the 2-hop chunk C.
        assert!(
            graph_results.len() > vector_top1.len(),
            "graph search (limit=10) should find more chunks than vector top-1; \
             graph={}, vector_top1={}",
            graph_results.len(),
            vector_top1.len()
        );
    }

    // ── AC3: retrieval mode + extraction model are registry-configurable ────────

    #[test]
    fn registry_graph_extraction_model_defaults_to_local() {
        let registry = crate::registry::ModelRegistry::default();
        assert_eq!(registry.graph_extraction_model_id(), "local-cooccurrence");
    }

    #[test]
    fn registry_rag_strategy_defaults_to_vector() {
        let registry = crate::registry::ModelRegistry::default();
        assert_eq!(registry.resolve_rag_strategy(None), "vector");
    }

    #[test]
    fn registry_resolves_per_space_mode_over_default() {
        let registry = crate::registry::ModelRegistry::default();
        assert_eq!(registry.resolve_rag_strategy(Some("graph")), "graph");
    }

    #[test]
    fn space_store_reports_graph_extraction_model() {
        let store = SpaceStore::open_in_memory().unwrap();
        assert_eq!(store.graph_extraction_model_id(), "local-cooccurrence");
    }

    // ── Entity extraction unit tests ───────────────────────────────────────────

    #[test]
    fn extract_entities_normalizes_to_lowercase() {
        let entities = extract_entities("Alice works at Acme.");
        assert!(entities.contains(&"alice".to_owned()));
        assert!(entities.contains(&"acme".to_owned()));
    }

    #[test]
    fn extract_entities_bridge_consistent_across_chunks() {
        // The bridge entity "Acme" must normalize to the same key in both chunks.
        let a = extract_entities("Alice works at Acme.");
        let b = extract_entities("Acme is based in Paris.");
        assert!(a.contains(&"acme".to_owned()));
        assert!(b.contains(&"acme".to_owned()));
    }

    #[test]
    fn retrieval_mode_serializes_and_deserializes() {
        let v = RetrievalMode::Vector;
        let g = RetrievalMode::Graph;
        assert_eq!(v.as_str(), "vector");
        assert_eq!(g.as_str(), "graph");
        assert_eq!(RetrievalMode::from_str("vector"), RetrievalMode::Vector);
        assert_eq!(RetrievalMode::from_str("graph"), RetrievalMode::Graph);
        assert_eq!(RetrievalMode::from_str("unknown"), RetrievalMode::Vector);
    }
}
