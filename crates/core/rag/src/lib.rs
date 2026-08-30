//! Retrieval-augmented-generation primitive (spec unit U17): embedder, reranker,
//! and the sqlite-backed `RetrievalStore` behind the `RagProvider` trait.
//!
//! Wires retrieval into the chat path: embed the query, search short/long-term
//! memory + Spaces, merge and rank by relevance, optionally re-rank the top-K
//! candidates, and return the final chunks so the caller can inject them into the
//! model context before the model call.
//!
//! This is an extracted Core capability crate (`crates/ryu-rag`) with ZERO
//! dependency on `apps/core`. Model/provider *selection* stays Core-side in the
//! single resolver `apps/core/src/rag_host.rs`, keyed by the bound provider-id:
//! every embedder/reranker/store here is constructed from plain config
//! (`base_url`/`model`/`dims`), never from the model registry, so the swap seam is
//! one construction origin and the per-space embedder is a `RagProvider`/`Embedder`
//! INSTANCE a consumer holds, not a process-global singleton.
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): retrieval is part of
//! *what runs* (orchestration: which chunks ground the answer), not *what is
//! allowed/measured/paid*, so it belongs in Core. Policy on whether a Space is
//! reachable would be a Gateway concern; mechanically searching and merging the
//! chunks Core already holds is orchestration.

use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex as StdMutex, RwLock,
};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_kernel_contracts::ResourceKey;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

mod memory_graph;

pub use memory_graph::{
    MemoryGraph, MemoryGraphDocument, MemoryGraphEdge, MemoryGraphHit, MemoryGraphNode,
    MemoryGraphNodeKind, MemoryGraphQuery, MemoryGraphSnapshot,
};

/// The active RAG provider contract: embed a query, retrieve grounding chunks, and
/// rerank candidates. The in-process [`RetrievalStore`] is the default impl; a
/// future out-of-process provider (e.g. a GraphRAG sidecar) implements the same
/// three verbs and is selected by the Core-side resolver keyed on the bound
/// provider-id. Consumers hold an instance minted by that one resolver, so a
/// provider swap moves every consumer together (no silent half-swap).
#[async_trait::async_trait]
pub trait RagProvider: Send + Sync {
    /// Embed a single query into a normalized vector.
    async fn embed(&self, text: &str) -> Result<Vec<f32>>;
    /// Retrieve the top grounding chunks for `query` under `opts`.
    async fn retrieve(&self, query: &str, opts: &RetrievalOptions) -> Result<Vec<ScoredChunk>>;
    /// Re-score and reorder `candidates` relative to `query` (best-first).
    async fn rerank(&self, query: &str, candidates: Vec<ScoredChunk>) -> Result<Vec<ScoredChunk>>;
}

/// Delegate that answers `opts.space_ids` **out of the Spaces store**, honouring
/// each Space's own `retrieval_mode`.
///
/// # Why this exists (read before "simplifying" it away)
///
/// `retrieval.db` (this crate) and `spaces.db` (`ryu-spaces`) are two different
/// databases, and a Space's *documents never enter this one*. The only writers of
/// `ChunkSource::Space` rows here are [`RetrievalStore::index_chunk`] (the manual
/// `POST /api/retrieval/index`, which no shipped client calls with a `space_id`)
/// and [`RetrievalStore::ingest_okf_bundle`], whose `space_id` is a **bundle id**,
/// not a Space id. So before this trait, `space_ids` — the agent's Space
/// allowlist on every chat turn, and the `space_ids` body field of
/// `POST /api/retrieval/search` — could not match a single row: a settable value
/// that could not take effect.
///
/// A Space's entity graph (`graph_nodes`/`graph_edges`) lives in `spaces.db` and
/// is built at ingest, gated on the Space's mode. Mirroring it here would give the
/// node **two entity graphs that can disagree**, which is a worse defect than the
/// one this closes. Delegation keeps exactly one graph, in the database that
/// maintains it.
///
/// The implementation (`apps/core/src/rag_host.rs`) is a thin call into
/// `SpaceStore::search_ext`, which already branches on the Space's own
/// `retrieval_mode` — so **no mode-resolution logic is duplicated here**, and a
/// Space set to `graph` is answered by traversal on the chat path exactly as it is
/// in the Spaces search box. Deliberately *not* mode-split at this layer: routing
/// only graph-mode Spaces through the Spaces store would leave vector-mode Spaces
/// returning nothing in chat, i.e. "set the Space to Graph and it starts working".
///
/// # Costs this delegation adds, honestly
///
/// - One `search_ext` per selected Space per retrieval. Each does a KNN (or BFS)
///   plus a rerank attempt against the (default-off, lazily started) reranker
///   server, which fails open. `space_ids: Some([])` — the default agent, and the
///   default chat turn — skips the hook entirely, so the common path is unchanged.
/// - `SpaceStore` serves every Space from ONE connection behind one mutex, and
///   **four** write paths hold it long enough to matter — not just the obvious
///   one. `set_retrieval_mode`'s graph rebuild holds it for **minutes** on a large
///   Space; `ingest_document` and `update_document` hold it for the whole
///   `build_graph_for_chunks` pass on a graph-mode Space, which is `O(chunks ×
///   entities²)` and is *not* bounded by "one document" (one uploaded book is one
///   document). `create_file` joined them: its single descriptor chunk (`title` +
///   `mime`) now obeys the Space's mode instead of a hardcoded `Vector`, and while
///   one chunk sounds free, the descriptor is never split by `chunk_text` and
///   `title` is uncapped at every HTTP/MCP entry point, so its edge fan-out is
///   bounded by the caller's filename rather than by `CHUNK_CHAR_SIZE`. A retrieval
///   overlapping any of the four blocks on that mutex; on
///   the chat path `AUTO_RECALL_TIMEOUT` (4 s) turns that into "no recall this
///   turn" rather than a stalled reply. No timeout is imposed here (this crate
///   builds tokio without the `time` feature, and a second timeout policy on top
///   of the caller's is worse than one).
///
///   All four now run their transaction on `tokio::task::spawn_blocking`, which
///   is what makes the sentence above *true* rather than optimistic: while a write
///   held the mutex inline on the runtime worker, a recall waiting on it could not
///   be polled and its 4 s deadline could not fire either. Moving the writes off
///   the worker did not shorten the wait — it made the wait interruptible. If a
///   fifth long write path is ever added to `SpaceStore`, it belongs on the
///   blocking pool for this reason and must be added to this list.
///
/// # What a graph-mode Space hit costs in *precision*, and what was accepted
///
/// This is a retrieval-quality trade, and it is written here rather than left to be
/// rediscovered, because the delegate is what put it on **every** chat turn for an
/// allowlisted Space.
///
/// A graph hit carries no relevance score (see [`fuse_ranked_lists`]) — so the
/// merge is by rank, and the graph list's rank-0 element enters the fused ranking at
/// **parity with the best cosine hit**, beating the second-best cosine hit. What
/// justifies that placement is the multi-hop case the feature exists for, where the
/// correct chunk shares no term with the query and cosine cannot rank it at all;
/// what it costs is that a merely-plausible graph hit gets the same seat.
///
/// Two things bound the damage, and one deliberately does not:
///
/// - **Seeds have a floor.** `ryu_spaces::SEED_MAX_CHUNK_FRACTION` stops a word that
///   appears in most of a Space from seeding the traversal while a rarer query word
///   can. Be precise about what that buys, because the bound is easy to overstate:
///   it changes **which chunk is visited first**, and therefore what occupies rank 0
///   — the position this fusion injects. It does *not* purge common-word chunks from
///   the result, since a flooding entity that co-occurs with the rare one in the same
///   chunk (usually the case, which is why the user typed both) is rediscovered as a
///   hop-1 neighbour and expands normally. Seed selection, not a filter.
/// - **The list is relevance-ordered.** `SpaceStore::search_ext` reranks its
///   candidates with the bge cross-encoder before returning them, so rank 0 is the
///   most relevant of what the traversal found.
/// - **Nothing is dropped for being weakly relevant.** The reranker reorders, it
///   does not threshold, and hop-1..3 chunks have no relevance requirement of their
///   own. So a graph-mode Space always contributes *something* when any query token
///   matches anything in it. Adding a threshold there would have to reject the
///   multi-hop answer too — it is a chunk with zero query overlap by construction —
///   so the floor was put on the seeds instead, where it discriminates without
///   cutting the traversal.
///
/// Demoting Space hits below the best cosine hit was considered and **not** done:
/// this layer cannot tell a graph-mode Space list from a vector-mode one (see
/// `rag_host::SpacesRecall`, which deliberately erases the distinction because a
/// `vec0` distance and a synthetic 0.0 are not comparable), so the demotion would
/// hit vector-mode Spaces too — i.e. it would make a Space's own documents rank
/// below memory on every turn, which is a bigger regression than the one it fixes.
#[async_trait::async_trait]
pub trait SpaceRecall: Send + Sync {
    /// Return ONE best-first ranked list **per Space** that `opts` selects — not a
    /// flat merged list. Separate lists are what lets [`fuse_ranked_lists`] treat
    /// each Space as its own ranking, which is required because scores are not
    /// comparable across Spaces (per-Space embedder) or across modes (a graph hit
    /// has no distance at all).
    ///
    /// `opts.space_ids`: `Some(ids)` = those Spaces; `Some([])` = none (the caller
    /// must skip this trait entirely); `None` = every Space the caller may READ,
    /// which the implementation enumerates under the same tenancy filter.
    ///
    /// `per_space_limit` is the cap for each list. Tenancy comes from
    /// `opts.node_bound`/`caller_user_id`/`caller_org_id`, which the implementation
    /// lowers into the Spaces `DocFilter` so a delegated search can never return a
    /// document the caller may not read.
    ///
    /// Fail-open per Space: an implementation SHOULD warn and skip a Space whose
    /// search fails rather than abort the whole recall. An `Err` here means the
    /// Space set itself could not be resolved; the caller warns and continues with
    /// the `retrieval.db` half.
    async fn recall(
        &self,
        query: &str,
        opts: &RetrievalOptions,
        per_space_limit: usize,
    ) -> Result<Vec<Vec<ScoredChunk>>>;
}

/// Reciprocal-rank-fusion constant (Cormack et al., 2009). Damps the head of each
/// list so one list's rank-0 hit cannot dominate; 60 is the published default and
/// is used here unchanged so the merge is a known quantity rather than a tuned
/// mystery.
const RRF_K: f32 = 60.0;

