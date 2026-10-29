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

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex as StdMutex, RwLock,
};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::content_sqlite::{self, ColumnPlan, KeyKind, StoreKeyState};
use ryu_crypto::{BlindIndex, ContentCipher, ContentContext, VectorCoverage, VectorIndex};
use ryu_kernel_contracts::ResourceKey;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

pub mod expansion;
pub mod filter;
pub mod hybrid;
mod memory_graph;
pub mod splitter;

pub use expansion::{expand_query, ExpandedQuery, ExpansionOptions, QueryRewriter};
pub use filter::MetadataFilter;
pub use hybrid::HybridOptions;
pub use memory_graph::{
    MemoryGraph, MemoryGraphDocument, MemoryGraphEdge, MemoryGraphHit, MemoryGraphNode,
    MemoryGraphNodeKind, MemoryGraphQuery, MemoryGraphSnapshot,
};
pub use splitter::{ChunkMetadata, ChunkingStrategy, TextChunk};

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
    /// Metadata predicate every returned chunk must satisfy (see
    /// [`MetadataFilter`]). Applied to this store's own chunks against their
    /// stored metadata plus the built-in fields `source`, `space_id`, `scope`,
    /// `agent_id` and `importance`, and forwarded to the [`SpaceRecall`]
    /// delegate, which evaluates it against each Space chunk's document and
    /// splitter metadata. `None` filters nothing.
    #[serde(default)]
    pub filter: Option<MetadataFilter>,
    /// Hybrid BM25 + vector search for delegated Spaces (see [`HybridOptions`]).
    /// `None` keeps each Space's own retrieval mode unchanged. This store's own
    /// chunks are always ranked by vector similarity.
    #[serde(default)]
    pub hybrid: Option<HybridOptions>,
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
            filter: None,
            hybrid: None,
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

/// Largest serialized metadata object accepted by
/// [`RetrievalStore::index_chunk_with_metadata`].
pub const MAX_CHUNK_METADATA_BYTES: usize = 16 * 1024;

/// Default number of chunks injected when a request does not specify `top_k`.
pub const DEFAULT_TOP_K: usize = 5;

/// Default importance for a memory chunk missing the column (mid of the 1..=5 scale).
pub const DEFAULT_MEM_IMPORTANCE: i32 = 3;

/// Per-importance-point nudge to a memory chunk's relevance score. Small enough
/// that a genuinely more-similar chunk still wins, but a high-importance fact
/// breaks near-ties in its favour.
const IMPORTANCE_BOOST_STEP: f32 = 0.02;

mod embed;
mod rerank;
mod store;

use embed::*;
pub use embed::{Embedder, EMBED_BATCH_SIZE};
pub use rerank::Reranker;
pub use store::{
    OkfEdge, OkfIngestSummary, RetrievalKeys, RetrievalStore, StaleEmbeddingReindexControl,
    StaleEmbeddingReindexOutcome, StaleEmbeddingReindexProgress, RETRIEVAL_STORE,
};

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

/// Why [`RetrievalStore::retrieve_local`] produced no list. A sidecar outage
/// degrades to a Spaces-only answer; a store error is returned as is.
enum LocalRetrievalError {
    SidecarUnavailable(anyhow::Error),
    Store(anyhow::Error),
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod at_rest_tests;
