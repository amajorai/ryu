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
use rusqlite::{params, Connection, OptionalExtension};
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
    /// Memory scope level (`"user"`/`"node"`/`"project"`) for `Memory` chunks;
    /// `None` for Space/OKF. Legacy memory chunks (pre-scoping) are treated as
    /// `"user"` by the level filter.
    #[serde(default)]
    pub mem_scope: Option<String>,
    /// Project folder path when `mem_scope == "project"`.
    #[serde(default)]
    pub mem_scope_id: Option<String>,
    /// 1..=5 importance for `Memory` chunks; used to boost ranking.
    #[serde(default)]
    pub mem_importance: i32,
    /// Denormalized owner (the source document's / memory's `owner_user_id`), so the
    /// per-caller tenancy filter runs in-process without a cross-store join. `None`
    /// = unattributed: shared knowledge (OKF / legacy Space chunk) for `Space`, and
    /// fail-closed (owner-only, invisible to a mismatched caller) for user-scope
    /// `Memory`. Refreshed for legacy memory rows by `backfill_memory_owner`.
    #[serde(default)]
    pub owner_user_id: Option<String>,
    /// Denormalized owning org, paired with `owner_user_id` for the org/team
    /// visibility branch.
    #[serde(default)]
    pub owner_org_id: Option<String>,
    /// Sharing visibility (`private`/`org`/`team`) for `Space` chunks; `None` for
    /// memory (its `mem_scope` decides sharing).
    #[serde(default)]
    pub visibility: Option<String>,
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
    /// Memory scope levels the caller (agent) may read (`"user"`/`"node"`/
    /// `"project"`). `None` searches every level (unconfigured / back-compat);
    /// `Some` restricts memory chunks to the listed levels.
    #[serde(default)]
    pub read_levels: Option<Vec<String>>,
    /// The active project folder path. Project-scoped memory chunks are only
    /// matched when their `mem_scope_id` equals this. `None` excludes all
    /// project-scoped memory.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Drop chunks whose relevance falls below this score (0.0 keeps everything).
    pub min_score: f32,
    /// How many candidates to collect before reranking. Must be >= top_k.
    /// Defaults to `top_k * 4` when not set.
    pub rerank_candidates: Option<usize>,
    /// Per-caller tenancy — the retrieval twin of the Spaces `DocFilter`. When
    /// `node_bound` is `false` (default / UNBOUND node) NO owner filtering runs, so
    /// every existing caller is byte-identical. When `true`, a user-scope memory
    /// chunk is returned only to its owner (`caller_user_id`), and a `Space` chunk
    /// only if unowned (shared/OKF) or owned by the caller / shared to their org.
    #[serde(default)]
    pub node_bound: bool,
    /// The verified caller's user id (bound-node owner match). `None` = anonymous.
    #[serde(default)]
    pub caller_user_id: Option<String>,
    /// The caller's org (bound-node org/team-visibility match).
    #[serde(default)]
    pub caller_org_id: Option<String>,
}

impl Default for RetrievalOptions {
    fn default() -> Self {
        Self {
            top_k: DEFAULT_TOP_K,
            space_ids: None,
            include_memory: true,
            read_levels: None,
            project_id: None,
            min_score: 0.0,
            rerank_candidates: None,
            node_bound: false,
            caller_user_id: None,
            caller_org_id: None,
        }
    }
}

/// The denormalized owner stamped onto a chunk at index time. `shared()` (all
/// `None`) marks OKF / node-shared knowledge; `owned(uid, org, vis)` attributes a
/// document or memory to a principal so the per-caller filter can gate it.
#[derive(Clone, Copy, Default)]
pub struct RetrievalOwner<'a> {
    pub user_id: Option<&'a str>,
    pub org_id: Option<&'a str>,
    pub visibility: Option<&'a str>,
}

impl<'a> RetrievalOwner<'a> {
    /// Unattributed — OKF bundles and node-shared knowledge (visible to everyone).
    pub fn shared() -> Self {
        Self::default()
    }

    /// Attributed to `user_id` within `org_id` at `visibility`.
    pub fn owned(user_id: Option<&'a str>, org_id: Option<&'a str>, visibility: Option<&'a str>) -> Self {
        Self {
            user_id,
            org_id,
            visibility,
        }
    }
}

/// Default number of chunks injected when a request does not specify `top_k`.
pub const DEFAULT_TOP_K: usize = 5;

/// Default importance for a memory chunk missing the column (mid of the 1..=5 scale).
pub const DEFAULT_MEM_IMPORTANCE: i32 = 3;

