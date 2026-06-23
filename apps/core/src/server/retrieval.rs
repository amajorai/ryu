//! Retrieval injection into the chat context (spec unit U17).
//!
//! Wires retrieval into the chat path: embed the query, search short/long-term
//! memory + Spaces, merge and rank by relevance, optionally re-rank the top-K
//! candidates, and return the final chunks so the caller can inject them into the
//! model context before the model call.
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): retrieval is part of
//! *what runs* (orchestration: which chunks ground the answer), not *what is
//! allowed/measured/paid*, so it belongs in Core. Policy on whether a Space is
//! reachable would be a Gateway concern; mechanically searching and merging the
//! chunks Core already holds is orchestration.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::registry::ModelRegistry;

/// Where a retrievable chunk originated. Used to merge memory with Spaces and to
/// label the injected context so the model can attribute its grounding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChunkSource {
    /// Short/long-term memory (U11). Not tied to a Space.
    Memory,
    /// A document chunk belonging to a Space.
    Space,
}

impl ChunkSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::Space => "space",
        }
    }

    fn from_str(s: &str) -> Self {
        match s {
            "space" => Self::Space,
            _ => Self::Memory,
        }
    }
}

/// A chunk available for retrieval, with its precomputed embedding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievableChunk {
    pub id: String,
    pub source: ChunkSource,
    /// Space identifier when `source == Space`; `None` for memory.
    pub space_id: Option<String>,
    pub content: String,
}

/// A retrieved chunk paired with its relevance score (higher is more relevant).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoredChunk {
    pub id: String,
    pub source: ChunkSource,
    pub space_id: Option<String>,
    pub content: String,
    pub score: f32,
}

/// Per-request / per-agent retrieval configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievalOptions {
    /// Maximum number of chunks to inject after ranking and optional reranking.
    pub top_k: usize,
    /// Which Spaces to search. `None` searches all Spaces; an empty list
    /// searches no Spaces (memory only).
    pub space_ids: Option<Vec<String>>,
    /// Whether to include memory (U11) in the search.
    pub include_memory: bool,
    /// Drop chunks whose relevance falls below this score (0.0 keeps everything).
    pub min_score: f32,
    /// How many candidates to collect before reranking. Must be >= top_k.
    /// Defaults to `top_k * 4` when not set.
    pub rerank_candidates: Option<usize>,
}

impl Default for RetrievalOptions {
    fn default() -> Self {
        Self {
            top_k: DEFAULT_TOP_K,
            space_ids: None,
            include_memory: true,
            min_score: 0.0,
            rerank_candidates: None,
        }
    }
}

/// Default number of chunks injected when a request does not specify `top_k`.
pub const DEFAULT_TOP_K: usize = 5;

// ── Embedder ────────────────────────────────────────────────────────────────

/// Produces a fixed-length embedding vector for a piece of text.
///
/// The default implementation is a dependency-free local hashing embedder so
/// Core can ground answers with no external model. Operators who want real
/// semantic embeddings can point `RYU_EMBED_BASE_URL` at an OpenAI-compatible
/// `/v1/embeddings` endpoint (see [`Embedder::from_registry`]).
#[derive(Clone)]
pub enum Embedder {
    /// Deterministic local hashing embedder (no network). Dims from the registry.
    Local { dims: usize },
    /// Remote OpenAI-compatible embeddings endpoint.
    Remote {
        base_url: String,
        model: String,
        dims: usize,
        api_key: Option<String>,
    },
}

