//! The sqlite-backed [`RetrievalStore`]: struct, keys, partitions and the
//! stale-reindex control types. The `impl` is split by concern across the
//! submodules.

use super::*;

mod index;
mod legacy;
mod okf;
mod okf_rows;
mod open;
mod reindex;
mod remove;
mod retrieve;
mod scorer;
mod state;

pub use okf_rows::*;
#[cfg(test)]
pub(crate) use reindex::update_stale_embedding_if_unchanged;
pub(crate) use scorer::*;

/// SQLite-backed index of retrievable chunks (memory + Spaces) and their
/// embeddings. Cheap to clone (wraps an `Arc<Mutex<Connection>>`).
///
/// **Sealed at rest** (`retrieval.db` content key): `chunks.content` and the
/// OKF `concept_path`/`tags`/`resource`/`links` are `encb:v1:`, each vector is
/// `RYU-CB01` bound to its chunk id and embedding model. OKF chunk ids carry a
/// blind token of the concept path (`concept_path_bi`), never the path. Vectors
/// are scored in the shared in-memory [`VectorIndex`] (one partition per memory
/// or Space/bundle collection). Ids, sources, owners, scopes and timestamps stay
/// plaintext so tenancy filters run in SQL.
#[derive(Clone)]
pub struct RetrievalStore {
    pub(crate) conn: Arc<Mutex<Connection>>,
    pub(crate) embedder: Arc<RwLock<Embedder>>,
    pub(crate) reranker: Reranker,
    /// Configured default reranker model id — the fallback reported for the local
    /// reranker (which has no model of its own). Resolved Core-side and passed in.
    pub(crate) reranker_model_id: String,
    /// Optional delegate to the Spaces store for `opts.space_ids` (see
    /// [`SpaceRecall`]). `None` — the default and every test construction — leaves
    /// [`Self::retrieve`] byte-identical to the pure-`retrieval.db` behaviour.
    /// Wired ONCE, Core-side, in `rag_host::open_retrieval_store`'s caller
    /// (`apps/core/src/main.rs`), so every consumer of the process store gets it.
    pub(crate) spaces: Option<Arc<dyn SpaceRecall>>,
    /// The content key and blind index this store seals with.
    pub(crate) keys: Arc<RetrievalKeys>,
    /// Opened vectors of the current embedder, one partition per collection
    /// (memory, or one Space/OKF bundle), under the process-wide cache budget.
    pub(crate) vectors: VectorIndex,
    /// Partitions this store may have hydrated, so deletes and embedder swaps
    /// can drop them.
    pub(crate) partitions: Arc<StdMutex<HashSet<PartitionKey>>>,
    /// Partitions larger than the whole vector cache: scored from the row
    /// stream instead of being rebuilt in memory on every query.
    pub(crate) too_large: Arc<StdMutex<HashSet<PartitionKey>>>,
    /// False when the store was sealed under a key this process does not hold:
    /// writes are refused (never re-sealed or reset).
    pub(crate) writable: Arc<AtomicBool>,
    /// Rows skipped because a sealed value did not open (`retrieval.db.unreadable_rows`).
    pub(crate) unreadable: Arc<AtomicU64>,
}

// ── At-rest sealing ───────────────────────────────────────────────────────────

/// Store name of the retrieval index (its content and blind keys derive from it).
pub const RETRIEVAL_STORE: &str = "retrieval.db";
/// Blind-index field of OKF concept paths.
pub(crate) const CONCEPT_PATH_FIELD: &str = "okf.concept_path";

/// The keys one retrieval store seals with: the `retrieval.db` content cipher
/// (`encb:v1:` text, `RYU-CB01` vectors) and the blind index of OKF concept
/// paths.
#[derive(Clone, Debug)]
pub struct RetrievalKeys {
    pub(crate) cipher: ContentCipher,
    concept_path: BlindIndex,
}

impl RetrievalKeys {
    /// The keys of a process that holds the master key (Core). Fails closed.
    pub fn resolve() -> Result<Self> {
        Ok(Self {
            cipher: ryu_crypto::content_cipher(RETRIEVAL_STORE)
                .context("resolving the retrieval content key")?,
            concept_path: ryu_crypto::blind_index(RETRIEVAL_STORE, CONCEPT_PATH_FIELD)
                .context("resolving the retrieval blind index")?,
        })
    }

    /// The keys under an explicit root (tests).
    pub fn from_root(root: &[u8; 32]) -> Self {
        Self {
            cipher: ContentCipher::from_root(root, RETRIEVAL_STORE),
            concept_path: BlindIndex::from_root(root, RETRIEVAL_STORE, CONCEPT_PATH_FIELD),
        }
    }

