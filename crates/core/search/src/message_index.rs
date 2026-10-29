//! Semantic index over past chat messages (the backing store for the
//! `search_conversations` builtin tool).
//!
//! ## Sealed vectors, in-memory search
//!
//! Conversation message bodies are sealed in `conversations.db`. This index
//! lives in its own `message-embeddings.db` and stores **no message text**: one
//! row per message with its metadata (`message_id`, `conversation_id`, `role`,
//! `embed_model`, `embed_dims`, `created_at`) and the embedding vector **sealed**
//! as a `RYU-CB01` blob (ChaCha20-Poly1305 under the `message-embeddings.db`
//! content key, bound to the message id and embedding model). Embeddings are
//! content: published inversion attacks recover approximate text from them.
//!
//! Search runs on the shared in-memory [`ryu_crypto::VectorIndex`] (partition
//! `messages`): vectors are opened into memory once (f16, cosine scoring) under
//! the process-wide vector cache budget. When the budget evicts the partition it
//! is rehydrated on the next search; when the partition alone exceeds the budget,
//! search streams over the sealed rows instead (slower, same answers).
//! [`MessageIndex::vector_coverage`] reports how much is in memory.
//!
//! An index written by an older build kept plaintext vectors in a sqlite-vec
//! `vec0` table. On open a background pass copies each one into the sealed
//! column, verifies every sealed row opens, drops the `vec0` table, and scrubs
//! the freed pages ([`ryu_crypto::content_sqlite::finish_store`]). Searches during
//! the pass read both forms.
//!
//! ## Indexing + backfill (fail-open)
//!
//! - **On write:** `ConversationStore::append_message` spawns a best-effort task
//!   that embeds the plaintext and inserts a sealed vector row. A failure is
//!   logged and dropped; the DB mutex is never held across the embed.
//! - **Lazy backfill:** the first search embeds any not-yet-indexed messages, so
//!   the feature returns hits for chats already on disk.
//! - **Deletes:** rows are removed with their conversation
//!   ([`MessageIndex::delete_conversation`]) and orphans are swept
//!   ([`MessageIndex::delete_messages`]).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::content_sqlite::{self, ColumnPlan, KeyKind, StoreKeyState};
use ryu_crypto::{ContentCipher, ContentContext, TopK, VectorCoverage, VectorIndex};
use tokio::sync::Mutex;

use crate::{encode_embedding, open_vec_connection, SearchEmbedder};

/// Store name of the semantic message index (its content key derives from it).
pub const MESSAGE_INDEX_STORE: &str = "message-embeddings.db";
/// The vector-index partition holding the current model's message vectors.
const PARTITION: &str = "messages";
/// AAD purpose of a sealed message vector.
const VECTOR_PURPOSE: &str = "message_embeddings.vector";
/// Rows per legacy-copy transaction.
const LEGACY_BATCH: usize = 500;

/// A KNN hit from the message index: the `message_id` + its L2 distance. The
/// snippet is intentionally NOT stored here; the caller re-reads and decrypts it
/// from `conversations.db`.
#[derive(Debug, Clone)]
pub struct MessageHit {
    pub message_id: String,
    pub conversation_id: String,
    pub role: String,
    pub created_at: i64,
    /// L2 distance between the normalized query and message vectors
    /// (`sqrt(2 - 2 * cosine)`, in `[0, 2]`; smaller = closer).
    pub distance: f32,
}

/// Sealed-vector index of chat-message embeddings. Cheap to clone (`Arc`
/// inside). Stores sealed vectors + metadata only; never message text.
#[derive(Clone)]
pub struct MessageIndex {
    conn: Arc<Mutex<Connection>>,
    embedder: Arc<RwLock<Arc<dyn SearchEmbedder>>>,
    /// Width every stored vector must have (the active embedder's dims).
    dims: Arc<AtomicUsize>,
    cipher: Arc<ContentCipher>,
    vectors: VectorIndex,
    /// False when the store was sealed under a key this process does not hold:
    /// writes are refused (the store is never re-sealed or reset).
    writable: Arc<AtomicBool>,
    unreadable: Arc<AtomicU64>,
    /// The partition did not fit the whole vector cache: searches stream and
    /// score it with a bounded top-k instead of rebuilding it every query.
    too_large: Arc<AtomicBool>,
}

fn vector_context(message_id: &str, model: &str) -> ContentContext {
    ContentContext::new(VECTOR_PURPOSE)
        .with("id", message_id)
        .with("model", model)
}

fn vector_plan() -> Result<ColumnPlan> {
    ColumnPlan::blob("message_embeddings", "vector", "message_id", KeyKind::Text)?
        .with_context(&["embed_model"], |row| {
            vector_context(&row.key(), &row.text("embed_model"))
        })
}

fn decode_vector(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.len() % 4 != 0 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect(),
    )
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let (mut dot, mut na, mut nb) = (0.0f32, 0.0f32, 0.0f32);
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let denominator = na.sqrt() * nb.sqrt();
    if denominator > 0.0 {
        dot / denominator
    } else {
        0.0
    }
}

fn l2_from_cosine(cosine: f32) -> f32 {
    (2.0 - 2.0 * cosine).max(0.0).sqrt()
}

fn has_legacy_vec_table(conn: &Connection) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE name = 'message_vectors'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some())
}

