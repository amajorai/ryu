//! Semantic index over past chat messages (the backing store for the
//! `search_conversations` builtin tool).
//!
//! ## Why this is a separate store (Core vs Gateway + encryption posture)
//!
//! Conversation message bodies are encrypted at rest in `conversations.db`
//! (`ConversationStore` / `ryu_crypto::FieldCipher`, the `enc:v1:` envelope).
//! The unified retrieval store (`retrieval.rs` `chunks` table) holds *plaintext*
//! content. Adding conversations as a third source there would copy decrypted
//! message text into a plaintext store — an at-rest-encryption regression. So
//! instead this index lives in its own `~/.ryu/message-embeddings.db` and stores
//! **only vectors + metadata** (`message_id`, `conversation_id`, `role`,
//! `embed_model`, `embed_dims`, `created_at`) — never the message text. On search
//! the KNN returns `message_id`s, and the caller re-reads + decrypts the snippet
//! from `conversations.db`. The vector BLOB itself is left plaintext, consistent
//! with `spaces.rs` (the secret is the message content, which is never copied out;
//! a vector is a deterministic, non-reversible derivative).
//!
//! ## Vector convention
//!
//! Follows the `spaces.rs` sqlite-vec `vec0` convention (efficient KNN), not the
//! brute-force cosine scan in `retrieval.rs`: a chat db can accumulate many
//! messages. The `vec0` table width is fixed at creation to the active embedder's
//! dims; rows are tagged with `embed_model` so a query embedded by a different
//! model never matches an incomparable vector space (stale rows are skipped until
//! re-embedded).
//!
//! ## Indexing + backfill (fail-open)
//!
//! - **On write:** `ConversationStore::append_message` spawns a best-effort task
//!   that embeds the *plaintext* (before sealing) and inserts a vector row. A
//!   failure (embed sidecar down, etc.) is logged and dropped — it never blocks
//!   or slows the chat write, and the DB mutex is never held across the embed.
//! - **Lazy backfill:** the first search embeds any not-yet-indexed messages
//!   (decrypting stored content first via the conversation cipher), so the feature
//!   returns hits for chats already on disk. A failed embed during backfill is
//!   non-fatal — that message is simply skipped this round.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use tokio::sync::Mutex;

use crate::{encode_embedding, open_vec_connection, SearchEmbedder};

/// A KNN hit from the message index: the `message_id` + its (squared L2) distance.
/// The snippet/content is intentionally NOT stored here — the caller re-reads and
/// decrypts it from `conversations.db`.
#[derive(Debug, Clone)]
pub struct MessageHit {
    pub message_id: String,
    pub conversation_id: String,
    pub role: String,
    pub created_at: i64,
    /// Squared L2 distance from the query vector (smaller = closer).
    pub distance: f32,
}

/// sqlite-vec-backed index of chat-message embeddings. Cheap to clone (`Arc`
/// inside). Stores vectors + metadata only; never message text.
#[derive(Clone)]
pub struct MessageIndex {
    conn: Arc<Mutex<Connection>>,
    embedder: Arc<dyn SearchEmbedder>,
    /// Width of the `message_vectors` vec0 table, fixed at creation.
    dims: Arc<AtomicUsize>,
}