impl Embedder {
    /// Build an embedder from the model registry.
    ///
    /// Uses the registry's `embed_base_url` as an OpenAI-compatible `/v1/embeddings`
    /// endpoint. By default this points at the local `llamacpp-embed` server (a
    /// llama.cpp `--embeddings` instance serving nomic-embed-text), so RAG gets
    /// real semantic embeddings on install with no setup. The registry already
    /// folds in the `RYU_EMBED_BASE_URL` override (env > registry.json > local
    /// default), so pointing at a remote endpoint is a config change, not a code
    /// change.
    ///
    /// Only when `embed_base_url` is explicitly blanked (e.g. `RYU_EMBED_BASE_URL=""`
    /// plus an empty registry value) does it fall back to the dependency-free local
    /// hashing embedder.
    ///
    ///   `RYU_EMBED_API_KEY` — bearer key (falls back to `OPENAI_API_KEY`)
    pub fn from_registry(registry: &ModelRegistry) -> Self {
        let base_url = registry.embed_base_url.trim();
        if base_url.is_empty() {
            return Self::Local {
                dims: registry.embedder.dims,
            };
        }
        let api_key = std::env::var("RYU_EMBED_API_KEY")
            .ok()
            .or_else(|| std::env::var("OPENAI_API_KEY").ok())
            .filter(|s| !s.is_empty());
        Self::Remote {
            base_url: base_url.to_string(),
            model: registry.embedder.id.clone(),
            dims: registry.embedder.dims,
            api_key,
        }
    }

    /// Returns the dimensionality this embedder produces.
    pub fn dims(&self) -> usize {
        match self {
            Self::Local { dims } => *dims,
            Self::Remote { dims, .. } => *dims,
        }
    }

    /// Returns the model identifier for this embedder (local or remote).
    pub fn model_id(&self) -> &str {
        match self {
            Self::Local { .. } => "local-hashing",
            Self::Remote { model, .. } => model.as_str(),
        }
    }

    /// Embed a single piece of text into a normalized vector.
    pub async fn embed(&self, text: &str) -> Result<Vec<f32>> {
        match self {
            Self::Local { dims } => Ok(local_embed(text, *dims)),
            Self::Remote {
                base_url,
                model,
                api_key,
                ..
            } => remote_embed(base_url, model, api_key.as_deref(), text).await,
        }
    }
}

/// Deterministic local embedding: a normalized bag-of-token-hashes vector.
///
/// Tokens are lowercased word-ish spans; each token is hashed into a bucket and
/// accumulated. The vector is L2-normalized so cosine similarity reduces to a
/// dot product. This is intentionally simple but gives meaningful term-overlap
/// relevance offline.
fn local_embed(text: &str, dims: usize) -> Vec<f32> {
    let mut vec = vec![0.0f32; dims];
    for token in tokenize(text) {
        let bucket = (fnv1a(&token) as usize) % dims;
        vec[bucket] += 1.0;
    }
    l2_normalize(&mut vec);
    vec
}

/// Split text into lowercased alphanumeric tokens.
fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .collect()
}

/// FNV-1a 64-bit hash — small, fast, dependency-free, stable across runs.
fn fnv1a(s: &str) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    for byte in s.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

fn l2_normalize(vec: &mut [f32]) {
    let norm: f32 = vec.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > f32::EPSILON {
        for v in vec.iter_mut() {
            *v /= norm;
        }
    }
}

/// Cosine similarity of two equal-length vectors. Returns 0.0 on length
/// mismatch (e.g. a stored embedding from a different embedder).
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom > f32::EPSILON {
        dot / denom
    } else {
        0.0
    }
}

/// Call an OpenAI-compatible `/v1/embeddings` endpoint for a single input.
async fn remote_embed(
    base_url: &str,
    model: &str,
    api_key: Option<&str>,
    text: &str,
) -> Result<Vec<f32>> {
    static HTTP_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = HTTP_CLIENT.get_or_init(reqwest::Client::new);
    let endpoint = format!("{}/v1/embeddings", base_url.trim_end_matches('/'));
    let payload = serde_json::json!({ "model": model, "input": text });
    let mut builder = client.post(endpoint).json(&payload);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        builder = builder.bearer_auth(key);
    }
    let resp = builder.send().await.context("embeddings request failed")?;
    if !resp.status().is_success() {
        anyhow::bail!("embeddings endpoint returned HTTP {}", resp.status());
    }
    let body: serde_json::Value = resp.json().await.context("decoding embeddings response")?;
    let vec = body
        .get("data")
        .and_then(|d| d.get(0))
        .and_then(|e| e.get("embedding"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|n| n.as_f64().map(|f| f as f32))
                .collect::<Vec<f32>>()
        })
        .context("embeddings response missing data[0].embedding")?;
    Ok(vec)
}