    /// The bare hex blind token of a concept path (exact, case-sensitive: paths
    /// are file paths).
    pub(crate) fn concept_token(&self, concept_path: &str) -> String {
        self.concept_path
            .token(concept_path)
            .trim_start_matches(ryu_crypto::blind_index::BLIND_TOKEN_PREFIX)
            .to_owned()
    }
}

pub(crate) fn content_context(id: &str) -> ContentContext {
    ContentContext::for_id("chunks.content", id)
}

pub(crate) fn embedding_context(id: &str, model: &str) -> ContentContext {
    ContentContext::new("chunks.embedding")
        .with("id", id)
        .with("model", model)
}

/// Context of the sealed caller/OKF filter metadata of `chunks.metadata`.
pub(crate) fn metadata_context(id: &str) -> ContentContext {
    ContentContext::for_id("chunks.metadata", id)
}

pub(crate) fn okf_context(column: &str, chunk_id: &str) -> ContentContext {
    ContentContext::for_id(format!("okf_chunks.{column}"), chunk_id)
}

/// The id of an OKF chunk: the bundle, the concept path's blind token (never
/// the path itself) and the chunk index.
pub(crate) fn okf_chunk_id(bundle_id: &str, concept_token: &str, index: usize) -> String {
    format!("okf:{bundle_id}:{concept_token}#{index}")
}

/// The sealed columns, for the background migration and `assert_all_open`.
pub(crate) fn seal_plans() -> Result<Vec<ColumnPlan>> {
    let mut plans = vec![
        ColumnPlan::text("chunks", "content", "id", KeyKind::Text)?,
        ColumnPlan::blob("chunks", "embedding", "id", KeyKind::Text)?
            .with_context(&["embedding_model"], |row| {
                embedding_context(&row.key(), &row.text("embedding_model"))
            })?,
    ];
    plans.push(ColumnPlan::text("chunks", "metadata", "id", KeyKind::Text)?);
    for column in ["concept_path", "tags", "resource", "links", "concept_body"] {
        plans.push(ColumnPlan::text(
            "okf_chunks",
            column,
            "chunk_id",
            KeyKind::Text,
        )?);
    }
    Ok(plans)
}

/// One vector partition: the embedder model, the chunk source and its Space
/// (OKF bundle) id.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct PartitionKey {
    model: String,
    source: String,
    space_id: Option<String>,
}

impl PartitionKey {
    pub(crate) fn new(model: &str, source: &str, space_id: Option<&str>) -> Self {
        Self {
            model: model.to_owned(),
            source: source.to_owned(),
            space_id: space_id.map(str::to_owned),
        }
    }

    pub(crate) fn name(&self) -> String {
        format!(
            "{}\u{1f}{}\u{1f}{}",
            self.model,
            self.source,
            self.space_id.as_deref().unwrap_or("")
        )
    }
}

/// Terminal or in-flight state for a stale-embedding reindex.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StaleEmbeddingReindexProgress {
    /// `running`, `completed`, `cancelled`, or `failed`.
    pub state: String,
    /// Number of stale rows found when the pass started.
    pub total: usize,
    /// Number of rows whose batch was committed.
    pub processed: usize,
    /// Number of rows actually updated by committed batches.
    pub updated: usize,
    /// A human-readable error when `state` is `failed`.
    pub error: Option<String>,
}

impl Default for StaleEmbeddingReindexProgress {
    fn default() -> Self {
        Self {
            state: "idle".to_owned(),
            total: 0,
            processed: 0,
            updated: 0,
            error: None,
        }
    }
}

/// Cooperative cancellation and progress state for a stale-embedding reindex.
///
/// Cancellation is observed between embedding requests and before each batch is
/// committed. A request already in flight cannot be interrupted by this crate's
/// embedder abstraction, so callers should treat cancellation as cooperative at
/// batch boundaries. Cloning this handle is cheap and lets a status endpoint poll
/// [`Self::progress`] while another task runs the reindex.
#[derive(Clone, Default)]
pub struct StaleEmbeddingReindexControl {
    cancelled: Arc<AtomicBool>,
    progress: Arc<StdMutex<StaleEmbeddingReindexProgress>>,
}

impl StaleEmbeddingReindexControl {
    /// Create a fresh control handle in the `idle` state.
    pub fn new() -> Self {
        Self::default()
    }

    /// Request cooperative cancellation. The worker observes this at its next
    /// safe boundary and leaves the current batch uncommitted.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// Return whether cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Snapshot the latest progress without exposing internal synchronization.
    pub fn progress(&self) -> StaleEmbeddingReindexProgress {
        self.progress
            .lock()
            .expect("stale embedding progress mutex poisoned")
            .clone()
    }
}

/// Result of a cooperatively cancellable stale-embedding reindex.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StaleEmbeddingReindexOutcome {
    /// Number of rows updated by committed batches.
    pub updated: usize,
    /// Whether the pass stopped because its control handle was cancelled.
    pub cancelled: bool,
}