impl MessageIndex {
    /// Open (or create) the message index at `path` using the supplied embedder.
    /// The default db path (`~/.ryu/message-embeddings.db`) and the
    /// registry-driven embedder choice are resolved Core-side by the
    /// `search_host` shim.
    pub fn open(path: PathBuf, embedder: Arc<dyn SearchEmbedder>) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating message-index db dir {}", parent.display()))?;
        }
        let conn = open_vec_connection(&path)?;
        let dims = embedder.dims();
        Self::init_schema(&conn, dims)?;
        // The vec0 table width is fixed at creation. If the active embedder now
        // produces a *different* dimensionality than what the on-disk index was
        // built for (the user swapped to a different-dimension embedding model and
        // restarted), a `MATCH` against the new query width would error. Follow the
        // `spaces.rs` precedent: drop + recreate the vector table at the new width
        // and clear the metadata so the next search cleanly re-backfills, rather
        // than failing. Detected via the stored `embed_dims` (any row's value).
        Self::reconcile_dims(&conn, dims)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            embedder,
            dims: Arc::new(AtomicUsize::new(dims)),
        })
    }

    /// Drop + recreate the vec0 table (and clear metadata) when the active embedder
    /// dims differ from the width the on-disk index was created with. A no-op for
    /// a fresh/empty index or when the dims already match.
    fn reconcile_dims(conn: &Connection, dims: usize) -> Result<()> {
        let stored: Option<i64> = conn
            .query_row(
                "SELECT embed_dims FROM message_embeddings LIMIT 1",
                [],
                |row| row.get(0),
            )
            .ok();
        if let Some(stored) = stored {
            if stored as usize != dims {
                conn.execute_batch(&format!(
                    "DROP TABLE IF EXISTS message_vectors;
                     DELETE FROM message_embeddings;
                     CREATE VIRTUAL TABLE message_vectors
                         USING vec0(rowid INTEGER PRIMARY KEY, embedding float[{dims}]);"
                ))
                .context("recreating message_vectors for new embedder dims")?;
            }
        }
        Ok(())
    }

    /// Open an in-memory index with the supplied embedder at that embedder's dims.
    /// Used by tests (both this crate's and Core's, via the `search_host` shim).
    pub fn open_in_memory(embedder: Arc<dyn SearchEmbedder>) -> Result<Self> {
        let dims = embedder.dims();
        let conn = open_vec_connection(Path::new(":memory:"))?;
        Self::init_schema(&conn, dims)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            embedder,
            dims: Arc::new(AtomicUsize::new(dims)),
        })
    }

    fn init_schema(conn: &Connection, dims: usize) -> Result<()> {
        // Metadata table. NOTE: `message_id` is a plain TEXT column, NOT a foreign
        // key — `messages` lives in a *separate* database file (`conversations.db`),
        // so a cross-db FK is impossible. Deleting a conversation therefore orphans
        // its vectors; search skips message ids that no longer resolve, and a
        // dedicated cleanup sweep is a known follow-up.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS message_embeddings (
                 message_id      TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL,
                 role            TEXT NOT NULL,
                 embed_model     TEXT NOT NULL,
                 embed_dims      INTEGER NOT NULL,
                 created_at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_msg_emb_conversation
                 ON message_embeddings(conversation_id);",
        )
        .context("initializing message_embeddings schema")?;

        // vec0 virtual table holds only the vector, keyed by the metadata rowid.
        // Width is fixed at creation to the active embedder dims.
        conn.execute_batch(&format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS message_vectors
                 USING vec0(rowid INTEGER PRIMARY KEY, embedding float[{dims}]);"
        ))
        .context("initializing message_vectors vec0 table")?;
        Ok(())
    }

    /// Snapshot the embedder (cheap `Arc` clone) so embedding I/O never holds a
    /// lock.
    pub fn embedder(&self) -> Arc<dyn SearchEmbedder> {
        self.embedder.clone()
    }

    /// Index a single message's embedding. Idempotent on `message_id` (re-indexing
    /// replaces the prior row + vector). The `embedding` length must equal the
    /// table width; a mismatch is rejected (a vec0 insert would otherwise error).
    pub async fn index_message(
        &self,
        message_id: &str,
        conversation_id: &str,
        role: &str,
        embedding: &[f32],
        embed_model: &str,
        created_at: i64,
    ) -> Result<()> {
        let dims = self.dims.load(Ordering::Relaxed);
        if embedding.len() != dims {
            anyhow::bail!(
                "embedding length {} does not match index width {dims}",
                embedding.len()
            );
        }
        let bytes = encode_embedding(embedding);
        let conn = self.conn.lock().await;
        // Re-indexing replaces the prior row + vector. vec0 virtual tables do NOT
        // support UPSERT, so we delete-then-insert: look up any existing rowid,
        // drop its vector, then re-insert metadata + vector under a fresh rowid.
        let existing_rowid: Option<i64> = conn
            .query_row(
                "SELECT rowid FROM message_embeddings WHERE message_id = ?1",
                [message_id],
                |row| row.get(0),
            )
            .ok();
        if let Some(rowid) = existing_rowid {
            conn.execute("DELETE FROM message_vectors WHERE rowid = ?1", [rowid])
                .context("deleting stale message vector")?;
            conn.execute(
                "DELETE FROM message_embeddings WHERE message_id = ?1",
                [message_id],
            )
            .context("deleting stale message_embeddings row")?;
        }
        conn.execute(
            "INSERT INTO message_embeddings
                 (message_id, conversation_id, role, embed_model, embed_dims, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                message_id,
                conversation_id,
                role,
                embed_model,
                dims as i64,
                created_at
            ],
        )
        .context("inserting message_embeddings row")?;
        let rowid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO message_vectors (rowid, embedding) VALUES (?1, ?2)",
            params![rowid, bytes],
        )
        .context("inserting message vector")?;
        Ok(())
    }

    /// The set of message ids already indexed (used to compute the backfill set).
    pub async fn indexed_ids(&self) -> Result<std::collections::HashSet<String>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT message_id FROM message_embeddings")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut set = std::collections::HashSet::new();
        for row in rows {
            set.insert(row?);
        }
        Ok(set)
    }

    /// KNN search. Embeds `query`, runs a cosine-distance KNN over the vec0 table
    /// filtered to the *current* embedder's model (incomparable vector spaces are
    /// skipped), optionally scoping to a set of conversation ids. Returns hits
    /// ordered nearest-first.
    pub async fn search(
        &self,
        query: &str,
        limit: usize,
        conversation_ids: Option<&[String]>,
    ) -> Result<Vec<MessageHit>> {
        let model_id = self.embedder.model_id().to_string();
        let query_vec = self.embedder.embed(query).await?;
        let bytes = encode_embedding(&query_vec);
        let conn = self.conn.lock().await;
        // vec0 KNN must over-fetch when we post-filter by conversation, since the
        // `WHERE k = ?` clause caps the candidate set before our metadata filter.
        let fetch = match conversation_ids {
            Some(ids) if !ids.is_empty() => limit.saturating_mul(8).max(64),
            _ => limit,
        };
        let mut stmt = conn.prepare(
            "SELECT m.message_id, m.conversation_id, m.role, m.created_at, v.distance
             FROM message_vectors v
             JOIN message_embeddings m ON m.rowid = v.rowid
             WHERE v.embedding MATCH ?1
               AND k = ?2
               AND m.embed_model = ?3
             ORDER BY v.distance",
        )?;
        let rows = stmt.query_map(params![bytes, fetch as i64, model_id], |row| {
            Ok(MessageHit {
                message_id: row.get(0)?,
                conversation_id: row.get(1)?,
                role: row.get(2)?,
                created_at: row.get(3)?,
                distance: row.get::<_, f64>(4)? as f32,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            let hit = row?;
            if let Some(ids) = conversation_ids {
                if !ids.is_empty() && !ids.iter().any(|c| c == &hit.conversation_id) {
                    continue;
                }
            }
            out.push(hit);
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_embedder::LocalHashingEmbedder;

    /// Default embed dims used by the crate's tests (mirrors Core's
    /// `registry::DEFAULT_EMBED_DIMS`).
    const TEST_DIMS: usize = 768;

    fn test_embedder() -> Arc<dyn SearchEmbedder> {
        Arc::new(LocalHashingEmbedder::new(TEST_DIMS))
    }

    /// Index a few messages with distinct tokens, then search for a query that
    /// shares tokens with one of them and assert it ranks first. Uses the local
    /// (network-free) hashing embedder, so no embed sidecar is required.
    #[tokio::test]
    async fn knn_round_trip_ranks_token_overlap_first() {
        let index = MessageIndex::open_in_memory(test_embedder()).expect("open index");
        let model = index.embedder().model_id().to_string();

        let docs = [
            (
                "m1",
                "c1",
                "user",
                "the quick brown fox jumps over the lazy dog",
            ),
            (
                "m2",
                "c1",
                "assistant",
                "rust borrow checker lifetimes and ownership",
            ),
            (
                "m3",
                "c2",
                "user",
                "favourite pizza toppings pepperoni mushroom",
            ),
        ];
        for (id, conv, role, text) in docs {
            let emb = index.embedder().embed(text).await.expect("embed");
            index
                .index_message(id, conv, role, &emb, &model, 0)
                .await
                .expect("index");
        }

        let hits = index
            .search("rust ownership and lifetimes", 3, None)
            .await
            .expect("search");
        assert!(!hits.is_empty(), "expected at least one hit");
        assert_eq!(hits[0].message_id, "m2", "rust message should rank first");
    }

    /// Conversation-scoped search returns only hits from the requested conversation.
    #[tokio::test]
    async fn search_scopes_to_conversation_ids() {
        let index = MessageIndex::open_in_memory(test_embedder()).expect("open index");
        let model = index.embedder().model_id().to_string();
        for (id, conv, text) in [
            ("m1", "c1", "alpha beta gamma"),
            ("m2", "c2", "alpha beta gamma"),
        ] {
            let emb = index.embedder().embed(text).await.expect("embed");
            index
                .index_message(id, conv, "user", &emb, &model, 0)
                .await
                .expect("index");
        }
        let hits = index
            .search("alpha beta", 5, Some(&["c2".to_owned()]))
            .await
            .expect("search");
        assert!(!hits.is_empty());
        assert!(
            hits.iter().all(|h| h.conversation_id == "c2"),
            "all hits must be scoped to c2"
        );
    }

    /// A dims mismatch between the on-disk index and the active embedder triggers
    /// a clean recreate (no MATCH error), leaving an empty index to re-backfill.
    #[tokio::test]
    async fn reconcile_dims_recreates_on_mismatch() {
        let dims = TEST_DIMS;
        let conn = open_vec_connection(Path::new(":memory:")).expect("conn");
        MessageIndex::init_schema(&conn, dims).expect("schema");
        // Seed a metadata row tagged with a *different* width.
        conn.execute(
            "INSERT INTO message_embeddings
                 (message_id, conversation_id, role, embed_model, embed_dims, created_at)
             VALUES ('m1', 'c1', 'user', 'old-model', ?1, 0)",
            params![(dims / 2) as i64],
        )
        .expect("seed row");
        // Reconcile to the new (full) dims: should clear the stale row.
        MessageIndex::reconcile_dims(&conn, dims).expect("reconcile");
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM message_embeddings", [], |r| r.get(0))
            .expect("count");
        assert_eq!(remaining, 0, "stale rows cleared on dims change");
        // And the recreated vec0 table accepts inserts at the new width.
        let index = MessageIndex {
            conn: Arc::new(Mutex::new(conn)),
            embedder: test_embedder(),
            dims: Arc::new(AtomicUsize::new(dims)),
        };
        let emb = index.embedder().embed("hello").await.expect("embed");
        index
            .index_message("m2", "c1", "user", &emb, "local-hashing", 0)
            .await
            .expect("insert at new width");
    }

    /// Re-indexing the same message id replaces (not duplicates) its vector row.
    #[tokio::test]
    async fn reindex_is_idempotent() {
        let index = MessageIndex::open_in_memory(test_embedder()).expect("open index");
        let model = index.embedder().model_id().to_string();
        let emb = index.embedder().embed("hello world").await.expect("embed");
        index
            .index_message("m1", "c1", "user", &emb, &model, 0)
            .await
            .expect("index");
        index
            .index_message("m1", "c1", "user", &emb, &model, 1)
            .await
            .expect("reindex");
        let ids = index.indexed_ids().await.expect("ids");
        assert_eq!(ids.len(), 1, "re-index must not duplicate the row");
    }
}