/// Merge ranked lists that have **no comparable score** into one ranking, by rank
/// position only (reciprocal rank fusion): `score = Σ 1/(K + rank)` over the lists
/// a chunk appears in, `rank` 0-based.
///
/// # Why rank fusion and not "sort by score"
///
/// The lists being merged are scored on incompatible scales:
///
/// - the `retrieval.db` list carries a cosine similarity (`0..1`-ish), optionally
///   overwritten by a cross-encoder relevance score;
/// - a Space list in **vector** mode carries a real `vec0` distance (lower is
///   better — the *opposite* direction);
/// - a Space list in **graph** mode carries a constant `0.0`, because a traversal
///   hit has no metric distance at all.
///
/// Sorting the union by any of those numbers is meaningless, and sorting by
/// `distance` specifically would put **every graph hit first** (0.0 beats every
/// real distance) — the trap this function exists to avoid. Rank position is the
/// one signal every list genuinely has, and each list is already best-first under
/// its own strategy (Space lists are reranked inside `search_ext`; the
/// `retrieval.db` list is reranked inside `retrieve`).
///
/// # Resulting order, and its tie-break
///
/// With `K` much larger than the list lengths, `1/(K + rank)` is dominated by
/// `rank`, so equal ranks tie and the output **interleaves**: `primary[0]`,
/// `others[0][0]`, `others[1][0]`, …, `primary[1]`, … Ties are broken (1) by list,
/// `primary` first — it carries memory, and it is the pre-existing behaviour — then
/// in the order the caller passed the other lists (which is the Space order), and
/// (2) by chunk id, so the output is fully deterministic for a given input and a
/// re-run of the same query cannot reshuffle the injected context.
///
/// A chunk appearing in more than one list (possible only if the same id was
/// manually indexed into `retrieval.db` AND lives in a delegated Space) sums its
/// contributions once, in a single output row — it is not duplicated.
///
/// The returned `score` is an RRF score (~`1/60`), **not** a similarity. Callers
/// that need cosine must not call this; [`RetrievalStore::retrieve`] only calls it
/// when at least one Space list participates, and returns the untouched cosine
/// list otherwise.
#[must_use]
pub fn fuse_ranked_lists(
    primary: Vec<ScoredChunk>,
    others: Vec<Vec<ScoredChunk>>,
    top_k: usize,
) -> Vec<ScoredChunk> {
    // Structural no-op: with nothing to fuse, the primary list is returned exactly
    // as it came in — same order, same cosine scores. This is what keeps every
    // caller that selects no Spaces byte-identical.
    if others.iter().all(Vec::is_empty) {
        let mut out = primary;
        out.truncate(top_k);
        return out;
    }

    /// One fused row: the chunk, its summed RRF score, and the two tie-break keys
    /// (best = lowest list index, then lowest rank within that list).
    struct Fused {
        chunk: ScoredChunk,
        score: f32,
        list: usize,
        rank: usize,
    }

    let mut fused: Vec<Fused> = Vec::new();
    let mut index_by_id: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for (list_idx, list) in std::iter::once(primary).chain(others).enumerate() {
        for (rank, chunk) in list.into_iter().enumerate() {
            let contribution = 1.0 / (RRF_K + rank as f32);
            match index_by_id.get(&chunk.id) {
                Some(&existing) => {
                    let row = &mut fused[existing];
                    row.score += contribution;
                    // Keep the best (earliest) position seen for the tie-break.
                    if (list_idx, rank) < (row.list, row.rank) {
                        row.list = list_idx;
                        row.rank = rank;
                    }
                }
                None => {
                    index_by_id.insert(chunk.id.clone(), fused.len());
                    fused.push(Fused {
                        chunk,
                        score: contribution,
                        list: list_idx,
                        rank,
                    });
                }
            }
        }
    }

    fused.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.list.cmp(&b.list))
            .then_with(|| a.rank.cmp(&b.rank))
            .then_with(|| a.chunk.id.cmp(&b.chunk.id))
    });
    fused.truncate(top_k);
    fused
        .into_iter()
        .map(|f| ScoredChunk {
            score: f.score,
            ..f.chunk
        })
        .collect()
}

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
    /// Memory scope level (`"agent"`/`"user"`/`"node"`/`"project"`/`"org"`) for `Memory` chunks;
    /// `None` for Space/OKF. Legacy memory chunks (pre-scoping) are treated as
    /// `"user"` by the level filter.
    #[serde(default)]
    pub mem_scope: Option<String>,
    /// Project folder path when `mem_scope == "project"`.
    #[serde(default)]
    pub mem_scope_id: Option<String>,
    /// Agent id used by the memory graph and `agent` scope filter.
    #[serde(default)]
    pub mem_agent_id: Option<String>,
    /// 1..=5 importance for `Memory` chunks; used to boost ranking.
    #[serde(default)]
    pub mem_importance: i32,
    /// Whether the source memory was classified as a sensitive topic.
    #[serde(default)]
    pub mem_sensitive: bool,
    /// Whether the denormalized memory metadata has been refreshed from the
    /// encrypted source of truth. Legacy rows default to false and are hidden
    /// when sensitive-memory consent is disabled rather than being treated as
    /// ordinary non-sensitive facts.
    #[serde(default)]
    pub mem_metadata_ready: bool,
    /// Denormalized owner (the source document's / memory's `owner_user_id`), so the
    /// per-caller tenancy filter runs in-process without a cross-store join. `None`
    /// is fail-closed for BOTH sources on a bound node: owner-only (invisible to a
    /// mismatched caller) for user-scope `Memory`, and hidden unless the chunk also
    /// carries an explicit `owner_org_id`/`visibility` shared stamp for `Space`
    /// (OKF bundles stamp one; a bare-unowned Space chunk is legacy/unattributed,
    /// not shared). Refreshed for legacy rows by `backfill_memory_owner` /
    /// `backfill_okf_space_owner`.
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
    /// Relevance, higher is better — but the *scale* depends on how the result set
    /// was produced. It is a cosine similarity (or a cross-encoder relevance score)
    /// when every hit came from `retrieval.db`, and a rank-fusion score (~`1/60`,
    /// see [`fuse_ranked_lists`]) once a delegated Space contributes, because
    /// Space hits carry no score comparable to a cosine. Comparable *within* one
    /// result set; never comparable across calls or against a fixed threshold.
    pub score: f32,
}

/// Per-request / per-agent retrieval configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievalOptions {
    /// Maximum number of chunks to inject after ranking and optional reranking.
    pub top_k: usize,
    /// Which Spaces to search. `None` searches all Spaces; an empty list
    /// searches no Spaces (memory only).
    ///
    /// This selects two different things, which is deliberate: the `space_id`
    /// column of this store's own chunks (in practice the OKF bundles — a bundle id
    /// is stored in that column), AND, when a [`SpaceRecall`] delegate is wired,
    /// the real Spaces answered out of `spaces.db` under their own
    /// `retrieval_mode`. Before that delegate existed, a real Space id here matched
    /// nothing, because a Space's documents are never indexed into this store.
    pub space_ids: Option<Vec<String>>,
    /// Whether to include memory (U11) in the search.
    pub include_memory: bool,
    /// Memory scope levels the caller (agent) may read (`"agent"`/`"user"`/
    /// `"node"`/`"project"`/`"org"`). `None` searches every personal level
    /// (unconfigured / back-compat) but excludes organization memory;
    /// `Some` restricts memory chunks to the listed levels.
    #[serde(default)]
    pub read_levels: Option<Vec<String>>,
    /// The active project folder path. Project-scoped memory chunks are only
    /// matched when their `mem_scope_id` equals this. `None` excludes all
    /// project-scoped memory.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Active agent id. Agent-scoped memory requires this exact scope id.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Whether this caller's server-resolved consent allows sensitive memories.
    /// This is never taken from an untrusted retrieval request on the server.
    #[serde(default)]
    pub include_sensitive: bool,
    /// Drop chunks whose relevance falls below this score (0.0 keeps everything).
    ///
    /// **Scope: this store's own chunks only.** A hit delegated to the Spaces store
    /// ([`SpaceRecall`]) carries no score on a comparable scale — in graph mode it
    /// carries no score at all — so there is nothing to threshold, and delegated
    /// hits pass through regardless of this value. Suppressing whole Spaces when a
    /// non-zero threshold is set was the alternative and was rejected: it would
    /// make an unrelated knob silently turn Spaces off. Callers that need a hard
    /// cutoff over Space content should search the Space directly
    /// (`POST /api/spaces/:id/search`), which ranks within one comparable scale.
    pub min_score: f32,
    /// How many candidates to collect before reranking. Must be >= top_k.
    /// Defaults to `top_k * 4` when not set.
    pub rerank_candidates: Option<usize>,
    /// Per-caller tenancy — the retrieval twin of the Spaces `DocFilter`. When
    /// `node_bound` is `false` (default / UNBOUND node) NO owner filtering runs, so
    /// every existing caller is byte-identical. When `true`, a user-scope memory
    /// chunk is returned only to its owner (`caller_user_id`), and a `Space` chunk
    /// only if owned by the caller or explicitly shared to their org/team
    /// (`caller_org_id` matching the chunk's stamped `owner_org_id`) — a bare
    /// unowned `Space` chunk is hidden (fail-closed).
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
            agent_id: None,
            include_sensitive: false,
            min_score: 0.0,
            rerank_candidates: None,
            node_bound: false,
            caller_user_id: None,
            caller_org_id: None,
        }
    }
}