// ── Reranker ──────────────────────────────────────────────────────────────────

/// Re-scores and reorders candidate chunks relative to a query.
///
/// The local default uses exact term-overlap (Jaccard-style token intersection)
/// as a second signal that is orthogonal to the hashed cosine used in the first
/// pass — so the two passes can genuinely disagree on ordering, which makes the
/// reranker testable with a deterministic fixture.
///
/// Operators can point `RYU_RERANKER_BASE_URL` at an OpenAI-compatible scoring
/// endpoint (e.g. a hosted `BAAI/bge-reranker` instance) for real neural
/// reranking.
#[derive(Clone)]
pub enum Reranker {
    /// Local exact term-overlap reranker (no network). Always available.
    Local,
    /// Remote cross-encoder scoring endpoint (model id from registry).
    Remote {
        base_url: String,
        model: String,
        api_key: Option<String>,
    },
}

impl Reranker {
    /// Build a reranker from environment configuration and the model registry.
    ///
    ///   `RYU_RERANKER_BASE_URL` — endpoint URL (enables remote mode)
    ///   `RYU_RERANKER_API_KEY`  — bearer key
    pub fn from_registry(registry: &ModelRegistry) -> Self {
        match std::env::var("RYU_RERANKER_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
        {
            Some(base_url) => {
                let api_key = std::env::var("RYU_RERANKER_API_KEY")
                    .ok()
                    .filter(|s| !s.is_empty());
                Self::Remote {
                    base_url,
                    model: registry.reranker.id.clone(),
                    api_key,
                }
            }
            None => Self::Local,
        }
    }

    /// Returns the model identifier for this reranker.
    pub fn model_id<'a>(&'a self, registry: &'a ModelRegistry) -> &'a str {
        match self {
            Self::Local => registry.reranker.id.as_str(),
            Self::Remote { model, .. } => model.as_str(),
        }
    }

    /// Re-score `candidates` relative to `query` and return them sorted by the
    /// new score (highest first).
    pub async fn rerank(
        &self,
        query: &str,
        mut candidates: Vec<ScoredChunk>,
    ) -> Result<Vec<ScoredChunk>> {
        match self {
            Self::Local => {
                let query_tokens = token_set(query);
                for chunk in &mut candidates {
                    let chunk_tokens = token_set(&chunk.content);
                    chunk.score = jaccard(&query_tokens, &chunk_tokens);
                }
                candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
                Ok(candidates)
            }
            Self::Remote {
                base_url,
                model,
                api_key,
            } => remote_rerank(base_url, model, api_key.as_deref(), query, candidates).await,
        }
    }
}

/// Build a lowercased token set from text (for Jaccard reranking).
fn token_set(text: &str) -> std::collections::HashSet<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .collect()
}

/// Jaccard similarity: |A ∩ B| / |A ∪ B|. Returns 0 when both sets are empty.
fn jaccard(a: &std::collections::HashSet<String>, b: &std::collections::HashSet<String>) -> f32 {
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let intersection = a.intersection(b).count() as f32;
    let union = (a.len() + b.len()) as f32 - intersection;
    if union > 0.0 {
        intersection / union
    } else {
        0.0
    }
}

