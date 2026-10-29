//! In-memory constructors, embedder/vector state and the schema.

use super::*;

impl RetrievalStore {
    /// Open an in-memory store with the local embedder at the given dims and the
    /// local (term-overlap) reranker. Used by consumer tests; the caller supplies
    /// the default dims + reranker id from the model registry.
    pub fn open_in_memory(embed_dims: usize, reranker_model_id: String) -> Result<Self> {
        Self::open_in_memory_with_keys(
            Embedder::Local { dims: embed_dims },
            reranker_model_id,
            RetrievalKeys::resolve()?,
        )
    }

    /// An in-memory store with a chosen embedder and explicit keys (tests).
    pub fn open_in_memory_with_keys(
        embedder: Embedder,
        reranker_model_id: String,
        keys: RetrievalKeys,
    ) -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory retrieval db")?;
        content_sqlite::enable_secure_delete(&conn)?;
        Self::init_schema(&conn)?;
        let writable = Self::check_keys(&conn, &keys)?;
        Ok(Self::assemble(
            conn,
            embedder,
            Reranker::Local,
            reranker_model_id,
            keys,
            writable,
        ))
    }

    /// Open an in-memory store with a chosen embedder (used by tests that swap
    /// embedding models without environment mutation).
    pub fn open_in_memory_with_embedder(
        embedder: Embedder,
        reranker_model_id: String,
    ) -> Result<Self> {
        Self::open_in_memory_with_keys(embedder, reranker_model_id, RetrievalKeys::resolve()?)
    }

    /// The model id this store uses for embedding.
    pub fn embedder_model_id(&self) -> String {
        self.embedder_snapshot().model_id().to_owned()
    }

    /// Swap the live retrieval embedder. Reindexing is intentionally separate:
    /// callers install the provider and then run the guarded stale-row pass.
    pub fn set_embedder(&self, embedder: Embedder) {
        *self
            .embedder
            .write()
            .expect("retrieval embedder lock poisoned") = embedder;
        // Partitions hold the previous model's vectors.
        self.drop_partitions(|_| true);
    }

    /// How much of this store's vector index is searchable from memory right
    /// now (for the recall diagnostics and health).
    pub fn vector_coverage(&self) -> VectorCoverage {
        self.vectors.coverage()
    }

    /// Rows skipped because a sealed value did not open, since this process
    /// started (`retrieval.db.unreadable_rows`).
    pub fn unreadable_rows(&self) -> u64 {
        self.unreadable.load(Ordering::Relaxed)
    }

    pub(crate) fn note_unreadable(&self, count: u64, what: &str) {
        note_unreadable(&self.unreadable, count, what);
    }

    pub(crate) fn ensure_writable(&self) -> Result<()> {
        if self.writable.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(content_sqlite::mismatch_error(RETRIEVAL_STORE))
        }
    }

    /// Drop every known partition matching `pred` (they rehydrate on next use).
    pub(crate) fn drop_partitions(&self, pred: impl Fn(&PartitionKey) -> bool) {
        self.too_large
            .lock()
            .expect("partition registry poisoned")
            .retain(|key| !pred(key));
        let mut known = self.partitions.lock().expect("partition registry poisoned");
        known.retain(|key| {
            if pred(key) {
                self.vectors.drop_partition(&key.name());
                false
            } else {
                true
            }
        });
    }

    /// After a chunk's vector was written: move it out of its previous partition
    /// and into the current one (a no-op for partitions not in memory).
    pub(crate) fn place_vector(
        &self,
        previous: Option<PartitionKey>,
        current: &PartitionKey,
        id: &str,
        vector: &[f32],
    ) {
        if let Some(previous) = previous.filter(|previous| previous != current) {
            self.vectors.remove(&previous.name(), id);
        }
        if current.model == self.embedder_snapshot().model_id() {
            self.vectors.upsert(&current.name(), id, vector);
        }
    }

    pub(crate) fn partition_of(conn: &Connection, id: &str) -> Result<Option<PartitionKey>> {
        Ok(conn
            .query_row(
                "SELECT embedding_model, source, space_id FROM chunks WHERE id = ?1",
                params![id],
                |row| {
                    Ok(PartitionKey {
                        model: row.get(0)?,
                        source: row.get(1)?,
                        space_id: row.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    pub(crate) fn embedder_snapshot(&self) -> Embedder {
        self.embedder
            .read()
            .expect("retrieval embedder lock poisoned")
            .clone()
    }

    /// The reranker model id from the registry.
    pub fn reranker_model_id(&self) -> &str {
        self.reranker.model_id(&self.reranker_model_id)
    }

    pub(crate) fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS chunks (
                 id              TEXT PRIMARY KEY,
                 source          TEXT NOT NULL,
                 space_id        TEXT,
                 content         TEXT NOT NULL,
                 embedding       BLOB NOT NULL,
                 embedding_model TEXT NOT NULL DEFAULT '',
                 created_at      INTEGER NOT NULL,
                 -- Memory-scope metadata (NULL for Space/OKF chunks). Denormalized
                 -- from `memory_entries` so the level/project filter runs in-query.
                 mem_scope       TEXT,
                 mem_scope_id    TEXT,
                 mem_agent_id    TEXT,
                 mem_category    TEXT,
                 mem_importance  INTEGER NOT NULL DEFAULT 3,
                 mem_sensitive   INTEGER NOT NULL DEFAULT 0,
                 mem_metadata_ready INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
             CREATE INDEX IF NOT EXISTS idx_chunks_space  ON chunks(space_id);

             -- Filterable metadata sidecar for OKF (Open Knowledge Format) chunks.
             -- One row per indexed chunk; `chunk_id` joins back to `chunks.id`.
             -- `tags` and `links` are JSON arrays so cross-links survive as
             -- progressive-disclosure edges without a separate edge table.
             CREATE TABLE IF NOT EXISTS okf_chunks (
                 chunk_id     TEXT PRIMARY KEY,
                 bundle_id    TEXT NOT NULL,
                 concept_path TEXT NOT NULL,
                 okf_type     TEXT NOT NULL,
                 tags         TEXT NOT NULL DEFAULT '[]',
                 resource     TEXT,
                 links        TEXT NOT NULL DEFAULT '[]',
                 chunk_index  INTEGER NOT NULL,
                 -- Blind token of the (sealed) concept path, for per-concept deletes.
                 concept_path_bi TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_okf_bundle  ON okf_chunks(bundle_id);
             CREATE INDEX IF NOT EXISTS idx_okf_type    ON okf_chunks(okf_type);",
        )
        .context("initializing retrieval schema")?;
        // Verbatim concept body for bundles ingested with a non-default chunking
        // strategy (see `OkfRow::concept_body`). Duplicate-column errors ignored.
        let _ = conn.execute("ALTER TABLE okf_chunks ADD COLUMN concept_body TEXT", []);

        // Migration for DBs created before the `embedding_model` column existed.
        // Vectors are only comparable within the same embedder (a hashing vector
        // and a nomic vector of equal length are different spaces — comparing them
        // yields garbage). Tagging each row with its model lets search filter to
        // the current embedder. Pre-migration rows default to '' and are skipped
        // at search until re-indexed. Ignore the "duplicate column" error when the
        // column already exists (fresh DBs get it from CREATE above).
        let _ = conn.execute(
            "ALTER TABLE chunks ADD COLUMN embedding_model TEXT NOT NULL DEFAULT ''",
            [],
        );

        // Migration for DBs created before the memory-scope columns existed.
        // Duplicate-column errors on fresh DBs (CREATE above) are ignored.
        let _ = conn.execute("ALTER TABLE chunks ADD COLUMN mem_scope TEXT", []);
        let _ = conn.execute("ALTER TABLE chunks ADD COLUMN mem_scope_id TEXT", []);
        let _ = conn.execute("ALTER TABLE chunks ADD COLUMN mem_agent_id TEXT", []);
        let _ = conn.execute("ALTER TABLE chunks ADD COLUMN mem_category TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE chunks ADD COLUMN mem_importance INTEGER NOT NULL DEFAULT 3",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE chunks ADD COLUMN mem_sensitive INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE chunks ADD COLUMN mem_metadata_ready INTEGER NOT NULL DEFAULT 0",
            [],
        );

        // Denormalized owner (per-resource tenancy). Mirrors how `mem_scope` is
        // denormalized off `memory_entries`: it lets the per-caller filter run
        // in-query without a cross-store join. NULL for OKF / legacy chunks.
        // Duplicate-column errors on fresh DBs are ignored.
        let _ = conn.execute("ALTER TABLE chunks ADD COLUMN owner_user_id TEXT", []);
        let _ = conn.execute("ALTER TABLE chunks ADD COLUMN owner_org_id TEXT", []);
        let _ = conn.execute("ALTER TABLE chunks ADD COLUMN visibility TEXT", []);
        // Caller-supplied JSON metadata object for `RetrievalOptions::filter`.
        // NULL for chunks indexed without metadata.
        let _ = conn.execute("ALTER TABLE chunks ADD COLUMN metadata TEXT", []);

        // Concept paths are sealed: the per-concept index moves to their blind
        // token. Duplicate-column errors on fresh DBs are ignored.
        let _ = conn.execute("ALTER TABLE okf_chunks ADD COLUMN concept_path_bi TEXT", []);
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_okf_concept;
             CREATE INDEX IF NOT EXISTS idx_okf_concept_bi ON okf_chunks(bundle_id, concept_path_bi);",
        )
        .context("indexing okf_chunks.concept_path_bi")?;

        // Built after the ALTERs above so it works on DBs created before the
        // mem_scope columns existed — on those, `CREATE TABLE IF NOT EXISTS`
        // no-ops and the columns only appear via the migrations, so indexing
        // them inside the initial batch would fail with "no such column".
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_chunks_mem_scope ON chunks(mem_scope, mem_scope_id, mem_agent_id, mem_sensitive);",
        )
        .context("indexing chunks.mem_scope")?;
        Ok(())
    }
}