/// Remove the legacy plaintext `vec0` rows joined (by rowid) to the metadata
/// rows `select` returns (`rowid, embed_dims` for one bound key). sqlite-vec
/// clears a deleted row's validity bit but leaves its float bytes in the chunk
/// blob, so each vector is overwritten with zeros first; secure_delete then
/// zeroes the freed rowid cells.
fn purge_legacy_vectors(conn: &Connection, select: &str, key: &str) -> Result<()> {
    let rows: Vec<(i64, i64)> = {
        let mut stmt = conn.prepare_cached(select)?;
        let rows = stmt.query_map([key], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (rowid, dims) in rows {
        let present = conn
            .query_row(
                "SELECT 1 FROM message_vectors WHERE rowid = ?1",
                [rowid],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if !present {
            continue;
        }
        let zeros = encode_embedding(&vec![0.0; usize::try_from(dims).unwrap_or(0)]);
        // A width mismatch (a corrupt row) cannot be overwritten; the delete
        // below still drops it.
        let _ = conn.execute(
            "UPDATE message_vectors SET embedding = ?1 WHERE rowid = ?2",
            params![zeros, rowid],
        );
        conn.execute("DELETE FROM message_vectors WHERE rowid = ?1", [rowid])
            .context("deleting a legacy plaintext vector")?;
    }
    Ok(())
}

impl MessageIndex {
    /// Open (or create) the message index at `path` using the supplied embedder,
    /// sealing under the process content key (fails closed without one). The
    /// default db path and the registry-driven embedder choice are resolved
    /// Core-side by the `search_host` shim. A legacy plaintext `vec0` table is
    /// migrated in the background.
    pub fn open(path: PathBuf, embedder: Arc<dyn SearchEmbedder>) -> Result<Self> {
        let cipher = ryu_crypto::content_cipher(MESSAGE_INDEX_STORE)
            .context("resolving the message index content key")?;
        let index = Self::open_with_cipher_no_migration(path.clone(), embedder, cipher)?;
        let worker = index.clone();
        std::thread::Builder::new()
            .name("message-index-seal".to_owned())
            .spawn(move || {
                if let Err(error) = worker.migrate_blocking(&path) {
                    tracing::warn!(
                        "message index: sealing legacy vectors did not finish (retried at the \
                         next start): {error:#}"
                    );
                }
            })
            .context("spawning the message index migration")?;
        Ok(index)
    }

    /// [`Self::open`] with an explicit cipher, migrating any legacy plaintext
    /// vectors synchronously before returning (tests).
    pub fn open_with_cipher(
        path: PathBuf,
        embedder: Arc<dyn SearchEmbedder>,
        cipher: ContentCipher,
    ) -> Result<Self> {
        let index = Self::open_with_cipher_no_migration(path.clone(), embedder, cipher)?;
        index.migrate_blocking(&path)?;
        Ok(index)
    }

    fn open_with_cipher_no_migration(
        path: PathBuf,
        embedder: Arc<dyn SearchEmbedder>,
        cipher: ContentCipher,
    ) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating message-index db dir {}", parent.display()))?;
        }
        let conn = open_vec_connection(&path)?;
        content_sqlite::enable_secure_delete(&conn)?;
        // A scrub a previous run could not finish runs before any request.
        if let Err(error) =
            content_sqlite::run_pending_vacuum_gated(&conn, &path, MESSAGE_INDEX_STORE)
        {
            tracing::warn!("message index: deferred compaction failed: {error:#}");
        }
        let owed = content_sqlite::compaction_owed(&conn, MESSAGE_INDEX_STORE).unwrap_or(false);
        let index = Self::build(conn, embedder, cipher)?;
        if owed {
            // Too large to compact while it opens: the background worker runs it
            // later under this index's lock.
            let weak = Arc::downgrade(&index.conn);
            content_sqlite::defer_compaction(
                MESSAGE_INDEX_STORE,
                Box::new(move || {
                    let conn = weak.upgrade()?;
                    let conn = conn.blocking_lock();
                    Some(content_sqlite::compact_deferred(
                        &conn,
                        &path,
                        MESSAGE_INDEX_STORE,
                    ))
                }),
            );
        }
        Ok(index)
    }

    /// Open an in-memory index with the supplied embedder, sealing under the
    /// process content key. Used by tests (this crate's and Core's).
    pub fn open_in_memory(embedder: Arc<dyn SearchEmbedder>) -> Result<Self> {
        let cipher = ryu_crypto::content_cipher(MESSAGE_INDEX_STORE)
            .context("resolving the message index content key")?;
        Self::open_in_memory_with_cipher(embedder, cipher)
    }

    /// [`Self::open_in_memory`] with an explicit cipher (tests).
    pub fn open_in_memory_with_cipher(
        embedder: Arc<dyn SearchEmbedder>,
        cipher: ContentCipher,
    ) -> Result<Self> {
        let conn = open_vec_connection(Path::new(":memory:"))?;
        content_sqlite::enable_secure_delete(&conn)?;
        Self::build(conn, embedder, cipher)
    }

    fn build(
        conn: Connection,
        embedder: Arc<dyn SearchEmbedder>,
        cipher: ContentCipher,
    ) -> Result<Self> {
        let dims = embedder.dims();
        Self::init_schema(&conn)?;
        let key_state = content_sqlite::check_store_key(&conn, &cipher)?;
        if key_state == StoreKeyState::Retired {
            // Values open under a retired key: walk them again so the background
            // migration reseals them under the current one.
            content_sqlite::reset_items(&conn, cipher.store(), &[vector_plan()?])?;
        }
        // The index was built for another dimensionality (the user swapped to a
        // different-width embedding model): clear it so the next search
        // re-backfills, rather than comparing incomparable vectors.
        Self::reconcile_dims(&conn, dims)?;
        let current_total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM message_embeddings WHERE embed_model = ?1 AND embed_dims = ?2",
            params![embedder.model_id(), dims as i64],
            |row| row.get(0),
        )?;
        let index = Self {
            conn: Arc::new(Mutex::new(conn)),
            embedder: Arc::new(RwLock::new(embedder)),
            dims: Arc::new(AtomicUsize::new(dims)),
            cipher: Arc::new(cipher),
            vectors: VectorIndex::new(MESSAGE_INDEX_STORE),
            writable: Arc::new(AtomicBool::new(key_state.writable())),
            unreadable: Arc::new(AtomicU64::new(0)),
            too_large: Arc::new(AtomicBool::new(false)),
        };
        index
            .vectors
            .set_partition_total(PARTITION, current_total.max(0) as u64);
        Ok(index)
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        // `message_id` is a plain TEXT column, NOT a foreign key: `messages` lives
        // in a separate database file (`conversations.db`). Rows are removed with
        // their conversation and by the orphan sweep.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS message_embeddings (
                 message_id      TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL,
                 role            TEXT NOT NULL,
                 embed_model     TEXT NOT NULL,
                 embed_dims      INTEGER NOT NULL,
                 created_at      INTEGER NOT NULL,
                 vector          BLOB
             );
             CREATE INDEX IF NOT EXISTS idx_msg_emb_conversation
                 ON message_embeddings(conversation_id);",
        )
        .context("initializing message_embeddings schema")?;
        // Indexes written before vectors were sealed lack the column.
        let has_vector: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('message_embeddings') WHERE name = 'vector'")?
            .exists([])?;
        if !has_vector {
            conn.execute_batch("ALTER TABLE message_embeddings ADD COLUMN vector BLOB;")
                .context("adding the sealed vector column")?;
        }
        Ok(())
    }

    /// Clear the index when the active embedder dims differ from the width the
    /// stored vectors were made with. A no-op for an empty index or equal dims.
    fn reconcile_dims(conn: &Connection, dims: usize) -> Result<()> {
        let stored: Option<i64> = conn
            .query_row(
                "SELECT embed_dims FROM message_embeddings LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(stored) = stored {
            if stored as usize != dims {
                conn.execute("DELETE FROM message_embeddings", [])
                    .context("clearing message vectors for new embedder dims")?;
                if has_legacy_vec_table(conn)? {
                    conn.execute_batch("DROP TABLE message_vectors;")
                        .context("dropping the legacy vec0 table")?;
                }
            }
        }
        Ok(())
    }

    /// Copy legacy plaintext `vec0` vectors into the sealed column, reseal values
    /// under a retired key, verify, drop the `vec0` table and scrub freed pages.
    /// Idempotent and resumable: a finished store does nothing; an interrupted
    /// copy continues from the rows still lacking a sealed vector. The shared
    /// connection is locked per batch, so searches keep running meanwhile.
    fn migrate_blocking(&self, db_path: &Path) -> Result<()> {
        // The store record names a key this process does not hold: seal nothing,
        // or the store would mix keys and the rows sealed here would count as
        // indexed yet never open under the real key.
        if !self.writable.load(Ordering::Acquire) {
            anyhow::bail!(content_sqlite::mismatch_error(MESSAGE_INDEX_STORE));
        }
        let legacy = {
            let conn = self.lock_sync();
            has_legacy_vec_table(&conn)?
        };
        let mut sealed = 0u64;
        let mut dropped = 0u64;
        if legacy {
            let mut cursor = String::new();
            loop {
                let conn = self.lock_sync();
                let tx = conn.unchecked_transaction()?;
                let batch: Vec<(String, String, Option<Vec<u8>>)> = {
                    let mut stmt = tx.prepare(
                        "SELECT m.message_id, m.embed_model, v.embedding
                         FROM message_embeddings m
                         LEFT JOIN message_vectors v ON v.rowid = m.rowid
                         WHERE m.vector IS NULL AND m.message_id > ?1
                         ORDER BY m.message_id LIMIT ?2",
                    )?;
                    let rows = stmt.query_map(params![cursor, LEGACY_BATCH as i64], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    })?;
                    rows.collect::<rusqlite::Result<Vec<_>>>()?
                };
                for (message_id, model, plain) in &batch {
                    match plain {
                        Some(bytes) if !bytes.is_empty() => {
                            let blob = self
                                .cipher
                                .seal_bytes(bytes, &vector_context(message_id, model))?;
                            sealed += tx.execute(
                                "UPDATE message_embeddings SET vector = ?1
                                 WHERE message_id = ?2 AND vector IS NULL",
                                params![blob, message_id],
                            )? as u64;
                        }
                        // Metadata without a vector: drop it, the backfill
                        // re-embeds the message.
                        _ => {
                            dropped += tx.execute(
                                "DELETE FROM message_embeddings WHERE message_id = ?1 AND vector IS NULL",
                                params![message_id],
                            )? as u64;
                        }
                    }
                }
                if let Some((last, _, _)) = batch.last() {
                    cursor = last.clone();
                }
                tx.commit()?;
                if batch.len() < LEGACY_BATCH {
                    break;
                }
            }
        }
        let mut conn = self.lock_sync();
        // Reseal values a retired key sealed (no-op once the item is finished).
        content_sqlite::migrate_columns(&mut conn, &self.cipher, &[vector_plan()?])?;
        content_sqlite::record_store_kcv(&conn, MESSAGE_INDEX_STORE, self.cipher.kcv())?;
        if legacy {
            // Never drop the plaintext before every row has a sealed copy that opens.
            let missing: i64 = conn.query_row(
                "SELECT COUNT(*) FROM message_embeddings WHERE vector IS NULL",
                [],
                |row| row.get(0),
            )?;
            if missing > 0 {
                anyhow::bail!("{missing} message vectors are not sealed yet");
            }
            content_sqlite::assert_all_open(&conn, &self.cipher, &[vector_plan()?])
                .context("verifying the sealed message vectors")?;
            conn.execute_batch("DROP TABLE message_vectors;")
                .context("dropping the legacy vec0 table")?;
            tracing::info!(
                sealed,
                dropped,
                "message index: legacy plaintext vectors sealed and the vec0 table dropped"
            );
        }
        // Scrub freed plaintext (the dropped vec0 pages, reseals) once.
        let owed = content_sqlite::read_store_record(&conn, MESSAGE_INDEX_STORE)?
            .is_some_and(|record| record.state == content_sqlite::states::VACUUM_PENDING);
        if owed && db_path != Path::new(":memory:") {
            content_sqlite::finish_store(&conn, db_path, MESSAGE_INDEX_STORE)?;
        }
        Ok(())
    }

    /// Lock the connection from synchronous code (the migration thread, or an
    /// open that may run inside an async test) without `blocking_lock`, which
    /// panics inside a runtime.
    fn lock_sync(&self) -> tokio::sync::MutexGuard<'_, Connection> {
        loop {
            if let Ok(guard) = self.conn.try_lock() {
                return guard;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    /// Snapshot the embedder (cheap `Arc` clone) so embedding I/O never holds a
    /// lock.
    pub fn embedder(&self) -> Arc<dyn SearchEmbedder> {
        self.embedder
            .read()
            .expect("message embedder lock poisoned")
            .clone()
    }

    /// Install a new embedder. A dimensionality change clears old vectors; a
    /// same-dimension model change leaves them tagged stale for re-embedding.
    pub async fn set_embedder(&self, embedder: Arc<dyn SearchEmbedder>) -> Result<()> {
        let dims = embedder.dims();
        let conn = self.conn.lock().await;
        Self::reconcile_dims(&conn, dims)?;
        self.dims.store(dims, Ordering::SeqCst);
        *self
            .embedder
            .write()
            .expect("message embedder lock poisoned") = embedder;
        // The in-memory partition holds the previous model's vectors.
        self.vectors.drop_partition(PARTITION);
        self.too_large.store(false, Ordering::Relaxed);
        Ok(())
    }

    /// Return message ids whose vectors were produced by another model or width.
    pub async fn stale_ids(&self, model: &str, dims: usize) -> Result<HashSet<String>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT message_id FROM message_embeddings
             WHERE embed_model != ?1 OR embed_dims != ?2",
        )?;
        let rows = stmt.query_map(params![model, dims as i64], |row| row.get(0))?;
        let mut ids = HashSet::new();
        for row in rows {
            ids.insert(row?);
        }
        Ok(ids)
    }

    /// Index a single message's embedding, sealed. Idempotent on `message_id`
    /// (re-indexing replaces the prior row). The `embedding` length must equal
    /// the active embedder's width.
    pub async fn index_message(
        &self,
        message_id: &str,
        conversation_id: &str,
        role: &str,
        embedding: &[f32],
        embed_model: &str,
        created_at: i64,
    ) -> Result<()> {
        if !self.writable.load(Ordering::Acquire) {
            return Err(content_sqlite::mismatch_error(MESSAGE_INDEX_STORE));
        }
        let dims = self.dims.load(Ordering::Relaxed);
        if embedding.len() != dims {
            anyhow::bail!(
                "embedding length {} does not match index width {dims}",
                embedding.len()
            );
        }
        let sealed = self.cipher.seal_bytes(
            &encode_embedding(embedding),
            &vector_context(message_id, embed_model),
        )?;
        let current_model = self.embedder().model_id().to_owned();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO message_embeddings
                 (message_id, conversation_id, role, embed_model, embed_dims, created_at, vector)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(message_id) DO UPDATE SET
                 conversation_id = excluded.conversation_id,
                 role            = excluded.role,
                 embed_model     = excluded.embed_model,
                 embed_dims      = excluded.embed_dims,
                 created_at      = excluded.created_at,
                 vector          = excluded.vector",
            params![
                message_id,
                conversation_id,
                role,
                embed_model,
                dims as i64,
                created_at,
                sealed
            ],
        )
        .context("inserting message_embeddings row")?;
        if embed_model == current_model {
            self.vectors.upsert(PARTITION, message_id, embedding);
        } else {
            self.vectors.remove(PARTITION, message_id);
        }
        Ok(())
    }

    /// Indexed primary-key lookup for reconciling append-time indexing without
    /// loading the complete set of indexed message IDs.
    pub async fn contains_message(&self, message_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM message_embeddings WHERE message_id = ?1)",
            [message_id],
            |row| row.get(0),
        )?)
    }

    /// The set of message ids already indexed (used to compute the backfill set).
    pub async fn indexed_ids(&self) -> Result<HashSet<String>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT message_id FROM message_embeddings")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut set = HashSet::new();
        for row in rows {
            set.insert(row?);
        }
        Ok(set)
    }

    /// Remove every vector of one conversation (called when it is deleted).
    /// Returns the number of messages removed.
    pub async fn delete_conversation(&self, conversation_id: &str) -> Result<usize> {
        let conn = self.conn.lock().await;
        let legacy = has_legacy_vec_table(&conn)?;
        let tx = conn.unchecked_transaction()?;
        let ids: Vec<String> = {
            let mut stmt =
                tx.prepare("SELECT message_id FROM message_embeddings WHERE conversation_id = ?1")?;
            let rows = stmt.query_map([conversation_id], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        if legacy {
            // The plaintext `vec0` row of a message the migration has not sealed
            // yet (or cannot, under a foreign key) goes with its metadata.
            purge_legacy_vectors(
                &tx,
                "SELECT rowid, embed_dims FROM message_embeddings WHERE conversation_id = ?1",
                conversation_id,
            )?;
        }
        tx.execute(
            "DELETE FROM message_embeddings WHERE conversation_id = ?1",
            [conversation_id],
        )
        .context("deleting a conversation's message vectors")?;
        tx.commit()?;
        if legacy && !ids.is_empty() {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        for id in &ids {
            self.vectors.remove(PARTITION, id);
        }
        Ok(ids.len())
    }

    /// Remove the vectors of these messages (orphans whose source message no
    /// longer exists). Returns the number removed.
    pub async fn delete_messages(&self, message_ids: &[String]) -> Result<usize> {
        if message_ids.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().await;
        let legacy = has_legacy_vec_table(&conn)?;
        let tx = conn.unchecked_transaction()?;
        let mut removed = 0;
        {
            let mut stmt =
                tx.prepare_cached("DELETE FROM message_embeddings WHERE message_id = ?1")?;
            for id in message_ids {
                if legacy {
                    purge_legacy_vectors(
                        &tx,
                        "SELECT rowid, embed_dims FROM message_embeddings WHERE message_id = ?1",
                        id,
                    )?;
                }
                removed += stmt.execute([id])?;
            }
        }
        tx.commit()?;
        if legacy && removed > 0 {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        for id in message_ids {
            self.vectors.remove(PARTITION, id);
        }
        Ok(removed)
    }

    /// Remove every semantic message vector and its metadata.
    ///
    /// The message bodies remain sealed in the conversation store. Clearing this
    /// derived index is the destructive half of turning chat remembering off;
    /// enabling it again can safely backfill from those retained messages.
    pub async fn clear(&self) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute("DELETE FROM message_embeddings", [])
            .context("clearing message vectors")?;
        if has_legacy_vec_table(&conn)? {
            conn.execute_batch("DROP TABLE message_vectors;")
                .context("dropping the legacy vec0 table")?;
        }
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        self.vectors.drop_partition(PARTITION);
        self.too_large.store(false, Ordering::Relaxed);
        Ok(())
    }

    /// How much of the index is searchable from memory right now (for the recall
    /// diagnostics and health).
    pub fn vector_coverage(&self) -> VectorCoverage {
        self.vectors.coverage()
    }

    /// Sealed vectors that did not open since this process started (skipped by
    /// search; the backfill re-embeds a message whose row is replaced).
    pub fn unreadable_rows(&self) -> u64 {
        self.unreadable.load(Ordering::Relaxed)
    }

    /// Semantic search. Embeds `query`, ranks the current model's vectors by
    /// cosine (incomparable models are never mixed), optionally scoped to a set
    /// of conversation ids. Returns hits ordered nearest-first.
    ///
    /// Everything after the embedding runs on a blocking thread (it may open
    /// every sealed vector of the partition), never on a runtime worker.
    pub async fn search(
        &self,
        query: &str,
        limit: usize,
        conversation_ids: Option<&[String]>,
    ) -> Result<Vec<MessageHit>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let embedder = self.embedder();
        let model = embedder.model_id().to_string();
        let dims = self.dims.load(Ordering::Relaxed);
        let query_vec = embedder.embed(query).await?;
        let scope: Option<Vec<String>> = conversation_ids
            .filter(|ids| !ids.is_empty())
            .map(<[String]>::to_vec);
        let conn = Arc::clone(&self.conn).lock_owned().await;
        let ctx = SearchContext {
            cipher: Arc::clone(&self.cipher),
            vectors: self.vectors.clone(),
            unreadable: Arc::clone(&self.unreadable),
            too_large: Arc::clone(&self.too_large),
            model,
            dims,
        };
        tokio::task::spawn_blocking(move || ctx.search(&conn, &query_vec, limit, scope.as_deref()))
            .await
            .context("message search task")?
    }
}

/// What a blocking message search needs, detached from the async index.
struct SearchContext {
    cipher: Arc<ContentCipher>,
    vectors: VectorIndex,
    unreadable: Arc<AtomicU64>,
    too_large: Arc<AtomicBool>,
    model: String,
    dims: usize,
}

impl SearchContext {
    /// Stream the current model's opened vectors through `consume`, reading a
    /// legacy plaintext `vec0` row for any message the background migration
    /// has not sealed yet. Rows that do not open are skipped (and counted when
    /// `count_unreadable`). Nothing is collected here: `consume` decides what
    /// to keep.
    fn with_vectors<R>(
        &self,
        conn: &Connection,
        count_unreadable: bool,
        consume: impl FnOnce(&mut dyn Iterator<Item = (String, Vec<f32>)>) -> R,
    ) -> Result<R> {
        let legacy = has_legacy_vec_table(conn)?;
        let sql = if legacy {
            "SELECT m.message_id, m.vector, v.embedding FROM message_embeddings m
             LEFT JOIN message_vectors v ON v.rowid = m.rowid
             WHERE m.embed_model = ?1 AND m.embed_dims = ?2"
        } else {
            "SELECT message_id, vector, NULL FROM message_embeddings
             WHERE embed_model = ?1 AND embed_dims = ?2"
        };
        let mut stmt = conn.prepare(sql)?;
        let mut rows = stmt.query(params![self.model, self.dims as i64])?;
        let mut failure: Option<rusqlite::Error> = None;
        let mut unreadable = 0u64;
        let result = {
            let mut opened = std::iter::from_fn(|| loop {
                let row = match rows.next() {
                    Ok(Some(row)) => row,
                    Ok(None) => return None,
                    Err(error) => {
                        failure = Some(error);
                        return None;
                    }
                };
                let read = (|| -> rusqlite::Result<(String, Option<Vec<u8>>)> {
                    let id: String = row.get(0)?;
                    let sealed: Option<Vec<u8>> = row.get(1)?;
                    let plain = match sealed {
                        Some(blob) => self
                            .cipher
                            .open_bytes(&blob, &vector_context(&id, &self.model))
                            .ok()
                            .map(|opened| opened.value),
                        None => row.get::<_, Option<Vec<u8>>>(2)?,
                    };
                    Ok((id, plain))
                })();
                let (id, plain) = match read {
                    Ok(read) => read,
                    Err(error) => {
                        failure = Some(error);
                        return None;
                    }
                };
                match plain.as_deref().and_then(decode_vector) {
                    Some(vector) if vector.len() == self.dims => return Some((id, vector)),
                    _ => unreadable += 1,
                }
            });
            consume(&mut opened)
        };
        if let Some(error) = failure {
            return Err(error.into());
        }
        if count_unreadable && unreadable > 0 {
            self.unreadable.fetch_add(unreadable, Ordering::Relaxed);
            tracing::warn!(
                unreadable,
                "message index: skipped vectors that did not open (message-embeddings.db.unreadable_rows)"
            );
        }
        Ok(result)
    }

    /// The message ids of the current model in these conversations, resolved
    /// in one query.
    fn scope_message_ids(
        &self,
        conn: &Connection,
        conversation_ids: &[String],
    ) -> Result<HashSet<String>> {
        let ids = serde_json::to_string(conversation_ids)?;
        let mut stmt = conn.prepare(
            "SELECT message_id FROM message_embeddings
             WHERE embed_model = ?1 AND embed_dims = ?2
               AND conversation_id IN (SELECT value FROM json_each(?3))",
        )?;
        let rows = stmt.query_map(params![self.model, self.dims as i64, ids], |row| {
            row.get::<_, String>(0)
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn search(
        &self,
        conn: &Connection,
        query: &[f32],
        limit: usize,
        conversation_ids: Option<&[String]>,
    ) -> Result<Vec<MessageHit>> {
        let scope = match conversation_ids {
            Some(ids) => {
                let scope = self.scope_message_ids(conn, ids)?;
                if scope.is_empty() {
                    return Ok(Vec::new());
                }
                Some(scope)
            }
            None => None,
        };
        let keep = |id: &str| scope.as_ref().map_or(true, |scope| scope.contains(id));
        let ranked = match self.vectors.search_filtered(PARTITION, query, limit, &keep) {
            Some(ranked) => ranked,
            None => self.rank_uncached(conn, query, limit, &keep)?,
        };
        self.hits(conn, ranked)
    }

    /// The partition is not in memory: hydrate it straight from the row
    /// stream, or, when it is larger than the whole cache, score the stream
    /// with a bounded top-`limit` (memory stays `O(limit)`).
    fn rank_uncached(
        &self,
        conn: &Connection,
        query: &[f32],
        limit: usize,
        keep: &dyn Fn(&str) -> bool,
    ) -> Result<Vec<(String, f32)>> {
        let mut counted = false;
        if !self.too_large.load(Ordering::Relaxed) {
            let hydrated = self.with_vectors(conn, true, |rows| {
                self.vectors.hydrate_partition(PARTITION, rows)
            })?;
            counted = true;
            match hydrated {
                Ok(()) => {
                    return Ok(self
                        .vectors
                        .search_filtered(PARTITION, query, limit, keep)
                        .unwrap_or_default())
                }
                Err(error) => {
                    // Remembered, so later queries stream instead of building
                    // a partition that cannot fit (cleared with the index).
                    self.too_large.store(true, Ordering::Relaxed);
                    tracing::warn!("message index: {error}; scoring without the cache");
                }
            }
        }
        self.with_vectors(conn, !counted, |rows| {
            let mut top = TopK::new(limit);
            for (id, vector) in rows {
                if !keep(&id) {
                    continue;
                }
                let score = cosine(&vector, query);
                if top.accepts(score) {
                    top.push(id, score);
                }
            }
            top.into_sorted()
        })
    }

    /// Hits for ranked ids, with their metadata fetched in one query.
    fn hits(&self, conn: &Connection, ranked: Vec<(String, f32)>) -> Result<Vec<MessageHit>> {
        if ranked.is_empty() {
            return Ok(Vec::new());
        }
        let ids =
            serde_json::to_string(&ranked.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>())?;
        let mut stmt = conn.prepare(
            "SELECT message_id, conversation_id, role, created_at FROM message_embeddings
             WHERE embed_model = ?1 AND message_id IN (SELECT value FROM json_each(?2))",
        )?;
        let mut meta: HashMap<String, (String, String, i64)> = stmt
            .query_map(params![self.model, ids], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ),
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(ranked
            .into_iter()
            .filter_map(|(message_id, score)| {
                let (conversation_id, role, created_at) = meta.remove(&message_id)?;
                Some(MessageHit {
                    message_id,
                    conversation_id,
                    role,
                    created_at,
                    distance: l2_from_cosine(score),
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;
    use crate::test_embedder::LocalHashingEmbedder;

    /// Default embed dims used by the crate's tests (mirrors Core's
    /// `registry::DEFAULT_EMBED_DIMS`).
    const TEST_DIMS: usize = 768;

    fn test_embedder() -> Arc<dyn SearchEmbedder> {
        Arc::new(LocalHashingEmbedder::new(TEST_DIMS))
    }

    fn cipher() -> ContentCipher {
        ContentCipher::from_root(&[9; 32], MESSAGE_INDEX_STORE)
    }

    fn memory_index() -> MessageIndex {
        MessageIndex::open_in_memory_with_cipher(test_embedder(), cipher()).expect("open index")
    }

    async fn add(index: &MessageIndex, id: &str, conv: &str, text: &str) -> Vec<f32> {
        let model = index.embedder().model_id().to_string();
        let emb = index.embedder().embed(text).await.expect("embed");
        index
            .index_message(id, conv, "user", &emb, &model, 0)
            .await
            .expect("index");
        emb
    }

    fn file_bytes(path: &Path) -> Vec<u8> {
        let mut bytes = std::fs::read(path).unwrap_or_default();
        let mut wal = path.as_os_str().to_owned();
        wal.push("-wal");
        bytes.extend(std::fs::read(PathBuf::from(wal)).unwrap_or_default());
        bytes
    }

    /// A dense vector, so its raw bytes are a distinctive probe (hashing
    /// embeddings are mostly zeros).
    fn dense(seed: f32) -> Vec<f32> {
        (0..TEST_DIMS)
            .map(|i| ((i as f32) * 0.37 + seed).sin())
            .collect()
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    /// Index a few messages with distinct tokens, then search for a query that
    /// shares tokens with one of them and assert it ranks first. Uses the local
    /// (network-free) hashing embedder, so no embed sidecar is required.
    #[tokio::test]
    async fn knn_round_trip_ranks_token_overlap_first() {
        let index = memory_index();
        add(
            &index,
            "m1",
            "c1",
            "the quick brown fox jumps over the lazy dog",
        )
        .await;
        add(
            &index,
            "m2",
            "c1",
            "rust borrow checker lifetimes and ownership",
        )
        .await;
        add(
            &index,
            "m3",
            "c2",
            "favourite pizza toppings pepperoni mushroom",
        )
        .await;

        let hits = index
            .search("rust ownership and lifetimes", 3, None)
            .await
            .expect("search");
        assert!(!hits.is_empty(), "expected at least one hit");
        assert_eq!(hits[0].message_id, "m2", "rust message should rank first");
        assert!(hits[0].distance < hits[hits.len() - 1].distance || hits.len() == 1);
        assert_eq!(index.vector_coverage().hydrated, 3);
    }

    /// Conversation-scoped search returns only hits from the requested conversation.
    #[tokio::test]
    async fn search_scopes_to_conversation_ids() {
        let index = memory_index();
        add(&index, "m1", "c1", "alpha beta gamma").await;
        add(&index, "m2", "c2", "alpha beta gamma").await;
        let hits = index
            .search("alpha beta", 5, Some(&["c2".to_owned()]))
            .await
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].conversation_id, "c2");
    }

    /// A partition too large for the cache is streamed and scored with a
    /// bounded top-k: same answers as the cached path, scoped or not, and an
    /// out-of-scope match never crowds out an in-scope one.
    #[tokio::test]
    async fn an_uncacheable_partition_is_scored_from_the_stream() {
        let index = memory_index();
        for i in 0..12 {
            add(&index, &format!("other{i}"), "c-big", "alpha beta gamma").await;
        }
        add(&index, "mine", "c-small", "alpha beta delta").await;
        add(&index, "unrelated", "c-small", "zeta eta theta").await;
        let cached = index.search("alpha beta", 3, None).await.unwrap();
        let cached_scoped = index
            .search("alpha beta", 1, Some(&["c-small".to_owned()]))
            .await
            .unwrap();
        assert_eq!(cached_scoped[0].message_id, "mine");

        index.vectors.drop_partition(PARTITION);
        index.too_large.store(true, Ordering::Relaxed);
        let streamed = index.search("alpha beta", 3, None).await.unwrap();
        assert_eq!(
            streamed
                .iter()
                .map(|hit| &hit.message_id)
                .collect::<Vec<_>>(),
            cached.iter().map(|hit| &hit.message_id).collect::<Vec<_>>()
        );
        assert!(
            !index.vectors.is_hydrated(PARTITION),
            "nothing is kept in memory"
        );
        let scoped = index
            .search("alpha beta", 1, Some(&["c-small".to_owned()]))
            .await
            .unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].message_id, "mine");
        assert_eq!(scoped[0].conversation_id, "c-small");
        // A scope with no indexed message answers nothing without ranking.
        assert!(index
            .search("alpha beta", 5, Some(&["c-none".to_owned()]))
            .await
            .unwrap()
            .is_empty());
        // Clearing the index forgets the oversize flag.
        index.clear().await.unwrap();
        assert!(!index.too_large.load(Ordering::Relaxed));
    }

    /// A dims change clears the stored vectors, leaving an empty index to
    /// re-backfill, and new-width vectors are accepted.
    #[tokio::test]
    async fn a_dims_change_clears_the_index() {
        let index = memory_index();
        add(&index, "m1", "c1", "hello").await;
        index
            .set_embedder(Arc::new(LocalHashingEmbedder::new(TEST_DIMS / 2)))
            .await
            .expect("swap");
        assert!(index.indexed_ids().await.unwrap().is_empty());
        let emb = index.embedder().embed("hello").await.unwrap();
        assert_eq!(emb.len(), TEST_DIMS / 2);
        index
            .index_message("m2", "c1", "user", &emb, "local-hashing", 0)
            .await
            .expect("insert at new width");
        assert_eq!(
            index.search("hello", 5, None).await.unwrap()[0].message_id,
            "m2"
        );
    }

    /// Re-indexing the same message id replaces (not duplicates) its vector row.
    #[tokio::test]
    async fn reindex_is_idempotent() {
        let index = memory_index();
        add(&index, "m1", "c1", "hello world").await;
        add(&index, "m1", "c1", "hello world").await;
        assert_eq!(index.indexed_ids().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn clear_and_deletes_remove_vectors() {
        let index = memory_index();
        add(&index, "m1", "c1", "remember this").await;
        add(&index, "m2", "c1", "remember that").await;
        add(&index, "m3", "c2", "remember those").await;
        // Hydrate, then delete: memory and disk agree.
        assert_eq!(index.search("remember", 5, None).await.unwrap().len(), 3);
        assert_eq!(index.delete_conversation("c1").await.unwrap(), 2);
        let hits = index.search("remember", 5, None).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, "m3");
        assert_eq!(index.delete_messages(&["m3".to_owned()]).await.unwrap(), 1);
        assert!(index.search("remember", 5, None).await.unwrap().is_empty());
        add(&index, "m4", "c3", "remember again").await;
        index.clear().await.expect("clear");
        assert!(index.indexed_ids().await.expect("ids").is_empty());
        assert!(index.search("remember", 5, None).await.unwrap().is_empty());
    }

    /// Vectors are sealed on disk (bound to message id and model): the raw f32
    /// bytes are absent from the file and its WAL, and a vector copied to
    /// another row does not open (it is skipped and counted).
    #[tokio::test]
    async fn vectors_are_sealed_on_disk_and_bound_to_their_row() {
        let dir = TestDir::new();
        let path = dir.path().join("message-embeddings.db");
        let index =
            MessageIndex::open_with_cipher(path.clone(), test_embedder(), cipher()).unwrap();
        add(&index, "m1", "c1", "sealed vector words").await;
        add(&index, "m2", "c1", "another message").await;
        index
            .index_message("m9", "c9", "user", &dense(1.0), "other-model", 0)
            .await
            .unwrap();
        let raw = encode_embedding(&dense(1.0));
        assert!(!contains(&file_bytes(&path), &raw[..32]));
        {
            let conn = index.conn.lock().await;
            let blob: Vec<u8> = conn
                .query_row(
                    "SELECT vector FROM message_embeddings WHERE message_id = 'm1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(ContentCipher::is_sealed_bytes(&blob));
            conn.execute(
                "UPDATE message_embeddings SET vector = ?1 WHERE message_id = 'm2'",
                params![blob],
            )
            .unwrap();
        }
        drop(index);
        let index = MessageIndex::open_with_cipher(path, test_embedder(), cipher()).unwrap();
        let hits = index.search("another message", 5, None).await.unwrap();
        assert_eq!(hits.len(), 1, "the swapped vector must not open");
        assert_eq!(hits[0].message_id, "m1");
        assert_eq!(index.unreadable_rows(), 1);
    }

    /// A legacy index (plaintext vectors in a `vec0` table) is sealed on open:
    /// the vectors move into the sealed column, the `vec0` table is dropped and
    /// the freed pages scrubbed, search still works, and a second open is a no-op.
    #[tokio::test]
    async fn legacy_vec0_vectors_are_sealed_and_the_plaintext_dropped() {
        let dir = TestDir::new();
        let path = dir.path().join("message-embeddings.db");
        let embedder = test_embedder();
        let emb = embedder.embed("legacy pizza message").await.unwrap();
        let other = embedder.embed("legacy rust message").await.unwrap();
        {
            let conn = open_vec_connection(&path).unwrap();
            conn.execute_batch(&format!(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE message_embeddings (message_id TEXT PRIMARY KEY,
                     conversation_id TEXT NOT NULL, role TEXT NOT NULL, embed_model TEXT NOT NULL,
                     embed_dims INTEGER NOT NULL, created_at INTEGER NOT NULL);
                 CREATE VIRTUAL TABLE message_vectors
                     USING vec0(rowid INTEGER PRIMARY KEY, embedding float[{TEST_DIMS}]);"
            ))
            .unwrap();
            for (id, vector) in [("m1", &emb), ("m2", &other)] {
                conn.execute(
                    "INSERT INTO message_embeddings VALUES (?1, 'c1', 'user', 'local-hashing', ?2, 0)",
                    params![id, TEST_DIMS as i64],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO message_vectors (rowid, embedding) VALUES (?1, ?2)",
                    params![conn.last_insert_rowid(), encode_embedding(vector)],
                )
                .unwrap();
            }
            conn.execute(
                "INSERT INTO message_embeddings VALUES ('m9', 'c9', 'user', 'other-model', ?1, 0)",
                params![TEST_DIMS as i64],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO message_vectors (rowid, embedding) VALUES (?1, ?2)",
                params![conn.last_insert_rowid(), encode_embedding(&dense(2.0))],
            )
            .unwrap();
            // Metadata whose vector is missing is dropped (re-embedded later).
            conn.execute(
                "INSERT INTO message_embeddings VALUES ('m3', 'c1', 'user', 'local-hashing', ?1, 0)",
                params![TEST_DIMS as i64],
            )
            .unwrap();
        }
        let probe = encode_embedding(&dense(2.0))[..32].to_vec();
        assert!(contains(&file_bytes(&path), &probe));

        let index =
            MessageIndex::open_with_cipher(path.clone(), embedder.clone(), cipher()).unwrap();
        {
            let conn = index.conn.lock().await;
            assert!(!has_legacy_vec_table(&conn).unwrap());
            content_sqlite::assert_all_open(&conn, &cipher(), &[vector_plan().unwrap()]).unwrap();
        }
        assert_eq!(index.indexed_ids().await.unwrap().len(), 3);
        assert_eq!(
            index.search("pizza message", 1, None).await.unwrap()[0].message_id,
            "m1"
        );
        drop(index);
        assert!(!contains(&file_bytes(&path), &probe));
        // A second open finds nothing to do and changes nothing.
        let index = MessageIndex::open_with_cipher(path, embedder, cipher()).unwrap();
        assert_eq!(index.indexed_ids().await.unwrap().len(), 3);
        assert_eq!(index.unreadable_rows(), 0);
    }

    /// A legacy store whose record names a key this process does not hold is
    /// left alone: no plaintext vector is sealed under the wrong key, and the
    /// `vec0` table is kept for when the real key returns.
    #[tokio::test]
    async fn legacy_vectors_are_not_sealed_under_a_foreign_key() {
        let dir = TestDir::new();
        let path = dir.path().join("message-embeddings.db");
        let emb = test_embedder().embed("legacy pizza message").await.unwrap();
        let foreign = ContentCipher::from_root(&[1; 32], MESSAGE_INDEX_STORE);
        {
            let conn = open_vec_connection(&path).unwrap();
            conn.execute_batch(&format!(
                "CREATE TABLE message_embeddings (message_id TEXT PRIMARY KEY,
                     conversation_id TEXT NOT NULL, role TEXT NOT NULL, embed_model TEXT NOT NULL,
                     embed_dims INTEGER NOT NULL, created_at INTEGER NOT NULL);
                 CREATE VIRTUAL TABLE message_vectors
                     USING vec0(rowid INTEGER PRIMARY KEY, embedding float[{TEST_DIMS}]);"
            ))
            .unwrap();
            conn.execute(
                "INSERT INTO message_embeddings VALUES ('m1', 'c1', 'user', 'local-hashing', ?1, 0)",
                params![TEST_DIMS as i64],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO message_vectors (rowid, embedding) VALUES (?1, ?2)",
                params![conn.last_insert_rowid(), encode_embedding(&emb)],
            )
            .unwrap();
            content_sqlite::record_store_kcv(&conn, MESSAGE_INDEX_STORE, foreign.kcv()).unwrap();
        }
        assert!(MessageIndex::open_with_cipher(path.clone(), test_embedder(), cipher()).is_err());
        let conn = open_vec_connection(&path).unwrap();
        assert!(has_legacy_vec_table(&conn).unwrap());
        let sealed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM message_embeddings WHERE vector IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sealed, 0, "nothing may be sealed under an unrecorded key");
    }

    /// While a legacy `vec0` table is kept (the store names a key this process
    /// does not hold), deleting a conversation or an orphaned message removes
    /// its plaintext vector too: the row is gone and its bytes are absent from
    /// the file and the WAL.
    #[tokio::test]
    async fn deletes_remove_legacy_plaintext_vectors_kept_under_a_foreign_key() {
        let dir = TestDir::new();
        let path = dir.path().join("message-embeddings.db");
        let foreign = ContentCipher::from_root(&[1; 32], MESSAGE_INDEX_STORE);
        let vectors = [
            ("m1", "c1", dense(3.0)),
            ("m2", "c1", dense(4.0)),
            ("m3", "c2", dense(5.0)),
            ("m4", "c2", dense(6.0)),
        ];
        {
            let conn = open_vec_connection(&path).unwrap();
            conn.execute_batch(&format!(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE message_embeddings (message_id TEXT PRIMARY KEY,
                     conversation_id TEXT NOT NULL, role TEXT NOT NULL, embed_model TEXT NOT NULL,
                     embed_dims INTEGER NOT NULL, created_at INTEGER NOT NULL);
                 CREATE VIRTUAL TABLE message_vectors
                     USING vec0(rowid INTEGER PRIMARY KEY, embedding float[{TEST_DIMS}]);"
            ))
            .unwrap();
            for (id, conversation, vector) in &vectors {
                conn.execute(
                    "INSERT INTO message_embeddings VALUES (?1, ?2, 'user', 'local-hashing', ?3, 0)",
                    params![id, conversation, TEST_DIMS as i64],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO message_vectors (rowid, embedding) VALUES (?1, ?2)",
                    params![conn.last_insert_rowid(), encode_embedding(vector)],
                )
                .unwrap();
            }
            content_sqlite::record_store_kcv(&conn, MESSAGE_INDEX_STORE, foreign.kcv()).unwrap();
        }
        let probe = |vector: &[f32]| encode_embedding(vector)[..32].to_vec();
        for (_, _, vector) in &vectors {
            assert!(contains(&file_bytes(&path), &probe(vector)));
        }
        // The migration refuses to run under an unrecorded key, so vec0 stays.
        let index =
            MessageIndex::open_with_cipher_no_migration(path.clone(), test_embedder(), cipher())
                .unwrap();
        assert!(index.migrate_blocking(&path).is_err());
        assert_eq!(index.delete_conversation("c1").await.unwrap(), 2);
        assert_eq!(index.delete_messages(&["m3".to_owned()]).await.unwrap(), 1);
        {
            let conn = index.conn.lock().await;
            assert!(has_legacy_vec_table(&conn).unwrap());
            let left: Vec<i64> = conn
                .prepare("SELECT rowid FROM message_vectors")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            let m4: i64 = conn
                .query_row(
                    "SELECT rowid FROM message_embeddings WHERE message_id = 'm4'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(left, vec![m4], "only the kept message's vec0 row remains");
        }
        let bytes = file_bytes(&path);
        for (id, _, vector) in &vectors {
            assert_eq!(
                contains(&bytes, &probe(vector)),
                *id == "m4",
                "plaintext vector of {id}"
            );
        }
    }

    /// A store sealed under another key refuses writes (it is never re-sealed).
    #[tokio::test]
    async fn a_foreign_key_refuses_writes() {
        let dir = TestDir::new();
        let path = dir.path().join("message-embeddings.db");
        let index =
            MessageIndex::open_with_cipher(path.clone(), test_embedder(), cipher()).unwrap();
        add(&index, "m1", "c1", "first").await;
        drop(index);
        let foreign = ContentCipher::from_root(&[1; 32], MESSAGE_INDEX_STORE);
        let index =
            MessageIndex::open_with_cipher_no_migration(path, test_embedder(), foreign).unwrap();
        let emb = index.embedder().embed("second").await.unwrap();
        assert!(index
            .index_message("m2", "c1", "user", &emb, "local-hashing", 0)
            .await
            .is_err());
    }
}