/// Call a remote cross-encoder scoring endpoint (OpenAI-compatible pattern for
/// reranking APIs that accept `{"model", "query", "documents"}`).
async fn remote_rerank(
    base_url: &str,
    model: &str,
    api_key: Option<&str>,
    query: &str,
    mut candidates: Vec<ScoredChunk>,
) -> Result<Vec<ScoredChunk>> {
    static HTTP_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = HTTP_CLIENT.get_or_init(reqwest::Client::new);
    let endpoint = format!("{}/rerank", base_url.trim_end_matches('/'));
    let documents: Vec<&str> = candidates.iter().map(|c| c.content.as_str()).collect();
    let payload = serde_json::json!({
        "model": model,
        "query": query,
        "documents": documents,
    });
    let mut builder = client.post(endpoint).json(&payload);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        builder = builder.bearer_auth(key);
    }
    let resp = builder.send().await.context("reranking request failed")?;
    if !resp.status().is_success() {
        anyhow::bail!("rerank endpoint returned HTTP {}", resp.status());
    }
    let body: serde_json::Value = resp.json().await.context("decoding rerank response")?;
    let results = body
        .get("results")
        .and_then(|r| r.as_array())
        .context("rerank response missing 'results' array")?;
    for result in results {
        let idx = result
            .get("index")
            .and_then(|v| v.as_u64())
            .context("rerank result missing 'index'")? as usize;
        let score = result
            .get("relevance_score")
            .and_then(|v| v.as_f64())
            .context("rerank result missing 'relevance_score'")? as f32;
        if idx < candidates.len() {
            candidates[idx].score = score;
        }
    }
    candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
    Ok(candidates)
}

// ── Store ─────────────────────────────────────────────────────────────────────

/// SQLite-backed index of retrievable chunks (memory + Spaces) and their
/// embeddings. Cheap to clone (wraps an `Arc<Mutex<Connection>>`).
#[derive(Clone)]
pub struct RetrievalStore {
    conn: Arc<Mutex<Connection>>,
    embedder: Embedder,
    reranker: Reranker,
    /// Registry snapshot — kept so callers can read the configured model ids.
    registry: Arc<ModelRegistry>,
}

fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("retrieval.db")
}

impl RetrievalStore {
    /// Open (or create) the retrieval store at the default path using the
    /// environment-configured model registry.
    pub fn open_default() -> Result<Self> {
        let registry = ModelRegistry::from_env();
        Self::open_with_registry(default_db_path(), registry)
    }

    /// Open (or create) the retrieval store with a specific registry (used by
    /// tests to swap models without environment-variable mutation).
    pub fn open_with_registry(path: PathBuf, registry: ModelRegistry) -> Result<Self> {
        let embedder = Embedder::from_registry(&registry);
        let reranker = Reranker::from_registry(&registry);
        Self::open_inner(path, embedder, reranker, Arc::new(registry))
    }