impl RetrievalOptions {
    /// Set the per-caller tenancy fields from the shared [`ResourceKey`]
    /// composition layer, together with the node's `node_bound` flag. The key
    /// collapses to its `(user, org)` pair; `node_bound = false` (an UNBOUND node)
    /// keeps filtering a total no-op regardless of the key — the invariant that
    /// stops a personal node from filtering itself out. This is the
    /// "accept-or-derive a ResourceKey internally" seam for the retrieval filter.
    #[must_use]
    pub fn with_caller_key(mut self, key: &ResourceKey, node_bound: bool) -> Self {
        let (user_id, org_id) = key.to_tenancy_parts();
        self.node_bound = node_bound;
        self.caller_user_id = user_id.map(str::to_owned);
        self.caller_org_id = org_id.map(str::to_owned);
        self
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
    pub fn owned(
        user_id: Option<&'a str>,
        org_id: Option<&'a str>,
        visibility: Option<&'a str>,
    ) -> Self {
        Self {
            user_id,
            org_id,
            visibility,
        }
    }

    /// Derive a chunk owner from the shared [`ResourceKey`] composition layer. The
    /// key collapses to its `(user, org)` pair (byte-identical to [`Self::owned`]
    /// fed that pair); `visibility` is orthogonal to the key and stays `None` here
    /// (a chunk's sharing visibility is set by its source row, not the tenancy
    /// address). This is the "accept-or-derive a ResourceKey internally" seam for
    /// the retrieval plane.
    ///
    /// FOLLOWUP (deferred this wave): the key's `project`/`session`/`node` fields
    /// are not consulted — a later wave folds `project` into project-scoped recall.
    pub fn from_resource_key(key: &'a ResourceKey) -> Self {
        let (user_id, org_id) = key.to_tenancy_parts();
        Self::owned(user_id, org_id, None)
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
    /// Build a remote OpenAI-compatible embedder from plain config, or fall back to
    /// the dependency-free local hashing embedder when `base_url` is blank.
    ///
    /// The registry/env read (`RYU_EMBED_BASE_URL`, `RYU_EMBED_API_KEY`,
    /// `OPENAI_API_KEY`, registry dims/model) is the Core-side resolver's job
    /// (`apps/core/src/rag_host.rs`) — this crate only takes the resolved config so
    /// it stays free of the model registry.
    pub fn remote(base_url: &str, model: &str, dims: usize, api_key: Option<String>) -> Self {
        let base_url = base_url.trim();
        if base_url.is_empty() {
            return Self::Local { dims };
        }
        Self::Remote {
            base_url: base_url.to_string(),
            model: model.to_string(),
            dims,
            api_key: api_key.filter(|s| !s.is_empty()),
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
                dims,
            } => {
                let embedding =
                    remote_embed(base_url, model, *dims, api_key.as_deref(), text).await?;
                anyhow::ensure!(
                    embedding.len() == *dims,
                    "embedding provider returned {} dimensions for model '{}' (expected {})",
                    embedding.len(),
                    model,
                    dims
                );
                Ok(embedding)
            }
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
    dims: usize,
    api_key: Option<&str>,
    text: &str,
) -> Result<Vec<f32>> {
    static HTTP_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = HTTP_CLIENT.get_or_init(reqwest::Client::new);
    let endpoint = format!("{}/v1/embeddings", base_url.trim_end_matches('/'));
    let payload = serde_json::json!({
        "model": model,
        "input": text,
        "dimensions": dims,
    });
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
    anyhow::ensure!(
        vec.iter().all(|value| value.is_finite()),
        "embeddings response contains a non-finite value"
    );
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
    /// Build a remote cross-encoder reranker from plain config, or the local
    /// term-overlap reranker when `base_url` is blank.
    ///
    /// The registry/env read (`RYU_RERANKER_BASE_URL`, `RYU_RERANKER_API_KEY`, the
    /// registry reranker model/base-url) is the Core-side resolver's job
    /// (`apps/core/src/rag_host.rs`) — this crate only takes the resolved config.
    pub fn remote(base_url: &str, model: &str, api_key: Option<String>) -> Self {
        let base_url = base_url.trim();
        if base_url.is_empty() {
            return Self::Local;
        }
        Self::Remote {
            base_url: base_url.to_string(),
            model: model.to_string(),
            api_key: api_key.filter(|s| !s.is_empty()),
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
                anyhow::ensure!(
                    ranked.len() == documents.len()
                        && ranked
                            .iter()
                            .map(|(idx, _)| *idx)
                            .collect::<std::collections::HashSet<_>>()
                            .len()
                            == documents.len(),
                    "rerank response must contain exactly one result for every document"
                );
                anyhow::ensure!(
                    ranked.iter().all(|(_, score)| score.is_finite()),
                    "rerank response contains a non-finite score"
                );
                ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
                Ok(ranked)
            }
        }
    }

    /// Returns the model identifier for this reranker. The `Local` reranker has no
    /// model of its own, so callers pass the configured default reranker id as the
    /// fallback (the Core-side resolver supplies it from the registry).
    pub fn model_id<'a>(&'a self, local_fallback: &'a str) -> &'a str {
        match self {
            Self::Local => local_fallback,
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
    embedder: Arc<RwLock<Embedder>>,
    reranker: Reranker,
    /// Configured default reranker model id — the fallback reported for the local
    /// reranker (which has no model of its own). Resolved Core-side and passed in.
    reranker_model_id: String,
    /// Optional delegate to the Spaces store for `opts.space_ids` (see
    /// [`SpaceRecall`]). `None` — the default and every test construction — leaves
    /// [`Self::retrieve`] byte-identical to the pure-`retrieval.db` behaviour.
    /// Wired ONCE, Core-side, in `rag_host::open_retrieval_store`'s caller
    /// (`apps/core/src/main.rs`), so every consumer of the process store gets it.
    spaces: Option<Arc<dyn SpaceRecall>>,
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

impl RetrievalStore {
    /// Open (or create) the retrieval store at `path` with a chosen embedder,
    /// reranker, and the configured default reranker model id.
    ///
    /// `backfill_owner` = `Some((owner_user_id, owner_org_id))` on an org-bound node
    /// with a signed-in account triggers the one-shot pre-tenancy memory-owner
    /// backfill; `None` (unbound node, or bound-without-account) skips it, byte
    /// identical to the pre-extraction behaviour. The registry/env read and the
    /// account/control-plane lookups that produce these arguments are the
    /// Core-side resolver's job (`apps/core/src/rag_host.rs`).
    pub fn open(
        path: PathBuf,
        embedder: Embedder,
        reranker: Reranker,
        reranker_model_id: String,
        backfill_owner: Option<(String, String)>,
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
        if let Err(e) = Self::backfill_memory_owner(&conn, backfill_owner.clone()) {
            tracing::warn!("retrieval memory-owner backfill skipped: {e:#}");
        }
        // One-shot org-visibility backfill for pre-tenancy OKF Space chunks: stamps
        // the explicit shared stamp `space_tenancy_allows` now requires, so legacy
        // OKF content does not go dark under the fail-closed bare-unowned default.
        // Non-OKF legacy Space chunks (no `okf_chunks` row) are deliberately left
        // unowned — this store cannot tell a leaked private document from
        // node-shared content, so it fails closed exactly like the memory backfill
        // does for a bound-but-unresolvable owner.
        if let Err(e) = Self::backfill_okf_space_owner(&conn, backfill_owner) {
            tracing::warn!("retrieval OKF space-owner backfill skipped: {e:#}");
        }
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            embedder: Arc::new(RwLock::new(embedder)),
            reranker,
            reranker_model_id,
            spaces: None,
        })
    }

    /// Attach the Spaces delegate that answers `opts.space_ids` (see
    /// [`SpaceRecall`] for what it buys and what it costs). Builder form because
    /// the hook needs the `SpaceStore`, which Core opens *before* the retrieval
    /// store; `RetrievalStore` is `Clone` over `Arc`s, so this must be applied to
    /// the ONE instance that goes into `ServerState` — a later `with_space_recall`
    /// on a clone would not reach the copies already handed out.
    #[must_use]
    pub fn with_space_recall(mut self, spaces: Arc<dyn SpaceRecall>) -> Self {
        self.spaces = Some(spaces);
        self
    }

    /// Attribute pre-tenancy MEMORY chunks to the local owner once the node binds —
    /// the retrieval twin of `MemoryStore::backfill` / `ConversationStore::backfill_tenancy`.
    ///
    /// Memory chunks indexed before the `owner_user_id` denorm existed carry NULL
    /// (or the pre-attribution `'local'` sentinel, mirrored from `memory_entries`).
    /// On a bound node the user-scope tenancy filter would then hide them from their
    /// real owner (a lockout). This stamps them to the local vault owner. `owner` is
    /// `None` on an unbound node (or a bound node with no signed-in account) →
    /// return immediately without marking, byte-identical. Idempotent via a marker
    /// row in a dedicated `retrieval_meta` table.
    fn backfill_memory_owner(conn: &Connection, owner: Option<(String, String)>) -> Result<()> {
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
        // Unbound (personal) node, or bound node with no signed-in account: chunks
        // stay unattributed, by design. Not marked.
        let Some((owner, org_id)) = owner else {
            return Ok(());
        };
        let claimed = conn
            .execute(
                "UPDATE chunks SET owner_user_id = ?1, owner_org_id = ?2
                 WHERE source = 'memory'
                   AND (owner_user_id IS NULL OR owner_user_id = 'local')",
                params![owner, org_id],
            )
            .context("backfilling retrieval memory-chunk owner")?;
        conn.execute(
            "INSERT OR REPLACE INTO retrieval_meta (key, value) VALUES ('mem_owner_backfill_v1', ?1)",
            params![owner],
        )?;
        tracing::info!("retrieval memory-owner backfill: attributed {claimed} memory chunk(s)");
        Ok(())
    }

    /// Attribute pre-tenancy OKF SPACE chunks to the node's org once the node
    /// binds — the twin of [`Self::backfill_memory_owner`] for `ChunkSource::Space`.
    ///
    /// OKF chunks ingested before the `owner_org_id`/`visibility` denorm existed
    /// carry NULL/NULL (the old "bare unowned = shared" fallback `space_tenancy_allows`
    /// used to honor). Under the fail-closed default a bare-unowned chunk is now
    /// HIDDEN, so this stamps every unowned chunk that [`ingest_okf_bundle`]
    /// actually produced (identified via its `okf_chunks` sidecar row — the only
    /// reliable signal that a NULL-owner Space chunk is genuinely OKF/node-shared
    /// rather than a legacy manually-indexed chunk of unknown provenance) to the
    /// node's org at `visibility = "org"`. Non-OKF unowned Space chunks are left
    /// alone — deliberately fail-closed, exactly as the memory backfill fails
    /// closed for a bound node with no resolvable account. `owner` is `None` on an
    /// unbound node (or bound with no signed-in account) → skip, byte-identical.
    /// Idempotent via its own marker row in `retrieval_meta`.
    fn backfill_okf_space_owner(conn: &Connection, owner: Option<(String, String)>) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS retrieval_meta (key TEXT PRIMARY KEY, value TEXT)",
        )
        .context("creating retrieval_meta")?;
        let done: Option<String> = conn
            .query_row(
                "SELECT value FROM retrieval_meta WHERE key = 'okf_owner_backfill_v1'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if done.is_some() {
            return Ok(());
        }
        let Some((_, org_id)) = owner else {
            return Ok(());
        };
        let claimed = conn
            .execute(
                "UPDATE chunks SET owner_org_id = ?1, visibility = 'org'
                 WHERE source = 'space'
                   AND owner_user_id IS NULL
                   AND owner_org_id IS NULL
                   AND id IN (SELECT chunk_id FROM okf_chunks)",
                params![org_id],
            )
            .context("backfilling retrieval OKF space-chunk owner")?;
        conn.execute(
            "INSERT OR REPLACE INTO retrieval_meta (key, value) VALUES ('okf_owner_backfill_v1', ?1)",
            params![org_id],
        )?;
        tracing::info!("retrieval OKF space-owner backfill: attributed {claimed} chunk(s)");
        Ok(())
    }

    /// Open an in-memory store with the local embedder at the given dims and the
    /// local (term-overlap) reranker. Used by consumer tests; the caller supplies
    /// the default dims + reranker id from the model registry.
    pub fn open_in_memory(embed_dims: usize, reranker_model_id: String) -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory retrieval db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            embedder: Arc::new(RwLock::new(Embedder::Local { dims: embed_dims })),
            reranker: Reranker::Local,
            reranker_model_id,
            spaces: None,
        })
    }

    /// Open an in-memory store with a chosen embedder (used by tests that swap
    /// embedding models without environment mutation).
    pub fn open_in_memory_with_embedder(
        embedder: Embedder,
        reranker_model_id: String,
    ) -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory retrieval db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            embedder: Arc::new(RwLock::new(embedder)),
            reranker: Reranker::Local,
            reranker_model_id,
            spaces: None,
        })
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
    }

    fn embedder_snapshot(&self) -> Embedder {
        self.embedder
            .read()
            .expect("retrieval embedder lock poisoned")
            .clone()
    }

    /// The reranker model id from the registry.
    pub fn reranker_model_id(&self) -> &str {
        self.reranker.model_id(&self.reranker_model_id)
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
        let embedder = self.embedder_snapshot();
        let embedding = embedder.embed(content).await?;
        let blob = encode_embedding(&embedding);
        let model = embedder.model_id().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO chunks
                (id, source, space_id, content, embedding, embedding_model, created_at,
                 mem_metadata_ready, owner_user_id, owner_org_id, visibility)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CASE WHEN ?2 = 'memory' THEN 1 ELSE 0 END, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                source          = excluded.source,
                space_id        = excluded.space_id,
                content         = excluded.content,
                embedding       = excluded.embedding,
                embedding_model = excluded.embedding_model,
                created_at      = excluded.created_at,
                mem_metadata_ready = excluded.mem_metadata_ready,
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
        self.index_memory_chunk_with_metadata(
            id, content, scope, scope_id, category, importance, None, false, owner,
        )
        .await
    }

    /// Index a memory fact with the agent and sensitivity metadata needed by
    /// typed GraphRAG and server-side consent filtering. The legacy wrapper above
    /// remains for external callers that only have the original metadata.
    pub async fn index_memory_chunk_with_metadata(
        &self,
        id: &str,
        content: &str,
        scope: &str,
        scope_id: Option<&str>,
        category: &str,
        importance: i32,
        agent_id: Option<&str>,
        sensitive: bool,
        owner: RetrievalOwner<'_>,
    ) -> Result<()> {
        let embedder = self.embedder_snapshot();
        let embedding = embedder.embed(content).await?;
        let blob = encode_embedding(&embedding);
        let model = embedder.model_id().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO chunks
                (id, source, space_id, content, embedding, embedding_model, created_at,
                 mem_scope, mem_scope_id, mem_agent_id, mem_category, mem_importance, mem_sensitive,
                 mem_metadata_ready, owner_user_id, owner_org_id, visibility)
             VALUES (?1, 'memory', NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12, ?13, NULL)
             ON CONFLICT(id) DO UPDATE SET
                 source          = 'memory',
                 space_id        = NULL,
                 content         = excluded.content,
                 embedding       = excluded.embedding,
                 embedding_model = excluded.embedding_model,
                 created_at      = excluded.created_at,
                 mem_scope       = excluded.mem_scope,
                 mem_scope_id    = excluded.mem_scope_id,
                 mem_agent_id    = excluded.mem_agent_id,
                 mem_category    = excluded.mem_category,
                 mem_importance  = excluded.mem_importance,
                 mem_sensitive   = excluded.mem_sensitive,
                 mem_metadata_ready = excluded.mem_metadata_ready,
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
                agent_id,
                category,
                importance.clamp(1, 5),
                if sensitive { 1_i64 } else { 0_i64 },
                owner.user_id,
                owner.org_id,
            ],
        )
        .context("indexing memory chunk")?;
        Ok(())
    }

    /// Refresh denormalized memory metadata without re-embedding the content.
    /// This repairs rows written before agent/sensitivity fields existed and keeps
    /// the retrieval copy aligned when a source fact changes classification.
    pub async fn update_memory_metadata(
        &self,
        id: &str,
        scope: &str,
        scope_id: Option<&str>,
        category: &str,
        importance: i32,
        agent_id: Option<&str>,
        sensitive: bool,
        owner: RetrievalOwner<'_>,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE chunks
             SET mem_scope = ?1,
                 mem_scope_id = ?2,
                 mem_agent_id = ?3,
                 mem_category = ?4,
                 mem_importance = ?5,
                 mem_sensitive = ?6,
                 mem_metadata_ready = 1,
                 owner_user_id = ?7,
                 owner_org_id = ?8
             WHERE id = ?9 AND source = 'memory'",
            params![
                scope,
                scope_id,
                agent_id,
                category,
                importance.clamp(1, 5),
                if sensitive { 1_i64 } else { 0_i64 },
                owner.user_id,
                owner.org_id,
                id,
            ],
        )?;
        Ok(updated > 0)
    }

    /// Ingest a parsed OKF [`Bundle`](ryu_knowledge::Bundle) into the retrieval
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
    ///
    /// `org_id` is the installing node's registered org (`None` on an unbound
    /// node). OKF content has no single user owner, so every chunk is stamped
    /// `owner_user_id = NULL`, `owner_org_id = org_id`, `visibility = "org"` when
    /// bound — an EXPLICIT shared stamp `space_tenancy_allows` recognizes, rather
    /// than relying on a bare-unowned chunk being treated as shared (that fallback
    /// is fail-closed on a bound node; see the predicate's doc comment). `None`
    /// leaves the chunk fully unattributed, matching the unbound no-op.
    pub async fn ingest_okf_bundle(
        &self,
        bundle_id: &str,
        bundle: &ryu_knowledge::Bundle,
        org_id: Option<&str>,
    ) -> Result<OkfIngestSummary> {
        // Re-index is a full replace: clear the prior generation first so removed
        // concepts and shrunk bodies do not leave orphaned chunks behind.
        self.remove_okf_bundle(bundle_id).await?;

        // Embed every chunk up front (no DB lock held during network/CPU work),
        // then commit all rows in a single transaction.
        let mut rows: Vec<OkfRow> = Vec::new();
        let model = self.embedder_snapshot().model_id().to_string();
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
                let embedding = self.embedder_snapshot().embed(&content).await?;
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

        // No specific user owns OKF content; a bound-node install stamps the
        // installing node's org as an EXPLICIT shared visibility so the fail-closed
        // `space_tenancy_allows` still lets every member read it.
        let okf_visibility = org_id.map(|_| "org");
        let chunk_count = rows.len();
        let concept_count = bundle.concepts.len();
        let conn = self.conn.lock().await;
        let tx = conn
            .unchecked_transaction()
            .context("opening okf ingest transaction")?;
        for row in &rows {
            tx.execute(
                "INSERT INTO chunks
                    (id, source, space_id, content, embedding, embedding_model, created_at,
                     owner_org_id, visibility)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                     source          = excluded.source,
                     space_id        = excluded.space_id,
                     content         = excluded.content,
                     embedding       = excluded.embedding,
                     embedding_model = excluded.embedding_model,
                     created_at      = excluded.created_at,
                     owner_org_id    = excluded.owner_org_id,
                     visibility      = excluded.visibility",
                params![
                    row.chunk_id,
                    ChunkSource::Space.as_str(),
                    bundle_id,
                    row.content,
                    row.blob,
                    model,
                    now,
                    org_id,
                    okf_visibility,
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

    /// Remove every derived memory chunk. The encrypted MemoryStore remains the
    /// authority; this clears only its vector/retrieval projection after a full
    /// memory wipe.
    pub async fn clear_memory_chunks(&self) -> Result<u64> {
        let conn = self.conn.lock().await;
        let removed = conn.execute("DELETE FROM chunks WHERE source = 'memory'", [])?;
        Ok(removed as u64)
    }

    /// Remove sensitive memory projections for one owner, or all sensitive
    /// memory projections when the node is unbound. This is used when consent
    /// is revoked; it is deliberately set-based so cleanup is not capped by a
    /// source-store page size.
    pub async fn clear_sensitive_memory_chunks(&self, owner_user_id: Option<&str>) -> Result<u64> {
        let conn = self.conn.lock().await;
        let removed = match owner_user_id {
            Some(owner) => conn.execute(
                "DELETE FROM chunks
                 WHERE source = 'memory' AND mem_sensitive = 1 AND owner_user_id = ?1",
                params![owner],
            )?,
            None => conn.execute(
                "DELETE FROM chunks WHERE source = 'memory' AND mem_sensitive = 1",
                [],
            )?,
        };
        Ok(removed as u64)
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
    ) -> Result<Vec<ryu_knowledge::Concept>> {
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
        let mut concepts: Vec<ryu_knowledge::Concept> = Vec::new();
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
        let model = self.embedder_snapshot().model_id().to_string();
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

    /// Re-embed chunks written by a different embedding model into the current
    /// model's vector space.
    ///
    /// Retrieval intentionally filters stale rows rather than mixing vectors
    /// from incomparable models. This bounded, resumable pass restores those
    /// rows after an embedder swap. Embedding is performed without holding the
    /// SQLite mutex; rows are committed in small batches, so a failed remote
    /// embed leaves the remaining stale rows available for a later retry.
    ///
    /// Returns the number of rows updated. Calling it when all rows already use
    /// the current model is a no-op.
    pub async fn reindex_stale_embeddings(&self) -> Result<usize> {
        let control = StaleEmbeddingReindexControl::new();
        Ok(self
            .reindex_stale_embeddings_with_control(&control)
            .await?
            .updated)
    }

    /// Re-embed stale rows with cooperative cancellation and observable progress.
    ///
    /// The existing [`Self::reindex_stale_embeddings`] method remains the
    /// compatibility entry point. Consumers that need a status/cancel surface
    /// create one [`StaleEmbeddingReindexControl`], pass a clone to their worker,
    /// and poll [`StaleEmbeddingReindexControl::progress`] from their status
    /// handler. Each committed batch is resumable; cancellation never commits a
    /// partially embedded batch.
    pub async fn reindex_stale_embeddings_with_control(
        &self,
        control: &StaleEmbeddingReindexControl,
    ) -> Result<StaleEmbeddingReindexOutcome> {
        let result = self
            .reindex_stale_embeddings_with_control_inner(control)
            .await;
        if let Err(error) = &result {
            let mut progress = control
                .progress
                .lock()
                .expect("stale embedding progress mutex poisoned");
            progress.state = "failed".to_owned();
            progress.error = Some(format!("{error:#}"));
        }
        result
    }

    async fn reindex_stale_embeddings_with_control_inner(
        &self,
        control: &StaleEmbeddingReindexControl,
    ) -> Result<StaleEmbeddingReindexOutcome> {
        const BATCH_SIZE: usize = 64;
        let embedder = self.embedder_snapshot();
        let model = embedder.model_id().to_string();
        let mut reindexed = 0;

        let total = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT COUNT(*) FROM chunks WHERE embedding_model != ?1",
                params![model],
                |row| row.get::<_, i64>(0),
            )?
            .max(0) as usize
        };
        {
            let mut progress = control
                .progress
                .lock()
                .expect("stale embedding progress mutex poisoned");
            *progress = StaleEmbeddingReindexProgress {
                state: if control.is_cancelled() {
                    "cancelled".to_owned()
                } else {
                    "running".to_owned()
                },
                total,
                ..StaleEmbeddingReindexProgress::default()
            };
        }
        if control.is_cancelled() {
            return Ok(StaleEmbeddingReindexOutcome {
                updated: 0,
                cancelled: true,
            });
        }

        loop {
            let batch: Vec<(String, String)> = {
                let conn = self.conn.lock().await;
                let mut stmt = conn
                    .prepare(
                        "SELECT id, content FROM chunks
                         WHERE embedding_model != ?1
                         LIMIT ?2",
                    )
                    .context("preparing stale embedding scan")?;
                let rows = stmt.query_map(params![model, BATCH_SIZE as i64], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?;
                let mut batch = Vec::with_capacity(BATCH_SIZE);
                for row in rows {
                    batch.push(row?);
                }
                batch
            };

            if batch.is_empty() {
                let mut progress = control
                    .progress
                    .lock()
                    .expect("stale embedding progress mutex poisoned");
                progress.state = "completed".to_owned();
                progress.processed = progress.total;
                progress.updated = reindexed;
                return Ok(StaleEmbeddingReindexOutcome {
                    updated: reindexed,
                    cancelled: false,
                });
            }

            let batch_len = batch.len();
            let mut embedded = Vec::with_capacity(batch_len);
            for (id, content) in &batch {
                if control.is_cancelled() {
                    let mut progress = control
                        .progress
                        .lock()
                        .expect("stale embedding progress mutex poisoned");
                    progress.state = "cancelled".to_owned();
                    progress.updated = reindexed;
                    return Ok(StaleEmbeddingReindexOutcome {
                        updated: reindexed,
                        cancelled: true,
                    });
                }
                embedded.push((id.clone(), content.clone(), embedder.embed(content).await?));
            }

            if control.is_cancelled() {
                let mut progress = control
                    .progress
                    .lock()
                    .expect("stale embedding progress mutex poisoned");
                progress.state = "cancelled".to_owned();
                progress.updated = reindexed;
                return Ok(StaleEmbeddingReindexOutcome {
                    updated: reindexed,
                    cancelled: true,
                });
            }

            let conn = self.conn.lock().await;
            let tx = conn
                .unchecked_transaction()
                .context("starting embedding reindex transaction")?;
            for (id, content, embedding) in &embedded {
                let changed =
                    update_stale_embedding_if_unchanged(&tx, id, content, embedding, &model)?;
                reindexed += changed;
            }
            tx.commit().context("committing embedding reindex batch")?;
            let mut progress = control
                .progress
                .lock()
                .expect("stale embedding progress mutex poisoned");
            progress.processed = (progress.processed + batch_len).min(progress.total);
            progress.updated = reindexed;
        }
    }

    /// Embed `query`, search memory + the selected Spaces, merge and rank by
    /// cosine relevance, re-rank the expanded candidate pool, and return the
    /// top-K chunks (per `opts`).
    ///
    /// Pipeline: embed → search → filter → cosine rank → rerank top-(top_k × 4)
    /// → final top-K.
    ///
    /// # The Spaces half
    ///
    /// When a [`SpaceRecall`] delegate is wired AND `opts` selects at least one
    /// Space, the selected Spaces are additionally answered **by the Spaces store**,
    /// each under its own `retrieval_mode` (vector KNN or graph traversal), and
    /// those per-Space rankings are merged with this store's list by
    /// [`fuse_ranked_lists`]. Without that delegate — or with `space_ids: Some([])`
    /// — this method behaves exactly as it did before the delegate existed, cosine
    /// scores and all.
    ///
    /// Two consequences worth stating plainly rather than discovering:
    ///
    /// - `opts.min_score` is applied to THIS store's candidates only. A delegated
    ///   Space hit has no comparable score to threshold (see [`fuse_ranked_lists`]),
    ///   so it is not filtered by `min_score`; see the field doc on
    ///   [`RetrievalOptions::min_score`].
    /// - the returned `score` is a fusion score, not a cosine, whenever a Space
    ///   list actually contributes.
    ///
    /// # When a local sidecar is down
    ///
    /// The embed call used to be the first statement and propagated with `?`, which
    /// coupled two halves that do not share a dependency. The default
    /// `embed_base_url` is `http://127.0.0.1:8081`, i.e. non-empty, so the embedder
    /// is [`Embedder::Remote`] on a stock install and [`remote_embed`] returns `Err`
    /// on a connect failure or a non-2xx — and the `llamacpp-embed` sidecar it points
    /// at is started *lazily*. So an embed server that is not up yet took down
    /// **graph-mode Space recall too**, which needs no vector at all: a BFS over
    /// `graph_nodes` seeded from the query's own tokens. On the chat path the error
    /// is swallowed (`auto-recall: memory retrieve failed (skipping)`), so the
    /// user's symptom was an agent that quietly stopped citing an allowlisted Space.
    ///
    /// Now the failure is scoped to the half that genuinely cannot proceed:
    ///
    /// - **Lost:** this store's entire own list — memory *and* OKF — because every
    ///   one of those hits is scored by cosine against the query vector. There is no
    ///   partial answer to salvage there, and none is faked.
    /// - **Kept:** the [`SpaceRecall`] half. A graph-mode Space answers normally; a
    ///   vector-mode Space fails inside the delegate (its own embedder is down too)
    ///   and is skipped per-Space, exactly as the trait already specifies.
    ///
    /// **The rerank pass gets the same treatment, and needed it as much.** The second
    /// pass calls a cross-encoder that is `Reranker::Remote` whenever
    /// `RYU_RERANKER_BASE_URL` is set — which `profile::apply_env_defaults` does on
    /// every non-release `RYU_PROFILE`, so on a dev stack it is the default, pointed
    /// at another lazily-started sidecar. A bare `?` there would have reproduced this
    /// exact defect one sidecar over: Spaces recall dying for want of a service it
    /// never calls. It is routed through the same degraded path, with the same
    /// re-raise-if-nothing-salvaged rule. Note the local list is *dropped*, not
    /// re-ordered by cosine — see [`Self::retrieve_spaces_only`] for why that
    /// restraint is deliberate.
    ///
    /// **The error is never silently downgraded to an empty result.** If the Spaces
    /// half returns nothing, the sidecar's own message is still what reaches the
    /// caller — prefixed, not replaced (see [`Self::retrieve_spaces_only`] for why the
    /// prefix is flattened into `Display` rather than attached as an `anyhow` context).
    /// It is only suppressed (to a `warn!`) when there is a real, differently-grounded
    /// answer to return instead.
    pub async fn retrieve(&self, query: &str, opts: &RetrievalOptions) -> Result<Vec<ScoredChunk>> {
        if query.trim().is_empty() || opts.top_k == 0 {
            return Ok(Vec::new());
        }
        let query_embedding = match self.embedder_snapshot().embed(query).await {
            Ok(v) => v,
            // Held, not logged-and-dropped: it is either re-raised below or reported
            // as the reason the memory half is missing from an otherwise real answer.
            Err(embed_err) => return self.retrieve_spaces_only(query, opts, embed_err).await,
        };

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

        // Second pass: rerank the expanded pool, then take the final top-K. A remote
        // cross-encoder is a second sidecar with the same liveness problem as the
        // embedder (`remote_rerank` propagates on connect failure and on non-2xx), and
        // it is the DEFAULT on every non-release `RYU_PROFILE` — so leaving a bare `?`
        // here would have left the exact defect this method was restructured to close,
        // one sidecar over.
        let mut reranked = match self.reranker.rerank(query, scored).await {
            Ok(r) => r,
            Err(rerank_err) => return self.retrieve_spaces_only(query, opts, rerank_err).await,
        };
        reranked.truncate(opts.top_k);

        // Third pass: the Spaces half. Runs AFTER the local pipeline (sequentially —
        // this crate builds tokio with only the `sync` feature, so there is no
        // `join!` here) and only when a delegate is wired and `opts` selects Spaces.
        let space_lists = self.recall_spaces(query, opts).await;
        Ok(fuse_ranked_lists(reranked, space_lists, opts.top_k))
    }

    /// The degraded path of [`Self::retrieve`]: this store's own half could not be
    /// produced (the embed sidecar or the rerank sidecar is down), so answer from the
    /// Spaces delegate alone — or re-raise `local_err` if that yields nothing.
    ///
    /// `local_err` is threaded in by value rather than logged at the call site
    /// precisely so this function has the option of returning it. A
    /// sidecar-unavailable error that becomes `Ok(vec![])` is the failure mode this
    /// whole change exists to avoid recreating one layer down: the chat path already
    /// swallows a retrieval error into a `warn!`, and an empty-and-silent result
    /// there is indistinguishable from "nothing was relevant".
    ///
    /// Note this does **not** fall back to cosine order on a rerank failure — it
    /// drops the local list entirely, exactly as the bare `?` did. Falling open to
    /// cosine (what the Spaces path does) would be a different, larger decision about
    /// what `POST /api/retrieval/search` returns; all that changes here is that one
    /// dead sidecar no longer takes down a Space that never needed it.
    ///
    /// There is no `fuse_ranked_lists` no-op subtlety here: with an empty primary and
    /// at least one non-empty Space list, fusion ranks by RRF position exactly as it
    /// would have, and the `score` field is a fusion score — the same scale the
    /// caller would have seen had the local half participated.
    ///
    /// # Why the prefix is formatted in, and not `.context(…)`
    ///
    /// `anyhow::Error::context` puts the new string *in front of* the cause in the
    /// chain, and `Display` renders only the head: `format!("{e}")` and `e.to_string()`
    /// on a context-wrapped error yield the context ALONE. Only the alternate form
    /// `{e:#}` walks the chain. That distinction is not academic here, because the two
    /// production callers of [`Self::retrieve`] disagree about which they use:
    ///
    /// - chat auto-recall (`sidecar::adapters`) logs `{e:#}` — chain visible;
    /// - `POST /api/retrieval/search` (`server::mod`) answers `500` with
    ///   `e.to_string()` — chain **invisible**.
    ///
    /// So wrapping with `.context` here would have deleted "connection refused to the
    /// embed sidecar" from the one surface an operator actually reads, and replaced it
    /// with a sentence that names no service — a regression in exactly the case this
    /// degraded path exists to keep diagnosable. Formatting `{local_err:#}` into a
    /// single message keeps the cause in `Display` for both callers. Nothing
    /// `downcast`s a retrieval error (checked across `server/mod.rs`,
    /// `sidecar/adapters/mod.rs` and this crate), so collapsing the chain costs
    /// nothing that is read.
    async fn retrieve_spaces_only(
        &self,
        query: &str,
        opts: &RetrievalOptions,
        local_err: anyhow::Error,
    ) -> Result<Vec<ScoredChunk>> {
        let space_lists = self.recall_spaces(query, opts).await;
        let fused = fuse_ranked_lists(Vec::new(), space_lists, opts.top_k);
        if fused.is_empty() {
            return Err(anyhow::anyhow!(
                "retrieval: the local half failed and no Space answered without it: \
                 {local_err:#}"
            ));
        }
        tracing::warn!(
            "retrieval: local retrieval unavailable ({local_err:#}); answered from Spaces \
             only — memory and OKF chunks are MISSING from this result"
        );
        Ok(fused)
    }

    /// The Spaces half of [`Self::retrieve`]: ask the [`SpaceRecall`] delegate for
    /// one ranked list per selected Space. Returns an empty `Vec` — which makes
    /// [`fuse_ranked_lists`] a structural no-op — in every case where the delegation
    /// does not apply:
    ///
    /// - no delegate wired (the default, and every test that does not wire one);
    /// - `space_ids: Some([])`, i.e. "no Spaces" — the default agent's allowlist and
    ///   therefore the overwhelming majority of chat turns, which must stay free of
    ///   any `spaces.db` work;
    /// - the delegate could not resolve the Space set (warn + continue; the memory
    ///   and OKF half of the answer is unaffected, and there is no risk of silently
    ///   answering a graph-mode Space with vector hits, because this store holds no
    ///   rows for a real Space at all).
    ///
    /// `per_space_limit = opts.top_k`: each Space may fill the whole budget, and the
    /// fusion truncates the merged ranking back to `top_k`.
    async fn recall_spaces(&self, query: &str, opts: &RetrievalOptions) -> Vec<Vec<ScoredChunk>> {
        let Some(delegate) = self.spaces.as_ref() else {
            return Vec::new();
        };
        if opts.space_ids.as_ref().is_some_and(Vec::is_empty) {
            return Vec::new();
        }
        match delegate.recall(query, opts, opts.top_k).await {
            Ok(lists) => lists,
            Err(e) => {
                tracing::warn!("retrieval: Spaces delegate failed (skipping Spaces): {e:#}");
                Vec::new()
            }
        }
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
        let model = self.embedder_snapshot().model_id().to_string();
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT id, source, space_id, content, embedding, \
                        mem_scope, mem_scope_id, mem_agent_id, mem_importance, mem_sensitive, \
                        mem_metadata_ready, owner_user_id, owner_org_id, visibility FROM chunks \
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
                        mem_agent_id: row.get(7)?,
                        mem_importance: row
                            .get::<_, Option<i32>>(8)?
                            .unwrap_or(DEFAULT_MEM_IMPORTANCE),
                        mem_sensitive: row.get::<_, Option<i64>>(9)?.unwrap_or(0) == 1,
                        mem_metadata_ready: row.get::<_, Option<i64>>(10)?.unwrap_or(0) == 1,
                        owner_user_id: row.get(11)?,
                        owner_org_id: row.get(12)?,
                        visibility: row.get(13)?,
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

fn update_stale_embedding_if_unchanged(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    content: &str,
    embedding: &[f32],
    model: &str,
) -> Result<usize> {
    // The content predicate is the optimistic-concurrency check. A row edited
    // while the remote embedder was running stays stale and is picked up again
    // on the next batch instead of being incorrectly marked current.
    Ok(tx.execute(
        "UPDATE chunks
         SET embedding = ?1, embedding_model = ?2
         WHERE id = ?3 AND content = ?4 AND embedding_model != ?2",
        params![encode_embedding(embedding), model, id, content],
    )?)
}

/// The in-process default RAG provider: the sqlite-backed vector store with its
/// held embedder + reranker. A bound out-of-process provider (e.g. a GraphRAG
/// sidecar) would implement the same trait and be selected by the Core-side
/// resolver; consumers hold whichever instance the resolver mints.
#[async_trait::async_trait]
impl RagProvider for RetrievalStore {
    async fn embed(&self, text: &str) -> Result<Vec<f32>> {
        self.embedder_snapshot().embed(text).await
    }

    async fn retrieve(&self, query: &str, opts: &RetrievalOptions) -> Result<Vec<ScoredChunk>> {
        RetrievalStore::retrieve(self, query, opts).await
    }

    async fn rerank(&self, query: &str, candidates: Vec<ScoredChunk>) -> Result<Vec<ScoredChunk>> {
        self.reranker.rerank(query, candidates).await
    }
}

/// Decide whether a chunk is in scope for this retrieval request, merging the
/// memory toggle with the Space selection.
fn chunk_matches(chunk: &RetrievableChunk, opts: &RetrievalOptions) -> bool {
    match chunk.source {
        ChunkSource::Memory => {
            opts.include_memory
                && (opts.include_sensitive || (chunk.mem_metadata_ready && !chunk.mem_sensitive))
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
/// brain" (visible to every member), while `agent`/`user`-scope facts are PRIVATE — returned
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
        // Org scope: visible to a caller in THAT org. Deliberately matched on
        // `mem_scope_id` (which mirrors the store's `scope_id`) rather than the
        // denormalized `owner_org_id`, so this stays the exact twin of
        // `MEMORY_VISIBLE_PREDICATE` — the two must agree, and agreeing is easier to
        // verify when they read the same field. A missing scope id or caller org
        // fails closed.
        "org" => matches!(
            (chunk.mem_scope_id.as_deref(), opts.caller_org_id.as_deref()),
            (Some(chunk_org), Some(caller_org)) if chunk_org == caller_org
        ),
        // user scope (and any unknown scope, treated as user) → owner-only.
        _ => matches!(
            (chunk.owner_user_id.as_deref(), opts.caller_user_id.as_deref()),
            (Some(owner), Some(caller)) if owner == caller
        ),
    }
}

/// Per-caller tenancy for a SPACE chunk — the retrieval twin of
/// `memory_tenancy_allows`, and FAIL-CLOSED like it. UNBOUND → no-op. BOUND: a
/// chunk is visible to its recorded owner (`owner_user_id == caller_user_id`), or
/// — for content with no specific user owner (OKF bundles, node-shared docs) — to
/// any caller in the org it was EXPLICITLY stamped shared to (`owner_org_id`
/// matches the caller's org AND `visibility` is `org`/`team`). A BARE unowned
/// chunk (no `owner_user_id` AND no matching explicit org/team stamp — pre-tenancy
/// legacy rows the backfill has not reached) is HIDDEN, not shared: unlike memory,
/// Space chunks carry real document CONTENT, so treating "nobody recorded an
/// owner" as "safe to show everyone" was the content-escape gap this closes.
/// Genuinely shared knowledge (OKF bundles) stamps its explicit org/team
/// visibility at index time (see [`RetrievalStore::ingest_okf_bundle`]) so it
/// never depends on the bare-unowned case to stay visible.
fn space_tenancy_allows(chunk: &RetrievableChunk, opts: &RetrievalOptions) -> bool {
    if !opts.node_bound {
        return true;
    }
    if let Some(owner) = chunk.owner_user_id.as_deref() {
        if opts.caller_user_id.as_deref() == Some(owner) {
            return true;
        }
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

/// Whether a `Memory` chunk passes the caller's level + active-agent/project filter.
/// Legacy chunks with no `mem_scope` are treated as `"user"` (broadly visible).
/// `read_levels == None` allows every level EXCEPT `"org"` (see below).
/// Agent-scoped chunks require `mem_scope_id == opts.agent_id`; project-scoped
/// chunks require `mem_scope_id == opts.project_id`.
///
/// **Org is opt-in.** `read_levels == None` means "unconfigured", and every agent
/// that predates org scope is unconfigured. Letting the permissive default cover
/// `"org"` would hand all of them organization-wide memory the moment the level
/// shipped — a privacy default change smuggled in as a schema addition. So `"org"`
/// is only ever returned when an agent NAMES it, matching
/// `MemoryStore::effective_levels`, which excludes it from its default set for the
/// same reason. The two defaults must agree or the store and the retrieval index
/// disagree about what an unconfigured agent can see.
fn memory_level_matches(chunk: &RetrievableChunk, opts: &RetrievalOptions) -> bool {
    let scope = chunk.mem_scope.as_deref().unwrap_or("user");
    match &opts.read_levels {
        Some(levels) => {
            if !levels.iter().any(|l| l == scope) {
                return false;
            }
        }
        None if scope == "org" => return false,
        None => {}
    }
    if scope == "agent" {
        return match (chunk.mem_scope_id.as_deref(), opts.agent_id.as_deref()) {
            (Some(memory_agent), Some(active_agent)) => memory_agent == active_agent,
            _ => false,
        };
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

/// Reassemble one [`ryu_knowledge::Concept`] from its ordered chunk rows.
///
/// `rows` must be non-empty and all share a `concept_path`. The first chunk's
/// header yields `title`/`description`; bodies are stripped of their headers and
/// rejoined with blank lines.
fn concept_from_export_rows(rows: &[OkfExportRow]) -> ryu_knowledge::Concept {
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
            ryu_knowledge::Link {
                text: target.clone(),
                target,
                relative,
            }
        })
        .collect();

    ryu_knowledge::Concept {
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
fn okf_chunk_header(concept: &ryu_knowledge::Concept) -> String {
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

    /// **ResourceKey regression (task C2, deliverable #1): behavior-preserving.**
    ///
    /// The retrieval plane derives a chunk owner and the per-caller filter fields
    /// from a `ResourceKey`, both byte-identical to the pre-ResourceKey values —
    /// including the collapse (org-only/unattributed ⇒ `(None, None)`) and the
    /// UNBOUND-node no-op (`node_bound = false` disables filtering regardless of
    /// the key).
    #[test]
    fn resource_key_retrieval_derivation_is_behavior_preserving() {
        // Owner: attributed and collapsed shapes match `RetrievalOwner::owned`.
        for (user, org) in [
            (Some("u1"), Some("acme")),
            (Some("u1"), None),
            (None, None),
            (None, Some("acme")),
        ] {
            let key = ResourceKey::owned(user, org);
            let via_key = RetrievalOwner::from_resource_key(&key);
            let expected = RetrievalOwner::owned(
                // the key's collapse: org dropped when user absent
                if user.is_some() { user } else { None },
                if user.is_some() { org } else { None },
                None,
            );
            assert_eq!(via_key.user_id, expected.user_id);
            assert_eq!(via_key.org_id, expected.org_id);
            assert_eq!(via_key.visibility, None);
        }

        // Filter on a BOUND node carries the caller identity through.
        let bound = RetrievalOptions::default()
            .with_caller_key(&ResourceKey::owned(Some("u1"), Some("acme")), true);
        assert!(bound.node_bound);
        assert_eq!(bound.caller_user_id.as_deref(), Some("u1"));
        assert_eq!(bound.caller_org_id.as_deref(), Some("acme"));

        // UNBOUND node: filtering stays a total no-op regardless of the key.
        let unbound = RetrievalOptions::default()
            .with_caller_key(&ResourceKey::owned(Some("u1"), Some("acme")), false);
        assert!(!unbound.node_bound);
    }

    /// The registry defaults the Core-side resolver would supply, inlined so these
    /// primitive tests stay free of the model registry (a Core type).
    const TEST_EMBED_DIMS: usize = 768;
    const TEST_RERANKER_ID: &str = "BAAI/bge-reranker";

    /// In-memory store at the default dims + reranker id (the pre-extraction
    /// `open_in_memory()` semantics).
    fn mem_store() -> RetrievalStore {
        RetrievalStore::open_in_memory(TEST_EMBED_DIMS, TEST_RERANKER_ID.to_owned()).unwrap()
    }

    async fn seed(store: &RetrievalStore) {
        store
            .index_chunk(
                "m1",
                ChunkSource::Memory,
                None,
                "The user prefers dark mode and concise answers.",
                RetrievalOwner::shared(),
            )
            .await
            .unwrap();
        store
            .index_chunk(
                "s1",
                ChunkSource::Space,
                Some("docs"),
                "Ryu Core runs on port 7980 and routes chat through adapters.",
                RetrievalOwner::shared(),
            )
            .await
            .unwrap();
        store
            .index_chunk(
                "s2",
                ChunkSource::Space,
                Some("docs"),
                "The gateway enforces firewall, routing, and budgets.",
                RetrievalOwner::shared(),
            )
            .await
            .unwrap();
        store
            .index_chunk(
                "s3",
                ChunkSource::Space,
                Some("recipes"),
                "Preheat the oven to 200 degrees and bake the bread.",
                RetrievalOwner::shared(),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn retrieves_relevant_chunk_grounding_the_query() {
        let store = mem_store();
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
        let store = mem_store();
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
        let store = mem_store();
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
        let store = mem_store();
        store
            .index_memory_chunk(
                "mu",
                "the user prefers concise answers",
                "user",
                None,
                "preference",
                3,
                RetrievalOwner::shared(),
            )
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
                RetrievalOwner::shared(),
            )
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
        let store = mem_store();
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
        let store = mem_store();
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

    /// AC4a: swapping the embedding model (via the resolver-supplied config)
    /// produces the new id.
    #[tokio::test]
    async fn resolver_config_uses_new_embed_model_id() {
        // A local-dims store with a distinct default reranker id (what the Core
        // resolver would inject from a swapped registry).
        let store = RetrievalStore::open_in_memory(256, "custom/reranker-test".to_owned()).unwrap();

        // The store should report the injected model id.
        assert_eq!(
            store.embedder_model_id(),
            "local-hashing",
            "local mode always returns 'local-hashing' (no base URL set)"
        );
        assert_eq!(store.reranker_model_id(), "custom/reranker-test");
    }

    #[tokio::test]
    async fn reindex_stale_embeddings_restores_retrieval_and_is_idempotent() {
        let store = mem_store();
        store
            .index_chunk(
                "stale",
                ChunkSource::Memory,
                None,
                "the user's favorite color is orange",
                RetrievalOwner::shared(),
            )
            .await
            .unwrap();

        // A model swap makes the old vector intentionally invisible to search.
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE chunks SET embedding_model = 'previous/embedder' WHERE id = 'stale'",
                [],
            )
            .unwrap();
        }
        assert!(store
            .retrieve("what is the favorite color", &RetrievalOptions::default())
            .await
            .unwrap()
            .is_empty());

        assert_eq!(store.reindex_stale_embeddings().await.unwrap(), 1);
        let hits = store
            .retrieve("what is the favorite color", &RetrievalOptions::default())
            .await
            .unwrap();
        assert_eq!(hits.first().map(|hit| hit.id.as_str()), Some("stale"));
        assert_eq!(store.reindex_stale_embeddings().await.unwrap(), 0);
    }

    #[tokio::test]
    async fn stale_embedding_reindex_reports_progress() {
        let store = mem_store();
        for id in ["stale-a", "stale-b"] {
            store
                .index_chunk(
                    id,
                    ChunkSource::Memory,
                    None,
                    "a stale embedding fixture",
                    RetrievalOwner::shared(),
                )
                .await
                .unwrap();
        }
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE chunks SET embedding_model = 'previous/embedder'",
                [],
            )
            .unwrap();
        }

        let control = StaleEmbeddingReindexControl::new();
        let outcome = store
            .reindex_stale_embeddings_with_control(&control)
            .await
            .unwrap();

        assert_eq!(outcome.updated, 2);
        assert!(!outcome.cancelled);
        assert_eq!(
            control.progress(),
            StaleEmbeddingReindexProgress {
                state: "completed".to_owned(),
                total: 2,
                processed: 2,
                updated: 2,
                error: None,
            }
        );
    }

    #[tokio::test]
    async fn stale_embedding_reindex_honors_cancellation_before_work() {
        let store = mem_store();
        store
            .index_chunk(
                "stale",
                ChunkSource::Memory,
                None,
                "a stale embedding fixture",
                RetrievalOwner::shared(),
            )
            .await
            .unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE chunks SET embedding_model = 'previous/embedder' WHERE id = 'stale'",
                [],
            )
            .unwrap();
        }

        let control = StaleEmbeddingReindexControl::new();
        control.cancel();
        let outcome = store
            .reindex_stale_embeddings_with_control(&control)
            .await
            .unwrap();

        assert_eq!(
            outcome,
            StaleEmbeddingReindexOutcome {
                updated: 0,
                cancelled: true,
            }
        );
        assert_eq!(control.progress().state, "cancelled");
        assert_eq!(control.progress().total, 1);
        assert_eq!(control.progress().processed, 0);
    }

    #[test]
    fn stale_embedding_update_skips_content_changed_during_embedding() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE chunks (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                embedding BLOB NOT NULL,
                embedding_model TEXT NOT NULL
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunks (id, content, embedding, embedding_model)
             VALUES ('chunk-1', 'old text', X'00', 'old-model')",
            [],
        )
        .unwrap();

        let tx = conn.unchecked_transaction().unwrap();
        // The reindex selected `old text`, then another writer committed this
        // edit before the embedding result was ready.
        tx.execute(
            "UPDATE chunks SET content = 'new text' WHERE id = 'chunk-1'",
            [],
        )
        .unwrap();
        assert_eq!(
            update_stale_embedding_if_unchanged(
                &tx,
                "chunk-1",
                "old text",
                &[1.0, 2.0],
                "current-model",
            )
            .unwrap(),
            0
        );
        let model: String = tx
            .query_row(
                "SELECT embedding_model FROM chunks WHERE id = 'chunk-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(model, "old-model");
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

    /// AC4c: embedder dims flow from the resolved config, not a hardcoded const.
    /// (The registry read that produces the dims now lives in `rag_host`.)
    #[test]
    fn embedder_dims_from_config() {
        let embedder = Embedder::remote("http://embed.local", "test/embed", 512, None);
        assert_eq!(embedder.dims(), 512);

        // Producing a vector gives the configured length.
        let vec = local_embed("hello world", embedder.dims());
        assert_eq!(vec.len(), 512);

        // A blank base URL falls back to the local hashing embedder at the same dims.
        let local = Embedder::remote("  ", "unused", 384, None);
        assert!(local.is_local());
        assert_eq!(local.dims(), 384);
    }

    // ── OKF ingest ────────────────────────────────────────────────────────────

    fn sample_bundle() -> ryu_knowledge::Bundle {
        let orders = ryu_knowledge::Concept::parse(
            "tables/orders.md",
            "---\ntype: BigQuery Table\ntitle: Orders\ntags:\n- sales\n---\n\
             # Schema\n\nThe orders fact table records customer purchases. \
             See [Customers](/tables/customers.md).\n",
        )
        .expect("parse orders");
        let recipe = ryu_knowledge::Concept::parse(
            "recipes/bread.md",
            "---\ntype: Playbook\ntitle: Bread\n---\n\
             Preheat the oven to 200 degrees and bake the sourdough loaf.\n",
        )
        .expect("parse recipe");
        ryu_knowledge::Bundle {
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
        let store = mem_store();
        let summary = store
            .ingest_okf_bundle("b1", &sample_bundle(), None)
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
        let store = mem_store();
        store
            .ingest_okf_bundle("b1", &sample_bundle(), None)
            .await
            .unwrap();
        let edges = store.okf_links("b1").await.unwrap();
        assert!(edges
            .iter()
            .any(|e| e.concept_path == "tables/orders.md" && e.target == "/tables/customers.md"));
    }

    #[tokio::test]
    async fn reingest_is_idempotent_on_concept_path() {
        let store = mem_store();
        let first = store
            .ingest_okf_bundle("b1", &sample_bundle(), None)
            .await
            .unwrap();
        // Re-ingesting the same bundle replaces rather than duplicates.
        let second = store
            .ingest_okf_bundle("b1", &sample_bundle(), None)
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
        let store = mem_store();
        store
            .ingest_okf_bundle("b1", &sample_bundle(), None)
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
        let store = mem_store();
        store
            .ingest_okf_bundle("b1", &sample_bundle(), None)
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
        let store = mem_store();
        seed_tenancy(&store).await;

        let hits = store
            .retrieve("secret launch date", &bound_opts("bob"))
            .await
            .unwrap();
        let ids: Vec<&str> = hits.iter().map(|c| c.id.as_str()).collect();
        assert!(
            !ids.contains(&"alice-mem"),
            "Bob must NOT see Alice's user-scope memory"
        );
        assert!(
            ids.contains(&"bob-mem"),
            "Bob sees his own user-scope memory"
        );
        assert!(
            ids.contains(&"shared-node-mem"),
            "node-scope memory is the shared brain, visible to Bob"
        );
    }

    /// No-lockout: Alice reaches her OWN user-scope memory (+ the shared fact).
    #[tokio::test]
    async fn alice_retrieves_her_own_user_memory() {
        let store = mem_store();
        seed_tenancy(&store).await;

        let hits = store
            .retrieve("secret launch date", &bound_opts("alice"))
            .await
            .unwrap();
        let ids: Vec<&str> = hits.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"alice-mem"));
        assert!(ids.contains(&"shared-node-mem"));
        assert!(
            !ids.contains(&"bob-mem"),
            "Alice must not see Bob's private memory"
        );
    }

    /// An UNBOUND node is byte-identical: no owner filtering, every chunk visible
    /// regardless of who owns it (the default `node_bound = false`).
    #[tokio::test]
    async fn unbound_node_retrieval_is_unfiltered() {
        let store = mem_store();
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

    #[tokio::test]
    async fn sensitive_memory_cleanup_can_be_scoped_without_a_page_limit() {
        let store = mem_store();
        for (id, owner) in [("alice-sensitive", "alice"), ("bob-sensitive", "bob")] {
            store
                .index_memory_chunk_with_metadata(
                    id,
                    "health condition requires a private note",
                    "user",
                    None,
                    "user_fact",
                    3,
                    Some("default"),
                    true,
                    RetrievalOwner::owned(Some(owner), Some("org1"), None),
                )
                .await
                .unwrap();
        }

        assert_eq!(
            store
                .clear_sensitive_memory_chunks(Some("alice"))
                .await
                .unwrap(),
            1
        );
        let remaining = store.indexed_memory_ids().await.unwrap();
        assert!(!remaining.contains("alice-sensitive"));
        assert!(remaining.contains("bob-sensitive"));
    }

    /// A Space chunk owned by Alice (visibility private) does not escape to Bob —
    /// pins the OWNED branch of `space_tenancy_allows` on its own, independent of
    /// the unowned/explicit-shared cases below.
    #[tokio::test]
    async fn bob_cannot_retrieve_alices_private_space_chunk_on_bound_node() {
        let store = mem_store();
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

        let bob_hits = store
            .retrieve("quarterly revenue", &bound_opts("bob"))
            .await
            .unwrap();
        assert!(
            bob_hits.iter().all(|c| c.id != "alice-doc"),
            "Bob must not read Alice's private document chunk"
        );

        // No-lockout: Alice, the owner, still can.
        let alice_hits = store
            .retrieve("quarterly revenue", &bound_opts("alice"))
            .await
            .unwrap();
        assert!(
            alice_hits.iter().any(|c| c.id == "alice-doc"),
            "Alice must still read her own document chunk"
        );
    }

    /// The content-escape regression test for the fail-closed flip: a BARE unowned
    /// Space chunk (no `owner_user_id`, no matching explicit org/team stamp — a
    /// pre-tenancy legacy row) is now HIDDEN on a bound node rather than the old
    /// fail-open "unowned = shared" default.
    #[tokio::test]
    async fn unowned_space_chunk_is_hidden_on_bound_node() {
        let store = mem_store();
        store
            .index_chunk(
                "legacy-bare",
                ChunkSource::Space,
                Some("docs"),
                "quarterly revenue reporting standards overview",
                RetrievalOwner::shared(),
            )
            .await
            .unwrap();

        let hits = store
            .retrieve("quarterly revenue reporting", &bound_opts("bob"))
            .await
            .unwrap();
        assert!(
            hits.iter().all(|c| c.id != "legacy-bare"),
            "a bare-unowned Space chunk must be hidden on a bound node, not shared"
        );
    }

    /// OKF-style content stamped with an EXPLICIT org-shared visibility (the exact
    /// shape `RetrievalStore::ingest_okf_bundle` now writes: no specific user
    /// owner, `owner_org_id` + `visibility = "org"`) stays visible to every member
    /// of that org — this is how genuinely shared knowledge survives the
    /// fail-closed flip above.
    #[tokio::test]
    async fn explicit_shared_space_chunk_visible_to_all_members() {
        let store = mem_store();
        store
            .index_chunk(
                "okf-shared",
                ChunkSource::Space,
                Some("docs"),
                "quarterly revenue reporting standards overview",
                RetrievalOwner::owned(None, Some("org1"), Some("org")),
            )
            .await
            .unwrap();

        let hits = store
            .retrieve("quarterly revenue reporting", &bound_opts("bob"))
            .await
            .unwrap();
        assert!(
            hits.iter().any(|c| c.id == "okf-shared"),
            "explicitly org-shared knowledge stays visible to every member"
        );
    }

    /// UNBOUND node: Space tenancy stays a total no-op, byte-identical regardless
    /// of owner shape — including the bare-unowned case that is hidden when bound.
    #[tokio::test]
    async fn unbound_node_space_tenancy_noop() {
        let store = mem_store();
        store
            .index_chunk(
                "legacy-bare",
                ChunkSource::Space,
                Some("docs"),
                "quarterly revenue reporting standards overview",
                RetrievalOwner::shared(),
            )
            .await
            .unwrap();
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

        let opts = RetrievalOptions {
            top_k: 10,
            ..Default::default()
        };
        let hits = store.retrieve("quarterly revenue", &opts).await.unwrap();
        let ids: Vec<&str> = hits.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"legacy-bare"));
        assert!(ids.contains(&"alice-doc"));
    }

    /// Integration: `ingest_okf_bundle` called with the node's org (the real
    /// production writer, not just the pure `RetrievalOwner::owned(None, ..)`
    /// shape exercised above) produces chunks that pass the fail-closed
    /// `space_tenancy_allows` for every bound-node member.
    #[tokio::test]
    async fn okf_bundle_ingested_with_org_stays_visible_to_bound_members() {
        let store = mem_store();
        store
            .ingest_okf_bundle("b1", &sample_bundle(), Some("org1"))
            .await
            .unwrap();

        let hits = store
            .retrieve("orders fact table customer purchases", &bound_opts("bob"))
            .await
            .unwrap();
        assert!(
            !hits.is_empty(),
            "OKF content ingested with the node's org must stay visible to a bound-node member"
        );
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
            mem_agent_id: None,
            mem_importance: 3,
            mem_sensitive: false,
            mem_metadata_ready: true,
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
        let node = RetrievableChunk {
            mem_scope: Some("node".into()),
            ..base.clone()
        };
        assert!(memory_tenancy_allows(&node, &bob));
        // unbound: everything.
        let unbound = RetrievalOptions::default();
        assert!(memory_tenancy_allows(&base, &unbound));

        let legacy = RetrievableChunk {
            mem_metadata_ready: false,
            ..base
        };
        assert!(
            !chunk_matches(&legacy, &RetrievalOptions::default()),
            "legacy memory metadata must fail closed while sensitive consent is off"
        );
        assert!(chunk_matches(
            &legacy,
            &RetrievalOptions {
                include_sensitive: true,
                ..Default::default()
            }
        ));
    }

    #[test]
    fn memory_agent_and_sensitive_filters_are_independent() {
        let agent_fact = RetrievableChunk {
            mem_scope: Some("agent".into()),
            mem_scope_id: Some("agent-a".into()),
            mem_agent_id: Some("agent-a".into()),
            mem_sensitive: true,
            ..RetrievableChunk {
                id: "agent-fact".into(),
                source: ChunkSource::Memory,
                space_id: None,
                content: "health fact".into(),
                mem_scope: None,
                mem_scope_id: None,
                mem_agent_id: None,
                mem_importance: 3,
                mem_sensitive: false,
                mem_metadata_ready: true,
                owner_user_id: Some("alice".into()),
                owner_org_id: Some("org1".into()),
                visibility: None,
            }
        };
        let mut opts = RetrievalOptions {
            read_levels: Some(vec!["agent".into()]),
            agent_id: Some("agent-a".into()),
            caller_user_id: Some("alice".into()),
            node_bound: true,
            ..Default::default()
        };
        assert!(!chunk_matches(&agent_fact, &opts));
        opts.include_sensitive = true;
        assert!(chunk_matches(&agent_fact, &opts));
        opts.agent_id = Some("agent-b".into());
        assert!(!chunk_matches(&agent_fact, &opts));
    }

    // ── Spaces delegation (`SpaceRecall`) + rank fusion ───────────────────────
    //
    // What these cover, and why they exist at all: a Space's documents are NEVER
    // indexed into this store (the only writers of `ChunkSource::Space` rows are
    // `index_chunk` — the manual `POST /api/retrieval/index`, which no shipped
    // client calls with a `space_id` — and `ingest_okf_bundle`, whose `space_id`
    // is a BUNDLE id). So `space_ids` selected nothing until the delegate existed,
    // and a Space's `retrieval_mode` could not reach `retrieve` at all. The fake
    // below stands in for `rag_host::SpacesRecall` (which calls
    // `SpaceStore::search_ext`, the same entry point the Spaces search box uses,
    // so the mode branch is exercised there, not duplicated here).

    /// A `SpaceRecall` that returns canned per-Space lists and counts its calls, so
    /// a test can assert both WHAT was merged and WHETHER the delegate was consulted
    /// at all (the `space_ids: Some([])` fast path must not touch it).
    struct FakeSpaces {
        /// One ranked list per Space id, returned in `space_ids` order.
        by_space: std::collections::HashMap<String, Vec<ScoredChunk>>,
        /// Set to fail the whole resolution (the "Spaces store unavailable" case).
        fail: bool,
        /// Consultation counter. There is deliberately no accessor method: the
        /// fake is moved into the store under an `Arc<dyn SpaceRecall>`, so every
        /// test clones this handle *before* the move and reads the atomic
        /// directly. A `fn calls(&self)` would be unreachable after the move —
        /// dead code that reads as an available affordance.
        calls: Arc<std::sync::atomic::AtomicUsize>,
        /// The `per_space_limit` the store asked for on the last call.
        last_limit: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl FakeSpaces {
        fn new(by_space: Vec<(&str, Vec<&str>)>) -> Self {
            let mut map = std::collections::HashMap::new();
            for (space, contents) in by_space {
                map.insert(
                    space.to_owned(),
                    contents
                        .into_iter()
                        .enumerate()
                        .map(|(i, content)| ScoredChunk {
                            id: format!("{space}:{i}"),
                            source: ChunkSource::Space,
                            space_id: Some(space.to_owned()),
                            content: content.to_owned(),
                            // Exactly what the real delegate does: no score, because
                            // a graph hit has none and a vector distance is not
                            // comparable to a cosine. Order carries the signal.
                            score: 0.0,
                        })
                        .collect(),
                );
            }
            Self {
                by_space: map,
                fail: false,
                calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                last_limit: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            }
        }

        fn failing() -> Self {
            let mut s = Self::new(vec![]);
            s.fail = true;
            s
        }
    }

    #[async_trait::async_trait]
    impl SpaceRecall for FakeSpaces {
        async fn recall(
            &self,
            _query: &str,
            opts: &RetrievalOptions,
            per_space_limit: usize,
        ) -> Result<Vec<Vec<ScoredChunk>>> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.last_limit
                .store(per_space_limit, std::sync::atomic::Ordering::SeqCst);
            if self.fail {
                anyhow::bail!("spaces store unavailable");
            }
            let ids: Vec<String> = match &opts.space_ids {
                Some(ids) => ids.clone(),
                // `None` = every Space, which the real delegate enumerates under the
                // caller's tenancy filter.
                None => {
                    let mut all: Vec<String> = self.by_space.keys().cloned().collect();
                    all.sort();
                    all
                }
            };
            Ok(ids
                .iter()
                .filter_map(|id| self.by_space.get(id).cloned())
                .filter(|l: &Vec<ScoredChunk>| !l.is_empty())
                .collect())
        }
    }

    fn chunk(id: &str, score: f32) -> ScoredChunk {
        ScoredChunk {
            id: id.to_owned(),
            source: ChunkSource::Memory,
            space_id: None,
            content: format!("content of {id}"),
            score,
        }
    }

    /// The no-op guarantee the whole design rests on: with nothing to fuse, the
    /// primary list comes back **unchanged** — same order, same ids, and the same
    /// cosine scores, not rank-fusion scores. Every caller that selects no Spaces
    /// (and every caller predating the delegate) depends on this, including the
    /// `score` field of `POST /api/retrieval/search`.
    #[test]
    fn fusion_without_space_lists_returns_the_primary_list_untouched() {
        let primary = vec![chunk("a", 0.9), chunk("b", 0.5), chunk("c", 0.1)];
        for others in [vec![], vec![vec![], vec![]]] {
            let out = fuse_ranked_lists(primary.clone(), others, 10);
            assert_eq!(
                out.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
                ["a", "b", "c"]
            );
            let scores: Vec<f32> = out.iter().map(|c| c.score).collect();
            assert_eq!(scores, vec![0.9, 0.5, 0.1], "cosine scores must survive");
        }
    }

    /// Mixed retrieval: two rankings with incomparable scores interleave by RANK,
    /// primary first at each rank. The graph-mode list deliberately carries the
    /// constant `0.0` every graph hit has — under a naive sort by score/distance it
    /// would either sink to the bottom or (sorting by distance) float every hit to
    /// the top; under rank fusion its position depends only on its own ranking.
    #[test]
    fn fusion_interleaves_two_incomparable_rankings_by_rank() {
        let primary = vec![chunk("v0", 0.91), chunk("v1", 0.88), chunk("v2", 0.4)];
        let graph = vec![chunk("g0", 0.0), chunk("g1", 0.0), chunk("g2", 0.0)];
        let out = fuse_ranked_lists(primary, vec![graph], 6);
        assert_eq!(
            out.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["v0", "g0", "v1", "g1", "v2", "g2"]
        );
        // Scores are now fusion scores, strictly non-increasing.
        for pair in out.windows(2) {
            assert!(pair[0].score >= pair[1].score);
        }
    }

    /// Three lists (memory/OKF + two Spaces) keep the documented tie-break: at an
    /// equal rank, the primary list wins, then the Spaces in the order the caller
    /// passed them. Re-running the same fusion cannot reshuffle the injected
    /// context, which is what makes a chat turn reproducible.
    #[test]
    fn fusion_tie_break_is_primary_then_list_order_and_is_deterministic() {
        let primary = vec![chunk("p0", 0.9), chunk("p1", 0.8)];
        let space_a = vec![chunk("a0", 0.0), chunk("a1", 0.0)];
        let space_b = vec![chunk("b0", 0.0), chunk("b1", 0.0)];
        let expected = ["p0", "a0", "b0", "p1", "a1", "b1"];
        for _ in 0..5 {
            let out = fuse_ranked_lists(primary.clone(), vec![space_a.clone(), space_b.clone()], 6);
            assert_eq!(
                out.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
                expected
            );
        }
    }

    /// A chunk id present in two lists is ONE output row whose contributions are
    /// summed — it must not be injected twice into the model context. Reachable
    /// when the same id was manually indexed here and also lives in a delegated
    /// Space.
    #[test]
    fn fusion_dedupes_an_id_present_in_two_lists_and_sums_its_score() {
        let primary = vec![chunk("dup", 0.9), chunk("p1", 0.8)];
        let space = vec![chunk("s0", 0.0), chunk("dup", 0.0)];
        let out = fuse_ranked_lists(primary, vec![space], 10);
        assert_eq!(out.iter().filter(|c| c.id == "dup").count(), 1);
        let dup = out.iter().find(|c| c.id == "dup").unwrap();
        let solo = out.iter().find(|c| c.id == "s0").unwrap();
        assert!(
            dup.score > solo.score,
            "a chunk both sources agree on must outrank one only one source found"
        );
        assert_eq!(out[0].id, "dup");
    }

    /// `top_k` bounds the MERGED ranking, not each list.
    #[test]
    fn fusion_truncates_the_merged_ranking_to_top_k() {
        let primary = vec![chunk("v0", 0.9), chunk("v1", 0.8)];
        let space = vec![chunk("g0", 0.0), chunk("g1", 0.0)];
        let out = fuse_ranked_lists(primary, vec![space], 3);
        assert_eq!(
            out.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["v0", "g0", "v1"]
        );
    }

    /// **The defect this unit closes.** A Space whose content lives ONLY in the
    /// Spaces store (as every real Space's does) now reaches `retrieve` — the call
    /// the chat turn makes — instead of returning nothing. Without the delegate the
    /// same query over the same store yields memory only.
    #[tokio::test]
    async fn retrieve_surfaces_space_content_that_is_not_indexed_in_this_store() {
        let store = mem_store();
        seed(&store).await;
        let opts = RetrievalOptions {
            top_k: 4,
            space_ids: Some(vec!["space-graph".to_owned()]),
            ..RetrievalOptions::default()
        };

        // Before: nothing in this store carries `space_id = "space-graph"`.
        let without = store.retrieve("moss ledger", &opts).await.unwrap();
        assert!(
            !without
                .iter()
                .any(|c| c.space_id.as_deref() == Some("space-graph")),
            "precondition: a real Space id matches no row in retrieval.db"
        );

        let fake = FakeSpaces::new(vec![(
            "space-graph",
            vec!["Moss keeps the ledger", "Ledger entries for Q3"],
        )]);
        let calls = Arc::clone(&fake.calls);
        let with = store
            .clone()
            .with_space_recall(Arc::new(fake))
            .retrieve("moss ledger", &opts)
            .await
            .unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(with
            .iter()
            .any(|c| c.space_id.as_deref() == Some("space-graph")));
        assert!(
            with.iter().any(|c| c.source == ChunkSource::Memory),
            "the memory half must still be there — delegation ADDS a source"
        );
    }

    /// The default agent allowlist is `Some([])` ("no Spaces"), which is the
    /// overwhelming majority of chat turns. It must not touch the Spaces store at
    /// all: `spaces.db` is served by ONE connection behind one mutex that a graph
    /// rebuild can hold for minutes, so a per-turn call there would be a real cost.
    #[tokio::test]
    async fn retrieve_with_an_empty_space_allowlist_never_calls_the_delegate() {
        let store = mem_store();
        seed(&store).await;
        let fake = FakeSpaces::new(vec![("space-graph", vec!["Moss keeps the ledger"])]);
        let calls = Arc::clone(&fake.calls);
        let store = store.with_space_recall(Arc::new(fake));
        let opts = RetrievalOptions {
            top_k: 4,
            space_ids: Some(Vec::new()),
            ..RetrievalOptions::default()
        };
        let hits = store.retrieve("dark mode", &opts).await.unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(hits.iter().all(|c| c.source == ChunkSource::Memory));
        // …and the scores are still cosines, because nothing was fused.
        assert!(hits.iter().any(|c| c.score > 0.05));
    }

    /// `space_ids: None` means "all Spaces" and must reach the delegate too —
    /// treating it as "no Spaces" would reinstate the defect for the one caller
    /// that asks for everything.
    #[tokio::test]
    async fn retrieve_with_no_space_filter_delegates_every_space() {
        let store = mem_store();
        seed(&store).await;
        let fake = FakeSpaces::new(vec![
            ("space-a", vec!["Alpha space content"]),
            ("space-b", vec!["Beta space content"]),
        ]);
        let calls = Arc::clone(&fake.calls);
        let hits = store
            .with_space_recall(Arc::new(fake))
            .retrieve(
                "content",
                &RetrievalOptions {
                    top_k: 8,
                    space_ids: None,
                    ..RetrievalOptions::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        for space in ["space-a", "space-b"] {
            assert!(
                hits.iter().any(|c| c.space_id.as_deref() == Some(space)),
                "missing {space}"
            );
        }
    }

    /// A Spaces store that cannot answer degrades to the `retrieval.db` half with a
    /// warning — it does not fail the turn. Safe precisely because this store holds
    /// no rows for a real Space, so "continue without Spaces" can never silently
    /// answer a graph-mode Space with stale vector hits.
    #[tokio::test]
    async fn retrieve_survives_a_failing_spaces_delegate() {
        let store = mem_store();
        seed(&store).await;
        let hits = store
            .with_space_recall(Arc::new(FakeSpaces::failing()))
            .retrieve(
                "dark mode",
                &RetrievalOptions {
                    top_k: 4,
                    space_ids: Some(vec!["space-graph".to_owned()]),
                    ..RetrievalOptions::default()
                },
            )
            .await
            .unwrap();
        assert!(hits.iter().any(|c| c.source == ChunkSource::Memory));
    }

    /// `min_score` thresholds THIS store's cosine-scored chunks and cannot threshold
    /// a delegated Space hit (which has no comparable score — none at all in graph
    /// mode). Asserted rather than left implicit, because the field is settable
    /// through `POST /api/retrieval/search` and a reader would otherwise assume it
    /// covers the whole result set. See the field doc for why the alternative
    /// (suppressing Spaces entirely) was rejected.
    #[tokio::test]
    async fn min_score_filters_local_chunks_only_never_delegated_space_hits() {
        let store = mem_store();
        seed(&store).await;
        let fake = FakeSpaces::new(vec![("space-graph", vec!["Moss keeps the ledger"])]);
        let hits = store
            .with_space_recall(Arc::new(fake))
            .retrieve(
                "moss ledger",
                &RetrievalOptions {
                    top_k: 5,
                    space_ids: Some(vec!["space-graph".to_owned()]),
                    // Above any cosine the local hashing embedder produces, so the
                    // local half is emptied.
                    min_score: 0.999,
                    ..RetrievalOptions::default()
                },
            )
            .await
            .unwrap();
        assert!(
            hits.iter()
                .all(|c| c.space_id.as_deref() == Some("space-graph")),
            "local chunks must be thresholded away: {hits:?}"
        );
        assert!(!hits.is_empty(), "delegated Space hits pass the threshold");
    }

    /// The per-Space budget handed to the delegate is `top_k`: each Space may fill
    /// the whole budget and the fusion truncates the merged ranking. A smaller
    /// per-Space limit would silently starve every Space but the first.
    #[tokio::test]
    async fn delegate_receives_top_k_as_the_per_space_limit() {
        let store = mem_store();
        let fake = FakeSpaces::new(vec![("space-a", vec!["a"])]);
        let last = Arc::clone(&fake.last_limit);
        store
            .with_space_recall(Arc::new(fake))
            .retrieve(
                "anything",
                &RetrievalOptions {
                    top_k: 7,
                    space_ids: Some(vec!["space-a".to_owned()]),
                    ..RetrievalOptions::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(last.load(std::sync::atomic::Ordering::SeqCst), 7);
    }

    /// A store whose embedder can only fail: `Embedder::Remote` pointed at a port
    /// nothing listens on. No network is required for this to be a *fast* failure —
    /// a loopback connect to a closed port is refused immediately, which matters
    /// because this crate builds tokio without the `time` feature and therefore has
    /// no timeout to fall back on.
    fn store_with_a_dead_embedder() -> RetrievalStore {
        RetrievalStore::open_in_memory_with_embedder(
            Embedder::remote(
                "http://127.0.0.1:1",
                "nomic-embed-text",
                TEST_EMBED_DIMS,
                None,
            ),
            TEST_RERANKER_ID.to_owned(),
        )
        .unwrap()
    }

    /// **The defect: an embed-server outage killed graph recall, which needs no
    /// embedding.**
    ///
    /// `retrieve` embedded the query as its first statement and propagated with `?`,
    /// so the Spaces half never ran. A graph-mode Space is answered by a BFS over
    /// `graph_nodes` seeded from the query's own tokens — no vector anywhere in it —
    /// yet a lazily-started `llamacpp-embed` sidecar that was not up yet took it
    /// down, and the chat path swallowed the error into a `warn!`. The user saw an
    /// agent quietly stop citing its allowlisted Space.
    #[tokio::test]
    async fn a_dead_embedder_does_not_take_down_graph_mode_space_recall() {
        let store = store_with_a_dead_embedder();
        // Precondition: the embedder really is broken, so the assertion below is
        // about the restructure and not about a store that quietly fell back local.
        assert!(
            store
                .embedder
                .read()
                .expect("embedder lock is not poisoned")
                .embed("anything")
                .await
                .is_err(),
            "fixture broken: the embedder must fail"
        );

        let fake = FakeSpaces::new(vec![("space-graph", vec!["Moss keeps the ledger"])]);
        let calls = Arc::clone(&fake.calls);
        let hits = store
            .with_space_recall(Arc::new(fake))
            .retrieve(
                "moss ledger",
                &RetrievalOptions {
                    top_k: 4,
                    space_ids: Some(vec!["space-graph".to_owned()]),
                    ..RetrievalOptions::default()
                },
            )
            .await
            .expect("a graph-mode Space must still answer without an embedder");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(
            hits.iter()
                .all(|c| c.space_id.as_deref() == Some("space-graph")),
            "only the Spaces half can survive: every local hit is cosine-scored \
             against a vector that does not exist; got {hits:?}"
        );
        assert!(!hits.is_empty());
    }

    /// **The other half of the contract: the failure stays diagnosable.**
    ///
    /// "Degrade to the Spaces half" must not become "swallow the outage". With
    /// nothing to salvage — no delegate wired here, which is also the `space_ids:
    /// Some([])` shape of the ordinary chat turn — the embedder's own error
    /// propagates, exactly as it did before. An `Ok(vec![])` here would be
    /// indistinguishable from "nothing was relevant" to every caller, including the
    /// auto-recall path that logs and continues.
    #[tokio::test]
    async fn a_dead_embedder_still_errors_when_no_space_can_answer() {
        let store = store_with_a_dead_embedder();
        let err = store
            .retrieve(
                "moss ledger",
                &RetrievalOptions {
                    top_k: 4,
                    ..RetrievalOptions::default()
                },
            )
            .await
            .expect_err("with no Space to answer, the embedder error must surface");
        let rendered = format!("{err:#}");
        assert!(
            rendered.contains("embeddings request failed") || rendered.contains("embeddings"),
            "the surfaced error must still name the embedder failure; got {rendered}"
        );

        // Same when a delegate IS wired but answers nothing: an empty Spaces half is
        // not evidence that the query was answered.
        let err = store
            .with_space_recall(Arc::new(FakeSpaces::failing()))
            .retrieve(
                "moss ledger",
                &RetrievalOptions {
                    top_k: 4,
                    space_ids: Some(vec!["space-graph".to_owned()]),
                    ..RetrievalOptions::default()
                },
            )
            .await;
        assert!(
            err.is_err(),
            "an empty Spaces half must not mask the outage"
        );
    }

    /// **The degraded path must stay diagnosable through `Display`, not only `{:#}`.**
    ///
    /// The test above renders with `{err:#}`, which walks an `anyhow` chain — so it
    /// passes whether the sidecar error is the cause of a context wrapper or is
    /// formatted into the message. The two production callers do NOT agree on that
    /// form: chat auto-recall logs `{e:#}`, but `POST /api/retrieval/search`
    /// (`server::mod`) answers `500` with `e.to_string()`, i.e. plain `Display`.
    ///
    /// With `local_err.context(…)`, `to_string()` yields the context string ALONE and
    /// the embed/rerank failure never reaches the HTTP body — an operator gets a
    /// sentence naming no service, which is strictly less than the raw sidecar error
    /// the route returned before the degraded path existed. That is the whole reason
    /// [`RetrievalStore::retrieve_spaces_only`] formats the cause in instead.
    ///
    /// Asserted on `to_string()` specifically (not `{:#}`) because that is the exact
    /// call the route makes; a future "tidy-up" to `.context(…)` fails here.
    #[tokio::test]
    async fn the_degraded_path_names_the_dead_sidecar_in_plain_display() {
        let store = store_with_a_dead_embedder();
        let err = store
            .retrieve(
                "moss ledger",
                &RetrievalOptions {
                    top_k: 4,
                    ..RetrievalOptions::default()
                },
            )
            .await
            .expect_err("with no Space to answer, the embedder error must surface");

        let plain = err.to_string();
        assert!(
            plain.contains("embeddings"),
            "`e.to_string()` is what POST /api/retrieval/search puts in the 500 body; \
             it must still name the failing sidecar, got {plain}"
        );
        assert!(
            plain.contains("no Space answered"),
            "…and must keep the framing that says why the local half is missing, \
             got {plain}"
        );
    }

    /// **The same defect, one sidecar over.** The rerank pass also propagated with a
    /// bare `?`, and `Reranker::Remote` is not an exotic configuration: every
    /// non-release `RYU_PROFILE` seeds `RYU_RERANKER_BASE_URL`, so on a dev stack the
    /// remote cross-encoder is the default and its `llamacpp-rerank` sidecar is
    /// started lazily. A graph-mode Space calls neither the embedder nor this
    /// reranker, so neither outage may cost it.
    ///
    /// The local list is still dropped rather than returned in cosine order — that
    /// restraint is the pre-existing behaviour and is deliberate (see
    /// `RetrievalStore::retrieve_spaces_only`); the only thing that changes is that
    /// the Spaces half survives.
    #[tokio::test]
    async fn a_dead_reranker_does_not_take_down_graph_mode_space_recall() {
        let store = RetrievalStore {
            reranker: Reranker::remote("http://127.0.0.1:1", "bge-reranker", None),
            ..mem_store()
        };
        seed(&store).await;
        // Precondition: the reranker really is remote-and-broken, so this test is
        // about the restructure and not about a store that quietly stayed local.
        assert!(
            store
                .reranker
                .rerank("anything", vec![chunk("a", 0.5)])
                .await
                .is_err(),
            "fixture broken: the reranker must fail"
        );

        let fake = FakeSpaces::new(vec![("space-graph", vec!["Moss keeps the ledger"])]);
        let hits = store
            .clone()
            .with_space_recall(Arc::new(fake))
            .retrieve(
                "moss ledger",
                &RetrievalOptions {
                    top_k: 4,
                    space_ids: Some(vec!["space-graph".to_owned()]),
                    ..RetrievalOptions::default()
                },
            )
            .await
            .expect("a graph-mode Space must still answer without a reranker");
        assert!(
            hits.iter()
                .all(|c| c.space_id.as_deref() == Some("space-graph")),
            "got {hits:?}"
        );
        assert!(!hits.is_empty());

        // …and with nothing to salvage, the reranker error still surfaces.
        assert!(
            store
                .retrieve(
                    "moss ledger",
                    &RetrievalOptions {
                        top_k: 4,
                        ..RetrievalOptions::default()
                    },
                )
                .await
                .is_err(),
            "a rerank outage with no Space to answer must not become an empty result"
        );
    }
}