/// Per-importance-point nudge to a memory chunk's relevance score. Small enough
/// that a genuinely more-similar chunk still wins, but a high-importance fact
/// breaks near-ties in its favour.
const IMPORTANCE_BOOST_STEP: f32 = 0.02;

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

    /// Returns `true` for the deterministic local hashing embedder (no network).
    /// Callers use this to decide whether embedding work can run inline (local,
    /// never blocks) or must be spawned off the request path (remote sidecar).
    pub fn is_local(&self) -> bool {
        matches!(self, Self::Local { .. })
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

    /// Build a reranker that targets the local `llamacpp-rerank` server (the bge
    /// cross-encoder) — used by Spaces RAG. Unlike [`from_registry`], this always
    /// returns a server-backed reranker pointing at `registry.reranker_base_url`.
    /// The Spaces search path lazily starts that server and falls open to the
    /// vector order whenever it is not reachable, so this is safe to construct
    /// even before the server (or its model) exists. `RYU_RERANKER_BASE_URL` +
    /// `RYU_RERANKER_API_KEY` still override to point at a remote endpoint.
    pub fn local_server(registry: &ModelRegistry) -> Self {
        let base_url = std::env::var("RYU_RERANKER_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| registry.reranker_base_url.clone());
        let api_key = std::env::var("RYU_RERANKER_API_KEY")
            .ok()
            .filter(|s| !s.is_empty());
        Self::Remote {
            base_url,
            model: registry.local_reranker_model.id.clone(),
            api_key,
        }
    }

    /// Score `documents` against `query`, returning `(original_index, score)`
    /// pairs sorted best-first. A lower-level primitive for callers (e.g. Spaces
    /// search) that hold their own chunk type rather than [`ScoredChunk`]. The
    /// `Remote` branch reuses the same `/rerank` request/response contract as
    /// [`remote_rerank`] (the bundled llama-server `--reranking` endpoint).
    pub async fn rank_documents(
        &self,
        query: &str,
        documents: &[String],
    ) -> Result<Vec<(usize, f32)>> {
        match self {
            Self::Local => {
                let query_tokens = token_set(query);
                let mut ranked: Vec<(usize, f32)> = documents
                    .iter()
                    .enumerate()
                    .map(|(i, doc)| (i, jaccard(&query_tokens, &token_set(doc))))
                    .collect();
                ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
                Ok(ranked)
            }
            Self::Remote {
                base_url,
                model,
                api_key,
            } => {
                static HTTP_CLIENT: std::sync::OnceLock<reqwest::Client> =
                    std::sync::OnceLock::new();
                let client = HTTP_CLIENT.get_or_init(reqwest::Client::new);
                let endpoint = format!("{}/rerank", base_url.trim_end_matches('/'));
                let payload = serde_json::json!({
                    "model": model,
                    "query": query,
                    "documents": documents,
                });
                let mut builder = client.post(endpoint).json(&payload);
                if let Some(key) = api_key.as_deref().filter(|k| !k.is_empty()) {
                    builder = builder.bearer_auth(key);
                }
                let resp = builder.send().await.context("reranking request failed")?;
                if !resp.status().is_success() {
                    anyhow::bail!("rerank endpoint returned HTTP {}", resp.status());
                }
                let body: serde_json::Value =
                    resp.json().await.context("decoding rerank response")?;
                let results = body
                    .get("results")
                    .and_then(|r| r.as_array())
                    .context("rerank response missing 'results' array")?;
                let mut ranked: Vec<(usize, f32)> = Vec::with_capacity(results.len());
                for result in results {
                    let idx = result
                        .get("index")
                        .and_then(serde_json::Value::as_u64)
                        .context("rerank result missing 'index'")?
                        as usize;
                    let score = result
                        .get("relevance_score")
                        .and_then(serde_json::Value::as_f64)
                        .context("rerank result missing 'relevance_score'")?
                        as f32;
                    if idx < documents.len() {
                        ranked.push((idx, score));
                    }
                }
                ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
                Ok(ranked)
            }
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
        // One-shot owner backfill for memory chunks indexed before per-resource
        // tenancy existed (best-effort; never blocks opening the store). Deliberately
        // NOT in `init_schema` (the in-memory test store runs that and must never
        // read the real account vault).
        if let Err(e) = Self::backfill_memory_owner(&conn) {
            tracing::warn!("retrieval memory-owner backfill skipped: {e:#}");
        }
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            embedder,
            reranker,
            registry,
        })
    }

    /// Attribute pre-tenancy MEMORY chunks to the local owner once the node binds —
    /// the retrieval twin of `MemoryStore::backfill` / `ConversationStore::backfill_tenancy`.
    ///
    /// Memory chunks indexed before the `owner_user_id` denorm existed carry NULL
    /// (or the pre-attribution `'local'` sentinel, mirrored from `memory_entries`).
    /// On a bound node the user-scope tenancy filter would then hide them from their
    /// real owner (a lockout). This stamps them to the local vault owner. Unbound
    /// node → return immediately (no marker), byte-identical. Idempotent via a marker
    /// row stored inside `chunks` is not possible (no meta table here), so it uses a
    /// dedicated `retrieval_meta` table.
    fn backfill_memory_owner(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS retrieval_meta (key TEXT PRIMARY KEY, value TEXT)",
        )
        .context("creating retrieval_meta")?;
        let done: Option<String> = conn
            .query_row(
                "SELECT value FROM retrieval_meta WHERE key = 'mem_owner_backfill_v1'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if done.is_some() {
            return Ok(());
        }
        // Unbound (personal) node: chunks stay unattributed, by design. Not marked.
        let Some(org) = crate::sidecar::control_plane::registered_org() else {
            return Ok(());
        };
        let Some(owner) = crate::auth::load_accounts()
            .active()
            .map(|a| a.user_id.clone())
        else {
            tracing::warn!(
                "retrieval memory-owner backfill: org-bound node with no signed-in local account \
                 — leaving pre-tenancy memory chunks unattributed (fail closed)."
            );
            return Ok(());
        };
        let claimed = conn
            .execute(
                "UPDATE chunks SET owner_user_id = ?1, owner_org_id = ?2
                 WHERE source = 'memory'
                   AND (owner_user_id IS NULL OR owner_user_id = 'local')",
                params![owner, org.id],
            )
            .context("backfilling retrieval memory-chunk owner")?;
        conn.execute(
            "INSERT OR REPLACE INTO retrieval_meta (key, value) VALUES ('mem_owner_backfill_v1', ?1)",
            params![owner],
        )?;
        tracing::info!("retrieval memory-owner backfill: attributed {claimed} memory chunk(s)");
        Ok(())
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
                 created_at      INTEGER NOT NULL,
                 -- Memory-scope metadata (NULL for Space/OKF chunks). Denormalized
                 -- from `memory_entries` so the level/project filter runs in-query.
                 mem_scope       TEXT,
                 mem_scope_id    TEXT,
                 mem_category    TEXT,
                 mem_importance  INTEGER NOT NULL DEFAULT 3
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
                 chunk_index  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_okf_bundle  ON okf_chunks(bundle_id);
             CREATE INDEX IF NOT EXISTS idx_okf_concept ON okf_chunks(bundle_id, concept_path);
             CREATE INDEX IF NOT EXISTS idx_okf_type    ON okf_chunks(okf_type);",
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

        // Migration for DBs created before the memory-scope columns existed.
        // Duplicate-column errors on fresh DBs (CREATE above) are ignored.
        let _ = conn.execute("ALTER TABLE chunks ADD COLUMN mem_scope TEXT", []);
        let _ = conn.execute("ALTER TABLE chunks ADD COLUMN mem_scope_id TEXT", []);
        let _ = conn.execute("ALTER TABLE chunks ADD COLUMN mem_category TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE chunks ADD COLUMN mem_importance INTEGER NOT NULL DEFAULT 3",
            [],
        );

        // Denormalized owner (per-resource tenancy). Mirrors how `mem_scope` is
        // denormalized off `memory_entries`: it lets the per-caller filter run
        // in-query without a cross-store join. NULL for OKF / legacy chunks.
        // Duplicate-column errors on fresh DBs are ignored.
        let _ = conn.execute("ALTER TABLE chunks ADD COLUMN owner_user_id TEXT", []);
        let _ = conn.execute("ALTER TABLE chunks ADD COLUMN owner_org_id TEXT", []);
        let _ = conn.execute("ALTER TABLE chunks ADD COLUMN visibility TEXT", []);

        // Built after the ALTERs above so it works on DBs created before the
        // mem_scope columns existed — on those, `CREATE TABLE IF NOT EXISTS`
        // no-ops and the columns only appear via the migrations, so indexing
        // them inside the initial batch would fail with "no such column".
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_chunks_mem_scope ON chunks(mem_scope, mem_scope_id);",
        )
        .context("indexing chunks.mem_scope")?;
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
        owner: RetrievalOwner<'_>,
    ) -> Result<()> {
        let embedding = self.embedder.embed(content).await?;
        let blob = encode_embedding(&embedding);
        let model = self.embedder.model_id().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO chunks
                (id, source, space_id, content, embedding, embedding_model, created_at,
                 owner_user_id, owner_org_id, visibility)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                 source          = excluded.source,
                 space_id        = excluded.space_id,
                 content         = excluded.content,
                 embedding       = excluded.embedding,
                 embedding_model = excluded.embedding_model,
                 created_at      = excluded.created_at,
                 owner_user_id   = excluded.owner_user_id,
                 owner_org_id    = excluded.owner_org_id,
                 visibility      = excluded.visibility",
            params![
                id,
                source.as_str(),
                space_id,
                content,
                blob,
                model,
                now,
                owner.user_id,
                owner.org_id,
                owner.visibility,
            ],
        )
        .context("indexing chunk")?;
        Ok(())
    }

    /// Index a memory fact with its scope metadata so the level/project filter can
    /// run in-query. Same upsert semantics as [`index_chunk`](Self::index_chunk)
    /// but for `ChunkSource::Memory`, carrying `mem_scope`/`mem_scope_id`/
    /// `mem_category`/`mem_importance`.
    pub async fn index_memory_chunk(
        &self,
        id: &str,
        content: &str,
        scope: &str,
        scope_id: Option<&str>,
        category: &str,
        importance: i32,
        owner: RetrievalOwner<'_>,
    ) -> Result<()> {
        let embedding = self.embedder.embed(content).await?;
        let blob = encode_embedding(&embedding);
        let model = self.embedder.model_id().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO chunks
                (id, source, space_id, content, embedding, embedding_model, created_at,
                 mem_scope, mem_scope_id, mem_category, mem_importance,
                 owner_user_id, owner_org_id, visibility)
             VALUES (?1, 'memory', NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL)
             ON CONFLICT(id) DO UPDATE SET
                 source          = 'memory',
                 space_id        = NULL,
                 content         = excluded.content,
                 embedding       = excluded.embedding,
                 embedding_model = excluded.embedding_model,
                 created_at      = excluded.created_at,
                 mem_scope       = excluded.mem_scope,
                 mem_scope_id    = excluded.mem_scope_id,
                 mem_category    = excluded.mem_category,
                 mem_importance  = excluded.mem_importance,
                 owner_user_id   = excluded.owner_user_id,
                 owner_org_id    = excluded.owner_org_id",
            params![
                id,
                content,
                blob,
                model,
                now,
                scope,
                scope_id,
                category,
                importance.clamp(1, 5),
                owner.user_id,
                owner.org_id,
            ],
        )
        .context("indexing memory chunk")?;
        Ok(())
    }

    /// Ingest a parsed OKF [`Bundle`](crate::okf::Bundle) into the retrieval
    /// index so an agent can read it as grounded knowledge.
    ///
    /// Each concept's body is chunked, embedded via the store's configured
    /// embedder (reusing the same path as [`index_chunk`](Self::index_chunk)),
    /// and indexed as `Space`-source chunks scoped to a synthetic space whose id
    /// is `bundle_id` — so the existing `space_ids` retrieval filter can target a
    /// single bundle. Alongside each chunk a row is written to `okf_chunks` with
    /// the filterable metadata `{ okf_type, tags, resource, source_bundle_id,
    /// concept_path }` plus the concept's cross-links (preserved as edges for
    /// progressive disclosure).
    ///
    /// **Idempotent on `concept_path`**: the call first removes any previously
    /// ingested chunks for `bundle_id` (via [`remove_okf_bundle`](Self::remove_okf_bundle)),
    /// then re-inserts. Re-ingesting an updated bundle therefore replaces stale
    /// chunks and drops concepts that no longer exist — no orphans accumulate.
    pub async fn ingest_okf_bundle(
        &self,
        bundle_id: &str,
        bundle: &crate::okf::Bundle,
    ) -> Result<OkfIngestSummary> {
        // Re-index is a full replace: clear the prior generation first so removed
        // concepts and shrunk bodies do not leave orphaned chunks behind.
        self.remove_okf_bundle(bundle_id).await?;

        // Embed every chunk up front (no DB lock held during network/CPU work),
        // then commit all rows in a single transaction.
        let mut rows: Vec<OkfRow> = Vec::new();
        let model = self.embedder.model_id().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        for concept in &bundle.concepts {
            let header = okf_chunk_header(concept);
            let tags_json =
                serde_json::to_string(&concept.tags).unwrap_or_else(|_| "[]".to_owned());
            let links: Vec<&str> = concept.links.iter().map(|l| l.target.as_str()).collect();
            let links_json = serde_json::to_string(&links).unwrap_or_else(|_| "[]".to_owned());
            let body_chunks = chunk_okf_body(&concept.body);
            for (idx, body_chunk) in body_chunks.into_iter().enumerate() {
                // Prepend a header (title/type/description) so each chunk carries
                // enough context to be retrievable on its own.
                let content = if header.is_empty() {
                    body_chunk
                } else if body_chunk.is_empty() {
                    header.clone()
                } else {
                    format!("{header}\n{body_chunk}")
                };
                let embedding = self.embedder.embed(&content).await?;
                let blob = encode_embedding(&embedding);
                let chunk_id = format!("okf:{bundle_id}:{}#{idx}", concept.file_path);
                rows.push(OkfRow {
                    chunk_id,
                    content,
                    blob,
                    concept_path: concept.file_path.clone(),
                    okf_type: concept.type_.clone(),
                    tags_json: tags_json.clone(),
                    resource: concept.resource.clone(),
                    links_json: links_json.clone(),
                    chunk_index: idx as i64,
                });
            }
        }

        let chunk_count = rows.len();
        let concept_count = bundle.concepts.len();
        let conn = self.conn.lock().await;
        let tx = conn
            .unchecked_transaction()
            .context("opening okf ingest transaction")?;
        for row in &rows {
            tx.execute(
                "INSERT INTO chunks (id, source, space_id, content, embedding, embedding_model, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                     source          = excluded.source,
                     space_id        = excluded.space_id,
                     content         = excluded.content,
                     embedding       = excluded.embedding,
                     embedding_model = excluded.embedding_model,
                     created_at      = excluded.created_at",
                params![
                    row.chunk_id,
                    ChunkSource::Space.as_str(),
                    bundle_id,
                    row.content,
                    row.blob,
                    model,
                    now
                ],
            )
            .context("indexing okf chunk")?;
            tx.execute(
                "INSERT INTO okf_chunks (chunk_id, bundle_id, concept_path, okf_type, tags, resource, links, chunk_index)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(chunk_id) DO UPDATE SET
                     bundle_id    = excluded.bundle_id,
                     concept_path = excluded.concept_path,
                     okf_type     = excluded.okf_type,
                     tags         = excluded.tags,
                     resource     = excluded.resource,
                     links        = excluded.links,
                     chunk_index  = excluded.chunk_index",
                params![
                    row.chunk_id,
                    bundle_id,
                    row.concept_path,
                    row.okf_type,
                    row.tags_json,
                    row.resource,
                    row.links_json,
                    row.chunk_index
                ],
            )
            .context("indexing okf metadata")?;
        }
        tx.commit().context("committing okf ingest")?;

        Ok(OkfIngestSummary {
            bundle_id: bundle_id.to_owned(),
            concepts: concept_count,
            chunks: chunk_count,
        })
    }

    /// Remove every chunk (and its metadata) that was ingested for `bundle_id`.
    /// Returns the number of metadata rows removed. Safe to call for an unknown
    /// bundle (no-op, returns 0).
    pub async fn remove_okf_bundle(&self, bundle_id: &str) -> Result<usize> {
        let conn = self.conn.lock().await;
        let tx = conn
            .unchecked_transaction()
            .context("opening okf remove transaction")?;
        tx.execute(
            "DELETE FROM chunks WHERE id IN (SELECT chunk_id FROM okf_chunks WHERE bundle_id = ?1)",
            params![bundle_id],
        )
        .context("deleting okf chunks")?;
        let removed = tx
            .execute(
                "DELETE FROM okf_chunks WHERE bundle_id = ?1",
                params![bundle_id],
            )
            .context("deleting okf metadata")?;
        tx.commit().context("committing okf removal")?;
        Ok(removed)
    }

    /// Remove a single indexed chunk by id (e.g. when a memory fact is deleted).
    /// Returns whether a row was removed. Safe to call for an unknown id.
    pub async fn remove_chunk(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let removed = conn.execute("DELETE FROM chunks WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }

    /// Return the cross-link edges preserved for a bundle: `(concept_path,
    /// link_target)` pairs, deduplicated, for progressive-disclosure traversal.
    pub async fn okf_links(&self, bundle_id: &str) -> Result<Vec<OkfEdge>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare("SELECT DISTINCT concept_path, links FROM okf_chunks WHERE bundle_id = ?1")
            .context("preparing okf links query")?;
        let rows = stmt
            .query_map(params![bundle_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .context("querying okf links")?;
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for row in rows {
            let (concept_path, links_json) = row?;
            let targets: Vec<String> = serde_json::from_str(&links_json).unwrap_or_default();
            for target in targets {
                if seen.insert((concept_path.clone(), target.clone())) {
                    out.push(OkfEdge {
                        concept_path: concept_path.clone(),
                        target,
                    });
                }
            }
        }
        Ok(out)
    }

    /// Reconstruct the OKF concepts previously ingested under `bundle_id` so the
    /// bundle can be exported back to an OKF directory.
    ///
    /// Ingest stores each concept's body as one or more chunks, each prefixed
    /// with a context header (`{title} [{type}] {description}`). This reverses
    /// that: rows are grouped by `concept_path` (ordered by `chunk_index`), the
    /// per-chunk header is stripped, and the bodies are rejoined. `title` and
    /// `description` are recovered from the header; `type`, `tags`, `resource`,
    /// and cross-links come from the `okf_chunks` sidecar; `timestamp` from the
    /// chunk's `created_at`.
    ///
    /// This is **lossy by design**: the body is reassembled from normalized
    /// chunks (original paragraph and whitespace boundaries are not perfectly
    /// preserved) and only metadata the index retained survives. It is faithful
    /// enough to re-emit a shareable bundle, not byte-identical to the source.
    pub async fn reconstruct_okf_concepts(
        &self,
        bundle_id: &str,
    ) -> Result<Vec<crate::okf::Concept>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT o.concept_path, o.okf_type, o.tags, o.resource, o.links, c.content, c.created_at
                 FROM okf_chunks o JOIN chunks c ON c.id = o.chunk_id
                 WHERE o.bundle_id = ?1
                 ORDER BY o.concept_path, o.chunk_index",
            )
            .context("preparing okf export query")?;
        let rows = stmt
            .query_map(params![bundle_id], |row| {
                Ok(OkfExportRow {
                    concept_path: row.get(0)?,
                    okf_type: row.get(1)?,
                    tags_json: row.get(2)?,
                    resource: row.get(3)?,
                    links_json: row.get(4)?,
                    content: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .context("querying okf export rows")?;

        // Rows arrive ordered by concept_path; collapse contiguous runs into one
        // Concept each.
        let mut concepts: Vec<crate::okf::Concept> = Vec::new();
        let mut group: Vec<OkfExportRow> = Vec::new();
        for row in rows {
            let row = row?;
            if group
                .first()
                .is_some_and(|f| f.concept_path != row.concept_path)
            {
                concepts.push(concept_from_export_rows(&group));
                group.clear();
            }
            group.push(row);
        }
        if !group.is_empty() {
            concepts.push(concept_from_export_rows(&group));
        }
        Ok(concepts)
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
                let mut score = cosine_similarity(&query_embedding, &embedding);
                // Nudge memory chunks by importance so high-value facts break ties.
                if chunk.source == ChunkSource::Memory {
                    score += (chunk.mem_importance - DEFAULT_MEM_IMPORTANCE) as f32
                        * IMPORTANCE_BOOST_STEP;
                }
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
                "SELECT id, source, space_id, content, embedding, \
                        mem_scope, mem_scope_id, mem_importance, \
                        owner_user_id, owner_org_id, visibility FROM chunks \
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
                        mem_scope: row.get(5)?,
                        mem_scope_id: row.get(6)?,
                        mem_importance: row
                            .get::<_, Option<i32>>(7)?
                            .unwrap_or(DEFAULT_MEM_IMPORTANCE),
                        owner_user_id: row.get(8)?,
                        owner_org_id: row.get(9)?,
                        visibility: row.get(10)?,
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
        ChunkSource::Memory => {
            opts.include_memory
                && memory_level_matches(chunk, opts)
                && memory_tenancy_allows(chunk, opts)
        }
        ChunkSource::Space => {
            let space_selected = match &opts.space_ids {
                // `None` => search all Spaces.
                None => true,
                // A list (possibly empty) => only those Spaces.
                Some(ids) => chunk
                    .space_id
                    .as_ref()
                    .is_some_and(|sid| ids.iter().any(|want| want == sid)),
            };
            space_selected && space_tenancy_allows(chunk, opts)
        }
    }
}

/// Per-caller tenancy for a MEMORY chunk — the retrieval twin of the memory-store
/// visibility predicate. On an UNBOUND node (`node_bound = false`) it is a no-op
/// (byte-identical). On a BOUND node: `node`/`project` scopes are the shared "company
/// brain" (visible to every member), while `user`-scope facts are PRIVATE — returned
/// only to their owner. A user-scope chunk whose owner does not equal the caller
/// (including legacy NULL/`'local'` owners the backfill has not yet reached) is
/// hidden. This is the filter that stops one member retrieving another's private
/// memory via `/api/retrieval/search`.
fn memory_tenancy_allows(chunk: &RetrievableChunk, opts: &RetrievalOptions) -> bool {
    if !opts.node_bound {
        return true;
    }
    let scope = chunk.mem_scope.as_deref().unwrap_or("user");
    match scope {
        "node" | "project" => true,
        // user scope (and any unknown scope, treated as user) → owner-only.
        _ => matches!(
            (chunk.owner_user_id.as_deref(), opts.caller_user_id.as_deref()),
            (Some(owner), Some(caller)) if owner == caller
        ),
    }
}

/// Per-caller tenancy for a SPACE chunk. UNBOUND → no-op. BOUND: an UNOWNED chunk
/// (OKF bundle / legacy manual index) is shared knowledge and stays visible; an
/// OWNED chunk is visible only to its owner, or to the caller's org when explicitly
/// shared (`visibility` in `org`/`team`).
fn space_tenancy_allows(chunk: &RetrievableChunk, opts: &RetrievalOptions) -> bool {
    if !opts.node_bound {
        return true;
    }
    let Some(owner) = chunk.owner_user_id.as_deref() else {
        // Unowned Space chunk = shared knowledge (OKF, node-shared bundle).
        return true;
    };
    if opts.caller_user_id.as_deref() == Some(owner) {
        return true;
    }
    matches!(
        (
            chunk.owner_org_id.as_deref(),
            opts.caller_org_id.as_deref(),
            chunk.visibility.as_deref(),
        ),
        (Some(org), Some(caller_org), Some(vis)) if org == caller_org && (vis == "org" || vis == "team")
    )
}

/// Whether a `Memory` chunk passes the caller's level + active-project filter.
/// Legacy chunks with no `mem_scope` are treated as `"user"` (broadly visible).
/// `read_levels == None` allows every level (unconfigured / back-compat).
/// Project-scoped chunks require `mem_scope_id == opts.project_id`.
fn memory_level_matches(chunk: &RetrievableChunk, opts: &RetrievalOptions) -> bool {
    let scope = chunk.mem_scope.as_deref().unwrap_or("user");
    if let Some(levels) = &opts.read_levels {
        if !levels.iter().any(|l| l == scope) {
            return false;
        }
    }
    if scope == "project" {
        return match (chunk.mem_scope_id.as_deref(), opts.project_id.as_deref()) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        };
    }
    true
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

// ── OKF ingest ──────────────────────────────────────────────────────────────

/// Maximum characters per OKF body chunk before splitting on word boundaries.
/// Mirrors the Space chunk size so the embedder sees comparably sized units.
const OKF_CHUNK_CHAR_SIZE: usize = 1_000;

/// Outcome of [`RetrievalStore::ingest_okf_bundle`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OkfIngestSummary {
    /// The bundle id the concepts were indexed under.
    pub bundle_id: String,
    /// Number of concepts ingested.
    pub concepts: usize,
    /// Number of chunks written (concepts may split into multiple chunks).
    pub chunks: usize,
}

/// A preserved cross-link edge: a concept points at a link target. Relationships
/// are untyped (OKF v0.1), so only source and target are recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OkfEdge {
    /// Bundle-relative path of the concept that contains the link.
    pub concept_path: String,
    /// Link target as written (bundle-absolute `/x.md` or relative `./x.md`).
    pub target: String,
}

/// One materialized chunk row, embedded and ready to commit. Internal to the
/// ingest path so embedding (async, lock-free) and DB writes (locked) stay split.
struct OkfRow {
    chunk_id: String,
    content: String,
    blob: Vec<u8>,
    concept_path: String,
    okf_type: String,
    tags_json: String,
    resource: Option<String>,
    links_json: String,
    chunk_index: i64,
}

/// One row read back during export: a single indexed chunk plus the concept
/// metadata the `okf_chunks` sidecar carries. Internal to
/// [`RetrievalStore::reconstruct_okf_concepts`].
struct OkfExportRow {
    concept_path: String,
    okf_type: String,
    tags_json: String,
    resource: Option<String>,
    links_json: String,
    content: String,
    created_at: i64,
}

/// Reassemble one [`crate::okf::Concept`] from its ordered chunk rows.
///
/// `rows` must be non-empty and all share a `concept_path`. The first chunk's
/// header yields `title`/`description`; bodies are stripped of their headers and
/// rejoined with blank lines.
fn concept_from_export_rows(rows: &[OkfExportRow]) -> crate::okf::Concept {
    let first = &rows[0];
    let okf_type = first.okf_type.clone();
    let tags: Vec<String> = serde_json::from_str(&first.tags_json).unwrap_or_default();
    let link_targets: Vec<String> = serde_json::from_str(&first.links_json).unwrap_or_default();

    let mut title: Option<String> = None;
    let mut description: Option<String> = None;
    let mut body_parts: Vec<String> = Vec::new();
    for (idx, row) in rows.iter().enumerate() {
        let (header, body_chunk) = split_chunk_header(&row.content);
        if idx == 0 {
            let (t, d) = parse_chunk_header(header, &okf_type);
            title = t;
            description = d;
        }
        let body_chunk = body_chunk.trim();
        if !body_chunk.is_empty() {
            body_parts.push(body_chunk.to_owned());
        }
    }
    let body = body_parts.join("\n\n");

    let timestamp =
        chrono::DateTime::from_timestamp_millis(first.created_at).map(|dt| dt.to_rfc3339());

    let links = link_targets
        .into_iter()
        .map(|target| {
            let relative = !target.starts_with('/');
            crate::okf::Link {
                text: target.clone(),
                target,
                relative,
            }
        })
        .collect();

    crate::okf::Concept {
        file_path: first.concept_path.clone(),
        type_: okf_type,
        title,
        description,
        resource: first.resource.clone(),
        timestamp,
        tags,
        extra: std::collections::BTreeMap::new(),
        body,
        links,
    }
}

/// Split a stored chunk into its leading header line and the body remainder.
/// Ingest always prepends a non-empty header followed by `\n`, so a present
/// newline marks the boundary; without one the whole content is the header
/// (an empty-body concept).
fn split_chunk_header(content: &str) -> (&str, &str) {
    content.split_once('\n').unwrap_or((content, ""))
}

/// Recover `(title, description)` from a chunk header of the form
/// `{title} [{type}] {description}`. The bracketed type acts as the delimiter;
/// either side may be empty. If the marker is absent, the whole header is taken
/// as the title.
fn parse_chunk_header(header: &str, okf_type: &str) -> (Option<String>, Option<String>) {
    let marker = format!("[{okf_type}]");
    if let Some(pos) = header.find(&marker) {
        let before = header[..pos].trim();
        let after = header[pos + marker.len()..].trim();
        let title = (!before.is_empty()).then(|| before.to_owned());
        let description = (!after.is_empty()).then(|| after.to_owned());
        (title, description)
    } else {
        let header = header.trim();
        ((!header.is_empty()).then(|| header.to_owned()), None)
    }
}

/// Build a short context header for a concept's chunks so each chunk is
/// retrievable on its own (title + bracketed type + description).
fn okf_chunk_header(concept: &crate::okf::Concept) -> String {
    let mut parts = Vec::new();
    if let Some(title) = concept.title.as_deref().filter(|s| !s.is_empty()) {
        parts.push(title.to_owned());
    }
    parts.push(format!("[{}]", concept.type_));
    if let Some(desc) = concept.description.as_deref().filter(|s| !s.is_empty()) {
        parts.push(desc.to_owned());
    }
    parts.join(" ")
}

/// Split a concept body into chunks of at most [`OKF_CHUNK_CHAR_SIZE`] chars,
/// breaking on paragraph then word boundaries. An empty body yields no chunks so
/// the header alone still carries the concept (handled by the caller).
fn chunk_okf_body(body: &str) -> Vec<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return vec![String::new()];
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    for paragraph in trimmed.split("\n\n") {
        for word in paragraph.split_whitespace() {
            if current.chars().count() + word.chars().count() + 1 > OKF_CHUNK_CHAR_SIZE
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
            RetrievalOwner::shared())
            .await
            .unwrap();
        store
            .index_chunk(
                "s1",
                ChunkSource::Space,
                Some("docs"),
                "Ryu Core runs on port 7980 and routes chat through adapters.",
            RetrievalOwner::shared())
            .await
            .unwrap();
        store
            .index_chunk(
                "s2",
                ChunkSource::Space,
                Some("docs"),
                "The gateway enforces firewall, routing, and budgets.",
            RetrievalOwner::shared())
            .await
            .unwrap();
        store
            .index_chunk(
                "s3",
                ChunkSource::Space,
                Some("recipes"),
                "Preheat the oven to 200 degrees and bake the bread.",
            RetrievalOwner::shared())
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
            ..Default::default()
        };
        let hits = store.retrieve("oven bread bake", &opts).await.unwrap();
        assert!(!hits.is_empty());
        assert!(hits
            .iter()
            .all(|c| c.space_id.as_deref() == Some("recipes")));
    }

    /// Memory-scope filter: a project-scoped memory chunk is only retrieved when
    /// the caller's `read_levels` includes `project` AND `project_id` matches; a
    /// user-only caller never sees it.
    #[tokio::test]
    async fn memory_level_filter_gates_project_scope() {
        let store = RetrievalStore::open_in_memory().unwrap();
        store
            .index_memory_chunk(
                "mu",
                "the user prefers concise answers",
                "user",
                None,
                "preference",
                3,
            RetrievalOwner::shared())
            .await
            .unwrap();
        store
            .index_memory_chunk(
                "mp",
                "this project uses pnpm and vitest",
                "project",
                Some("/proj/x"),
                "project_context",
                4,
            RetrievalOwner::shared())
            .await
            .unwrap();

        // User-only agent: never sees the project chunk, even inside project X.
        let user_only = RetrievalOptions {
            top_k: 10,
            read_levels: Some(vec!["user".to_owned()]),
            project_id: Some("/proj/x".to_owned()),
            ..Default::default()
        };
        let hits = store
            .retrieve("what does the project use", &user_only)
            .await
            .unwrap();
        assert!(
            hits.iter().all(|c| c.id != "mp"),
            "project chunk must be hidden from a user-only agent"
        );

        // Project-enabled agent in project X: the project chunk is retrievable.
        let in_x = RetrievalOptions {
            top_k: 10,
            read_levels: Some(vec!["user".to_owned(), "project".to_owned()]),
            project_id: Some("/proj/x".to_owned()),
            ..Default::default()
        };
        let hits_x = store
            .retrieve("what does the project use", &in_x)
            .await
            .unwrap();
        assert!(
            hits_x.iter().any(|c| c.id == "mp"),
            "project chunk must surface inside its project"
        );

        // Same agent in a DIFFERENT project: the project chunk is excluded.
        let in_y = RetrievalOptions {
            top_k: 10,
            read_levels: Some(vec!["user".to_owned(), "project".to_owned()]),
            project_id: Some("/proj/y".to_owned()),
            ..Default::default()
        };
        let hits_y = store
            .retrieve("what does the project use", &in_y)
            .await
            .unwrap();
        assert!(
            hits_y.iter().all(|c| c.id != "mp"),
            "project chunk must not leak into another project"
        );
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
            ..Default::default()
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

    // ── OKF ingest ────────────────────────────────────────────────────────────

    fn sample_bundle() -> crate::okf::Bundle {
        let orders = crate::okf::Concept::parse(
            "tables/orders.md",
            "---\ntype: BigQuery Table\ntitle: Orders\ntags:\n- sales\n---\n\
             # Schema\n\nThe orders fact table records customer purchases. \
             See [Customers](/tables/customers.md).\n",
        )
        .expect("parse orders");
        let recipe = crate::okf::Concept::parse(
            "recipes/bread.md",
            "---\ntype: Playbook\ntitle: Bread\n---\n\
             Preheat the oven to 200 degrees and bake the sourdough loaf.\n",
        )
        .expect("parse recipe");
        crate::okf::Bundle {
            root: std::path::PathBuf::from("/tmp/bundle"),
            concepts: vec![orders, recipe],
            index: None,
            log: None,
            okf_version: Some("0.1".to_owned()),
            warnings: Vec::new(),
        }
    }

    #[tokio::test]
    async fn ingests_okf_bundle_and_retrieves_concept() {
        let store = RetrievalStore::open_in_memory().unwrap();
        let summary = store
            .ingest_okf_bundle("b1", &sample_bundle())
            .await
            .unwrap();
        assert_eq!(summary.concepts, 2);
        assert!(summary.chunks >= 2);

        let opts = RetrievalOptions {
            top_k: 1,
            ..Default::default()
        };
        let hits = store
            .retrieve("orders fact table customer purchases", &opts)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        // Indexed as a Space scoped to the bundle id.
        assert_eq!(hits[0].source, ChunkSource::Space);
        assert_eq!(hits[0].space_id.as_deref(), Some("b1"));
        assert!(hits[0].content.contains("Orders"));
    }

    #[tokio::test]
    async fn okf_cross_links_are_preserved_as_edges() {
        let store = RetrievalStore::open_in_memory().unwrap();
        store
            .ingest_okf_bundle("b1", &sample_bundle())
            .await
            .unwrap();
        let edges = store.okf_links("b1").await.unwrap();
        assert!(edges
            .iter()
            .any(|e| e.concept_path == "tables/orders.md" && e.target == "/tables/customers.md"));
    }

    #[tokio::test]
    async fn reingest_is_idempotent_on_concept_path() {
        let store = RetrievalStore::open_in_memory().unwrap();
        let first = store
            .ingest_okf_bundle("b1", &sample_bundle())
            .await
            .unwrap();
        // Re-ingesting the same bundle replaces rather than duplicates.
        let second = store
            .ingest_okf_bundle("b1", &sample_bundle())
            .await
            .unwrap();
        assert_eq!(first.chunks, second.chunks);

        let edges = store.okf_links("b1").await.unwrap();
        // Exactly one edge for the cross-link, not duplicated by re-ingest.
        let customer_edges = edges
            .iter()
            .filter(|e| e.target == "/tables/customers.md")
            .count();
        assert_eq!(customer_edges, 1);
    }

    #[tokio::test]
    async fn remove_okf_bundle_clears_chunks() {
        let store = RetrievalStore::open_in_memory().unwrap();
        store
            .ingest_okf_bundle("b1", &sample_bundle())
            .await
            .unwrap();
        let removed = store.remove_okf_bundle("b1").await.unwrap();
        assert!(removed >= 2);

        let opts = RetrievalOptions {
            top_k: 5,
            ..Default::default()
        };
        let hits = store
            .retrieve("orders fact table sourdough", &opts)
            .await
            .unwrap();
        assert!(hits.is_empty());
        // Edges gone too.
        assert!(store.okf_links("b1").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn reconstruct_okf_concepts_round_trips_metadata_and_body() {
        let store = RetrievalStore::open_in_memory().unwrap();
        store
            .ingest_okf_bundle("b1", &sample_bundle())
            .await
            .unwrap();

        let mut concepts = store.reconstruct_okf_concepts("b1").await.unwrap();
        assert_eq!(concepts.len(), 2);
        concepts.sort_by(|a, b| a.file_path.cmp(&b.file_path));

        // recipes/bread.md sorts before tables/orders.md.
        let bread = &concepts[0];
        assert_eq!(bread.file_path, "recipes/bread.md");
        assert_eq!(bread.type_, "Playbook");
        assert_eq!(bread.title.as_deref(), Some("Bread"));
        assert!(bread.body.contains("Preheat the oven"));

        let orders = &concepts[1];
        assert_eq!(orders.file_path, "tables/orders.md");
        assert_eq!(orders.type_, "BigQuery Table");
        assert_eq!(orders.title.as_deref(), Some("Orders"));
        assert_eq!(orders.tags, vec!["sales".to_owned()]);
        assert!(orders.body.contains("orders fact table"));
        // Cross-link target survives reconstruction.
        assert!(orders
            .links
            .iter()
            .any(|l| l.target == "/tables/customers.md"));
        // Timestamp is stamped from the indexed chunk's created_at.
        assert!(orders.timestamp.is_some());

        // Unknown bundle yields no concepts (not an error).
        assert!(store
            .reconstruct_okf_concepts("nope")
            .await
            .unwrap()
            .is_empty());
    }

    // ── Per-caller tenancy (the content-escape filter) ────────────────────────
    //
    // These are the acceptance tests for the retrieval half of the Spaces/memory
    // tenancy plane: `/api/retrieval/search` is where document CONTENT and
    // user-scope memory actually escape (decrypted chunks), so the filter here is
    // the highest-value one. They drive `retrieve()` end-to-end with a bound-node
    // `RetrievalOptions` — no org registration needed, because the caller tenancy is
    // passed IN (the same "pure form" trick the conversation plane's ACL uses).

    /// Seed Alice's + Bob's user-scope memory and a shared node-scope fact, all with
    /// the same content so cosine ranks them together — the filter, not relevance,
    /// decides what each caller sees.
    async fn seed_tenancy(store: &RetrievalStore) {
        let org = Some("org1");
        store
            .index_memory_chunk(
                "alice-mem",
                "the secret launch date is March",
                "user",
                None,
                "user_fact",
                3,
                RetrievalOwner::owned(Some("alice"), org, None),
            )
            .await
            .unwrap();
        store
            .index_memory_chunk(
                "bob-mem",
                "the secret launch date is March",
                "user",
                None,
                "user_fact",
                3,
                RetrievalOwner::owned(Some("bob"), org, None),
            )
            .await
            .unwrap();
        store
            .index_memory_chunk(
                "shared-node-mem",
                "the secret launch date is March",
                "node",
                None,
                "organization",
                3,
                RetrievalOwner::owned(Some("alice"), org, None),
            )
            .await
            .unwrap();
    }

    fn bound_opts(caller: &str) -> RetrievalOptions {
        RetrievalOptions {
            top_k: 10,
            min_score: 0.0,
            node_bound: true,
            caller_user_id: Some(caller.to_owned()),
            caller_org_id: Some("org1".to_owned()),
            ..Default::default()
        }
    }

    /// THE explicit content-escape test: on a bound node Bob CANNOT retrieve Alice's
    /// user-scope memory, but the shared node-scope fact IS visible to him.
    #[tokio::test]
    async fn bob_cannot_retrieve_alices_user_memory_but_shares_node_memory() {
        let store = RetrievalStore::open_in_memory().unwrap();
        seed_tenancy(&store).await;

        let hits = store
            .retrieve("secret launch date", &bound_opts("bob"))
            .await
            .unwrap();
        let ids: Vec<&str> = hits.iter().map(|c| c.id.as_str()).collect();
        assert!(!ids.contains(&"alice-mem"), "Bob must NOT see Alice's user-scope memory");
        assert!(ids.contains(&"bob-mem"), "Bob sees his own user-scope memory");
        assert!(
            ids.contains(&"shared-node-mem"),
            "node-scope memory is the shared brain, visible to Bob"
        );
    }

    /// No-lockout: Alice reaches her OWN user-scope memory (+ the shared fact).
    #[tokio::test]
    async fn alice_retrieves_her_own_user_memory() {
        let store = RetrievalStore::open_in_memory().unwrap();
        seed_tenancy(&store).await;

        let hits = store
            .retrieve("secret launch date", &bound_opts("alice"))
            .await
            .unwrap();
        let ids: Vec<&str> = hits.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"alice-mem"));
        assert!(ids.contains(&"shared-node-mem"));
        assert!(!ids.contains(&"bob-mem"), "Alice must not see Bob's private memory");
    }

    /// An UNBOUND node is byte-identical: no owner filtering, every chunk visible
    /// regardless of who owns it (the default `node_bound = false`).
    #[tokio::test]
    async fn unbound_node_retrieval_is_unfiltered() {
        let store = RetrievalStore::open_in_memory().unwrap();
        seed_tenancy(&store).await;

        let opts = RetrievalOptions {
            top_k: 10,
            ..Default::default()
        };
        let hits = store.retrieve("secret launch date", &opts).await.unwrap();
        let ids: Vec<&str> = hits.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"alice-mem"));
        assert!(ids.contains(&"bob-mem"));
        assert!(ids.contains(&"shared-node-mem"));
    }

    /// A Space chunk owned by Alice (visibility private) does not escape to Bob, but
    /// an UNOWNED (OKF / shared-knowledge) Space chunk stays visible to everyone.
    #[tokio::test]
    async fn space_chunk_owner_filter_and_shared_okf() {
        let store = RetrievalStore::open_in_memory().unwrap();
        store
            .index_chunk(
                "alice-doc",
                ChunkSource::Space,
                Some("docs"),
                "quarterly revenue was forty two million",
                RetrievalOwner::owned(Some("alice"), Some("org1"), Some("private")),
            )
            .await
            .unwrap();
        store
            .index_chunk(
                "okf-shared",
                ChunkSource::Space,
                Some("docs"),
                "quarterly revenue reporting standards overview",
                RetrievalOwner::shared(),
            )
            .await
            .unwrap();

        let hits = store
            .retrieve("quarterly revenue", &bound_opts("bob"))
            .await
            .unwrap();
        let ids: Vec<&str> = hits.iter().map(|c| c.id.as_str()).collect();
        assert!(!ids.contains(&"alice-doc"), "Bob must not read Alice's private document chunk");
        assert!(ids.contains(&"okf-shared"), "shared/OKF knowledge stays visible");
    }

    /// The pure filter functions, exercised directly (no DB): the same matrix the
    /// SQL-less unit tests of the conversation plane use.
    #[test]
    fn memory_tenancy_pure_matrix() {
        let base = RetrievableChunk {
            id: "x".into(),
            source: ChunkSource::Memory,
            space_id: None,
            content: String::new(),
            mem_scope: Some("user".into()),
            mem_scope_id: None,
            mem_importance: 3,
            owner_user_id: Some("alice".into()),
            owner_org_id: Some("org1".into()),
            visibility: None,
        };
        let bob = bound_opts("bob");
        let alice = bound_opts("alice");
        // user-scope: owner-only.
        assert!(!memory_tenancy_allows(&base, &bob));
        assert!(memory_tenancy_allows(&base, &alice));
        // node/project: shared.
        let node = RetrievableChunk { mem_scope: Some("node".into()), ..base.clone() };
        assert!(memory_tenancy_allows(&node, &bob));
        // unbound: everything.
        let unbound = RetrievalOptions::default();
        assert!(memory_tenancy_allows(&base, &unbound));
    }
}