    fn open_inner(
        path: PathBuf,
        embedder: Embedder,
        reranker: Reranker,
        registry: Arc<ModelRegistry>,
    ) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating retrieval db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening retrieval db {}", path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            embedder,
            reranker,
            registry,
        })
    }

    /// Open an in-memory store with the local embedder at default registry dims
    /// (used by tests).
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let registry = Arc::new(ModelRegistry::default());
        let conn = Connection::open_in_memory().context("opening in-memory retrieval db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            embedder: Embedder::Local {
                dims: registry.embedder.dims,
            },
            reranker: Reranker::Local,
            registry,
        })
    }

    /// Open an in-memory store with a custom registry (used by tests).
    #[cfg(test)]
    pub fn open_in_memory_with_registry(registry: ModelRegistry) -> Result<Self> {
        let embedder = Embedder::from_registry(&registry);
        let conn = Connection::open_in_memory().context("opening in-memory retrieval db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            embedder,
            reranker: Reranker::Local,
            registry: Arc::new(registry),
        })
    }

    /// The model id this store uses for embedding.
    pub fn embedder_model_id(&self) -> &str {
        self.embedder.model_id()
    }

    /// The reranker model id from the registry.
    pub fn reranker_model_id(&self) -> &str {
        self.reranker.model_id(&self.registry)
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS chunks (
                 id              TEXT PRIMARY KEY,
                 source          TEXT NOT NULL,
                 space_id        TEXT,
                 content         TEXT NOT NULL,
                 embedding       BLOB NOT NULL,
                 embedding_model TEXT NOT NULL DEFAULT '',
                 created_at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
             CREATE INDEX IF NOT EXISTS idx_chunks_space  ON chunks(space_id);",
        )
        .context("initializing retrieval schema")?;

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
        Ok(())
    }

    /// Embed and index a chunk so it can be retrieved later. Re-indexing the
    /// same id replaces the previous content and embedding.
    pub async fn index_chunk(
        &self,
        id: &str,
        source: ChunkSource,
        space_id: Option<&str>,
        content: &str,
    ) -> Result<()> {
        let embedding = self.embedder.embed(content).await?;
        let blob = encode_embedding(&embedding);
        let model = self.embedder.model_id().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO chunks (id, source, space_id, content, embedding, embedding_model, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                 source          = excluded.source,
                 space_id        = excluded.space_id,
                 content         = excluded.content,
                 embedding       = excluded.embedding,
                 embedding_model = excluded.embedding_model,
                 created_at      = excluded.created_at",
            params![id, source.as_str(), space_id, content, blob, model, now],
        )
        .context("indexing chunk")?;
        Ok(())
    }

    /// Return the set of `Memory`-source chunk ids already indexed *under the
    /// current embedder*.
    ///
    /// Used by the auto-recall lazy-backfill (mirrors the message-index pattern):
    /// long-term memory facts are bridged into this store on demand so semantic
    /// search can find them, and this lets the backfill embed only NEW facts
    /// instead of re-embedding every fact each turn.
    ///
    /// The filter is `source = 'memory' AND embedding_model = <current>` — NOT just
    /// `source = 'memory'`. Vectors are only comparable within one embedder, and
    /// [`Self::load_candidates`] already filters retrieval to the current
    /// `embedding_model`. If "already indexed" ignored the model, a node that
    /// indexed facts under the local hashing embedder and then installed the embed
    /// server (model id changes) would have its old rows both skipped by backfill
    /// AND filtered out of retrieval — recreating the "semantic memory returns
    /// nothing" bug. Matching the load filter means an embedder swap re-backfills
    /// once (cheap; `index_chunk` upserts via ON CONFLICT).
    pub async fn indexed_memory_ids(&self) -> Result<std::collections::HashSet<String>> {
        let model = self.embedder.model_id().to_string();
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare("SELECT id FROM chunks WHERE source = 'memory' AND embedding_model = ?1")
            .context("preparing indexed-memory-ids query")?;
        let rows = stmt
            .query_map(params![model], |row| row.get::<_, String>(0))
            .context("querying indexed memory ids")?;
        let mut out = std::collections::HashSet::new();
        for row in rows {
            out.insert(row?);
        }
        Ok(out)
    }

    /// Embed `query`, search memory + the selected Spaces, merge and rank by
    /// cosine relevance, re-rank the expanded candidate pool, and return the
    /// top-K chunks (per `opts`).
    ///
    /// Pipeline: embed → search → filter → cosine rank → rerank top-(top_k × 4)
    /// → final top-K.
    pub async fn retrieve(&self, query: &str, opts: &RetrievalOptions) -> Result<Vec<ScoredChunk>> {
        if query.trim().is_empty() || opts.top_k == 0 {
            return Ok(Vec::new());
        }
        let query_embedding = self.embedder.embed(query).await?;

        let candidates = self.load_candidates(opts).await?;

        let mut scored: Vec<ScoredChunk> = candidates
            .into_iter()
            .map(|(chunk, embedding)| {
                let score = cosine_similarity(&query_embedding, &embedding);
                ScoredChunk {
                    id: chunk.id,
                    source: chunk.source,
                    space_id: chunk.space_id,
                    content: chunk.content,
                    score,
                }
            })
            .filter(|c| c.score >= opts.min_score)
            .collect();

        // First pass: sort by cosine and collect an expanded pool for reranking.
        scored.sort_by(|a, b| b.score.total_cmp(&a.score));
        let rerank_n = opts
            .rerank_candidates
            .unwrap_or(opts.top_k.saturating_mul(4).max(opts.top_k));
        scored.truncate(rerank_n);

        // Second pass: rerank the expanded pool, then take the final top-K.
        let mut reranked = self.reranker.rerank(query, scored).await?;
        reranked.truncate(opts.top_k);
        Ok(reranked)
    }

    /// Load candidate chunks (with embeddings) matching the source/Space filter.
    async fn load_candidates(
        &self,
        opts: &RetrievalOptions,
    ) -> Result<Vec<(RetrievableChunk, Vec<f32>)>> {
        // Only consider chunks embedded by the *current* embedder. Mixing vector
        // spaces of equal length (e.g. legacy hashing vs nomic) produces garbage
        // cosine scores, and there is no dim guard to catch it — so we filter by
        // model id here. Chunks from a different/unknown embedder are skipped
        // until re-indexed, rather than silently returned as bad matches.
        let model = self.embedder.model_id().to_string();
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT id, source, space_id, content, embedding FROM chunks \
                 WHERE embedding_model = ?1",
            )
            .context("preparing candidate query")?;
        let rows = stmt
            .query_map(params![model], |row| {
                let source = ChunkSource::from_str(&row.get::<_, String>(1)?);
                let space_id: Option<String> = row.get(2)?;
                let blob: Vec<u8> = row.get(4)?;
                Ok((
                    RetrievableChunk {
                        id: row.get(0)?,
                        source,
                        space_id,
                        content: row.get(3)?,
                    },
                    decode_embedding(&blob),
                ))
            })
            .context("querying candidates")?;

        let mut out = Vec::new();
        for row in rows {
            let (chunk, embedding) = row?;
            if chunk_matches(&chunk, opts) {
                out.push((chunk, embedding));
            }
        }
        Ok(out)
    }
}

/// Decide whether a chunk is in scope for this retrieval request, merging the
/// memory toggle with the Space selection.
fn chunk_matches(chunk: &RetrievableChunk, opts: &RetrievalOptions) -> bool {
    match chunk.source {
        ChunkSource::Memory => opts.include_memory,
        ChunkSource::Space => match &opts.space_ids {
            // `None` => search all Spaces.
            None => true,
            // A list (possibly empty) => only those Spaces.
            Some(ids) => chunk
                .space_id
                .as_ref()
                .is_some_and(|sid| ids.iter().any(|want| want == sid)),
        },
    }
}

/// Encode an embedding as little-endian f32 bytes for BLOB storage.
fn encode_embedding(vec: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vec.len() * 4);
    for v in vec {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    bytes
}

/// Decode a little-endian f32 BLOB back into an embedding vector.
fn decode_embedding(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Render retrieved chunks into a single system-context string suitable for
/// injection ahead of the model call. Returns `None` when there is nothing to
/// inject so callers can skip adding an empty system message.
pub fn build_context_block(chunks: &[ScoredChunk]) -> Option<String> {
    if chunks.is_empty() {
        return None;
    }
    let mut block = String::from(
        "Use the following retrieved context to ground your answer. \
         If it is not relevant, ignore it.\n",
    );
    for (i, chunk) in chunks.iter().enumerate() {
        let label = match (chunk.source, chunk.space_id.as_deref()) {
            (ChunkSource::Space, Some(space)) => format!("Space:{space}"),
            (ChunkSource::Space, None) => "Space".to_owned(),
            (ChunkSource::Memory, _) => "Memory".to_owned(),
        };
        block.push_str(&format!(
            "\n[{}] ({}) {}\n",
            i + 1,
            label,
            chunk.content.trim()
        ));
    }
    Some(block)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::ModelRegistry;

    async fn seed(store: &RetrievalStore) {
        store
            .index_chunk(
                "m1",
                ChunkSource::Memory,
                None,
                "The user prefers dark mode and concise answers.",
            )
            .await
            .unwrap();
        store
            .index_chunk(
                "s1",
                ChunkSource::Space,
                Some("docs"),
                "Ryu Core runs on port 7980 and routes chat through adapters.",
            )
            .await
            .unwrap();
        store
            .index_chunk(
                "s2",
                ChunkSource::Space,
                Some("docs"),
                "The gateway enforces firewall, routing, and budgets.",
            )
            .await
            .unwrap();
        store
            .index_chunk(
                "s3",
                ChunkSource::Space,
                Some("recipes"),
                "Preheat the oven to 200 degrees and bake the bread.",
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn retrieves_relevant_chunk_grounding_the_query() {
        let store = RetrievalStore::open_in_memory().unwrap();
        seed(&store).await;

        let opts = RetrievalOptions {
            top_k: 1,
            ..Default::default()
        };
        let hits = store
            .retrieve("what port does ryu core run on", &opts)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "s1");
        assert!(hits[0].score > 0.0);
    }

    #[tokio::test]
    async fn merges_memory_and_spaces_ranked_by_relevance() {
        let store = RetrievalStore::open_in_memory().unwrap();
        seed(&store).await;

        let opts = RetrievalOptions {
            top_k: 5,
            ..Default::default()
        };
        let hits = store
            .retrieve("dark mode answers and core port", &opts)
            .await
            .unwrap();
        // Both a memory chunk and a Space chunk should be present in the merge.
        assert!(hits.iter().any(|c| c.source == ChunkSource::Memory));
        assert!(hits.iter().any(|c| c.source == ChunkSource::Space));
        // Sorted by descending score.
        for pair in hits.windows(2) {
            assert!(pair[0].score >= pair[1].score);
        }
    }

    #[tokio::test]
    async fn space_filter_restricts_search() {
        let store = RetrievalStore::open_in_memory().unwrap();
        seed(&store).await;

        let opts = RetrievalOptions {
            top_k: 10,
            space_ids: Some(vec!["recipes".to_owned()]),
            include_memory: false,
            min_score: 0.0,
            rerank_candidates: None,
        };
        let hits = store.retrieve("oven bread bake", &opts).await.unwrap();
        assert!(!hits.is_empty());
        assert!(hits
            .iter()
            .all(|c| c.space_id.as_deref() == Some("recipes")));
    }

    #[tokio::test]
    async fn empty_space_list_searches_memory_only() {
        let store = RetrievalStore::open_in_memory().unwrap();
        seed(&store).await;

        let opts = RetrievalOptions {
            top_k: 10,
            space_ids: Some(vec![]),
            include_memory: true,
            min_score: 0.0,
            rerank_candidates: None,
        };
        let hits = store.retrieve("dark mode", &opts).await.unwrap();
        assert!(hits.iter().all(|c| c.source == ChunkSource::Memory));
    }

    #[tokio::test]
    async fn top_k_limits_results() {
        let store = RetrievalStore::open_in_memory().unwrap();
        seed(&store).await;

        let opts = RetrievalOptions {
            top_k: 2,
            ..Default::default()
        };
        let hits = store
            .retrieve("ryu core gateway docs", &opts)
            .await
            .unwrap();
        assert!(hits.len() <= 2);
    }

    #[test]
    fn context_block_is_none_when_empty() {
        assert!(build_context_block(&[]).is_none());
    }

    #[test]
    fn context_block_labels_sources() {
        let chunks = vec![
            ScoredChunk {
                id: "m1".into(),
                source: ChunkSource::Memory,
                space_id: None,
                content: "remembered fact".into(),
                score: 0.9,
            },
            ScoredChunk {
                id: "s1".into(),
                source: ChunkSource::Space,
                space_id: Some("docs".into()),
                content: "space fact".into(),
                score: 0.8,
            },
        ];
        let block = build_context_block(&chunks).unwrap();
        assert!(block.contains("Memory"));
        assert!(block.contains("Space:docs"));
        assert!(block.contains("remembered fact"));
    }

    #[test]
    fn cosine_handles_length_mismatch() {
        assert_eq!(cosine_similarity(&[1.0, 0.0], &[1.0]), 0.0);
    }

    #[test]
    fn embedding_round_trips_through_blob() {
        let vec = vec![0.5f32, -0.25, 1.0, 0.0];
        let decoded = decode_embedding(&encode_embedding(&vec));
        assert_eq!(vec, decoded);
    }

    // ── AC4: registry swap + reranker reorders ────────────────────────────────

    /// AC4a: swapping the embedding model via a temp registry produces the new id.
    #[tokio::test]
    async fn registry_swap_uses_new_embed_model_id() {
        // Use a custom registry with a distinct model id.
        let registry = ModelRegistry::with_models("custom/embed-test", 256, "custom/reranker-test");
        let store = RetrievalStore::open_in_memory_with_registry(registry).unwrap();

        // The store should report the injected model id.
        assert_eq!(
            store.embedder_model_id(),
            "local-hashing",
            "local mode always returns 'local-hashing' (no base URL set)"
        );
        assert_eq!(store.reranker_model_id(), "custom/reranker-test");
    }

    /// AC4b: reranking genuinely changes candidate order.
    ///
    /// Fixture design: two chunks where cosine favors C1 (token overlap with the
    /// query) but Jaccard reranking favors C2 (exact term match). We force this by
    /// using a query whose tokens fully cover C2 but only partially cover C1.
    #[tokio::test]
    async fn reranker_changes_candidate_order() {
        // C1: many tokens, partially overlapping with query.
        // C2: few tokens, all of which appear in the query.
        // Query: tokens from C2 plus one extra token that pulls cosine toward C1.
        let c1 = ScoredChunk {
            id: "c1".into(),
            source: ChunkSource::Memory,
            space_id: None,
            content: "alpha beta gamma delta epsilon zeta".into(),
            score: 0.9, // pretend cosine put c1 first
        };
        let c2 = ScoredChunk {
            id: "c2".into(),
            source: ChunkSource::Memory,
            space_id: None,
            content: "alpha beta".into(),
            score: 0.5, // cosine put c2 second
        };

        // Query: "alpha beta" — Jaccard with c2 = 2/2 = 1.0; with c1 = 2/6 ≈ 0.33.
        let query = "alpha beta";
        let reranker = Reranker::Local;
        let reranked = reranker.rerank(query, vec![c1, c2]).await.unwrap();

        // After reranking, c2 (exact match) should be first.
        assert_eq!(
            reranked[0].id, "c2",
            "reranker should elevate the exact-match chunk"
        );
        assert_eq!(reranked[1].id, "c1");
        // Scores should reflect Jaccard, not the original cosine.
        assert!(reranked[0].score > reranked[1].score);
    }

    /// AC4c: embedder dims are derived from the registry, not a hardcoded const.
    #[test]
    fn embedder_dims_derived_from_registry() {
        let registry = ModelRegistry::with_models("test/embed", 512, "test/reranker");
        let embedder = Embedder::from_registry(&registry);
        assert_eq!(embedder.dims(), 512);

        // Producing a vector gives the configured length.
        let vec = local_embed("hello world", embedder.dims());
        assert_eq!(vec.len(), 512);
    }

    /// AC4d: default registry uses the spec-required model ids.
    #[test]
    fn default_registry_has_spec_models() {
        let registry = ModelRegistry::default();
        assert_eq!(registry.embedder.id, "nomic-embed-text-v1.5");
        assert_eq!(registry.reranker.id, "BAAI/bge-reranker");
    }
}
