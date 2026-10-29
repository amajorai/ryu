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
//! When set to `"graph"`, ingestion additionally extracts normalized terms and
//! directed within-chunk co-occurrence pairs into `graph_nodes` / `graph_edges`.
//! `SpaceStore::search` then branches on the mode: vector mode runs the existing
//! KNN query; graph mode runs entity-matching + BFS traversal and returns the
//! grounded chunks reachable from the query's entities.
//!
//! `RYU_GRAPH_EXTRACTION_MODEL` / `registry.json` `graph_extraction_model` select
//! the implementation. `local-cooccurrence` is the only shipped value and is
//! deterministic/offline; unsupported ids fail store creation instead of being
//! accepted while the local algorithm runs silently.
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
//! U10 `ConversationStore` shape exactly.
//!
//! Encryption at rest: free text (chunk text and chunk metadata included) and
//! embeddings are sealed per value under the `spaces.db` content key and blob
//! files are sealed `RYU-SF01` files; equality lookups use blind tokens and body
//! search a blind term index. See [`seal`] for the formats and the SQL
//! functions every statement uses to reach the cipher.

mod database_formula;
mod database_query;
mod history;
mod retrieval;
mod seal;

use retrieval::{embed_text_chunks, EmbeddedChunk};
pub use retrieval::{ParentExpansion, SpaceSearchOptions, MAX_SEARCH_QUERIES};

#[cfg(test)]
mod version_history_tests;

#[cfg(test)]
mod seal_tests;

pub mod backup;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::OnceLock;

use anyhow::{Context, Result};
use rusqlite::{named_params, params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

// Spaces reuse the async `Embedder` from the RAG primitive (Local hashing +
// Remote OpenAI-compatible `/v1/embeddings`). Sharing one embedder type means a
// Space's markdown pages get the same real semantic embeddings (the local
// `llamacpp-embed` nomic server by default) the retrieval store uses, and a
// single swap changes the model everywhere.
use ryu_crypto::content_sqlite::{self, StoreKeyState};
use ryu_crypto::{ContentContext, VectorIndex};
use ryu_kernel_contracts::ResourceKey;
use ryu_rag::{Embedder, Reranker};
use ryu_workspace::source_history::{SourceHistory, SourceHistoryVersion};

use history::{
    decode_snapshot, encode_snapshot, plan_automatic_retention, RetentionCandidate,
    SnapshotPayload, AUTO_BUCKET_MS, MAX_HISTORY_BYTES_PER_SPACE, SNAPSHOT_CODEC,
};

/// Default embedding dimensionality for the in-memory/test store when the caller
/// does not resolve a model registry. Production stores are opened through the
/// Core-side `spaces` shim, which passes the registry-configured dims — this
/// constant only parameterizes the crate's own test/in-memory constructor and is
/// self-consistent with the `Embedder::Local { dims }` it pairs with, so it never
/// interacts with the Core registry value.
pub const DEFAULT_EMBED_DIMS: usize = 768;

static SOURCE_HISTORY_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Publish Core's managed source-history root. The extracted Spaces crate keeps
/// this host path as an explicit seam, just like the embedder and blob root.
pub fn set_source_history_root(root: PathBuf) {
    let _ = SOURCE_HISTORY_ROOT.set(root);
}

fn source_history() -> SourceHistory {
    let root = SOURCE_HISTORY_ROOT.get().cloned().unwrap_or_else(|| {
        if cfg!(test) {
            // Per process: the history is sealed under this process's master
            // key, and a test run with a fresh RYU_DIR has a different one.
            std::env::temp_dir().join(format!("ryu-spaces-{}", std::process::id()))
        } else {
            ryu_sidecar_runtime::layout::files_path(
                &ryu_sidecar_runtime::ryu_dir(),
                "source-history",
            )
        }
    });
    SourceHistory::new(root)
}

fn source_history_path(doc_id: &str, kind: &str, space_id: &str) -> String {
    let extension = if kind == "page" { "md" } else { "json" };
    format!("spaces/{space_id}/documents/{doc_id}.{extension}")
}

async fn checkpoint_source_history(
    relative_path: String,
    content: String,
    label: Option<String>,
) -> Result<SourceHistoryVersion> {
    let history = source_history();
    tokio::task::spawn_blocking(move || {
        history.checkpoint(&relative_path, &content, label.as_deref())
    })
    .await
    .context("source history checkpoint task panicked")
    .and_then(|result| result.context("checkpointing source history"))
}

/// Record history after a committed Space mutation without changing the
/// mutation's response semantics. SQLite is the source-of-truth transaction;
/// Git is a durable audit projection that can be repaired after a transient
/// disk or process failure.
async fn checkpoint_source_history_best_effort(
    relative_path: String,
    content: String,
    label: Option<String>,
) {
    if let Err(error) = checkpoint_source_history(relative_path.clone(), content, label).await {
        tracing::warn!(
            path = %relative_path,
            error = %error,
            "Space source-history checkpoint was not recorded"
        );
    }
}

async fn list_source_history(
    relative_path: String,
    limit: Option<usize>,
) -> Result<Vec<SourceHistoryVersion>> {
    let history = source_history();
    tokio::task::spawn_blocking(move || history.list(&relative_path, limit))
        .await
        .context("source history list task panicked")?
        .context("listing source history")
}

async fn read_source_history(relative_path: String, version_id: String) -> Result<Option<String>> {
    let history = source_history();
    tokio::task::spawn_blocking(move || history.read(&relative_path, &version_id))
        .await
        .context("source history read task panicked")?
        .context("reading source history")
}

fn is_git_version_id(version_id: &str) -> bool {
    (7..=64).contains(&version_id.len())
        && version_id
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

/// Supported graph-extraction implementation id. The in-memory/test store selects
/// it directly; production stores receive the configured id through Core and reject
/// any other value before opening the database.
pub const DEFAULT_GRAPH_EXTRACTION_MODEL: &str = "local-cooccurrence";

const RETRIEVAL_REBUILD_BATCH_SIZE: usize = 32;
const MAX_RETRIEVAL_MODE_TERMINAL_STATUSES: usize = 16;
/// Bound graph construction to at most 64 unique terms per chunk/query. Since the
/// local extractor writes directed pairs, this caps one chunk at 4,032 edges.
const MAX_EXTRACTED_GRAPH_TERMS: usize = 64;
const MAX_GRAPH_TERM_BYTES: usize = 128;
const MAX_GRAPH_CHUNKS_PER_DOCUMENT: usize = 256;
const MAX_GRAPH_ROWS_PER_SPACE: usize = 2_000_000;
const MAX_DOCUMENT_TITLE_BYTES: usize = 512;
const MAX_DOCUMENT_MIME_BYTES: usize = 255;
/// Durable file-storage ceilings checked inside the same SQLite transaction as
/// the document insert. The node ceiling bounds aggregate disk growth while the
/// owner ceiling prevents one local user/org from consuming the whole node.
pub const MAX_FILE_BYTES_PER_OWNER: i64 = 512 * 1024 * 1024;
pub const MAX_FILE_COUNT_PER_OWNER: i64 = 10_000;
pub const MAX_FILE_BYTES_PER_NODE: i64 = 4 * 1024 * 1024 * 1024;

/// A validated graph-extraction implementation.
///
/// Keeping this as an enum prevents a configured-but-unsupported id from entering
/// the store and being reported as active while [`extract_entities`] still runs the
/// local algorithm.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GraphExtractionModel {
    LocalCooccurrence,
}

impl GraphExtractionModel {
    fn parse(configured: &str) -> Result<Self> {
        match configured.trim() {
            DEFAULT_GRAPH_EXTRACTION_MODEL => Ok(Self::LocalCooccurrence),
            _ => anyhow::bail!(
                "unsupported graph extraction model '{configured}'; only '{DEFAULT_GRAPH_EXTRACTION_MODEL}' is available"
            ),
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::LocalCooccurrence => DEFAULT_GRAPH_EXTRACTION_MODEL,
        }
    }
}

/// Owner attribution for a Spaces/documents row — the extracted, apps/core-free
/// twin of Core's `conversations::Tenancy`. It is a plain data record (NOT a
/// parallel enum with `owned_by`-style logic), so it cannot drift from the
/// conversation plane's semantics: `(None, None)` is byte-identical to
/// `Tenancy::Unattributed`, and `Some(user)` is `Tenancy::Owned`. The Core-side
/// `spaces` shim lowers a `Tenancy` into this at the boundary
/// (`spaces::owner_of` / `background_owner` / `caller_owner`), keeping the
/// choke-point contract (a mandatory argument, never an `Option`) intact.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocOwner {
    /// The owning user id, or `None` for an unattributed row (unbound personal
    /// node, or a write into an already-existing row whose owner is preserved).
    pub user_id: Option<String>,
    /// The owning org id, if any.
    pub org_id: Option<String>,
}

impl DocOwner {
    /// The unattributed owner — byte-identical to `Tenancy::Unattributed`.
    pub fn unattributed() -> Self {
        Self::default()
    }

    /// Attribute to `user_id` (with optional `org_id`) unless it is absent, in
    /// which case the row is unattributed.
    pub fn owned(user_id: Option<&str>, org_id: Option<&str>) -> Self {
        match user_id {
            Some(uid) => Self {
                user_id: Some(uid.to_owned()),
                org_id: org_id.map(str::to_owned),
            },
            None => Self::unattributed(),
        }
    }

    /// The `(owner_user_id, org_id)` column pair this owner writes.
    fn parts(&self) -> (Option<&str>, Option<&str>) {
        (self.user_id.as_deref(), self.org_id.as_deref())
    }

    /// Derive a `DocOwner` from the shared [`ResourceKey`] composition layer. The
    /// key's compound `node`/`project`/`session` fields live at the layer above and
    /// never affect this collapse: a `DocOwner` is exactly the key's
    /// `(owner_user_id, org_id)` pair, byte-identical to [`Self::owned`] fed the
    /// same pair. This is the "constructors accept-or-derive a ResourceKey
    /// internally" seam — the [`upsert_document_row`] / [`upsert_space_row`] choke
    /// points still call [`Self::parts`], unchanged.
    pub fn from_resource_key(key: &ResourceKey) -> Self {
        let (user_id, org_id) = key.to_tenancy_parts();
        Self::owned(user_id, org_id)
    }

    /// Lift this owner into the shared [`ResourceKey`] so a caller can compose the
    /// fuller address (session/project/node) before lowering it back. Round-trips
    /// through the `(user, org)` pair, so it never invents attribution.
    pub fn to_resource_key(&self) -> ResourceKey {
        ResourceKey::from_tenancy_parts(self.user_id.as_deref(), self.org_id.as_deref())
    }
}

/// Access metadata for a document row — the extracted, apps/core-free twin of
/// Core's `identity_verify::ResourceTenancy`. The Core-side `spaces` shim
/// (`spaces::doc_access_meta`) maps this into `ResourceTenancy` so the shared
/// `resource_access` row-gate keeps receiving one type from both the conversation
/// and the Spaces stores.
#[derive(Debug, Clone)]
pub struct DocAccessMeta {
    /// The owning user id, or `None` for an unattributed row.
    pub owner_user_id: Option<String>,
    /// The owning org id, if any.
    pub org_id: Option<String>,
    /// The row's visibility (`NOT NULL DEFAULT 'private'`, so always present).
    pub visibility: String,
    /// The team the row is shared with, if any.
    pub team_id: Option<String>,
}

/// Access metadata for a Space row — the twin of [`DocAccessMeta`] for the
/// `spaces` table, so the Core-side `spaces::space_access_meta` shim can map it
/// into `ResourceTenancy` for the per-resource `resource_access` row-gate (the
/// `delete_space` write gate). Carries `system` so a caller can distinguish a
/// node-singleton system space (`system = 1`, NULL owner) from a user space.
#[derive(Debug, Clone)]
pub struct SpaceAccessMeta {
    /// The owning user id, or `None` for a system / unattributed space.
    pub owner_user_id: Option<String>,
    /// The owning org id, if any.
    pub org_id: Option<String>,
    /// The row's visibility (`NOT NULL DEFAULT 'private'`, so always present).
    pub visibility: String,
    /// The team the row is shared with, if any.
    pub team_id: Option<String>,
    /// Whether this is a Ryu-created system space (Artifacts / Meetings / Canvas /
    /// Clips) — a node singleton with no owner, kept shared to every member.
    pub system: bool,
}

/// Maximum characters per chunk before the ingestion pipeline splits.
///
/// Also the reason entity fan-out per chunk is bounded by a constant: a chunk this
/// size holds ≲ 250 tokens of ≥ 3 characters, so [`extract_entities`] can return at
/// most ~250 entities and [`build_graph_for_chunks`] at most ~62,250 edges for it.
/// That is the worst case; measured on English prose it is **≈57 distinct entities
/// ⇒ ≈3,200 edges per chunk**. Raising this raises the graph's per-chunk cost
/// **quadratically** — and the per-Space cost with it (see the measured table on
/// [`build_graph_for_chunks`]).
const CHUNK_CHAR_SIZE: usize = 1_000;

/// Maximum entities carried from one [`SpaceStore::graph_search`] BFS hop into the
/// next.
///
/// Not a tuning knob so much as the thing that makes the traversal terminate in
/// bounded work: co-occurrence edges join every entity pair within a chunk, so an
/// entity's out-degree grows with the size of the Space, and an unbounded hop-2
/// frontier is "every entity in the Space". 512 is far above what any fixture or
/// realistic query needs to reach its `limit` chunks (the multi-hop fixture walks
/// frontiers of size ≤ 3), and far below the point where a hop's SQL cost is
/// noticeable.
///
/// # Exact semantics, because "a cap" underspecifies three things
///
/// - **Per hop, not cumulative.** `next_frontier` is rebuilt each iteration, so the
///   ceiling on entities expanded by a whole search is `seeds + max_hops × 512`, not
///   512.
/// - **It keeps the lexicographically smallest neighbours**, because the edge query
///   carries `ORDER BY e.dst_entity` (that `ORDER BY` is there for determinism, and
///   this is its second, unadvertised job). Which entities survive is therefore
///   arbitrary with respect to relevance — it is alphabetical.
/// - **It bounds frontier growth only, not the hop's work.** The check sits *after*
///   chunk collection, so a saturated hop still issues one chunk query per frontier
///   entity; what it stops is the *next* hop exploding.
///
/// Retuning this **changes retrieval**, it does not merely change speed: a chunk
/// whose only path runs through a truncated frontier entity stops being reachable —
/// and in a sparse Space it stays unreachable, since nothing rediscovers the dropped
/// entity on a later hop. That is not a theory; it is asserted by
/// `graph_search_frontier_truncation_can_drop_a_reachable_chunk`, which fails (finds
/// the chunk) the moment the cap is lifted. Three tests hold the bound, sized from
/// this constant so changing it cannot leave them vacuous:
/// `graph_search_truncates_an_oversized_frontier` (the branch runs, over stored
/// edges), `graph_search_reaches_a_two_hop_chunk_through_a_truncated_frontier` (a
/// truncated search still returns the grounded chunk), and the lossiness test above.
const MAX_FRONTIER_ENTITIES: usize = 512;
/// Link expansion shares the reranker candidate budget with vector/term hits.
const MAX_LINK_EXPANDED_DOCUMENTS: usize = 16;
const MAX_LINK_EXPANDED_CHUNKS: usize = 32;

/// **The graph seed floor.** A query entity present in more than this fraction of a
/// Space's chunks does not discriminate between them, so it is not allowed to seed
/// the traversal when a rarer query entity can.
///
/// # Why a floor exists at all
///
/// [`extract_entities`] admits every token ≥ 3 chars that is capitalised **or**
/// longer than 4 — i.e. most words of ordinary prose. Seeding a BFS from all of them
/// makes graph recall approximately "any chunk sharing a long word with the query",
/// and since [`fuse_ranked_lists`](ryu_rag::fuse_ranked_lists) merges by *rank*, that
/// list's first element lands next to the best cosine hit in **every** chat turn for
/// an allowlisted graph Space. Worse, the seed loop stops the moment `limit` chunks
/// are collected, so a Space-wide-common entity that happens to sort first in the
/// query crowds the rare, discriminating one out entirely — the chunk the user was
/// actually asking about is never even visited.
/// `graph_seed_floor_keeps_a_common_word_from_crowding_out_a_rare_one` is that case,
/// and it fails without this floor.
///
/// # Why *this* floor, and what it deliberately does not do
///
/// It is classic inverse-document-frequency pruning, computed from the Space's own
/// `graph_nodes` rows: deterministic, offline, no model, one `COUNT` per query
/// entity. It filters **seeds only** — a common entity reached as a *neighbour* is
/// still expanded, so no multi-hop path is cut. That is what keeps
/// `graphrag_multi_hop_finds_connected_chunk_that_vector_misses` (the only proof the
/// feature works) answering exactly as before.
///
/// The cost of that restraint, stated rather than left to be discovered: this is
/// **not** a filter over the result. When the flooding word and the rare one share a
/// chunk — the normal case, since that is usually why the user typed both — the
/// flooding entity comes back as a hop-1 neighbour and its chunks are collected a hop
/// later. What the floor changes is which chunk is visited *first*, and therefore
/// what occupies rank 0, which is the position the chat path injects.
///
/// Two escape hatches keep it from ever emptying a result set that works today:
///
/// - **Small Spaces are exempt** ([`SEED_FLOOR_MIN_CHUNKS`]): below that many chunks
///   the fraction is noise, not a statistic.
/// - **If every query entity floods, none is dropped.** A single-entity query, and a
///   query made only of Space-wide words, seed exactly as they did before — there is
///   no rarer alternative to prefer, and returning nothing would be strictly worse
///   than returning something weakly grounded.
///
/// 0.5 is a judgement, not a measurement, and is stated as one: an entity in more
/// than half a Space's chunks cannot partition it. Retuning it **changes which
/// chunks a graph query returns**, so it belongs in the same commit as the test
/// above.
const SEED_MAX_CHUNK_FRACTION: f64 = 0.5;

/// Minimum Space size (in chunks) before [`SEED_MAX_CHUNK_FRACTION`] is applied at
/// all. In a three-chunk Space "appears in more than half the chunks" describes two
/// chunks, which says nothing about a term's specificity — so the floor would be
/// filtering on noise. Kept deliberately small: it exists to exempt fixtures and
/// brand-new Spaces, not to disable the floor in practice.
const SEED_FLOOR_MIN_CHUNKS: i64 = 8;

/// Name of the auto-created, hidden Space that backs meeting notes. Kept in sync
/// with `meetings_api::MEETINGS_SPACE_NAME` and the desktop's spaces hide-filter.
/// The danger-zone "delete all spaces" preserves and ignores this Space.
const MEETINGS_SPACE_NAME: &str = "Meetings";

/// Name of the default, undeletable system Space that holds **user**-initiated
/// file uploads (chat attachments, page/editor media, `ui.uploadFile`). Twin of
/// the Artifacts space (agent-created files). Seeded at Core boot; callers resolve
/// it via [`SpaceStore::ensure_system_space`].
pub const UPLOADS_SPACE_NAME: &str = "Uploads";

// ── Per-resource tenancy (twin of conversations.rs) ──────────────────────────
//
// Spaces/documents mirror the conversation plane exactly (`conversations.rs`):
//   - CREATE stamps an owner via the ONE choke point (`upsert_document_row` /
//     `upsert_space_row`), which always emits the tenancy clause, so a future
//     creation path cannot silently forget (the mandatory [`Tenancy`] enum, not an
//     `Option`, is what makes "forgot to stamp" a compile error).
//   - LIST/SEARCH visibility is expressed by ONE SQL predicate below, so the row
//     gate (`server/mod.rs` `resource_access`, via `get_access_meta`) and the list
//     gate can never drift.
//   - a one-shot backfill (`SpaceStore::backfill_tenancy`) attributes pre-ACL
//     NULL rows to the local owner once the node binds — WITHOUT it, the by-id ACL
//     denies every untenanted document on a bound node (a lockout, not a leak).

/// Document visibility filter — the SQL twin of `resource_access` for the
/// `documents` table (alias `d`). Mirrors `conversations.rs::TENANCY_VISIBLE_PREDICATE`:
///   - `:bound = 0` (node UNBOUND, the single local principal): no restriction.
///     Byte-identical to the pre-ACL behaviour.
///   - `:bound = 2` (node UNBOUND, see [`DocFilter::restricted_when_unbound`]):
///     untenanted legacy rows plus the caller's own and shared rows.
///   - node ORG-BOUND: a document is visible iff the caller OWNS it, or it is
///     explicitly shared (`visibility` in `org`/`team`) within the caller's org. An
///     untenanted (NULL-owner) document is INVISIBLE on a bound node — matching the
///     by-id ACL's fail-closed reading of an unattributable legacy row.
const DOC_TENANCY_VISIBLE_PREDICATE: &str = "(
        :bound = 0
        OR (:bound = 2 AND d.owner_user_id IS NULL AND d.org_id IS NULL)
        OR (:uid IS NOT NULL AND d.owner_user_id = :uid)
        OR (:uid IS NOT NULL AND :org IS NOT NULL AND d.org_id = :org
            AND (d.visibility = 'org'
                 OR (d.visibility = 'team' AND d.team_id IN
                     (SELECT value FROM json_each(:teams)))))
        OR EXISTS (
            SELECT 1 FROM spaces inherited_space
            WHERE inherited_space.id = d.space_id
              AND (
                  inherited_space.system = 1
                  OR (:uid IS NOT NULL AND :org IS NOT NULL
                      AND inherited_space.org_id = :org
                      AND (inherited_space.visibility = 'org'
                           OR (inherited_space.visibility = 'team'
                               AND inherited_space.team_id IN
                                   (SELECT value FROM json_each(:teams)))))
              )
        )
     )";

/// Space visibility filter — the SQL twin for the `spaces` table (alias `s`).
/// Identical to [`DOC_TENANCY_VISIBLE_PREDICATE`] PLUS `OR s.system = 1`: system
/// spaces (Artifacts / Uploads / Meetings / Canvas / Clips) are node singletons with
/// no owner and MUST stay visible to every member, or the whole node loses them.
const SPACE_TENANCY_VISIBLE_PREDICATE: &str = "(
        s.system = 1
        OR :bound = 0
        OR (:bound = 2 AND s.owner_user_id IS NULL AND s.org_id IS NULL)
        OR (:uid IS NOT NULL AND s.owner_user_id = :uid)
        OR (:uid IS NOT NULL AND :org IS NOT NULL AND s.org_id = :org
            AND (s.visibility = 'org'
                 OR (s.visibility = 'team' AND s.team_id IN
                     (SELECT value FROM json_each(:teams)))))
     )";

/// The caller context a tenancy-filtered Spaces query is evaluated against. Cheap
/// to clone; construct via [`DocFilter::unrestricted`] (in-process, full-trust) or
/// [`DocFilter::for_caller`] (an HTTP request narrowed to this node's org).
#[derive(Clone)]
pub struct DocFilter<'a> {
    /// Whether THIS node is bound to an org. Unbound → no filtering at all.
    node_bound: bool,
    /// The verified caller's user id, or `None` for an anonymous caller.
    owner_user_id: Option<&'a str>,
    /// The caller's org (already narrowed to this node's org by identity verify).
    org_id: Option<&'a str>,
    /// All verified team memberships, encoded once for SQLite's `json_each`.
    /// Owning this value avoids order-dependent authorization for multi-team users.
    team_ids_json: String,
    /// On an UNBOUND node, whether the caller is narrower than the node's single
    /// local principal (a verified user, or an anonymous remote request). Ignored
    /// on a bound node. See [`Self::restricted_when_unbound`].
    restricted_when_unbound: bool,
}

impl<'a> DocFilter<'a> {
    /// The in-process, full-trust filter: every row on the node (used by internal
    /// callers and by the unbound single-user path).
    pub fn unrestricted() -> Self {
        Self {
            node_bound: false,
            owner_user_id: None,
            org_id: None,
            team_ids_json: "[]".to_owned(),
            restricted_when_unbound: false,
        }
    }

    /// The filter for an HTTP caller. `node_bound = false` collapses to
    /// [`Self::unrestricted`] regardless of the ids, keeping the personal-node path
    /// byte-identical.
    pub fn for_caller(
        owner_user_id: Option<&'a str>,
        org_id: Option<&'a str>,
        node_bound: bool,
    ) -> Self {
        Self::for_caller_with_teams(owner_user_id, org_id, &[], node_bound)
    }

    /// Build a caller filter with a team-scoped visibility context.
    pub fn for_caller_with_team(
        owner_user_id: Option<&'a str>,
        org_id: Option<&'a str>,
        team_id: Option<&'a str>,
        node_bound: bool,
    ) -> Self {
        let team_ids: Vec<&str> = team_id.into_iter().collect();
        Self::for_caller_with_teams(owner_user_id, org_id, &team_ids, node_bound)
    }

    /// Build a caller filter from the caller's complete verified team set.
    pub fn for_caller_with_teams(
        owner_user_id: Option<&'a str>,
        org_id: Option<&'a str>,
        team_ids: &[&str],
        node_bound: bool,
    ) -> Self {
        Self {
            node_bound,
            owner_user_id,
            org_id,
            team_ids_json: serde_json::to_string(team_ids)
                .expect("serializing verified team ids cannot fail"),
            restricted_when_unbound: false,
        }
    }

    /// Narrow an UNBOUND-node filter from the single local principal's full view
    /// to untenanted legacy rows plus the rows this caller owns or was shared.
    /// Core applies it to verified callers and to anonymous remote requests, the
    /// same boundary its by-id ACL and realtime gateway draw.
    #[must_use]
    pub fn restricted_when_unbound(mut self) -> Self {
        self.restricted_when_unbound = true;
        self
    }

    /// `:bound` for the tenancy predicates: `1` bound, `0` unbound full view, `2`
    /// unbound restricted view.
    fn bound_flag(&self) -> i64 {
        if self.node_bound {
            1
        } else if self.restricted_when_unbound {
            2
        } else {
            0
        }
    }
}

/// **CHOKE POINT** — the one and only `INSERT INTO documents` in Core.
///
/// Every path that brings a document row into existence (`ingest_document`,
/// `create_document_of_kind` and its `create_page`/`create_database`/
/// `create_whiteboard`/`create_child_page`/`app_create_doc` callers, `create_file`)
/// funnels through here, and this statement ALWAYS emits the tenancy clause. The
/// mandatory [`Tenancy`] argument (no default) is what makes "a new creation path
/// forgot to stamp its owner" a compile error rather than a silent lockout.
///
/// `ON CONFLICT` = COALESCE preserve-never-clobber + first-writer-wins, matching
/// `conversations::upsert_conversation_row`. The caller has already inserted the
/// document's non-tenancy columns in the same statement; this fn owns only the
/// full row insert so the tenancy clause lives in exactly one place.
fn validate_document_metadata(title: &str, mime: Option<&str>) -> Result<()> {
    anyhow::ensure!(
        title.len() <= MAX_DOCUMENT_TITLE_BYTES,
        "document title exceeds the {MAX_DOCUMENT_TITLE_BYTES}-byte limit"
    );
    if let Some(mime) = mime {
        anyhow::ensure!(
            mime.len() <= MAX_DOCUMENT_MIME_BYTES,
            "document MIME type exceeds the {MAX_DOCUMENT_MIME_BYTES}-byte limit"
        );
    }
    Ok(())
}

/// Reserve the next file's durable quota before any document/blob row is
/// committed. The caller holds SpaceStore's SQLite mutex and invokes this from
/// an active transaction, so concurrent uploads cannot both observe the same
/// remaining capacity. `existing_doc_id` is used by file replacement to remove
/// the old revision from the accounting before adding the new one.
fn ensure_file_quota(
    conn: &Connection,
    byte_size: i64,
    tenancy: &DocOwner,
    existing_doc_id: Option<&str>,
) -> Result<()> {
    anyhow::ensure!(byte_size >= 0, "file size cannot be negative");
    let (owner_user_id, org_id) = tenancy.parts();
    let (owner_bytes, owner_count, node_bytes): (i64, i64, i64) = conn.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN owner_user_id IS ?1 AND org_id IS ?2
                              THEN COALESCE(byte_size, 0) ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN owner_user_id IS ?1 AND org_id IS ?2
                              THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(COALESCE(byte_size, 0)), 0)
         FROM documents
         WHERE kind = 'file'
           AND (?3 IS NULL OR id <> ?3)",
        params![owner_user_id, org_id, existing_doc_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;

    if owner_count >= MAX_FILE_COUNT_PER_OWNER
        || owner_bytes.saturating_add(byte_size) > MAX_FILE_BYTES_PER_OWNER
    {
        anyhow::bail!(
            "file quota exceeded for this owner ({} files or {} bytes)",
            MAX_FILE_COUNT_PER_OWNER,
            MAX_FILE_BYTES_PER_OWNER
        );
    }
    if node_bytes.saturating_add(byte_size) > MAX_FILE_BYTES_PER_NODE {
        anyhow::bail!(
            "file quota exceeded for this node ({} bytes)",
            MAX_FILE_BYTES_PER_NODE
        );
    }
    Ok(())
}

fn upsert_document_row(
    conn: &Connection,
    document_id: &str,
    space_id: &str,
    title: &str,
    now: i64,
    source: &str,
    kind: &str,
    parent_id: Option<&str>,
    mime: Option<&str>,
    blob_sha256: Option<&str>,
    byte_size: Option<i64>,
    tenancy: &DocOwner,
) -> Result<()> {
    validate_document_metadata(title, mime)?;
    let (owner_user_id, org_id) = tenancy.parts();
    conn.execute(
        "INSERT INTO documents
            (id, space_id, title, title_bi, created_at, source, updated_at, kind, parent_id,
             mime, blob_sha256, byte_size, owner_user_id, org_id)
         VALUES (:id, :space_id, ryu_seal('documents.title', :id, :title),
             ryu_bi('documents.title', :title), :now,
             ryu_seal('documents.source', :id, :source), :now, :kind, :parent_id,
             :mime, :blob_sha256, :byte_size, :owner, :org)
         ON CONFLICT(id) DO UPDATE SET
             owner_user_id = COALESCE(documents.owner_user_id, excluded.owner_user_id),
             org_id        = COALESCE(documents.org_id, excluded.org_id)",
        named_params! {
            ":id": document_id,
            ":space_id": space_id,
            ":title": title,
            ":now": now,
            ":source": source,
            ":kind": kind,
            ":parent_id": parent_id,
            ":mime": mime,
            ":blob_sha256": blob_sha256,
            ":byte_size": byte_size,
            ":owner": owner_user_id,
            ":org": org_id,
        },
    )
    .context("inserting document (choke point)")?;
    Ok(())
}

/// **CHOKE POINT** — the one and only `INSERT INTO spaces` in Core. Twin of
/// [`upsert_document_row`]; a system space passes [`Tenancy::Unattributed`] and sets
/// `system = 1` so the visibility predicate keeps it shared.
fn upsert_space_row(
    conn: &Connection,
    space_id: &str,
    name: &str,
    description: Option<&str>,
    now: i64,
    retrieval_mode: &str,
    system: i64,
    tenancy: &DocOwner,
) -> Result<()> {
    upsert_space_row_with_visibility(
        conn,
        space_id,
        name,
        description,
        now,
        retrieval_mode,
        system,
        tenancy,
        "private",
        None,
    )
}

fn upsert_space_row_with_visibility(
    conn: &Connection,
    space_id: &str,
    name: &str,
    description: Option<&str>,
    now: i64,
    retrieval_mode: &str,
    system: i64,
    tenancy: &DocOwner,
    visibility: &str,
    team_id: Option<&str>,
) -> Result<()> {
    let (owner_user_id, org_id) = tenancy.parts();
    conn.execute(
        "INSERT INTO spaces
            (id, name, name_bi, description, created_at, updated_at, retrieval_mode, system,
             owner_user_id, org_id, visibility, team_id)
         VALUES (:id, ryu_seal('spaces.name', :id, :name), ryu_bi('spaces.name', :name),
                 ryu_seal('spaces.description', :id, :description), :now, :now, :mode,
                 :system, :owner, :org, :visibility, :team_id)
         ON CONFLICT(id) DO UPDATE SET
             owner_user_id = COALESCE(spaces.owner_user_id, excluded.owner_user_id),
             org_id        = COALESCE(spaces.org_id, excluded.org_id)",
        named_params! {
            ":id": space_id,
            ":name": name,
            ":description": description,
            ":now": now,
            ":mode": retrieval_mode,
            ":system": system,
            ":owner": owner_user_id,
            ":org": org_id,
            ":visibility": visibility,
            ":team_id": team_id,
        },
    )
    .context("inserting space (choke point)")?;
    Ok(())
}

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
    /// Cosine KNN over the Space's sealed embeddings, scored in memory (default).
    #[default]
    Vector,
    /// Entity/relation graph traversal over the `graph_nodes`/`graph_edges` tables.
    Graph,
}

impl RetrievalMode {
    /// The wire + column spelling. This is the ONE spelling: it is what the
    /// `retrieval_mode` column stores, what `Serialize` emits (the `snake_case`
    /// rename above produces the same two strings), and what [`Self::parse`]
    /// accepts. Keep the three in lockstep — a wire form that does not round-trip
    /// through `parse`/`as_str` silently degrades to `Vector`, which is exactly the
    /// "settable value that cannot take effect" defect this API exists to remove.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vector => "vector",
            Self::Graph => "graph",
        }
    }

    /// **Strict** parse for values that arrive from a *caller* (HTTP body, env var,
    /// `registry.json`). Returns `None` for an unknown or empty spelling so the
    /// caller can reject it loudly instead of quietly retrieving with the wrong
    /// algorithm. Use this everywhere a human typed the value.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "vector" => Some(Self::Vector),
            "graph" => Some(Self::Graph),
            _ => None,
        }
    }

    /// **Lenient** parse for values read back out of the `retrieval_mode` column.
    ///
    /// Deliberately different from [`Self::parse`]: a DB row is not a caller. The
    /// column is `NOT NULL DEFAULT 'vector'`, so the only way an unknown spelling
    /// gets there is a hand-edited sqlite file or a downgrade from a future build
    /// that added a third mode. Degrading such a row to `Vector` keeps its Space
    /// searchable; erroring would make every query on it fail. Writes are guarded
    /// by `parse` at the boundary, so this can never mask a live typo.
    fn from_str(s: &str) -> Self {
        match s {
            "graph" => Self::Graph,
            _ => Self::Vector,
        }
    }
}

/// What a [`SpaceStore::set_retrieval_mode`] call actually did.
///
/// Every field exists so the HTTP response can *state the consequence* rather than
/// just returning 200. Switching a populated Space to `Graph` is not a metadata
/// edit: graph extraction is gated on mode inside `insert_chunks`, so a Space that
/// was ingested in `Vector` mode has **no** `graph_nodes`/`graph_edges` rows at all,
/// and flipping only the column would route its searches at an empty graph — a
/// Space that answers nothing. So the switch rebuilds the graph from the chunks
/// already on disk, in the same transaction, and reports what it built.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct RetrievalModeChange {
    /// The mode the Space had before this call.
    pub previous: RetrievalMode,
    /// The mode the Space has now.
    pub mode: RetrievalMode,
    /// Whether `previous != mode`. A no-op re-assert still rebuilds a graph (see
    /// `graph_rebuilt`), because that is the *only* repair path for a Space whose
    /// graph was dropped or never built — there is no incremental "top up the
    /// missing rows" mode, so re-asserting `Graph` is how an operator fixes one.
    ///
    /// This used to read "the cheap repair path", which was wrong in the same way
    /// [`SpaceStore::set_retrieval_mode`]'s doc was before it was measured: a
    /// re-assert is a *full* rebuild and costs exactly what a first build costs
    /// (~16 s on a 1,566-chunk Space, and it was tens of seconds to minutes before
    /// [`graph_row_id`] — see the table on
    /// [`build_graph_for_chunks`]). `changed: false` therefore does **not** mean
    /// "this call did nothing"; it is often the most expensive call the endpoint
    /// makes, and a caller that renders it as a cheap no-op is lying to the user.
    pub changed: bool,
    /// Whether the entity graph was (re)built by this call. True whenever the new
    /// mode is `Graph`; false when switching to `Vector` (which instead *drops* the
    /// now-unmaintained graph rows).
    pub graph_rebuilt: bool,
    /// How many chunks the rebuild walked. `0` when switching to `Vector`.
    pub chunks_scanned: usize,
    /// Entity nodes written by the rebuild.
    pub graph_nodes: usize,
    /// Co-occurrence edges written by the rebuild.
    pub graph_edges: usize,
}

/// A retrieval-mode rebuild accepted by the background worker.
#[derive(Debug, Clone, Serialize)]
pub struct RetrievalModeJob {
    pub job_id: String,
    pub space_id: String,
    pub requested_mode: RetrievalMode,
}

#[derive(Debug)]
pub struct RetrievalModeRebuildConflict;

impl std::fmt::Display for RetrievalModeRebuildConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("another retrieval-mode rebuild is active")
    }
}

impl std::error::Error for RetrievalModeRebuildConflict {}

#[derive(Debug)]
struct RetrievalModeCancelled;

impl std::fmt::Display for RetrievalModeCancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("retrieval-mode rebuild cancelled")
    }
}

impl std::error::Error for RetrievalModeCancelled {}

/// Observable state for a retrieval-mode rebuild.
///
/// `state = "cancelled"` means the transaction was rolled back. The progress
/// counters then describe work attempted before the cooperative cancellation
/// point, not rows that were committed.
#[derive(Debug, Clone, Serialize)]
pub struct RetrievalModeJobStatus {
    pub job_id: String,
    pub space_id: String,
    pub requested_mode: RetrievalMode,
    pub previous_mode: Option<RetrievalMode>,
    pub state: String,
    pub total_chunks: usize,
    pub processed_chunks: usize,
    pub graph_nodes: usize,
    pub graph_edges: usize,
    pub change: Option<RetrievalModeChange>,
    pub error: Option<String>,
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
    /// True for Ryu-owned system Spaces (Artifacts, Meetings) — undeletable and
    /// skipped by the danger-zone bulk clear. Drives the desktop's delete-action
    /// suppression + the "Artifacts" resolver.
    #[serde(default)]
    pub system: bool,
    /// `private` keeps the Space owner-only; `org`/`team` share it with the
    /// matching organization scope. Pages inherit this effective visibility.
    #[serde(default = "default_private_visibility")]
    pub visibility: String,
    /// The owning team when `visibility == "team"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    /// Optional Notion-style glyph (`GlyphValue` JSON from `@ryu/ui`). Null =
    /// use the surface fallback icon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<serde_json::Value>,
}

fn default_private_visibility() -> String {
    "private".to_owned()
}

/// A document belonging to a Space.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub space_id: String,
    pub title: String,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds. Older rows may carry `0`; callers should fall back to
    /// `created_at` when displaying an age.
    pub updated_at: i64,
    pub chunk_count: i64,
    /// `"page"` (markdown) or `"database"` (data-grid JSON in `source`).
    pub kind: String,
    /// Parent document id when this is a database "row page"; `None` for
    /// top-level documents.
    pub parent_id: Option<String>,
    /// MIME type for `kind='file'` documents (`None` for page/database/whiteboard).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    /// Byte size for `kind='file'` documents (`None` otherwise).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_size: Option<i64>,
    /// Optional Notion-style glyph (`GlyphValue` JSON). Null = kind default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<serde_json::Value>,
}

/// A permission-filtered lexical hit from the global Spaces search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LexicalDocumentMatch {
    pub document_id: String,
    pub space_id: String,
    pub space_name: String,
    pub title: String,
    pub snippet: String,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds. Falls back to `created_at` for legacy rows.
    pub updated_at: i64,
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
    /// Monotonic content revision used by conditional saves and restores.
    #[serde(default)]
    pub revision: i64,
    pub chunk_count: i64,
    /// `"page"` (markdown) or `"database"` (data-grid JSON in `source`).
    pub kind: String,
    /// Parent document id when this is a database "row page"; `None` otherwise.
    pub parent_id: Option<String>,
    /// Optional Notion-style glyph (`GlyphValue` JSON). Null = kind default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<serde_json::Value>,
}

/// Stable-id snapshot used by Core's opt-in cross-device mirror. Binary files
/// are intentionally excluded because their blob bytes need a separate transfer
/// protocol; pages, databases, whiteboards, and app-owned JSON are supported.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSyncRecord {
    pub document: DocumentContent,
    pub owner_user_id: Option<String>,
}

/// Space metadata carried alongside every synced document so a receiving node
/// can recreate the collection before replaying its pages.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceSyncRecord {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub retrieval_mode: String,
    pub visibility: String,
    pub team_id: Option<String>,
}

/// One app-owned document as returned to a full-page Companion app (grant
/// `spaces:docs`). This is the kind-isolated view: an app only ever sees a doc
/// whose `kind == "app:<its plugin id>"`, never another app's or a built-in
/// page/database/whiteboard/file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppDoc {
    pub id: String,
    pub title: String,
    /// The document's raw source (an app's own JSON/text — the app owns the shape).
    pub source: String,
    /// Always `app:<plugin_id>` for a doc an app can see.
    pub kind: String,
}

/// A lightweight listing row for an app's own documents in a Space.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppDocSummary {
    pub id: String,
    pub title: String,
    /// Unix milliseconds.
    pub updated_at: i64,
}

/// Per-Space inventory for documents owned by one Companion app. The count and
/// byte total are intentionally derived from document rows so an uninstall
/// preview never needs to expose document contents.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSpaceUsage {
    pub id: String,
    pub name: String,
    pub document_count: i64,
    pub storage_bytes: i64,
    pub system: bool,
}

/// Metadata for a binary file document (`kind = 'file'`). The bytes live in the
/// content-addressed blob store keyed by `sha256`; this is the row-level pointer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMeta {
    pub id: String,
    pub space_id: String,
    pub title: String,
    pub mime: String,
    pub sha256: String,
    pub byte_size: i64,
    /// Unix milliseconds.
    pub created_at: i64,
}

/// One editable page or database produced by a Space import.
///
/// Imports can fan out, most notably a ZIP containing several files or a workbook
/// containing several sheets. Keeping the result kind and title beside the id lets
/// clients open every result without guessing from the requested destination.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpaceImportResultDocument {
    pub id: String,
    pub kind: String,
    pub title: String,
}

/// Durable progress and provenance for one file or connected-app import.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpaceImportRecord {
    pub id: String,
    pub space_id: String,
    /// `file` or `composio`.
    pub source_type: String,
    /// Filename for file imports, toolkit display name for connected apps.
    pub source_name: String,
    /// Lowercase extension for files, toolkit slug for connected apps.
    pub source_format: String,
    /// Requested destination while queued, then the actual result kind
    /// (`page`, `database`, or `mixed`) when complete.
    pub destination_kind: String,
    /// `pending`, `running`, `completed`, or `failed`.
    pub status: String,
    pub result_documents: Vec<SpaceImportResultDocument>,
    pub item_count: i64,
    pub byte_size: i64,
    /// A failure reason or a non-fatal completion note.
    pub message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

/// Metadata for one saved version of a document (no `source`, so version lists
/// stay light). The full snapshot is fetched per-version via `get_document_version`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentVersionMeta {
    pub id: String,
    pub document_id: String,
    pub title: String,
    /// Optional user-supplied label for a manual snapshot (`None` for auto ones).
    pub label: Option<String>,
    /// `"page"` or `"database"` — the doc kind captured at snapshot time.
    pub kind: String,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Last edit captured by an automatic group. Equals `created_at` for pins.
    pub updated_at: i64,
    /// `automatic`, `baseline`, `named`, `manual`, or `restore_guard`.
    pub capture_type: String,
    /// `exact`, `ten_minute`, `hour`, `day`, or `week`.
    pub granularity: String,
    /// Document revision represented by this checkpoint.
    pub revision: i64,
    /// Verified editor id when Core had one at the write boundary.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
}

/// A full saved version of a document, including the captured `source`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentVersion {
    pub id: String,
    pub document_id: String,
    pub title: String,
    pub source: String,
    pub label: Option<String>,
    pub kind: String,
    /// Unix milliseconds.
    pub created_at: i64,
    pub updated_at: i64,
    pub capture_type: String,
    pub granularity: String,
    pub revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentUpdateResult {
    pub revision: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    pub duplicate: bool,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DocumentUpdateOutcome {
    Applied(DocumentUpdateResult),
    Conflict { current_revision: i64 },
}

#[derive(Debug, Clone, Copy)]
enum DocumentHistoryAction {
    Automatic,
    RestoreGuard,
}

struct DocumentHistoryHead {
    chunk_count: i64,
    kind: String,
    mode: String,
    revision: i64,
    source: String,
    space_id: String,
    title: String,
    updated_by: Option<String>,
}

/// An inter-document link (wiki `[[Title]]` or mention `[[@Title]]`). Used for the
/// outgoing-links list and, with `src_title`/`snippet` populated, for backlinks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocLink {
    pub src_doc_id: String,
    /// `None` when the target page does not exist yet (a *pending* link).
    pub dst_doc_id: Option<String>,
    pub dst_title: String,
    /// `"wiki"` or `"mention"`.
    pub kind: String,
    /// Title of the source document (populated for backlinks).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src_title: Option<String>,
    /// A short context line around the link (populated for backlinks).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

/// A node in the document-link graph. `id` is a document id, or a synthetic
/// `pending:<lowercased-title>` id for a not-yet-created target.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocGraphNode {
    pub id: String,
    pub title: String,
    /// `"page"`, `"database"`, or `"pending"`.
    pub kind: String,
    pub space_id: String,
    pub pending: bool,
}

/// An edge in the document-link graph. `kind` is `"wiki"`, `"mention"`, or
/// `"parent"` (the `parent_id` database→row-page hierarchy).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocGraphEdge {
    pub src: String,
    pub dst: String,
    pub kind: String,
}

/// The document-link graph for a Space (or, globally, across all Spaces).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DocGraph {
    pub nodes: Vec<DocGraphNode>,
    pub edges: Vec<DocGraphEdge>,
}

/// A parsed link occurrence extracted from a document's markdown source.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedLink {
    title: String,
    kind: &'static str,
}

/// Current embedding model identity for a Space store.
#[derive(Debug, Clone, Serialize)]
pub struct EmbeddingModelInfo {
    pub model_id: String,
    pub dims: usize,
}

/// One vector returned by the active Space embedder, in request order.
#[derive(Debug, Clone, Serialize)]
pub struct EmbeddedText {
    pub index: usize,
    pub embedding: Vec<f32>,
}

/// A batch of text vectors produced by one active embedding-model snapshot.
#[derive(Debug, Clone, Serialize)]
pub struct EmbeddingBatch {
    pub model_id: String,
    pub dims: usize,
    pub embeddings: Vec<EmbeddedText>,
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
///
/// Building a concrete [`Embedder`] from this preference (the per-space embedder
/// gotcha — a Space picks its own model) is done Core-side by the `spaces` shim
/// (`spaces::embedder_for_pref`), which funnels it through the single RAG resolver
/// so a per-space embedder still follows an embed-provider swap. The struct itself
/// is plain config so the crate never touches the model registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingModelPref {
    pub model_id: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub dims: Option<usize>,
    /// `gateway` keeps cloud credentials and upstream URLs inside Gateway.
    /// `None` preserves the local/self-hosted OpenAI-compatible behavior.
    #[serde(default)]
    pub provider: Option<String>,
}

/// Preferences KV key for the user-chosen default embedding model.
pub const EMBEDDING_MODEL_PREF_KEY: &str = "embedding-model";

/// A single chunk returned from a similarity search (used by U17 retrieval).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChunkMatch {
    pub chunk_id: String,
    pub document_id: String,
    pub content: String,
    /// Cosine distance from the query vector (`1 - cosine similarity`; smaller
    /// is closer). Term-index fallback and link-expanded hits use `1.0`.
    /// For graph-mode results this is set to a synthetic value of `0.0`
    /// (exact match via graph traversal — distance is not meaningful), and so it
    /// is for keyword-only hits of a hybrid search.
    pub distance: f32,
    /// Fusion score (higher is better) when the result came from hybrid or
    /// multi-query fusion, or a bounded BM25 relevance for a keyword hit.
    /// Comparable only within one result set. Absent for plain searches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f32>,
    /// The chunk's splitter metadata (`index`, `token_count`, `header_path`)
    /// plus its `ordinal` in the document. Filled by `search_with`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    /// The widened context when a `parent` expansion was requested.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_content: Option<String>,
}

// ── Embedder ───────────────────────────────────────────────────────────────────
//
// The embedder type lives in the `ryu_rag` crate (imported above). It is an async
// enum with a deterministic `Local` hashing variant (headless/offline default for
// tests) and a `Remote` OpenAI-compatible variant that points at the local
// `llamacpp-embed` nomic server by default. `SpaceStore` holds it behind a Mutex
// so the default embedding model can be swapped at runtime (which triggers a
// background re-index — see `reindex_all`).

// ── Graph entity extraction ────────────────────────────────────────────────────

/// Extract entities from a text chunk using deterministic co-occurrence.
///
/// Strategy: every normalized alphanumeric token of at least three characters that starts with
/// an uppercase letter (or, for the purposes of this local extractor, any token
/// that the heuristic selects as "noun-like") is treated as an entity. The
/// normalization step lowercases and trims so that "Alice" and "alice" map to the
/// same node key, guaranteeing bridge-entity consistency across chunks.
///
/// This is intentionally simple and offline. Graph fan-out is quadratic in the
/// number of unique terms, so extraction stops at [`MAX_EXTRACTED_GRAPH_TERMS`].
/// Unsupported configured extractor ids are rejected during store construction.
fn extract_entities(text: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut entities = Vec::new();
    for token in text.split(|c: char| !c.is_alphanumeric()) {
        if token.len() > MAX_GRAPH_TERM_BYTES {
            continue;
        }
        let character_count = token.chars().count();
        if character_count < 3 {
            continue;
        }
        // Heuristic: starts with an uppercase letter OR is longer than 4 chars
        // (catches common nouns that might bridge chunks).
        let first_upper = token.chars().next().is_some_and(|c| c.is_uppercase());
        if first_upper || character_count > 4 {
            let normalized = token.to_lowercase();
            if seen.insert(normalized.clone()) {
                entities.push(normalized);
                if entities.len() >= MAX_EXTRACTED_GRAPH_TERMS {
                    break;
                }
            }
        }
    }
    entities
}

/// Drop query entities that are too common in `space_id` to discriminate between
/// its chunks, so [`SpaceStore::graph_search`] seeds from the informative ones.
/// See [`SEED_MAX_CHUNK_FRACTION`] for the policy and its two escape hatches.
///
/// Reads document frequency from `graph_nodes` (one indexed `COUNT` per query
/// entity — queries are a handful of words, so this is a constant-ish cost paid
/// once per search, against the per-entity chunk+edge queries the traversal itself
/// issues).
///
/// Entities with **zero** stored nodes are dropped unconditionally, and that is
/// behaviour-preserving rather than a second policy: [`build_graph_for_chunks`]
/// writes a chunk's nodes and its edges from the same entity set, so an entity with
/// no `graph_nodes` row has no `graph_edges` row either — it can contribute neither
/// a chunk nor a neighbour. It is excluded from the "did everything flood?" test for
/// the same reason: falling back to a word the Space has never seen would answer
/// nothing at all.
fn seed_entities_above_floor(
    conn: &Connection,
    space_id: &str,
    entities: Vec<String>,
    filter: &DocFilter<'_>,
) -> Result<Vec<String>> {
    // One entity: there is no rarer alternative to prefer, so the floor could only
    // turn a working query into an empty one. Skips two queries on the common path.
    if entities.len() < 2 {
        return Ok(entities);
    }
    let total_sql = format!(
        "SELECT COUNT(*) FROM chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE c.space_id = :space_id AND {DOC_TENANCY_VISIBLE_PREDICATE}"
    );
    let total_chunks: i64 = conn
        .query_row(
            &total_sql,
            named_params! {
                ":space_id": space_id,
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json.as_str(),
            },
            |row| row.get(0),
        )
        .context("counting space chunks for the graph seed floor")?;
    if total_chunks < SEED_FLOOR_MIN_CHUNKS {
        return Ok(entities);
    }
    let cutoff = total_chunks as f64 * SEED_MAX_CHUNK_FRACTION;

    let frequency_sql = format!(
        "SELECT COUNT(DISTINCT n.chunk_id) FROM graph_nodes n
         JOIN chunks c ON c.id = n.chunk_id
         JOIN documents d ON d.id = c.document_id
         WHERE n.space_id = :space_id AND n.entity = :entity
           AND {DOC_TENANCY_VISIBLE_PREDICATE}"
    );
    let mut stmt = conn
        .prepare(&frequency_sql)
        .context("preparing seed-entity document frequency query")?;
    let mut kept = Vec::with_capacity(entities.len());
    for entity in &entities {
        let df: i64 = stmt
            .query_row(
                named_params! {
                    ":space_id": space_id,
                    ":entity": entity,
                    ":bound": filter.bound_flag(),
                    ":uid": filter.owner_user_id,
                    ":org": filter.org_id,
                    ":teams": filter.team_ids_json.as_str(),
                },
                |row| row.get(0),
            )
            .context("reading seed-entity document frequency")?;
        if df > 0 && (df as f64) <= cutoff {
            kept.push(entity.clone());
        }
    }
    // Nothing survived: either every entity the Space holds floods it, or the Space
    // holds none of them. Seed exactly as before — returning the original list is
    // "no floor applied" in the first case and inert in the second.
    if kept.is_empty() {
        return Ok(entities);
    }
    Ok(kept)
}

// ── Wiki page-link extraction ───────────────────────────────────────────────────

/// Extract inter-document links from a markdown `source`.
///
/// Three forms are recognized, all emitted by (or accepted into) Ryu's editor so
/// the round-trip is deterministic:
/// - Raw wiki syntax `[[Title]]` / `[[Title|Alias]]` → a **wiki** link, and
///   `[[@Title]]` → a **mention** link (Obsidian-style, e.g. pasted markdown).
/// - The editor's canonical markdown-link serialization `[display](<wikilink:Title>)`
///   → **wiki**, and `[display](<mention:Title>)` → **mention** (angle brackets and
///   percent-encoding both tolerated; the target title is url-decoded).
///
/// The alias / display text is ignored for resolution; only the target title
/// matters. Duplicate (title, kind) pairs within one document are collapsed.
fn extract_doc_links(source: &str) -> Vec<ParsedLink> {
    // Reuse compiled patterns across document saves and bulk imports.
    static RAW_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"\[\[\s*(@)?\s*([^\[\]|]+?)\s*(?:\|[^\[\]]*)?\]\]")
            .expect("static wikilink regex is valid")
    });
    // `[text](<wikilink:Title>)` or `[text](mention:Title)` — angle brackets optional.
    static LINK_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"\]\(\s*<?\s*(wikilink|mention):([^)>]+?)\s*>?\s*\)")
            .expect("static doc-link regex is valid")
    });

    let mut seen: std::collections::HashSet<(String, &'static str)> =
        std::collections::HashSet::new();
    let mut out = Vec::new();
    let mut push = |title: String, kind: &'static str, out: &mut Vec<ParsedLink>| {
        if title.is_empty() {
            return;
        }
        if seen.insert((title.to_lowercase(), kind)) {
            out.push(ParsedLink { title, kind });
        }
    };

    for caps in RAW_RE.captures_iter(source) {
        let kind = if caps.get(1).is_some() {
            "mention"
        } else {
            "wiki"
        };
        let title = caps.get(2).map(|m| m.as_str().trim().to_string());
        if let Some(title) = title {
            push(title, kind, &mut out);
        }
    }
    for caps in LINK_RE.captures_iter(source) {
        let kind = if &caps[1] == "mention" {
            "mention"
        } else {
            "wiki"
        };
        let raw = caps[2].trim();
        let title = urlencoding::decode(raw)
            .map(|c| c.into_owned())
            .unwrap_or_else(|_| raw.to_string());
        push(title.trim().to_string(), kind, &mut out);
    }
    out
}

/// Return a short one-line snippet of `source` containing `title`, for backlink
/// context. Falls back to the first non-empty line when no direct hit is found.
fn link_snippet(source: &str, title: &str) -> Option<String> {
    let needle = title.to_lowercase();
    for line in source.lines() {
        if line.to_lowercase().contains(&needle) {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                return Some(truncate_snippet(trimmed));
            }
        }
    }
    source
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(truncate_snippet)
}

fn truncate_snippet(line: &str) -> String {
    const MAX: usize = 160;
    if line.chars().count() <= MAX {
        return line.to_string();
    }
    let truncated: String = line.chars().take(MAX).collect();
    format!("{truncated}…")
}

/// Synthetic node id for a pending (not-yet-created) link target, scoped by space
/// so it never collides across Spaces in the global graph.
fn pending_node_id(space_id: &str, title: &str) -> String {
    format!("pending:{space_id}:{}", title.to_lowercase())
}

/// Whether link-expansion retrieval is on by default. Swappable via the
/// `RYU_SPACES_LINK_EXPANSION` env var (set to `0`/`false`/`off` to disable),
/// per the "nothing hardcoded, everything a swappable default" rule.
fn link_expansion_default() -> bool {
    !matches!(
        std::env::var("RYU_SPACES_LINK_EXPANSION").ok().as_deref(),
        Some("0") | Some("false") | Some("off")
    )
}

/// Replace `src_doc_id`'s outgoing document links, parsed from its markdown
/// `source`, resolving each target title to a document id in the same space
/// (case-insensitive, excluding the source itself). Unmatched targets are stored
/// with `dst_doc_id = NULL` (a pending link). Idempotent: existing links for this
/// source are deleted first, so re-saving re-derives the full set.
fn store_doc_links(
    conn: &Connection,
    space_id: &str,
    src_doc_id: &str,
    source: &str,
    now: i64,
) -> Result<()> {
    conn.execute(
        "DELETE FROM document_links WHERE src_doc_id = ?1",
        params![src_doc_id],
    )
    .context("clearing old document links")?;
    for link in extract_doc_links(source) {
        let dst_doc_id: Option<String> = conn
            .query_row(
                "SELECT id FROM documents
                 WHERE space_id = ?1 AND title_bi = ryu_bi('documents.title', ?2) AND id != ?3
                 LIMIT 1",
                params![space_id, link.title, src_doc_id],
                |row| row.get(0),
            )
            .optional()
            .context("resolving link target")?;
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO document_links
                 (id, space_id, src_doc_id, dst_doc_id, dst_title, dst_title_bi, link_kind,
                  created_at)
             VALUES (?1, ?2, ?3, ?4, ryu_seal('document_links.dst_title', ?1, ?5),
                     ryu_bi('document_links.dst_title', ?5), ?6, ?7)",
            params![id, space_id, src_doc_id, dst_doc_id, link.title, link.kind, now],
        )
        .context("inserting document link")?;
    }
    Ok(())
}

/// Back-fill pending links whose target title now matches a document. Called when
/// a document is created or renamed so inbound `[[Title]]` links resolve
/// automatically (Obsidian's pending-page-becomes-real behaviour).
fn reresolve_pending_links(
    conn: &Connection,
    space_id: &str,
    doc_id: &str,
    doc_title: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE document_links SET dst_doc_id = ?1
         WHERE space_id = ?2 AND dst_doc_id IS NULL
           AND dst_title_bi = ryu_bi('document_links.dst_title', ?3)",
        params![doc_id, space_id, doc_title],
    )
    .context("re-resolving pending links")?;
    Ok(())
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
    /// Width of the indexed vectors. Equals the active embedder's dims; updated
    /// when a model change re-embeds the store.
    vec_dims: Arc<AtomicUsize>,
    /// Validated graph extractor. Unsupported configured ids fail store creation,
    /// so this value always names the algorithm that writes and queries graph rows.
    graph_extraction_model: GraphExtractionModel,
    /// Neural reranker for Spaces RAG (the bge cross-encoder served by the
    /// lazily-started `llamacpp-rerank` server). `search` over-fetches candidates
    /// and re-scores them with this before truncating to the requested limit;
    /// reranking fails open to the vector order whenever the server is unreachable.
    reranker: Reranker,
    /// Root of the content-addressed blob store for file-kind documents. Injected
    /// at construction by the Core-side shim (`~/.ryu/blobs`) so the crate never
    /// reads Core's `paths` module; the in-memory/test store uses a temp dir.
    blob_root: PathBuf,
    /// Background re-index coordination (single-run guard + last error).
    reindex: Arc<Mutex<ReindexInner>>,
    /// Retrieval-mode rebuild coordination. This is a std mutex because the
    /// worker updates progress from `spawn_blocking` at chunk boundaries.
    retrieval_mode: Arc<StdMutex<RetrievalModeInner>>,
    /// Content sealing: keys, writability (a store sealed under a key this
    /// process does not hold refuses writes), unreadable-row counter, migration
    /// progress. The same state backs the SQL sealing functions.
    seal: seal::SealState,
    /// On-disk database path (`None` for the in-memory store), for the
    /// background migration's own connection.
    db_path: Option<PathBuf>,
    /// The decrypted vectors, one partition per Space, under the process-wide
    /// vector budget (least-recently-used partitions are evicted).
    vectors: VectorIndex,
    /// Per Space: what its in-memory partition reflects (see
    /// [`PartitionState`]). Shared with the connection's `ryu_vec_tracked`
    /// function, which decides which writes the vector journal records.
    vector_state: VectorStates,
    /// Spaces whose partition is being hydrated in the background.
    hydrating: Arc<StdMutex<std::collections::HashSet<String>>>,
    /// Hands out the token of each full hydration.
    hydration_token: Arc<std::sync::atomic::AtomicU64>,
    /// Full hydrations started (every sealed vector of a partition read and
    /// opened); writes are applied from the journal instead.
    full_hydrations: Arc<std::sync::atomic::AtomicU64>,
}

/// The [`PartitionState`] of every Space with one.
type VectorStates = Arc<StdMutex<HashMap<String, PartitionState>>>;

/// What one Space's in-memory vector partition reflects.
///
/// Every write to `chunk_embeddings` bumps the Space's `space_vector_gen` (a
/// persistent trigger), and, while the Space is `Ready` or `Hydrating`, also
/// records the chunk id in this connection's TEMP `space_vector_journal`
/// ([`SpaceStore::install_vector_journal`]). A search applies the journal to
/// the partition (opening only the vectors written since) when the journal
/// accounts for every generation bump; anything else (a write from another
/// connection, a journal lost to a temp-store change, an evicted partition)
/// reloads the whole partition.
///
/// The journal lives in process memory, so it is bounded: the write that
/// takes a Space past [`VECTOR_JOURNAL_APPLY_MAX`] journaled entries (more
/// than a search would apply) drops the Space's state and its journal, and
/// an evicted partition's journal is dropped by the next search on any Space
/// ([`SpaceStore::retire_evicted_partitions`]). Either way the next search on
/// it reloads it once.
#[derive(Clone, Debug, PartialEq, Eq)]
enum PartitionState {
    /// Hydrated at `gen` for `model`/`dims`; `journaled` writes since.
    Ready {
        gen: i64,
        model: String,
        dims: usize,
        journaled: usize,
    },
    /// Full hydration `token` read the rows at `gen` and is opening them;
    /// `journaled` writes since.
    Hydrating {
        token: u64,
        gen: i64,
        model: String,
        dims: usize,
        journaled: usize,
    },
    /// `total` vectors of `model`/`dims` did not fit in the whole vector
    /// budget: served by the term index, without opening the vectors again,
    /// until the partition has fewer vectors than that.
    Refused {
        model: String,
        dims: usize,
        total: i64,
    },
}

impl PartitionState {
    /// Whether writes to this Space are journaled.
    fn tracked(&self) -> bool {
        matches!(self, Self::Ready { .. } | Self::Hydrating { .. })
    }
}

/// Count one write to `space_id` against its journal. Returns whether the
/// write was tracked (the journal trigger fires). The write that overflows
/// [`VECTOR_JOURNAL_APPLY_MAX`] drops the Space's state, so the trigger's
/// purge statement then deletes its journal and later writes are not
/// journaled until a full reload.
fn count_journaled_write(states: &mut HashMap<String, PartitionState>, space_id: &str) -> bool {
    let overflowed = match states.get_mut(space_id) {
        Some(
            PartitionState::Ready { journaled, .. } | PartitionState::Hydrating { journaled, .. },
        ) => {
            *journaled += 1;
            *journaled > VECTOR_JOURNAL_APPLY_MAX
        }
        _ => return false,
    };
    if overflowed {
        states.remove(space_id);
    }
    true
}

/// The most journaled writes a search applies to a partition; more than that
/// reload it (on a blocking thread, or in the background when large).
const VECTOR_JOURNAL_APPLY_MAX: usize = 4_096;

/// Internal re-index run state.
#[derive(Default)]
struct ReindexInner {
    running: bool,
    errored: Option<String>,
    target_model: Option<String>,
    target_dims: Option<usize>,
}

struct RetrievalModeInner {
    statuses: HashMap<String, RetrievalModeJobStatus>,
    terminal_job_ids: VecDeque<String>,
    cancel: Option<Arc<AtomicBool>>,
    finalizing: bool,
    direct_active: bool,
}

impl Default for RetrievalModeInner {
    fn default() -> Self {
        Self {
            statuses: HashMap::new(),
            terminal_job_ids: VecDeque::new(),
            cancel: None,
            finalizing: false,
            direct_active: false,
        }
    }
}

/// Releases the direct/background retrieval-mode arbitration flag even if the
/// awaiting caller is cancelled or the blocking task panics.
struct DirectRetrievalModeGuard {
    state: Arc<StdMutex<RetrievalModeInner>>,
}

impl Drop for DirectRetrievalModeGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.direct_active = false;
        }
    }
}

/// History label for a local body kept aside by a cross-device sync conflict.
pub const SYNC_CONFLICT_LABEL: &str = "Kept from this device before a sync from another device";

/// `document_versions.capture_type` of a version kept by a sync conflict.
pub const SYNC_CONFLICT_CAPTURE_TYPE: &str = "sync_conflict";

/// The local state of a document an incoming sync snapshot is about to replace.
struct LocalSyncedDocument {
    updated_at: i64,
    sync_base_updated_at: Option<i64>,
    title: String,
    source: String,
    kind: String,
    space_id: String,
    revision: i64,
    updated_by: Option<String>,
}

impl LocalSyncedDocument {
    /// Whether replacing this row with `incoming` would drop work: the row was
    /// edited here since the last snapshot it received from another device, and
    /// the incoming body is different.
    fn has_unsynced_edits_diverging_from(&self, incoming: &DocumentContent) -> bool {
        let edited_locally = self.sync_base_updated_at != Some(self.updated_at);
        edited_locally && (self.source != incoming.source || self.title != incoming.title)
    }
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
pub(crate) use seal::sha256_hex;
pub(crate) use seal::{blob_path, embedding_context, vec_to_bytes};
pub use seal::{
    decrypt_blob_to_path, open_blob, read_blob_at, seal_legacy_blobs, BlobReader, BlobSweepReport,
    SealStatus, SpacesKeys, BLOB_STORE, SPACES_STORE,
};

impl SpaceStore {
    /// Open (or create) the store at `path` with a fully-resolved embedder,
    /// reranker, graph-extraction model, blob root, and one-shot backfill owner.
    ///
    /// This is the crate's single real constructor: every model/provider/path
    /// choice is resolved Core-side (the `spaces` shim: registry-configured
    /// embedder via the single RAG resolver, `~/.ryu` paths, and the injected
    /// backfill owner) and passed in, so the crate has ZERO dependency on
    /// apps/core. `embed_dims` must equal the output length of
    /// `embedder.embed(...)`; a mismatch causes vec0 insert failures.
    #[allow(clippy::too_many_arguments)]
    pub fn open_at(
        path: PathBuf,
        embedder: Embedder,
        embed_dims: usize,
        graph_extraction_model: String,
        reranker: Reranker,
        blob_root: PathBuf,
        backfill_owner: Option<(String, String)>,
    ) -> Result<Self> {
        // Validate the extractor before resolving keys or touching the disk.
        GraphExtractionModel::parse(&graph_extraction_model)?;
        let keys = SpacesKeys::resolve()?;
        let store = Self::open_at_with_keys(
            path,
            embedder,
            embed_dims,
            graph_extraction_model,
            reranker,
            blob_root,
            backfill_owner,
            keys,
        )?;
        store.start_background_migration();
        Ok(store)
    }

    /// [`Self::open_at`] under explicit keys (tests), without starting the
    /// background migration (call [`Self::migrate_now`]).
    #[allow(clippy::too_many_arguments)]
    pub fn open_at_with_keys(
        path: PathBuf,
        embedder: Embedder,
        embed_dims: usize,
        graph_extraction_model: String,
        reranker: Reranker,
        blob_root: PathBuf,
        backfill_owner: Option<(String, String)>,
        keys: SpacesKeys,
    ) -> Result<Self> {
        let graph_extraction_model = GraphExtractionModel::parse(&graph_extraction_model)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = open_vec_connection(&path)?;
        restrict_db_permissions(&path);
        let seal = Self::prepare_sealed_connection(&conn, Some(&path), keys)?;
        // Too large to compact while Core boots: compacted in the background.
        let compaction_owed = matches!(Self::migration_finished(&conn), Ok(true))
            && content_sqlite::compaction_owed(&conn, SPACES_STORE).unwrap_or(false);
        Self::init_schema(&conn, embed_dims)?;
        let vector_state = VectorStates::default();
        Self::register_vector_journal(&conn, &vector_state)?;
        // A graph rebuild interrupted by a crash leaves its staging tables.
        cleanup_retrieval_staging(&conn)?;
        // So does an embedding reindex that failed or was interrupted. No reindex
        // can be running before the store is open.
        drop_embedding_reindex_staging(&conn)?;
        Self::reconcile_blind_generation(&conn, &seal)?;
        // One-shot tenancy backfill for spaces/documents that pre-date the ACL.
        // Deliberately NOT in `init_schema` (the in-memory test store runs that and
        // must never read the real account vault) and best-effort: a failure here
        // must never stop the node from opening its Spaces db.
        if let Err(e) = Self::backfill_tenancy(&conn, backfill_owner) {
            tracing::warn!("spaces tenancy backfill skipped: {e:#}");
        }
        let conn = Arc::new(Mutex::new(conn));
        if compaction_owed {
            Self::defer_compaction(&conn, path.clone());
        }
        Ok(Self {
            conn,
            embedder: Arc::new(Mutex::new(embedder)),
            vec_dims: Arc::new(AtomicUsize::new(embed_dims)),
            graph_extraction_model,
            reranker,
            blob_root,
            reindex: Arc::new(Mutex::new(ReindexInner::default())),
            retrieval_mode: Arc::new(StdMutex::new(RetrievalModeInner::default())),
            seal,
            db_path: Some(path),
            vectors: VectorIndex::new(SPACES_STORE),
            vector_state,
            hydrating: Arc::new(StdMutex::new(std::collections::HashSet::new())),
            hydration_token: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            full_hydrations: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        })
    }

    /// Open an in-memory store using the crate default dims (used by tests and by
    /// Core's own in-memory test constructors). A plain `pub fn` — NOT
    /// `#[cfg(test)]` — because it is called from apps/core test code across the
    /// crate boundary, where this crate is compiled without `--cfg test`. Uses a
    /// per-store temp blob root so file-document tests never touch `~/.ryu`.
    pub fn open_in_memory() -> Result<Self> {
        Self::open_in_memory_with_keys(SpacesKeys::resolve()?)
    }

    /// [`Self::open_in_memory`] under explicit keys (tests).
    pub fn open_in_memory_with_keys(keys: SpacesKeys) -> Result<Self> {
        let dims = DEFAULT_EMBED_DIMS;
        let conn = open_vec_connection(std::path::Path::new(":memory:"))?;
        let seal = Self::prepare_sealed_connection(&conn, None, keys)?;
        Self::init_schema(&conn, dims)?;
        let vector_state = VectorStates::default();
        Self::register_vector_journal(&conn, &vector_state)?;
        Self::reconcile_blind_generation(&conn, &seal)?;
        let blob_root =
            std::env::temp_dir().join(format!("ryu-spaces-mem-{}", uuid::Uuid::new_v4()));
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            embedder: Arc::new(Mutex::new(Embedder::Local { dims })),
            vec_dims: Arc::new(AtomicUsize::new(dims)),
            graph_extraction_model: GraphExtractionModel::LocalCooccurrence,
            // Test helper: the local (server-backed, fail-open) reranker needs no
            // registry — mirrors `Embedder::Local` above.
            reranker: Reranker::Local,
            blob_root,
            reindex: Arc::new(Mutex::new(ReindexInner::default())),
            retrieval_mode: Arc::new(StdMutex::new(RetrievalModeInner::default())),
            seal,
            db_path: None,
            vectors: VectorIndex::new(SPACES_STORE),
            vector_state,
            hydrating: Arc::new(StdMutex::new(std::collections::HashSet::new())),
            hydration_token: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            full_hydrations: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        })
    }

    /// Turn on `secure_delete`, run a compaction a previous run deferred when
    /// the store is small enough to compact before it serves anything (a larger
    /// one gets its freelist scrub now and is compacted later by
    /// [`Self::defer_compaction`]), check the store's recorded key, and register
    /// the SQL sealing functions.
    fn prepare_sealed_connection(
        conn: &Connection,
        path: Option<&Path>,
        keys: SpacesKeys,
    ) -> Result<seal::SealState> {
        content_sqlite::enable_secure_delete(conn)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .context("setting the spaces busy timeout")?;
        if let Some(path) = path {
            // The deferred VACUUM builds its transient copy in temp storage,
            // on disk (temp_store = FILE) so a multi-GB store is not copied
            // into RAM. That copy lands outside the data folder, where nothing
            // scrubs it, so it runs only once the migration has finished and
            // the database holds no legacy plaintext (the freelist scrub runs
            // first). Until then the scrub is still owed and the migration's
            // own `finish_store` runs it after the last value is sealed. Spaces
            // opens on Core's boot path, so only a store up to
            // `VACUUM_NOW_MAX_BYTES` is vacuumed here; a larger one is handed to
            // the background worker once the store is open.
            let vacuum = match Self::migration_finished(conn) {
                Ok(true) => with_file_temp_store(conn, |conn| {
                    content_sqlite::run_pending_vacuum_gated(conn, path, SPACES_STORE)
                })
                .and_then(|result| result)
                .map(|_| ()),
                Ok(false) => Ok(()),
                Err(error) => Err(error),
            };
            if let Err(error) = vacuum {
                tracing::warn!("spaces store: deferred compaction failed: {error:#}");
            }
        }
        // MEMORY from here on, before any TEMP object (triggers) is created.
        secure_connection(conn)?;
        let writable = match content_sqlite::check_store_key(conn, &keys.cipher)? {
            StoreKeyState::Mismatch { .. } => false,
            StoreKeyState::Retired => {
                content_sqlite::reset_items(conn, SPACES_STORE, &seal::seal_plans()?)?;
                true
            }
            StoreKeyState::Recorded | StoreKeyState::Current => true,
        };
        let state = seal::SealState::new(keys, writable);
        seal::register_sql_functions(conn, &state)?;
        Ok(state)
    }

    /// Hand a compaction too large for Core's boot path to the background
    /// compaction worker (`ryu-compaction`, a couple of minutes after start). It
    /// runs under this store's connection lock, so requests wait for it instead
    /// of the boot, and only once the sealing migration has finished (its
    /// transient copy is never scrubbed). The `VACUUM` needs file-backed temp
    /// storage, which drops the connection's TEMP triggers, so the connection
    /// is secured again and the term-index triggers reinstalled afterwards.
    fn defer_compaction(conn: &Arc<Mutex<Connection>>, path: PathBuf) {
        let weak = Arc::downgrade(conn);
        content_sqlite::defer_compaction(
            SPACES_STORE,
            Box::new(move || {
                let conn = weak.upgrade()?;
                let conn = conn.blocking_lock();
                Some(Self::compact_deferred(&conn, &path))
            }),
        );
    }

    /// The deferred compaction's body (see [`Self::defer_compaction`]).
    fn compact_deferred(conn: &Connection, path: &Path) -> Result<bool> {
        if !Self::migration_finished(conn)? {
            return Ok(false);
        }
        let compacted = with_file_temp_store(conn, |conn| {
            content_sqlite::compact_deferred(conn, path, SPACES_STORE)
        })
        .and_then(|result| result);
        let restored = secure_connection(conn)
            .and_then(|()| Self::install_term_triggers(conn))
            .and_then(|()| Self::install_vector_journal(conn));
        if let Err(error) = &restored {
            tracing::error!(
                "spaces store: could not restore the connection after compaction: {error:#}"
            );
        }
        let compacted = compacted?;
        restored?;
        Ok(compacted)
    }

    /// Whether the sealing migration has finished: every sealed column item is
    /// `sealed`, the legacy plaintext `vec0` tables are gone, and both derived
    /// indexes are in the sorted token format. Only then may the deferred
    /// compaction copy the database (its transient copy is never scrubbed).
    fn migration_finished(conn: &Connection) -> Result<bool> {
        for plan in seal::seal_plans()? {
            let state = content_sqlite::item_state(conn, SPACES_STORE, &plan.item())?;
            if state.as_deref() != Some(content_sqlite::states::SEALED) {
                return Ok(false);
            }
        }
        let legacy_vectors: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master
                 WHERE name IN ('chunk_vectors', 'chunk_vectors_rebuild') LIMIT 1",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if legacy_vectors {
            return Ok(false);
        }
        for item in [TERMS_FORMAT_ITEM, GRAPH_FORMAT_ITEM] {
            if derived_format(conn, item)?.as_deref() != Some(DERIVED_FORMAT_SORTED) {
                return Ok(false);
            }
        }
        if derived_format(conn, TERMS_SECURE_ITEM)?.as_deref() != Some(TERMS_SECURE_DONE) {
            return Ok(false);
        }
        Ok(true)
    }

    /// Sealing health: unreadable rows skipped, writability, migration and blob
    /// sweep progress (`spaces.db` health item).
    pub fn seal_status(&self) -> SealStatus {
        self.seal.snapshot()
    }

    /// Start [`Self::migrate_now`] on a background thread (production open).
    fn start_background_migration(&self) {
        let store = self.clone();
        let spawned = std::thread::Builder::new()
            .name("spaces-seal-migration".to_owned())
            .spawn(move || {
                if let Err(error) = store.migrate_now() {
                    tracing::warn!("spaces store: sealing migration stopped: {error:#}");
                    store.seal.set_migration(format!("error: {error:#}"));
                }
            });
        if let Err(error) = spawned {
            tracing::warn!("spaces store: could not start the sealing migration: {error}");
        }
    }

    /// Seal everything written before sealing, on its own connection, without
    /// blocking requests for long: legacy `vec0` vectors are converted to sealed
    /// rows, graph entities become blind tokens, the term index is filled, every
    /// sealed column is migrated (cursor-paginated, compare-and-swap,
    /// resumable, idempotent: [`content_sqlite::migrate_columns`]), freed
    /// plaintext is scrubbed ([`content_sqlite::finish_store`]; a store too large
    /// to vacuum now is compacted at the next start), then legacy blob files are
    /// sealed in place one at a time ([`seal_legacy_blobs`]). Plaintext is only
    /// replaced after its sealed copy is written and (for files) verified.
    pub fn migrate_now(&self) -> Result<content_sqlite::MigrationReport> {
        let Some(path) = self.db_path.clone() else {
            self.seal.set_migration(content_sqlite::states::SEALED);
            return Ok(content_sqlite::MigrationReport::default());
        };
        if !self.seal.writable.load(Ordering::Relaxed) {
            self.seal
                .set_migration("refused: the store is sealed under another key");
            return Err(content_sqlite::mismatch_error(SPACES_STORE));
        }
        self.seal.set_migration(content_sqlite::states::SEALING);
        let mut conn = open_vec_connection(&path)?;
        secure_connection(&conn)?;
        conn.busy_timeout(std::time::Duration::from_secs(30))?;
        seal::register_sql_functions(&conn, &self.seal)?;
        Self::install_term_triggers(&conn)?;

        Self::convert_legacy_vectors(&mut conn)?;
        Self::drop_legacy_vector_staging(&conn)?;
        Self::tokenize_legacy_graph(&conn)?;
        let kcv = self.seal.keys.cipher.kcv().to_owned();
        let reindex =
            blind_generation(&conn)?.is_some_and(|(_, state)| state == blind_states::REINDEXING);
        if reindex {
            self.seal.set_migration(blind_states::REINDEXING);
            Self::rebuild_derived_indexes(&mut conn, &kcv)?;
        }
        Self::clear_unsorted_term_index(&mut conn, reindex)?;
        Self::fill_term_index(&conn)?;
        set_derived_format(&conn, TERMS_FORMAT_ITEM, DERIVED_FORMAT_SORTED)?;
        Self::optimize_term_index_once(&mut conn)?;
        if reindex {
            let tx = conn.transaction()?;
            record_blind_generation(&tx, &kcv, blind_states::OK)?;
            clear_reindex_progress(&tx)?;
            // The rebuild above wrote every graph row in the sorted format.
            set_derived_format(&tx, GRAPH_FORMAT_ITEM, DERIVED_FORMAT_SORTED)?;
            tx.commit()?;
            tracing::info!(
                "spaces store: rebuilt the blind term index and graph under the current key"
            );
            self.seal.set_migration(content_sqlite::states::SEALING);
        }
        Self::rebuild_unsorted_graph(&mut conn, &kcv)?;
        let report = content_sqlite::migrate_columns(
            &mut conn,
            &self.seal.keys.cipher,
            &seal::seal_plans()?,
        )?;
        if report.sealed > 0 || report.unreadable > 0 {
            tracing::info!(
                sealed = report.sealed,
                unreadable = report.unreadable,
                "spaces store: sealed legacy values"
            );
        }
        let readdressed = Self::rekey_history_blobs(&mut conn, &self.seal)?;
        if readdressed > 0 {
            tracing::info!(
                rows = readdressed,
                "spaces store: moved history snapshots to keyed addresses"
            );
        }
        let owed = content_sqlite::read_store_record(&conn, SPACES_STORE)?
            .is_some_and(|record| record.state == content_sqlite::states::VACUUM_PENDING);
        if owed {
            self.seal.set_migration("compacting");
            // File-backed temp storage for the VACUUM (see
            // `prepare_sealed_connection`). This drops the connection's TEMP
            // triggers, which is fine: it is closed right after.
            let finished = with_file_temp_store(&conn, |conn| {
                content_sqlite::finish_store(conn, &path, SPACES_STORE)
            })
            .and_then(|result| result);
            match finished {
                Ok(outcome) if outcome.vacuum_pending => {
                    tracing::info!("spaces store: compaction deferred to the next start");
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!("spaces store: scrub deferred to the next start: {error:#}");
                }
            }
        }
        drop(conn);
        self.seal.set_migration(content_sqlite::states::SEALED);

        let status = self.seal.status.clone();
        let sweep = seal_legacy_blobs(&self.blob_root, &self.seal.keys.blob_cipher, |progress| {
            if let Ok(mut status) = status.lock() {
                status.blobs_sealed = progress.sealed;
                status.blobs_total = progress.total;
            }
        });
        if let Err(error) = sweep {
            tracing::warn!("spaces store: blob sealing paused until the next start: {error:#}");
            if let Ok(mut status) = self.seal.status.lock() {
                status.blobs_pending = Some(format!("{error:#}"));
            }
        }
        Ok(report)
    }

    /// Move vectors out of the legacy plaintext `vec0` table into sealed
    /// `chunk_embeddings` rows (bound to the chunk id and its model), in
    /// batches, then drop the `vec0` table. Resumable: converted chunks are
    /// skipped, and the `vec0` table is dropped only when every vector that has
    /// a chunk was converted.
    fn convert_legacy_vectors(conn: &mut Connection) -> Result<()> {
        let legacy: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE name = 'chunk_vectors'",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !legacy {
            return Ok(());
        }
        loop {
            let tx = conn.transaction()?;
            let moved = tx
                .execute(
                    "INSERT INTO chunk_embeddings (chunk_id, space_id, model, dims, embedding)
                     SELECT c.id, c.space_id, c.embed_model, c.embed_dims,
                            ryu_seal_vec(c.id, c.embed_model, v.embedding)
                     FROM chunks c JOIN chunk_vectors v ON v.rowid = c.rowid
                     WHERE NOT EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.id)
                     LIMIT 500",
                    [],
                )
                .context("sealing legacy vectors")?;
            tx.commit()?;
            if moved == 0 {
                break;
            }
        }
        conn.execute_batch("DROP TABLE chunk_vectors;")
            .context("dropping the legacy vector table")?;
        Ok(())
    }

    /// Drop the reindex staging table of builds before sealing.
    ///
    /// Those builds staged an embedding reindex (after an embedder or dims
    /// change) in a plaintext `vec0` table, `chunk_vectors_rebuild`, and
    /// dropped it only after a successful swap: a failed reindex (provider
    /// error, contents changed meanwhile) left a full plaintext copy of every
    /// embedding behind. Nothing reads it any more (the sealed staging table is
    /// `chunk_embeddings_rebuild`), so it is dropped; sqlite-vec is registered
    /// on this connection, so the drop removes its shadow tables too, and
    /// `secure_delete` zeroes the freed pages. The scrub is marked owed so the
    /// compaction runs.
    fn drop_legacy_vector_staging(conn: &Connection) -> Result<()> {
        let present: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE name = 'chunk_vectors_rebuild'",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !present {
            return Ok(());
        }
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch("DROP TABLE IF EXISTS chunk_vectors_rebuild;")
            .context("dropping the legacy vector staging table")?;
        mark_scrub_owed(&tx)?;
        tx.commit()?;
        tracing::info!("spaces store: dropped a plaintext embedding reindex left by a failed run");
        Ok(())
    }

    /// Empty a term index written in the plaintext word order (before
    /// [`seal::term_document`] sorted each row by token), once: the rows are
    /// refilled by [`Self::fill_term_index`]. `secure_delete` zeroes the
    /// deleted content rows, the FTS5 `optimize` merges the index segments
    /// (freeing the old pages), and the scrub is marked owed so the compaction
    /// runs. The format record moves to `filling` with the clear, so a restart
    /// during the refill does not clear again. A key reindex in this run
    /// (`reindexed`) already cleared the index.
    fn clear_unsorted_term_index(conn: &mut Connection, reindexed: bool) -> Result<()> {
        if derived_format(conn, TERMS_FORMAT_ITEM)?.is_some() {
            return Ok(());
        }
        let tx = conn.transaction()?;
        if !reindexed {
            let rows: i64 = tx.query_row("SELECT COUNT(*) FROM spaces_terms_map", [], |row| {
                row.get(0)
            })?;
            if rows > 0 {
                tx.execute_batch(
                    "DELETE FROM spaces_terms;
                     DELETE FROM spaces_terms_map;
                     INSERT INTO spaces_terms (spaces_terms) VALUES ('optimize');",
                )
                .context("clearing the unsorted Spaces term index")?;
                mark_scrub_owed(&tx)?;
            }
        }
        set_derived_format(&tx, TERMS_FORMAT_ITEM, DERIVED_FORMAT_FILLING)?;
        tx.commit()?;
        Ok(())
    }

    /// Rebuild, once, the graph rows of every graph-mode Space written before
    /// [`entity_tokens`] sorted each chunk's tokens (their row ids replay the
    /// order the terms occur in the text). Uses the bounded, resumable
    /// per-Space rebuild of a key adoption ([`Self::rebuild_space_graph`]);
    /// the deleted rows are zeroed by `secure_delete` and the scrub is marked
    /// owed.
    fn rebuild_unsorted_graph(conn: &mut Connection, kcv: &str) -> Result<()> {
        if derived_format(conn, GRAPH_FORMAT_ITEM)?.as_deref() == Some(DERIVED_FORMAT_SORTED) {
            return Ok(());
        }
        let has_rows: bool = conn
            .query_row("SELECT 1 FROM graph_nodes LIMIT 1", [], |_| Ok(true))
            .optional()?
            .unwrap_or(false);
        if has_rows {
            mark_scrub_owed(conn)?;
            let graph_spaces: Vec<String> = {
                let mut stmt =
                    conn.prepare("SELECT id FROM spaces WHERE retrieval_mode = ?1 ORDER BY id")?;
                let rows =
                    stmt.query_map(params![RetrievalMode::Graph.as_str()], |row| row.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            for space_id in graph_spaces {
                Self::rebuild_space_graph(conn, kcv, &space_id)?;
            }
            // Rows of a Space that is not (or no longer) in graph mode are
            // never read; remove them rather than leave them in text order.
            for table in ["graph_edges", "graph_nodes"] {
                let sql = format!(
                    "DELETE FROM {table} WHERE rowid IN
                         (SELECT t.rowid FROM {table} t
                          WHERE NOT EXISTS (SELECT 1 FROM spaces s
                                            WHERE s.id = t.space_id AND s.retrieval_mode = ?1)
                          LIMIT 5000)"
                );
                while conn
                    .execute(&sql, params![RetrievalMode::Graph.as_str()])
                    .with_context(|| format!("removing stray {table} rows"))?
                    > 0
                {}
            }
            tracing::info!("spaces store: rebuilt graph rows in token order");
        }
        let tx = conn.transaction()?;
        clear_reindex_progress(&tx)?;
        set_derived_format(&tx, GRAPH_FORMAT_ITEM, DERIVED_FORMAT_SORTED)?;
        tx.commit()?;
        Ok(())
    }

    /// Replace plaintext graph entities of rows written before sealing with
    /// their blind tokens, in batches (the graph is a derived index; no sealed
    /// copy of the text is kept).
    fn tokenize_legacy_graph(conn: &Connection) -> Result<()> {
        for sql in [
            "UPDATE graph_nodes SET entity = ryu_bi('graph.entity', entity)
             WHERE id IN (SELECT id FROM graph_nodes WHERE entity NOT LIKE 'bi1:%' LIMIT 2000)",
            "UPDATE graph_edges
                 SET src_entity = CASE WHEN src_entity LIKE 'bi1:%' THEN src_entity
                                       ELSE ryu_bi('graph.entity', src_entity) END,
                     dst_entity = CASE WHEN dst_entity LIKE 'bi1:%' THEN dst_entity
                                       ELSE ryu_bi('graph.entity', dst_entity) END
             WHERE id IN (SELECT id FROM graph_edges
                          WHERE src_entity NOT LIKE 'bi1:%' OR dst_entity NOT LIKE 'bi1:%'
                          LIMIT 2000)",
        ] {
            while conn
                .execute(sql, [])
                .context("tokenizing legacy graph rows")?
                > 0
            {}
        }
        Ok(())
    }

    /// Keep every blind token under the key the store is sealed with now.
    /// Tokens are HMACs under the store root, so after a key adoption (the
    /// store's record names a retired root) tokens written earlier never
    /// match again: Space-by-name lookups, wiki-link resolution, body search
    /// and graph retrieval would all miss existing content. The root that
    /// produced the stored tokens is recorded as its own key check value
    /// ([`BLIND_STORE`]); when it differs from the current root, the equality
    /// tokens (cheap, and needed by the very first request, e.g. the system
    /// Spaces lookup at startup) are recomputed here from the opened values,
    /// before the store serves anything, and the term index and graph rows
    /// are marked for a rebuild by the background migration
    /// ([`Self::rebuild_derived_indexes`], reported as `reindexing`).
    fn reconcile_blind_generation(conn: &Connection, seal: &seal::SealState) -> Result<()> {
        if !seal.writable.load(Ordering::Relaxed) {
            return Ok(());
        }
        let current = seal.keys.cipher.kcv().to_owned();
        let recorded = blind_generation(conn)?;
        // Before this record existed, tokens were written under the root the
        // store record names (a retired root after a key adoption).
        let generation = match &recorded {
            Some((Some(kcv), _)) => Some(kcv.clone()),
            _ => content_sqlite::read_store_record(conn, SPACES_STORE)?.and_then(|r| r.kcv),
        };
        if generation.as_deref().is_none_or(|kcv| kcv == current) {
            if recorded.is_none() {
                record_blind_generation(conn, &current, blind_states::OK)?;
            }
            return Ok(());
        }
        tracing::info!("spaces store: blind tokens predate the current key; recomputing them");
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "UPDATE spaces
                 SET name_bi = COALESCE(
                     ryu_bi('spaces.name', ryu_open_soft('spaces.name', id, name)), '');
             UPDATE documents
                 SET title_bi = COALESCE(
                     ryu_bi('documents.title', ryu_open_soft('documents.title', id, title)), '');
             UPDATE document_links
                 SET dst_title_bi = COALESCE(
                     ryu_bi('document_links.dst_title',
                            ryu_open_soft('document_links.dst_title', id, dst_title)), '');",
        )
        .context("recomputing Spaces blind tokens under the current key")?;
        record_blind_generation(&tx, &current, blind_states::REINDEXING)?;
        // A rebuild of an earlier adoption that never finished starts over.
        clear_reindex_progress(&tx)?;
        tx.commit()?;
        Ok(())
    }

    /// Rebuild the derived indexes that hold only blind tokens (after a key
    /// adoption): the body/chunk term index is emptied (refilled by
    /// [`Self::fill_term_index`]), and the graph rows of every graph-mode Space
    /// are rebuilt from the opened chunk text.
    ///
    /// Bounded and resumable, like the staged retrieval-mode rebuild: a Space's
    /// old graph rows are deleted in bounded batches, then its chunks are
    /// processed [`RETRIEVAL_REBUILD_BATCH_SIZE`] at a time, each batch in its
    /// own short `IMMEDIATE` transaction that also records the Space's rowid
    /// cursor (`reindex:graph:<space>` in the state table, bound to the current
    /// key check value). The write lock is released between batches, so page
    /// saves and uploads on the main connection proceed, and a restart resumes
    /// from the cursor instead of starting over. Old-key rows match nothing
    /// under the new key, so a partly rebuilt graph is never wrong, only
    /// incomplete. A chunk that already has graph rows when its batch runs was
    /// written by the live path under the new key after the clear, and is
    /// skipped (no duplicates). Progress rows are removed with the final
    /// generation record ([`clear_reindex_progress`]).
    fn rebuild_derived_indexes(conn: &mut Connection, kcv: &str) -> Result<()> {
        if reindex_progress(conn, kcv, REINDEX_TERMS_ITEM)?.is_none() {
            let tx = conn.transaction()?;
            tx.execute_batch(
                "DELETE FROM spaces_terms;
                 DELETE FROM spaces_terms_map;
                 INSERT INTO spaces_terms (spaces_terms) VALUES ('optimize');",
            )
            .context("clearing the Spaces term index")?;
            set_reindex_progress(&tx, kcv, REINDEX_TERMS_ITEM, 0)?;
            tx.commit()?;
        }
        let graph_spaces: Vec<String> = {
            let mut stmt =
                conn.prepare("SELECT id FROM spaces WHERE retrieval_mode = ?1 ORDER BY id")?;
            let rows = stmt.query_map(params![RetrievalMode::Graph.as_str()], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for space_id in graph_spaces {
            Self::rebuild_space_graph(conn, kcv, &space_id)?;
        }
        Ok(())
    }

    /// One Space of [`Self::rebuild_derived_indexes`].
    fn rebuild_space_graph(conn: &mut Connection, kcv: &str, space_id: &str) -> Result<()> {
        const CLEAR_BATCH: i64 = 5_000;
        let item = format!("{REINDEX_GRAPH_ITEM_PREFIX}{space_id}");
        let mut last_rowid = match reindex_progress(conn, kcv, &item)? {
            Some(cursor) => cursor,
            None => {
                // Clear the old-key rows in bounded deletes; the cursor row is
                // written only once the Space is empty, so a crash here simply
                // clears again.
                for table in ["graph_edges", "graph_nodes"] {
                    let sql = format!(
                        "DELETE FROM {table} WHERE rowid IN
                             (SELECT rowid FROM {table} WHERE space_id = ?1 LIMIT ?2)"
                    );
                    while conn
                        .execute(&sql, params![space_id, CLEAR_BATCH])
                        .with_context(|| format!("clearing {table} for a rebuild"))?
                        > 0
                    {}
                }
                set_reindex_progress(conn, kcv, &item, 0)?;
                0
            }
        };
        loop {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let still_graph = tx
                .query_row(
                    "SELECT retrieval_mode FROM spaces WHERE id = ?1",
                    params![space_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .is_some_and(|mode| RetrievalMode::from_str(&mode) == RetrievalMode::Graph);
            if !still_graph {
                // Deleted or switched to vector mode meanwhile: nothing to build.
                tx.commit()?;
                return Ok(());
            }
            let rows: Vec<(i64, String, String)> = {
                let mut stmt = tx.prepare(
                    "SELECT c.rowid, c.id, COALESCE(ryu_open_soft('chunks.content', c.id, c.content), '')
                     FROM chunks c
                     WHERE c.space_id = ?1 AND c.rowid > ?2
                       AND NOT EXISTS (SELECT 1 FROM graph_nodes n WHERE n.chunk_id = c.id)
                     ORDER BY c.rowid LIMIT ?3",
                )?;
                let mapped = stmt.query_map(
                    params![space_id, last_rowid, RETRIEVAL_REBUILD_BATCH_SIZE as i64],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                mapped.collect::<rusqlite::Result<_>>()?
            };
            let Some(batch_last) = rows.last().map(|(rowid, _, _)| *rowid) else {
                tx.commit()?;
                return Ok(());
            };
            let pairs: Vec<(&str, &str)> = rows
                .iter()
                .map(|(_, id, content)| (id.as_str(), content.as_str()))
                .collect();
            build_graph_for_chunks(&tx, space_id, &pairs)?;
            set_reindex_progress(&tx, kcv, &item, batch_last)?;
            tx.commit().context("committing a graph rebuild batch")?;
            last_rowid = batch_last;
        }
    }

    /// Index bodies and chunks written before the term index existed (the
    /// triggers keep it current afterwards). Rewriting the column with itself
    /// fires the index trigger; batches keep each write short.
    fn fill_term_index(conn: &Connection) -> Result<()> {
        for sql in [
            "UPDATE documents SET source = source WHERE id IN (
                 SELECT d.id FROM documents d
                 WHERE NOT EXISTS (SELECT 1 FROM spaces_terms_map m
                                   WHERE m.kind = 'doc' AND m.ref_id = d.id)
                 LIMIT 500)",
            "UPDATE chunks SET content = content WHERE id IN (
                 SELECT c.id FROM chunks c
                 WHERE NOT EXISTS (SELECT 1 FROM spaces_terms_map m
                                   WHERE m.kind = 'chunk' AND m.ref_id = c.id)
                 LIMIT 500)",
        ] {
            while conn
                .execute(sql, [])
                .context("filling the Spaces term index")?
                > 0
            {}
        }
        Ok(())
    }

    /// Fail a write early when the store is sealed under a key this process
    /// does not hold.
    fn ensure_writable(&self) -> Result<()> {
        if self.seal.writable.load(Ordering::Relaxed) {
            Ok(())
        } else {
            Err(content_sqlite::mismatch_error(SPACES_STORE))
        }
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

    /// Embed caller-provided text with one snapshot of the active model.
    ///
    /// This is the shared transient embedding primitive for browser page search
    /// and other clients that rank data they do not want to store as Space docs.
    /// It performs no persistence; only the returned vectors leave this method.
    pub async fn embed_texts(&self, texts: &[String]) -> Result<EmbeddingBatch> {
        let embedder = self.embedder_snapshot().await;
        let model_id = embedder.model_id().to_owned();
        let dims = embedder.dims();
        let vectors = embedder.embed_batch(texts).await?;
        anyhow::ensure!(
            vectors.len() == texts.len(),
            "embedding provider returned an unexpected vector count"
        );
        anyhow::ensure!(
            vectors.iter().all(|vector| {
                vector.len() == dims && vector.iter().all(|value| value.is_finite())
            }),
            "embedding provider returned an invalid vector"
        );

        Ok(EmbeddingBatch {
            model_id,
            dims,
            embeddings: vectors
                .into_iter()
                .enumerate()
                .map(|(index, embedding)| EmbeddedText { index, embedding })
                .collect(),
        })
    }

    fn init_schema(conn: &Connection, embed_dims: usize) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
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
             CREATE INDEX IF NOT EXISTS idx_graph_nodes_space_entity_chunk
                 ON graph_nodes(space_id, entity, chunk_id);
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
             CREATE INDEX IF NOT EXISTS idx_graph_edges_space_src_dst
                 ON graph_edges(space_id, src_entity, dst_entity);
             CREATE INDEX IF NOT EXISTS idx_graph_edges_space_dst
                 ON graph_edges(space_id, dst_entity);
             CREATE TABLE IF NOT EXISTS space_imports (
                 id                   TEXT PRIMARY KEY,
                 space_id             TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
                 source_type          TEXT NOT NULL,
                 source_name          TEXT NOT NULL,
                 source_format        TEXT NOT NULL,
                 destination_kind     TEXT NOT NULL,
                 status               TEXT NOT NULL,
                 result_documents     TEXT NOT NULL DEFAULT '[]',
                 item_count           INTEGER NOT NULL DEFAULT 0,
                 byte_size            INTEGER NOT NULL DEFAULT 0,
                 message              TEXT,
                 created_at           INTEGER NOT NULL,
                 updated_at           INTEGER NOT NULL,
                 completed_at         INTEGER
             );
             CREATE INDEX IF NOT EXISTS idx_space_imports_space_created
                 ON space_imports(space_id, created_at DESC);",
        )
        .context("initializing spaces schema")?;

        // Embeddings are content: each vector is sealed (`RYU-CB01`, bound to the
        // chunk id and model) in `chunk_embeddings` (see `init_sealed_schema`) and
        // searched in the shared in-memory vector index. The legacy `vec0`
        // `chunk_vectors` table is converted and dropped by the migration.
        let _ = embed_dims;

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
        let _ = conn
            .execute_batch("ALTER TABLE documents ADD COLUMN kind TEXT NOT NULL DEFAULT 'page';");

        // Idempotent migration: the built-in whiteboard editor was ported to the
        // Whiteboard Ryu App, which OWNS its documents under `kind = app:<plugin_id>`
        // (so the app's sandboxed frame can load/save them via `spaces:docs`). Re-key
        // every legacy `kind='whiteboard'` document to the app's kind so existing
        // boards open in the app instead of the removed built-in renderer. Naturally
        // idempotent: after the first run no rows match, so re-running each startup is
        // a no-op. `flatten_app_source` handles the reflattened text on next re-embed.
        let _ = conn.execute_batch(
            "UPDATE documents SET kind = 'app:@ryu/whiteboard' WHERE kind = 'whiteboard';",
        );

        // Idempotent migration: a document may belong to a parent document — used by
        // database "row pages" (a row's body is a child `kind='page'` doc whose
        // `parent_id` is the database). Top-level listings filter `parent_id IS NULL`
        // so row-body pages never show as loose documents; deleting the parent
        // cascades to children (handled explicitly in `delete_document`).
        let _ = conn.execute_batch("ALTER TABLE documents ADD COLUMN parent_id TEXT;");
        let _ = conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents(parent_id, created_at);",
        );

        // Wiki page-link graph (Obsidian/Notion-style backlinks + graph view).
        // A `document_links` row records that `src_doc_id` links to a target. When
        // the target title matches an existing document in the same space,
        // `dst_doc_id` is set; otherwise it is NULL — a *pending* link to a page
        // that does not exist yet (created on click). This is distinct from the
        // chunk-level `graph_nodes`/`graph_edges` entity graph: this graph is
        // document-to-document and drives backlinks, the graph view, and
        // link-expansion in retrieval. `link_kind` is `'wiki'` (`[[Title]]`) or
        // `'mention'` (`[[@Title]]`). Titles are matched case-insensitively.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS document_links (
                 id          TEXT PRIMARY KEY,
                 space_id    TEXT NOT NULL,
                 src_doc_id  TEXT NOT NULL,
                 dst_doc_id  TEXT,
                 dst_title   TEXT NOT NULL,
                 link_kind   TEXT NOT NULL DEFAULT 'wiki',
                 created_at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_document_links_src
                 ON document_links(space_id, src_doc_id);
             CREATE INDEX IF NOT EXISTS idx_document_links_dst
                 ON document_links(space_id, dst_doc_id);",
        )
        .context("initializing document_links schema")?;

        // Page history keeps metadata in the legacy-compatible version ledger and
        // stores new snapshot bodies once in a compressed, content-addressed blob.
        // Existing inline `source` rows are backfilled below without changing ids.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS document_versions (
                 id          TEXT PRIMARY KEY,
                 document_id TEXT NOT NULL,
                 space_id    TEXT NOT NULL,
                 title       TEXT NOT NULL,
                 source      TEXT NOT NULL,
                 label       TEXT,
                 kind        TEXT NOT NULL DEFAULT 'page',
                 created_at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_document_versions_doc
                 ON document_versions(document_id, created_at DESC);",
        )
        .context("initializing document_versions schema")?;

        let existing_version_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(document_versions)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        for (col, ddl) in [
            ("blob_hash", "ALTER TABLE document_versions ADD COLUMN blob_hash TEXT"),
            ("capture_type", "ALTER TABLE document_versions ADD COLUMN capture_type TEXT NOT NULL DEFAULT 'manual'"),
            ("granularity", "ALTER TABLE document_versions ADD COLUMN granularity TEXT NOT NULL DEFAULT 'exact'"),
            ("revision", "ALTER TABLE document_versions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"),
            ("updated_at", "ALTER TABLE document_versions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0"),
            ("created_by", "ALTER TABLE document_versions ADD COLUMN created_by TEXT"),
            ("group_key", "ALTER TABLE document_versions ADD COLUMN group_key TEXT"),
            ("pinned", "ALTER TABLE document_versions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 1"),
        ] {
            if !existing_version_columns.contains(col) {
                conn.execute_batch(ddl)
                    .with_context(|| format!("adding column {col} to document_versions"))?;
            }
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS document_version_blobs (
                 hash TEXT PRIMARY KEY, codec TEXT NOT NULL, payload BLOB NOT NULL,
                 raw_bytes INTEGER NOT NULL, stored_bytes INTEGER NOT NULL,
                 created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS document_version_operations (
                 document_id TEXT NOT NULL, operation_id TEXT NOT NULL,
                 revision INTEGER NOT NULL, version_id TEXT, changed INTEGER NOT NULL,
                 created_at INTEGER NOT NULL,
                 PRIMARY KEY (document_id, operation_id)
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_document_versions_group
                 ON document_versions(document_id, group_key)
                 WHERE group_key IS NOT NULL;
             CREATE INDEX IF NOT EXISTS idx_document_version_operations_age
                 ON document_version_operations(document_id, created_at DESC);",
        )
        .context("initializing document history v2 schema")?;

        // Existing manual versions are pins. Backfill their inline sources into
        // the blob table so every read and restore uses one codec from now on.
        let legacy_versions: Vec<(String, String, String, String)> = {
            let mut stmt = conn.prepare(
                "SELECT id, ryu_open('document_versions.title', id, title),
                        ryu_open('document_versions.source', id, source), kind
                 FROM document_versions
                 WHERE blob_hash IS NULL",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?;
            rows.filter_map(std::result::Result::ok).collect()
        };
        for (id, title, source, kind) in legacy_versions {
            let encoded = encode_snapshot(&SnapshotPayload {
                kind,
                source,
                title,
            })?;
            let hash = history_hash(conn, &encoded.raw)?;
            conn.execute(
                "INSERT OR IGNORE INTO document_version_blobs
                     (hash, codec, payload, raw_bytes, stored_bytes, created_at)
                 VALUES (?1, ?2, ryu_seal_blob('document_version_blobs.payload', ?1, ?3),
                         ?4, ?5, ?6)",
                params![
                    hash,
                    SNAPSHOT_CODEC,
                    encoded.payload,
                    encoded.raw_bytes,
                    encoded.stored_bytes,
                    now_millis()
                ],
            )?;
            conn.execute(
                "UPDATE document_versions
                 SET blob_hash = ?1,
                     updated_at = CASE WHEN updated_at = 0 THEN created_at ELSE updated_at END
                 WHERE id = ?2",
                params![hash, id],
            )?;
        }

        // Multi-user tenancy (collaboration epic, Phase 0): the verified human
        // owner of the document, the org it belongs to, its sharing visibility,
        // and an optional owning team. Guarded by a PRAGMA table_info existence
        // check (mirroring the conversations migration) so each ALTER is a no-op
        // when the column already exists and a real error surfaces otherwise.
        // ACL enforcement is wired in a later stage; schema-only for now.
        let existing_doc_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(documents)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        for (col, ddl) in [
            (
                "owner_user_id",
                "ALTER TABLE documents ADD COLUMN owner_user_id TEXT",
            ),
            ("org_id", "ALTER TABLE documents ADD COLUMN org_id TEXT"),
            (
                "visibility",
                "ALTER TABLE documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'",
            ),
            ("team_id", "ALTER TABLE documents ADD COLUMN team_id TEXT"),
            (
                "revision",
                "ALTER TABLE documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "updated_by",
                "ALTER TABLE documents ADD COLUMN updated_by TEXT",
            ),
            // `updated_at` of the last snapshot applied from another device. A
            // row whose `updated_at` differs has local edits the incoming sync
            // has not seen; see `apply_synced_document_blocking`.
            (
                "sync_base_updated_at",
                "ALTER TABLE documents ADD COLUMN sync_base_updated_at INTEGER",
            ),
        ] {
            if !existing_doc_columns.contains(col) {
                conn.execute_batch(ddl)
                    .with_context(|| format!("adding column {col} to documents"))?;
            }
        }

        // Idempotent migration: binary "file" documents (kind = 'file'). Unlike
        // page/database/whiteboard docs, a file's bytes live in the content-
        // addressed blob store (`~/.ryu/blobs/<sha256>`), not in `source`. These
        // columns carry the pointer + metadata; `source` holds a short text
        // descriptor (title + mime) so the file stays findable in RAG. Additive
        // columns only, so existing dbs upgrade in place.
        let _ = conn.execute_batch("ALTER TABLE documents ADD COLUMN mime TEXT;");
        let _ = conn.execute_batch("ALTER TABLE documents ADD COLUMN blob_sha256 TEXT;");
        let _ = conn.execute_batch("ALTER TABLE documents ADD COLUMN byte_size INTEGER;");

        // Idempotent migration: system Spaces. A system Space (e.g. the default
        // "Artifacts" and "Meetings" spaces) is created by Ryu itself, cannot be
        // deleted individually, and is skipped by the danger-zone bulk clear. This
        // generalizes the old name-matched "Meetings" special-case into a flag.
        let _ =
            conn.execute_batch("ALTER TABLE spaces ADD COLUMN system INTEGER NOT NULL DEFAULT 0;");

        // Notion-style entity glyphs (GlyphValue JSON from the shared GlyphPicker).
        let _ = conn.execute_batch("ALTER TABLE spaces ADD COLUMN icon TEXT;");
        let _ = conn.execute_batch("ALTER TABLE documents ADD COLUMN icon TEXT;");

        // Multi-user tenancy for SPACES (collaboration epic). `documents` already
        // carries this quartet (above); spaces did not. Guarded by a PRAGMA
        // table_info existence check (mirroring the documents block) so each ALTER
        // is a no-op when the column already exists and a real error surfaces
        // otherwise. Enforcement is the visibility predicate + the choke point +
        // the backfill; system spaces (`system = 1`) stay shared regardless.
        let existing_space_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(spaces)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        for (col, ddl) in [
            (
                "owner_user_id",
                "ALTER TABLE spaces ADD COLUMN owner_user_id TEXT",
            ),
            ("org_id", "ALTER TABLE spaces ADD COLUMN org_id TEXT"),
            (
                "visibility",
                "ALTER TABLE spaces ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'",
            ),
            ("team_id", "ALTER TABLE spaces ADD COLUMN team_id TEXT"),
        ] {
            if !existing_space_columns.contains(col) {
                conn.execute_batch(ddl)
                    .with_context(|| format!("adding column {col} to spaces"))?;
            }
        }

        retrieval::init_retrieval_schema(conn)?;
        Self::init_sealed_schema(conn)
    }

    /// Schema of the sealed store: blind equality columns (titles, link titles,
    /// Space names) and their indexes, and the blind term index `spaces_terms`
    /// kept current by per-connection TEMP triggers on `documents.source` and
    /// `chunks.content` ([`Self::install_term_triggers`]; `ryu_terms` opens the
    /// stored value, so the triggers work on legacy plaintext and on sealed
    /// values alike). Legacy rows get their tokens and
    /// terms from the background migration.
    fn init_sealed_schema(conn: &Connection) -> Result<()> {
        for (table, column) in [
            ("documents", "title_bi"),
            ("document_links", "dst_title_bi"),
            ("spaces", "name_bi"),
        ] {
            let exists: bool = conn
                .query_row(
                    &format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"),
                    params![column],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);
            if !exists {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"))
                    .with_context(|| format!("adding column {column} to {table}"))?;
            }
        }
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_document_links_title;
             CREATE INDEX IF NOT EXISTS idx_document_links_title_bi
                 ON document_links(space_id, dst_title_bi);
             CREATE INDEX IF NOT EXISTS idx_documents_title_bi
                 ON documents(space_id, title_bi);
             CREATE INDEX IF NOT EXISTS idx_spaces_name_bi ON spaces(name_bi);
             CREATE VIRTUAL TABLE IF NOT EXISTS spaces_terms
                 USING fts5(terms, detail=none, tokenize='ascii');
             CREATE TABLE IF NOT EXISTS spaces_terms_map (
                 term_rowid INTEGER PRIMARY KEY,
                 kind       TEXT NOT NULL,
                 ref_id     TEXT NOT NULL,
                 doc_id     TEXT NOT NULL,
                 UNIQUE (kind, ref_id)
             );
             CREATE INDEX IF NOT EXISTS idx_spaces_terms_map_doc
                 ON spaces_terms_map(doc_id);
             CREATE TABLE IF NOT EXISTS chunk_embeddings (
                 chunk_id  TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
                 space_id  TEXT NOT NULL,
                 model     TEXT NOT NULL,
                 dims      INTEGER NOT NULL,
                 embedding BLOB NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_space
                 ON chunk_embeddings(space_id, model, dims);
             CREATE TABLE IF NOT EXISTS space_vector_gen (
                 space_id TEXT PRIMARY KEY,
                 gen      INTEGER NOT NULL
             );
             CREATE TRIGGER IF NOT EXISTS chunk_embeddings_gen_ai AFTER INSERT ON chunk_embeddings BEGIN
                 INSERT OR IGNORE INTO space_vector_gen (space_id, gen) VALUES (NEW.space_id, 0);
                 UPDATE space_vector_gen SET gen = gen + 1 WHERE space_id = NEW.space_id;
             END;
             CREATE TRIGGER IF NOT EXISTS chunk_embeddings_gen_au AFTER UPDATE ON chunk_embeddings BEGIN
                 INSERT OR IGNORE INTO space_vector_gen (space_id, gen) VALUES (NEW.space_id, 0);
                 UPDATE space_vector_gen SET gen = gen + 1 WHERE space_id = NEW.space_id;
             END;
             CREATE TRIGGER IF NOT EXISTS chunk_embeddings_gen_ad AFTER DELETE ON chunk_embeddings BEGIN
                 INSERT OR IGNORE INTO space_vector_gen (space_id, gen) VALUES (OLD.space_id, 0);
                 UPDATE space_vector_gen SET gen = gen + 1 WHERE space_id = OLD.space_id;
             END;
             CREATE TRIGGER IF NOT EXISTS spaces_terms_doc_ad AFTER DELETE ON documents BEGIN
                 DELETE FROM spaces_terms WHERE rowid IN
                     (SELECT term_rowid FROM spaces_terms_map WHERE kind = 'doc' AND ref_id = OLD.id);
                 DELETE FROM spaces_terms_map WHERE kind = 'doc' AND ref_id = OLD.id;
             END;
             CREATE TRIGGER IF NOT EXISTS spaces_terms_chunk_ad AFTER DELETE ON chunks BEGIN
                 DELETE FROM spaces_terms WHERE rowid IN
                     (SELECT term_rowid FROM spaces_terms_map WHERE kind = 'chunk' AND ref_id = OLD.id);
                 DELETE FROM spaces_terms_map WHERE kind = 'chunk' AND ref_id = OLD.id;
             END;",
        )
        .context("initializing the sealed spaces schema")?;
        Self::enable_term_secure_delete(conn)?;
        Self::install_term_triggers(conn)?;
        // Blind tokens of rows written before sealing (equality lookups need
        // them at once; '' marks a value that does not open and never matches).
        conn.execute_batch(
            "UPDATE spaces
                 SET name_bi = COALESCE(
                     ryu_bi('spaces.name', ryu_open_soft('spaces.name', id, name)), '')
                 WHERE name_bi IS NULL;
             UPDATE documents
                 SET title_bi = COALESCE(
                     ryu_bi('documents.title', ryu_open_soft('documents.title', id, title)), '')
                 WHERE title_bi IS NULL;
             UPDATE document_links
                 SET dst_title_bi = COALESCE(
                     ryu_bi('document_links.dst_title',
                            ryu_open_soft('document_links.dst_title', id, dst_title)), '')
                 WHERE dst_title_bi IS NULL;",
        )
        .context("backfilling Spaces blind tokens")?;
        Ok(())
    }

    /// Turn on FTS5 secure-delete for `spaces_terms`, so deleting a page or
    /// chunk removes its blind tokens from the segment b-tree. A regular FTS5
    /// table otherwise only writes delete markers and keeps the original
    /// postings until a merge (SQLite's `secure_delete` pragma frees no page
    /// there, so it does not help). The setting persists in
    /// `spaces_terms_config`; it is read first so a connection that finds it set
    /// writes nothing.
    fn enable_term_secure_delete(conn: &Connection) -> Result<()> {
        let enabled: bool = conn
            .query_row(
                "SELECT 1 FROM spaces_terms_config WHERE k = 'secure-delete' AND v = 1",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !enabled {
            conn.execute(
                "INSERT INTO spaces_terms (spaces_terms, rank) VALUES ('secure-delete', 1)",
                [],
            )
            .context("enabling FTS5 secure-delete on spaces_terms")?;
        }
        Ok(())
    }

    /// Merge away the postings of a store written before secure-delete was on
    /// (deleted rows left tombstones, not removals), once, and mark the scrub
    /// owed so the freed pages are zeroed and compacted.
    fn optimize_term_index_once(conn: &mut Connection) -> Result<()> {
        if derived_format(conn, TERMS_SECURE_ITEM)?.as_deref() == Some(TERMS_SECURE_DONE) {
            return Ok(());
        }
        let tx = conn.transaction()?;
        let has_rows: bool = tx
            .query_row("SELECT 1 FROM spaces_terms_map LIMIT 1", [], |_| Ok(true))
            .optional()?
            .unwrap_or(false);
        if has_rows {
            tx.execute(
                "INSERT INTO spaces_terms (spaces_terms) VALUES ('optimize')",
                [],
            )
            .context("merging the Spaces term index segments")?;
            mark_scrub_owed(&tx)?;
        }
        set_derived_format(&tx, TERMS_SECURE_ITEM, TERMS_SECURE_DONE)?;
        tx.commit()?;
        Ok(())
    }

    /// Keep `spaces_terms` current on this connection: per-connection TEMP
    /// triggers on body and chunk writes. They call `ryu_terms`, which only
    /// exists where [`seal::register_sql_functions`] ran, so they must never be
    /// stored in the database: a stored trigger would make every page write
    /// fail with "no such function" on a downgraded build or in the sqlite3
    /// CLI. Persistent copies left by an earlier build are dropped here. The
    /// delete triggers use plain SQL and stay persistent. Call after
    /// [`secure_connection`] (changing `temp_store` drops TEMP triggers).
    fn install_term_triggers(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS main.spaces_terms_doc_ai;
             DROP TRIGGER IF EXISTS main.spaces_terms_doc_au;
             DROP TRIGGER IF EXISTS main.spaces_terms_chunk_ai;
             DROP TRIGGER IF EXISTS main.spaces_terms_chunk_au;
             CREATE TEMP TRIGGER IF NOT EXISTS spaces_terms_doc_ai AFTER INSERT ON main.documents BEGIN
                 INSERT OR IGNORE INTO spaces_terms_map (kind, ref_id, doc_id)
                     VALUES ('doc', NEW.id, NEW.id);
                 DELETE FROM spaces_terms WHERE rowid =
                     (SELECT term_rowid FROM spaces_terms_map WHERE kind = 'doc' AND ref_id = NEW.id);
                 INSERT INTO spaces_terms (rowid, terms)
                     SELECT term_rowid, ryu_terms('documents.source', NEW.id, NEW.source)
                     FROM spaces_terms_map WHERE kind = 'doc' AND ref_id = NEW.id;
             END;
             CREATE TEMP TRIGGER IF NOT EXISTS spaces_terms_doc_au AFTER UPDATE OF source ON main.documents BEGIN
                 INSERT OR IGNORE INTO spaces_terms_map (kind, ref_id, doc_id)
                     VALUES ('doc', NEW.id, NEW.id);
                 DELETE FROM spaces_terms WHERE rowid =
                     (SELECT term_rowid FROM spaces_terms_map WHERE kind = 'doc' AND ref_id = NEW.id);
                 INSERT INTO spaces_terms (rowid, terms)
                     SELECT term_rowid, ryu_terms('documents.source', NEW.id, NEW.source)
                     FROM spaces_terms_map WHERE kind = 'doc' AND ref_id = NEW.id;
             END;
             CREATE TEMP TRIGGER IF NOT EXISTS spaces_terms_chunk_ai AFTER INSERT ON main.chunks BEGIN
                 INSERT OR IGNORE INTO spaces_terms_map (kind, ref_id, doc_id)
                     VALUES ('chunk', NEW.id, NEW.document_id);
                 DELETE FROM spaces_terms WHERE rowid =
                     (SELECT term_rowid FROM spaces_terms_map WHERE kind = 'chunk' AND ref_id = NEW.id);
                 INSERT INTO spaces_terms (rowid, terms)
                     SELECT term_rowid, ryu_terms('chunks.content', NEW.id, NEW.content)
                     FROM spaces_terms_map WHERE kind = 'chunk' AND ref_id = NEW.id;
             END;
             CREATE TEMP TRIGGER IF NOT EXISTS spaces_terms_chunk_au AFTER UPDATE OF content ON main.chunks BEGIN
                 INSERT OR IGNORE INTO spaces_terms_map (kind, ref_id, doc_id)
                     VALUES ('chunk', NEW.id, NEW.document_id);
                 DELETE FROM spaces_terms WHERE rowid =
                     (SELECT term_rowid FROM spaces_terms_map WHERE kind = 'chunk' AND ref_id = NEW.id);
                 INSERT INTO spaces_terms (rowid, terms)
                     SELECT term_rowid, ryu_terms('chunks.content', NEW.id, NEW.content)
                     FROM spaces_terms_map WHERE kind = 'chunk' AND ref_id = NEW.id;
             END;",
        )
        .context("installing the Spaces term-index triggers")
    }

    /// Register `ryu_vec_tracked(space_id)` (whether a Space's write is
    /// journaled; counts it, see [`count_journaled_write`]) and
    /// `ryu_vec_untracked(space_id)` (whether its journal is to be dropped)
    /// on the store's own connection and install the vector journal. Not on
    /// the migration connection: its writes are not journaled, so they reload
    /// the partitions they touch.
    fn register_vector_journal(conn: &Connection, states: &VectorStates) -> Result<()> {
        let counted = Arc::clone(states);
        conn.create_scalar_function(
            "ryu_vec_tracked",
            1,
            rusqlite::functions::FunctionFlags::SQLITE_UTF8,
            move |ctx| {
                let space_id: String = ctx.get(0)?;
                Ok(counted
                    .lock()
                    .map(|mut states| count_journaled_write(&mut states, &space_id))
                    .unwrap_or(false))
            },
        )
        .context("registering ryu_vec_tracked")?;
        let read = Arc::clone(states);
        conn.create_scalar_function(
            "ryu_vec_untracked",
            1,
            rusqlite::functions::FunctionFlags::SQLITE_UTF8,
            move |ctx| {
                let space_id: String = ctx.get(0)?;
                Ok(read
                    .lock()
                    .map(|states| !states.get(&space_id).is_some_and(PartitionState::tracked))
                    .unwrap_or(true))
            },
        )
        .context("registering ryu_vec_untracked")?;
        Self::install_vector_journal(conn)
    }

    /// The TEMP vector journal and its triggers (see [`PartitionState`]).
    /// Per connection, like the term triggers, because `ryu_vec_tracked` only
    /// exists here. A temp-store change drops them; reinstall after
    /// [`secure_connection`] (the lost entries make the generation check fail,
    /// so those partitions reload).
    fn install_vector_journal(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS space_vector_journal (
                 seq      INTEGER PRIMARY KEY,
                 space_id TEXT NOT NULL,
                 chunk_id TEXT NOT NULL,
                 put      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS temp.idx_space_vector_journal
                 ON space_vector_journal(space_id, seq);
             CREATE TEMP TRIGGER IF NOT EXISTS space_vector_journal_ai
                 AFTER INSERT ON main.chunk_embeddings WHEN ryu_vec_tracked(NEW.space_id) BEGIN
                 INSERT INTO space_vector_journal (space_id, chunk_id, put)
                     VALUES (NEW.space_id, NEW.chunk_id, 1);
                 DELETE FROM space_vector_journal WHERE space_id = NEW.space_id
                     AND (SELECT ryu_vec_untracked(NEW.space_id));
             END;
             CREATE TEMP TRIGGER IF NOT EXISTS space_vector_journal_au
                 AFTER UPDATE ON main.chunk_embeddings WHEN ryu_vec_tracked(NEW.space_id) BEGIN
                 INSERT INTO space_vector_journal (space_id, chunk_id, put)
                     VALUES (NEW.space_id, NEW.chunk_id, 1);
                 DELETE FROM space_vector_journal WHERE space_id = NEW.space_id
                     AND (SELECT ryu_vec_untracked(NEW.space_id));
             END;
             CREATE TEMP TRIGGER IF NOT EXISTS space_vector_journal_ad
                 AFTER DELETE ON main.chunk_embeddings WHEN ryu_vec_tracked(OLD.space_id) BEGIN
                 INSERT INTO space_vector_journal (space_id, chunk_id, put)
                     VALUES (OLD.space_id, OLD.chunk_id, 0);
                 DELETE FROM space_vector_journal WHERE space_id = OLD.space_id
                     AND (SELECT ryu_vec_untracked(OLD.space_id));
             END;",
        )
        .context("installing the Spaces vector journal")
    }

    /// Decide, once, what a pre-existing NULL-tenancy space/document row MEANS —
    /// the exact twin of `ConversationStore::backfill_tenancy`.
    ///
    /// Before the per-resource ACL was populated, every space/document was created
    /// with `owner_user_id`/`org_id` NULL. On an org-bound node the by-id ACL
    /// (`resource_access`) reads an untenanted row as unattributable → DENIED to
    /// EVERYONE, including the owner (a lockout). This attributes those rows to the
    /// local owner so the owner keeps reaching their own data.
    ///
    ///   - **Node UNBOUND**: return immediately, stamp nothing (one principal; the
    ///     node token is the boundary). The marker is NOT written, so this reruns
    ///     if the node later joins an org.
    ///   - **Node ORG-BOUND**: attribute every untenanted, NON-system space +
    ///     document to the LOCAL OWNER (the signed-in vault account). System spaces
    ///     (`system = 1`) are SKIPPED — they must stay shared, and the predicate's
    ///     `OR s.system = 1` branch already keeps them (and their documents, via the
    ///     document backfill leaving system-space docs owned by whoever created
    ///     them) reachable. Idempotent via a `space_meta` marker.
    ///   - **Node ORG-BOUND with no local account**: nobody to attribute to; leave
    ///     NULL + warn. Fail closed (the ACL denies them).
    ///
    /// The owner is INJECTED by the Core-side `spaces` shim
    /// (`spaces::open_default` resolves it from `control_plane` + the account
    /// vault) so the crate never reads Core's identity plane: `None` = an unbound
    /// personal node (rows stay untenanted, by design), `Some((user, org))` = an
    /// org-bound node with a signed-in account.
    fn backfill_tenancy(conn: &Connection, owner: Option<(String, String)>) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS space_meta (key TEXT PRIMARY KEY, value TEXT)",
        )
        .context("creating space_meta")?;
        let done: Option<String> = conn
            .query_row(
                "SELECT value FROM space_meta WHERE key = 'tenancy_backfill_v1'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if done.is_some() {
            return Ok(());
        }

        // Unbound (personal) node, or org-bound node with no signed-in local
        // account: rows stay untenanted (fail closed — the ACL denies them until
        // an owner signs in and restarts). Not marked done, so a later bind can
        // still claim them.
        let Some((owner, org_id)) = owner else {
            return Ok(());
        };

        // Documents: attribute every untenanted document (system-space docs
        // included — they belong to whoever created them, not "shared").
        let docs = conn
            .execute(
                "UPDATE documents SET owner_user_id = ?1, org_id = ?2
                 WHERE owner_user_id IS NULL AND org_id IS NULL",
                params![owner, org_id],
            )
            .context("backfilling document tenancy")?;
        // Spaces: attribute every untenanted NON-system space; system spaces stay
        // shared via the predicate's `OR s.system = 1`.
        let spaces = conn
            .execute(
                "UPDATE spaces SET owner_user_id = ?1, org_id = ?2
                 WHERE owner_user_id IS NULL AND org_id IS NULL AND system = 0",
                params![owner, org_id],
            )
            .context("backfilling space tenancy")?;
        conn.execute(
            "INSERT OR REPLACE INTO space_meta (key, value) VALUES ('tenancy_backfill_v1', ?1)",
            params![owner],
        )?;
        tracing::info!(
            "spaces tenancy backfill: attributed {docs} document(s) + {spaces} space(s) to the local owner"
        );
        Ok(())
    }

    /// Create a new Space and return its id, hard-defaulting `retrieval_mode` to
    /// `"vector"`.
    ///
    /// This is the *literal* default (`DEFAULT_RAG_STRATEGY`'s twin), not the
    /// operator-configurable one. The node-wide default from `registry.json` /
    /// `RYU_RAG_STRATEGY` is applied one layer up, at the HTTP creator
    /// (`server::create_space` → `ModelRegistry::resolve_rag_strategy`), because
    /// this crate deliberately has no dependency on Core's model registry. In-crate
    /// and system-space callers (`ensure_system_space`) intentionally stay on the
    /// literal `Vector`: an Artifacts/Clips/Uploads singleton is a filing drawer,
    /// not a knowledge base, and flipping it to graph on an operator's global knob
    /// would change retrieval for surfaces that never asked for it.
    ///
    /// Use [`Self::create_space_with_mode`] to opt a Space into graph retrieval, or
    /// [`Self::set_retrieval_mode`] to change one after the fact.
    pub async fn create_space(
        &self,
        name: &str,
        description: Option<&str>,
        tenancy: &DocOwner,
    ) -> Result<String> {
        self.create_space_with_mode(name, description, RetrievalMode::Vector, tenancy)
            .await
    }

    /// Create a new Space with an explicit retrieval mode, owned by `tenancy`.
    pub async fn create_space_with_mode(
        &self,
        name: &str,
        description: Option<&str>,
        mode: RetrievalMode,
        tenancy: &DocOwner,
    ) -> Result<String> {
        self.create_space_with_mode_and_visibility(
            name,
            description,
            mode,
            tenancy,
            "private",
            None,
        )
        .await
    }

    /// Create a Space with an explicit retrieval mode and sharing visibility.
    /// `visibility` is validated at the HTTP boundary; this method keeps the
    /// storage choke point explicit so a shared Space cannot be created without
    /// its ACL fields being stamped in the same insert.
    pub async fn create_space_with_mode_and_visibility(
        &self,
        name: &str,
        description: Option<&str>,
        mode: RetrievalMode,
        tenancy: &DocOwner,
        visibility: &str,
        team_id: Option<&str>,
    ) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        let conn = self.conn.lock().await;
        upsert_space_row_with_visibility(
            &conn,
            &id,
            name,
            description,
            now,
            mode.as_str(),
            0,
            tenancy,
            visibility,
            team_id,
        )?;
        Ok(id)
    }

    /// Recreate or refresh a mirrored Space with its stable id. Metadata is
    /// last-writer-wins by `updated_at`; tenancy stays first-writer-wins.
    pub async fn apply_synced_space(
        &self,
        record: &SpaceSyncRecord,
        tenancy: &DocOwner,
    ) -> Result<bool> {
        let mode = RetrievalMode::from_str(&record.retrieval_mode);
        let visibility = match record.visibility.as_str() {
            "org" => "org",
            "team" => "team",
            _ => "private",
        };
        let team_id = if visibility == "team" {
            record.team_id.as_deref()
        } else {
            None
        };
        let conn = self.conn.lock().await;
        let existing: Option<i64> = conn
            .query_row(
                "SELECT updated_at FROM spaces WHERE id = ?1",
                params![record.id],
                |row| row.get(0),
            )
            .optional()?;
        if existing.is_some_and(|updated_at| updated_at >= record.updated_at) {
            return Ok(false);
        }
        upsert_space_row_with_visibility(
            &conn,
            &record.id,
            &record.name,
            record.description.as_deref(),
            record.created_at,
            mode.as_str(),
            0,
            tenancy,
            visibility,
            team_id,
        )?;
        conn.execute(
            "UPDATE spaces
             SET name = ryu_seal('spaces.name', id, ?1), name_bi = ryu_bi('spaces.name', ?1),
                 description = ryu_seal('spaces.description', id, ?2),
                 created_at = ?3, updated_at = ?4,
                 retrieval_mode = ?5, visibility = ?6, team_id = ?7
             WHERE id = ?8",
            params![
                record.name,
                record.description,
                record.created_at,
                record.updated_at,
                mode.as_str(),
                visibility,
                team_id,
                record.id,
            ],
        )?;
        Ok(true)
    }

    /// List the Spaces the caller may READ, most-recently-updated first, with
    /// document counts. The `filter` is the SQL twin of `resource_access`
    /// ([`SPACE_TENANCY_VISIBLE_PREDICATE`]); pass [`DocFilter::unrestricted`] for
    /// the in-process / unbound-node full-trust listing.
    pub async fn list_spaces(&self, filter: DocFilter<'_>) -> Result<Vec<Space>> {
        let conn = self.conn.lock().await;
        let sql = format!(
            "SELECT s.id, ryu_open_soft('spaces.name', s.id, s.name),
                    ryu_open_soft('spaces.description', s.id, s.description),
                    s.created_at, s.updated_at,
                    (SELECT COUNT(*) FROM documents d
                        WHERE d.space_id = s.id AND d.parent_id IS NULL
                          AND {DOC_TENANCY_VISIBLE_PREDICATE}),
                    s.retrieval_mode, s.system, s.icon, s.visibility, s.team_id
             FROM spaces s
             WHERE {SPACE_TENANCY_VISIBLE_PREDICATE}
             ORDER BY s.updated_at DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json.as_str(),
            },
            |row| {
                let mode_str: String = row.get(6)?;
                let icon_raw: Option<String> = row.get(8)?;
                // A name that does not open skips the Space (counted).
                let Some(name) = row.get::<_, Option<String>>(1)? else {
                    return Ok(None);
                };
                Ok(Some(Space {
                    id: row.get(0)?,
                    name,
                    description: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    document_count: row.get(5)?,
                    retrieval_mode: RetrievalMode::from_str(&mode_str),
                    system: row.get(7)?,
                    icon: icon_raw.and_then(|s| serde_json::from_str(&s).ok()),
                    visibility: row.get(9)?,
                    team_id: row.get(10)?,
                }))
            },
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.extend(row?);
        }
        Ok(out)
    }

    /// List the documents in a Space the caller may READ, with chunk counts. The
    /// `filter` applies [`DOC_TENANCY_VISIBLE_PREDICATE`] so a member holding only
    /// coarse `space.read` never sees another member's private document metadata;
    /// pass [`DocFilter::unrestricted`] for the in-process / unbound full listing.
    pub async fn list_documents(
        &self,
        space_id: &str,
        filter: DocFilter<'_>,
    ) -> Result<Vec<Document>> {
        let conn = self.conn.lock().await;
        let sql = format!(
            "SELECT d.id, d.space_id, ryu_open_soft('documents.title', d.id, d.title),
                    d.created_at, d.updated_at,
                    (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id),
                    d.kind, d.parent_id, d.mime, d.byte_size, d.icon
             FROM documents d
             WHERE d.space_id = :space_id AND d.parent_id IS NULL
               AND {DOC_TENANCY_VISIBLE_PREDICATE}
             ORDER BY d.created_at ASC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":space_id": space_id,
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json.as_str(),
            },
            |row| {
                let icon_raw: Option<String> = row.get(10)?;
                let Some(title) = row.get::<_, Option<String>>(2)? else {
                    return Ok(None);
                };
                Ok(Some(Document {
                    id: row.get(0)?,
                    space_id: row.get(1)?,
                    title,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    chunk_count: row.get(5)?,
                    kind: row.get(6)?,
                    parent_id: row.get(7)?,
                    mime: row.get(8)?,
                    byte_size: row.get(9)?,
                    icon: icon_raw.and_then(|s| serde_json::from_str(&s).ok()),
                }))
            },
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.extend(row?);
        }
        Ok(out)
    }

    /// List full source documents for a portable Space export.
    ///
    /// Binary files are intentionally excluded: their blobs are node-local and
    /// are not part of the Markdown/OKF interchange contract. Unlike
    /// list_documents, this includes database row pages so an export can
    /// preserve the row-to-page relationship.
    pub async fn list_document_contents_for_export(
        &self,
        space_id: &str,
        filter: DocFilter<'_>,
    ) -> Result<Vec<DocumentContent>> {
        let conn = self.conn.lock().await;
        let sql = format!(
            "SELECT d.id, d.space_id, ryu_open_soft('documents.title', d.id, d.title),
                    ryu_open_soft('documents.source', d.id, d.source), d.created_at, d.updated_at,
                    (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id),
                    d.kind, d.parent_id, d.icon, d.revision
             FROM documents d
             WHERE d.space_id = :space_id AND d.kind != 'file'
               AND {DOC_TENANCY_VISIBLE_PREDICATE}
             ORDER BY d.parent_id IS NOT NULL, d.created_at ASC, d.id ASC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":space_id": space_id,
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json.as_str(),
            },
            |row| {
                let icon_raw: Option<String> = row.get(9)?;
                let (Some(title), Some(source)) = (
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ) else {
                    return Ok(None);
                };
                Ok(Some(DocumentContent {
                    id: row.get(0)?,
                    space_id: row.get(1)?,
                    title,
                    source,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    revision: row.get(10)?,
                    chunk_count: row.get(6)?,
                    kind: row.get(7)?,
                    parent_id: row.get(8)?,
                    icon: icon_raw.and_then(|value| serde_json::from_str(&value).ok()),
                }))
            },
        )?;
        let rows = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("listing Space source documents for export")?;
        Ok(rows.into_iter().flatten().collect())
    }

    /// List every non-binary document for cross-device sync, including child pages.
    pub async fn list_documents_for_sync(&self) -> Result<Vec<DocumentSyncRecord>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT d.id, d.space_id, ryu_open_soft('documents.title', d.id, d.title),
                    ryu_open_soft('documents.source', d.id, d.source), d.created_at, d.updated_at,
                    (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id),
                    d.kind, d.parent_id, d.icon, d.revision, d.owner_user_id
             FROM documents d WHERE d.kind != 'file' ORDER BY d.created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            let icon_raw: Option<String> = row.get(9)?;
            let (Some(title), Some(source)) = (
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ) else {
                return Ok(None);
            };
            Ok(Some(DocumentSyncRecord {
                document: DocumentContent {
                    id: row.get(0)?,
                    space_id: row.get(1)?,
                    title,
                    source,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    revision: row.get(10)?,
                    chunk_count: row.get(6)?,
                    kind: row.get(7)?,
                    parent_id: row.get(8)?,
                    icon: icon_raw.and_then(|value| serde_json::from_str(&value).ok()),
                },
                owner_user_id: row.get(11)?,
            }))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.extend(row?);
        }
        Ok(out)
    }

    /// Search page titles, Space metadata, editable source, and extracted chunk
    /// text. Titles and Space names/descriptions match as case-insensitive
    /// substrings; bodies and extracted chunk text match as whole words through
    /// the blind `spaces_terms` index. This intentionally sits beside the
    /// vector/graph RAG path: a global palette needs predictable lexical recall
    /// without starting an embedder or reranker, while normal Space answers keep
    /// their richer retrieval behavior.
    pub async fn search_documents_lexical(
        &self,
        query: &str,
        limit: usize,
        filter: DocFilter<'_>,
    ) -> Result<Vec<LexicalDocumentMatch>> {
        let terms: Vec<String> = query
            .split_whitespace()
            .map(str::trim)
            .filter(|term| !term.is_empty())
            .take(8)
            .map(ToOwned::to_owned)
            .collect();
        if terms.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }

        let mut matches = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for term in terms {
            let term_matches = self
                .search_documents_lexical_term(&term, limit, filter.clone())
                .await?;
            for hit in term_matches {
                if seen.insert(hit.document_id.clone()) {
                    matches.push(hit);
                    if matches.len() >= limit {
                        return Ok(matches);
                    }
                }
            }
        }
        Ok(matches)
    }

    /// One term of [`Self::search_documents_lexical`]. Space names, descriptions
    /// and document titles are sealed, so they are opened and matched in memory
    /// (case-insensitive substring, as before). Bodies and chunk text are found
    /// through the blind term index `spaces_terms` (whole words: a term matches
    /// a document whose body contains every word of the term). Ranking is
    /// unchanged: an exact title match, then an exact Space name match, then
    /// the most recently updated.
    async fn search_documents_lexical_term(
        &self,
        term: &str,
        limit: usize,
        filter: DocFilter<'_>,
    ) -> Result<Vec<LexicalDocumentMatch>> {
        struct Candidate {
            hit: LexicalDocumentMatch,
            description: Option<String>,
            doc_hit: bool,
            chunk_hit: Option<String>,
        }
        let needle = term.to_lowercase();
        let body_query = self.seal.keys.terms_query(term);
        let body_columns = if body_query.is_some() {
            "d.id IN (SELECT m.doc_id FROM spaces_terms_map m
                      WHERE m.kind = 'doc' AND m.term_rowid IN
                          (SELECT rowid FROM spaces_terms WHERE spaces_terms MATCH :query)),
             (SELECT c.id FROM chunks c
              JOIN spaces_terms_map m ON m.kind = 'chunk' AND m.ref_id = c.id
              WHERE c.document_id = d.id AND m.term_rowid IN
                  (SELECT rowid FROM spaces_terms WHERE spaces_terms MATCH :query)
              ORDER BY c.ordinal ASC LIMIT 1)"
        } else {
            "0, NULL"
        };
        let conn = self.conn.lock().await;
        let sql = format!(
            "SELECT d.id, d.space_id, ryu_open_soft('spaces.name', s.id, s.name),
                    ryu_open_soft('spaces.description', s.id, s.description),
                    ryu_open_soft('documents.title', d.id, d.title), d.created_at,
                    CASE WHEN d.updated_at > 0 THEN d.updated_at ELSE d.created_at END,
                    {body_columns}
             FROM documents d
             JOIN spaces s ON s.id = d.space_id
             WHERE {SPACE_TENANCY_VISIBLE_PREDICATE}
               AND {DOC_TENANCY_VISIBLE_PREDICATE}"
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut params: Vec<(&str, &dyn rusqlite::ToSql)> = vec![];
        let bound = filter.bound_flag();
        let teams = filter.team_ids_json.as_str();
        params.push((":bound", &bound));
        params.push((":uid", &filter.owner_user_id));
        params.push((":org", &filter.org_id));
        params.push((":teams", &teams));
        if let Some(query) = body_query.as_ref() {
            params.push((":query", query));
        }
        let rows = stmt.query_map(params.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, bool>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })?;
        let mut candidates = Vec::new();
        for row in rows {
            let (
                id,
                space_id,
                name,
                description,
                title,
                created_at,
                updated_at,
                doc_hit,
                chunk_hit,
            ) = row?;
            let (Some(space_name), Some(title)) = (name, title) else {
                continue;
            };
            let contains = |value: &str| value.to_lowercase().contains(&needle);
            let metadata_hit = contains(&space_name)
                || description.as_deref().is_some_and(contains)
                || contains(&title);
            if !(metadata_hit || doc_hit || chunk_hit.is_some()) {
                continue;
            }
            candidates.push(Candidate {
                hit: LexicalDocumentMatch {
                    document_id: id,
                    space_id,
                    space_name,
                    title,
                    snippet: String::new(),
                    created_at,
                    updated_at,
                },
                description,
                doc_hit,
                chunk_hit,
            });
        }
        let rank = |candidate: &Candidate| {
            if candidate.hit.title.to_lowercase() == needle {
                0
            } else if candidate.hit.space_name.to_lowercase() == needle {
                1
            } else {
                2
            }
        };
        candidates.sort_by(|left, right| {
            rank(left)
                .cmp(&rank(right))
                .then(right.hit.updated_at.cmp(&left.hit.updated_at))
        });
        candidates.truncate(limit);
        let first_chars = |value: &str| value.chars().take(280).collect::<String>();
        let mut out = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let Candidate {
                mut hit,
                description,
                doc_hit,
                chunk_hit,
            } = candidate;
            let contains = |value: &str| value.to_lowercase().contains(&needle);
            hit.snippet = if contains(&hit.space_name) {
                hit.space_name.clone()
            } else if description.as_deref().is_some_and(contains) {
                description.unwrap_or_else(|| hit.space_name.clone())
            } else if contains(&hit.title) {
                hit.title.clone()
            } else if doc_hit {
                conn.query_row(
                    "SELECT ryu_open_soft('documents.source', id, source) FROM documents
                     WHERE id = ?1",
                    params![hit.document_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten()
                .map(|source| first_chars(&source))
                .unwrap_or_else(|| hit.title.clone())
            } else if let Some(chunk_id) = chunk_hit {
                conn.query_row(
                    "SELECT ryu_open_soft('chunks.content', id, content) FROM chunks
                     WHERE id = ?1",
                    params![chunk_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten()
                .map(|content| first_chars(&content))
                .unwrap_or_else(|| hit.title.clone())
            } else {
                hit.title.clone()
            };
            out.push(hit);
        }
        Ok(out)
    }

    /// Ingest a document into a Space: chunk the text, embed each chunk, and store
    /// the rows plus their vectors. In graph mode also extracts entities/relations.
    /// Returns the new document id. Errors if the Space does not exist.
    ///
    /// # Why the write half runs on `spawn_blocking`
    ///
    /// In **graph** mode this transaction reaches [`build_graph_for_chunks`], whose
    /// cost is `O(chunks × entities²)`: measured on English prose, ≈57 distinct
    /// entities per ~990-char chunk ⇒ ≈3,200 edge INSERTs **per chunk**, and ~20–55
    /// ms per chunk on an on-disk db (see the table on [`build_graph_for_chunks`]).
    /// A large upload is therefore seconds-to-minutes of uninterruptible SQLite
    /// work, and it used to run inline on the tokio worker that polled this future —
    /// the same defect that [`Self::set_retrieval_mode`] was moved off the worker
    /// for, differing only in that the input is one document rather than a whole
    /// Space. "One document" is not a bound: a single uploaded book is one document.
    /// `graph_ingest_does_not_occupy_the_async_worker` is the regression guard, and
    /// it counted 0 scheduler ticks against the inline shape.
    ///
    /// Be precise about what moving it does and does not buy — the same three points
    /// as [`Self::set_retrieval_mode`], because it is the same connection and the
    /// same one-transaction guarantee:
    ///
    /// - **Fixed:** no runtime worker is parked for the duration. Embedding still
    ///   happens *before* the lock (it may do network I/O), so only the SQL runs on
    ///   the blocking pool.
    /// - **NOT fixed:** the connection mutex is held for the whole transaction, so
    ///   every other `SpaceStore` call — including every *other* Space — still
    ///   queues behind it. Moving the work changes *who* waits, not *whether*.
    /// - **Behaviour change, stated rather than discovered:** the write is now
    ///   detached from the caller's future. Dropping that future (client disconnect,
    ///   request timeout) after the blocking task is spawned no longer even
    ///   *appears* to abandon the ingest — it runs to completion and **commits**,
    ///   and the caller never learns the new id. Inline, the same commit happened
    ///   (the body had no await point, so it could not be interrupted either), so
    ///   nothing became less cancellable; what changed is that the result can now be
    ///   dropped on the floor. A panic inside the body likewise surfaces as
    ///   `Err(… task panicked)` instead of unwinding into the caller's task.
    pub async fn ingest_document(
        &self,
        space_id: &str,
        title: &str,
        content: &str,
        tenancy: &DocOwner,
    ) -> Result<String> {
        validate_document_metadata(title, None)?;
        let chunks = self.split_for_space(space_id, content).await?;
        let mode = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT retrieval_mode FROM spaces WHERE id = ?1",
                params![space_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("querying space retrieval_mode before ingest")?
            .map(|value| RetrievalMode::from_str(&value))
        }
        .ok_or_else(|| anyhow::anyhow!("space '{space_id}' not found"))?;
        if mode == RetrievalMode::Graph {
            anyhow::ensure!(
                chunks.len() <= MAX_GRAPH_CHUNKS_PER_DOCUMENT,
                "document has {} chunks; graph mode supports at most {MAX_GRAPH_CHUNKS_PER_DOCUMENT} chunks per document",
                chunks.len()
            );
        }
        // Embed outside the lock — the embedder may do network I/O.
        let emb = self.embedder_snapshot().await;
        let model_id = emb.model_id().to_string();
        let dims = emb.dims();
        let embedded = embed_text_chunks(&emb, chunks).await?;

        let document_id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        // `spawn_blocking` demands `'static`, so the borrowed arguments are cloned
        // and the guard is taken as an *owned* one. Acquiring the lock HERE rather
        // than inside the closure keeps the wait asynchronous: callers queue on the
        // tokio mutex instead of occupying a blocking-pool thread while they wait.
        let history_space_id = space_id.to_owned();
        let space_id = history_space_id.clone();
        let title = title.to_owned();
        let history_content = content.to_owned();
        let content = history_content.clone();
        let tenancy = tenancy.clone();
        let guard = self.conn.clone().lock_owned().await;
        let created_id = tokio::task::spawn_blocking(move || {
            Self::ingest_document_blocking(
                guard,
                &document_id,
                &space_id,
                &title,
                &content,
                now,
                &model_id,
                dims,
                &embedded,
                &tenancy,
            )
        })
        .await
        .context("document ingest task panicked")??;
        checkpoint_source_history_best_effort(
            source_history_path(&created_id, "page", &history_space_id),
            history_content,
            Some("Document created".to_owned()),
        )
        .await;
        Ok(created_id)
    }

    /// The blocking body of [`SpaceStore::ingest_document`]. Split out only so the
    /// `spawn_blocking` closure stays a one-liner; all the reasoning about *why* it
    /// is shaped this way lives on the public method.
    ///
    /// Takes the guard **by value** so the connection is released exactly when the
    /// transaction ends, on the blocking thread, whether it commits or unwinds.
    #[allow(clippy::too_many_arguments)]
    fn ingest_document_blocking(
        mut guard: tokio::sync::OwnedMutexGuard<Connection>,
        document_id: &str,
        space_id: &str,
        title: &str,
        content: &str,
        now: i64,
        model_id: &str,
        dims: usize,
        embedded: &[EmbeddedChunk],
        tenancy: &DocOwner,
    ) -> Result<String> {
        let conn = &mut *guard;
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

        upsert_document_row(
            &tx,
            document_id,
            space_id,
            title,
            now,
            content,
            "page",
            None,
            None,
            None,
            None,
            tenancy,
        )?;

        insert_chunks(
            &tx,
            document_id,
            space_id,
            embedded,
            now,
            model_id,
            dims,
            mode,
        )?;

        tx.execute(
            "UPDATE spaces SET updated_at = ?1 WHERE id = ?2",
            params![now, space_id],
        )
        .context("bumping space updated_at")?;

        // Wiki page-links: store this document's outgoing links, and resolve any
        // pending inbound links now that this title exists.
        store_doc_links(&tx, space_id, document_id, content, now)?;
        reresolve_pending_links(&tx, space_id, document_id, title)?;

        tx.commit().context("committing ingest transaction")?;
        Ok(document_id.to_owned())
    }

    /// Create an empty Notion-style page (document with no content yet) in a Space.
    /// Returns the new document id. The editor fills it in via `update_document`,
    /// which is what produces chunks + embeddings.
    pub async fn create_page(
        &self,
        space_id: &str,
        title: &str,
        tenancy: &DocOwner,
    ) -> Result<String> {
        self.create_document_of_kind(space_id, title, "page", None, tenancy)
            .await
    }

    /// Create an empty page whose `parent_id` is `parent` — a database "row page".
    /// It embeds like any page but is hidden from top-level document listings.
    pub async fn create_child_page(
        &self,
        space_id: &str,
        title: &str,
        parent: &str,
        tenancy: &DocOwner,
    ) -> Result<String> {
        self.create_document_of_kind(space_id, title, "page", Some(parent), tenancy)
            .await
    }

    /// Create an empty database (data-grid) document in a Space. Same lifecycle as
    /// a page — the editor fills its grid JSON in via `update_document`, which
    /// chunks + embeds the flattened cell text so the database stays searchable.
    /// Import a source document without embedding it.
    ///
    /// Portable packages use this path so a package never has to ship
    /// provider-specific vectors. A later save or the manual embedding re-index
    /// path turns the source into searchable chunks on the target node.
    pub async fn import_document(
        &self,
        space_id: &str,
        title: &str,
        source: &str,
        kind: &str,
        parent_id: Option<&str>,
        tenancy: &DocOwner,
    ) -> Result<String> {
        anyhow::ensure!(
            matches!(kind, "page" | "database"),
            "portable documents support page and database kinds only"
        );
        validate_document_metadata(title, None)?;
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
        upsert_document_row(
            &conn,
            &document_id,
            space_id,
            title,
            now,
            source,
            kind,
            parent_id,
            None,
            None,
            None,
            tenancy,
        )?;
        conn.execute(
            "UPDATE spaces SET updated_at = ?1 WHERE id = ?2",
            params![now, space_id],
        )
        .context("bumping space updated_at")?;
        reresolve_pending_links(&conn, space_id, &document_id, title)?;
        store_doc_links(&conn, space_id, &document_id, source, now)?;
        let history_path = source_history_path(&document_id, kind, space_id);
        let history_source = source.to_owned();
        drop(conn);
        checkpoint_source_history_best_effort(
            history_path,
            history_source,
            Some("Document imported".to_owned()),
        )
        .await;
        Ok(document_id)
    }

    /// Replace the source of a document that has not been embedded yet.
    ///
    /// This is the second half of a portable database import: the database row
    /// pages need their new local ids before the database source can point at
    /// them. It refuses to overwrite an indexed document so it cannot silently
    /// discard searchable content.
    pub async fn replace_document_source_without_embedding(
        &self,
        doc_id: &str,
        title: &str,
        source: &str,
    ) -> Result<bool> {
        validate_document_metadata(title, None)?;
        let now = now_millis();
        let conn = self.conn.lock().await;
        let chunk_count: Option<i64> = conn
            .query_row(
                "SELECT COUNT(*) FROM chunks WHERE document_id = ?1",
                params![doc_id],
                |row| row.get(0),
            )
            .optional()
            .context("checking unindexed document")?;
        let Some(chunk_count) = chunk_count else {
            return Ok(false);
        };
        anyhow::ensure!(
            chunk_count == 0,
            "document {doc_id} is already indexed and cannot be replaced without embedding"
        );
        let Some((space_id, kind)) = conn
            .query_row(
                "SELECT space_id, kind FROM documents WHERE id = ?1",
                params![doc_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .context("reading unindexed document space")?
        else {
            return Ok(false);
        };
        let updated = conn
            .execute(
                "UPDATE documents
                 SET title = ryu_seal('documents.title', id, ?1),
                     title_bi = ryu_bi('documents.title', ?1),
                     source = ryu_seal('documents.source', id, ?2),
                     updated_at = ?3, revision = revision + 1
                 WHERE id = ?4",
                params![title, source, now, doc_id],
            )
            .context("replacing unindexed document source")?;
        if updated == 0 {
            return Ok(false);
        }
        conn.execute(
            "UPDATE spaces SET updated_at = ?1 WHERE id = ?2",
            params![now, space_id],
        )
        .context("bumping Space updated_at")?;
        store_doc_links(&conn, &space_id, doc_id, source, now)?;
        let history_path = source_history_path(doc_id, &kind, &space_id);
        let history_source = source.to_owned();
        drop(conn);
        checkpoint_source_history_best_effort(
            history_path,
            history_source,
            Some("Document imported".to_owned()),
        )
        .await;
        Ok(true)
    }

    pub async fn create_database(
        &self,
        space_id: &str,
        title: &str,
        tenancy: &DocOwner,
    ) -> Result<String> {
        self.create_document_of_kind(space_id, title, "database", None, tenancy)
            .await
    }

    /// Create an empty whiteboard (Excalidraw scene) document in a Space. Same
    /// lifecycle as a page/database — the editor saves the Excalidraw scene JSON
    /// via `update_document`, which chunks + embeds the flattened element text so
    /// the board stays searchable.
    pub async fn create_whiteboard(
        &self,
        space_id: &str,
        title: &str,
        tenancy: &DocOwner,
    ) -> Result<String> {
        self.create_document_of_kind(space_id, title, "whiteboard", None, tenancy)
            .await
    }

    // ── App-owned documents (grant `spaces:docs`) ───────────────────────────────
    //
    // Full-page Companion apps OWN Space documents through these methods, so a
    // whiteboard-as-app (or any app) gets the full Spaces integration: persisted in
    // the `documents` table, search-embedded, `[[backlinked]]`, versioned, and
    // Space-routed. Isolation is by `kind`: every app doc carries
    // `kind = "app:<plugin_id>"`, and every read/update/delete verifies that kind
    // FIRST — one app can never see or mutate another app's docs, nor any built-in
    // page/database/whiteboard/file. The owning `plugin_id` comes from the bridge's
    // path-bound id (never the body), so it cannot be spoofed.

    /// The isolation `kind` for a given app's documents.
    fn app_kind(plugin_id: &str) -> String {
        format!("app:{plugin_id}")
    }

    /// Create an app-owned document in a Space (`kind = app:<plugin_id>`). Returns
    /// the new document id. Same lifecycle as a page/database/whiteboard — empty
    /// until the app fills it via [`app_update_doc`](Self::app_update_doc).
    pub async fn app_create_doc(
        &self,
        plugin_id: &str,
        space_id: &str,
        title: &str,
        tenancy: &DocOwner,
    ) -> Result<String> {
        let kind = Self::app_kind(plugin_id);
        // The Core-side bridge injects the verified HTTP caller's owner when one is
        // present, or the local background owner for hook and migration writers.
        self.create_document_of_kind(space_id, title, &kind, None, tenancy)
            .await
    }

    /// Fetch one app-owned document. Returns `Ok(None)` unless the document exists
    /// AND its `kind` is exactly `app:<plugin_id>` — so it never exposes another
    /// app's doc or a built-in page/database/whiteboard/file.
    pub async fn app_get_doc(&self, plugin_id: &str, doc_id: &str) -> Result<Option<AppDoc>> {
        let want = Self::app_kind(plugin_id);
        let Some(doc) = self.get_document(doc_id).await? else {
            return Ok(None);
        };
        if doc.kind != want {
            return Ok(None);
        }
        Ok(Some(AppDoc {
            id: doc.id,
            title: doc.title,
            source: doc.source,
            kind: doc.kind,
        }))
    }

    /// Update an app-owned document. The kind is verified FIRST (an app may only
    /// touch its own `app:<plugin_id>` docs), then the write reuses the normal
    /// [`update_document`](Self::update_document) path so flatten + search
    /// re-embedding + `[[backlink]]` re-resolution all run. `title = None` keeps
    /// the current title.
    pub async fn app_update_doc(
        &self,
        plugin_id: &str,
        doc_id: &str,
        title: Option<&str>,
        source: &str,
    ) -> Result<()> {
        let want = Self::app_kind(plugin_id);
        let doc = self
            .get_document(doc_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("document '{doc_id}' not found"))?;
        if doc.kind != want {
            anyhow::bail!("document '{doc_id}' is not owned by app '{plugin_id}'");
        }
        let title = title.unwrap_or(&doc.title);
        self.update_document(doc_id, title, source).await
    }

    /// List an app's own documents in a Space (only `kind = app:<plugin_id>`),
    /// most-recently-updated first.
    pub async fn app_list_docs(
        &self,
        plugin_id: &str,
        space_id: &str,
    ) -> Result<Vec<AppDocSummary>> {
        let want = Self::app_kind(plugin_id);
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT id, ryu_open_soft('documents.title', id, title), updated_at
                 FROM documents
                 WHERE space_id = ?1 AND kind = ?2
                 ORDER BY updated_at DESC, id DESC",
            )
            .context("preparing app doc list")?;
        let rows = stmt
            .query_map(params![space_id, want], |row| {
                let Some(title) = row.get::<_, Option<String>>(1)? else {
                    return Ok(None);
                };
                Ok(Some(AppDocSummary {
                    id: row.get(0)?,
                    title,
                    updated_at: row.get(2)?,
                }))
            })
            .context("querying app docs")?;
        let mut out = Vec::new();
        for row in rows {
            out.extend(row?);
        }
        Ok(out)
    }

    /// Delete an app-owned document (kind-verified FIRST). Reuses
    /// [`delete_document`](Self::delete_document), which also removes the doc's
    /// links and version history.
    pub async fn app_delete_doc(&self, plugin_id: &str, doc_id: &str) -> Result<()> {
        let want = Self::app_kind(plugin_id);
        let doc = self
            .get_document(doc_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("document '{doc_id}' not found"))?;
        if doc.kind != want {
            anyhow::bail!("document '{doc_id}' is not owned by app '{plugin_id}'");
        }
        self.delete_document(doc_id).await?;
        Ok(())
    }

    /// Summarize every visible Space containing documents owned by an app.
    /// App ownership is the exact `kind = app:<plugin_id>` contract used by the
    /// Companion document bridge; the caller filter still applies to both the
    /// Space and document rows on an org-bound node.
    pub async fn app_space_usage(
        &self,
        plugin_id: &str,
        filter: DocFilter<'_>,
    ) -> Result<Vec<AppSpaceUsage>> {
        let conn = self.conn.lock().await;
        let sql = format!(
            "SELECT s.id, ryu_open_soft('spaces.name', s.id, s.name), COUNT(d.id),
                    COALESCE(SUM(COALESCE(d.byte_size,
                        length(ryu_open_soft('documents.source', d.id, d.source)))), 0),
                    s.system
             FROM spaces s
             JOIN documents d ON d.space_id = s.id
             WHERE d.kind = :kind
               AND {SPACE_TENANCY_VISIBLE_PREDICATE}
               AND {DOC_TENANCY_VISIBLE_PREDICATE}
             GROUP BY s.id, s.system
             ORDER BY MAX(s.updated_at) DESC, s.id ASC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":kind": Self::app_kind(plugin_id),
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json.as_str(),
            },
            |row| {
                let Some(name) = row.get::<_, Option<String>>(1)? else {
                    return Ok(None);
                };
                Ok(Some(AppSpaceUsage {
                    id: row.get(0)?,
                    name,
                    document_count: row.get(2)?,
                    storage_bytes: row.get(3)?,
                    system: row.get(4)?,
                }))
            },
        )?;
        let rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().flatten().collect())
    }

    /// Delete all visible documents owned by an app, preserving the normal
    /// document deletion transaction for vectors, graph rows, links, versions,
    /// and child pages. Spaces themselves are shared Core resources and are not
    /// removed by app cleanup.
    pub async fn delete_app_data(&self, plugin_id: &str, filter: DocFilter<'_>) -> Result<u64> {
        let ids = {
            let conn = self.conn.lock().await;
            let sql = format!(
                "SELECT d.id
                 FROM documents d
                 JOIN spaces s ON s.id = d.space_id
                 WHERE d.kind = :kind
                   AND {SPACE_TENANCY_VISIBLE_PREDICATE}
                   AND {DOC_TENANCY_VISIBLE_PREDICATE}
                 ORDER BY d.parent_id IS NOT NULL, d.id"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(
                named_params! {
                    ":kind": Self::app_kind(plugin_id),
                    ":bound": filter.bound_flag(),
                    ":uid": filter.owner_user_id,
                    ":org": filter.org_id,
                    ":teams": filter.team_ids_json.as_str(),
                },
                |row| row.get::<_, String>(0),
            )?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        let mut removed = 0;
        for id in ids {
            if self.delete_document(&id).await? {
                removed += 1;
            }
        }
        Ok(removed)
    }

    /// Shared constructor for an empty document of a given `kind`
    /// (`"page"` | `"database"`), optionally parented to another document.
    async fn create_document_of_kind(
        &self,
        space_id: &str,
        title: &str,
        kind: &str,
        parent_id: Option<&str>,
        tenancy: &DocOwner,
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
        upsert_document_row(
            &conn,
            &document_id,
            space_id,
            title,
            now,
            "",
            kind,
            parent_id,
            None,
            None,
            None,
            tenancy,
        )?;
        conn.execute(
            "UPDATE spaces SET updated_at = ?1 WHERE id = ?2",
            params![now, space_id],
        )
        .context("bumping space updated_at")?;
        // A new page may satisfy pending `[[Title]]` links from other documents.
        reresolve_pending_links(&conn, space_id, &document_id, title)?;
        let history_path = source_history_path(&document_id, kind, space_id);
        drop(conn);
        checkpoint_source_history_best_effort(
            history_path,
            String::new(),
            Some("Document created".to_owned()),
        )
        .await;
        Ok(document_id)
    }

    /// Get-or-create a **system** Space by name. System spaces (e.g. the default
    /// "Artifacts", "Uploads", and "Meetings" collections) are Ryu-owned: they cannot
    /// be deleted individually and are skipped by the danger-zone bulk clear. Called
    /// idempotently at startup, so a matching row is reused and its `system` flag
    /// is (re-)asserted. Returns the space id.
    pub async fn ensure_system_space(
        &self,
        name: &str,
        description: Option<&str>,
    ) -> Result<String> {
        let conn = self.conn.lock().await;
        // `name` is sealed: find candidates by blind token, then keep the old
        // exact (case-sensitive) comparison on the opened names.
        let existing: Option<String> = {
            let mut stmt = conn.prepare(
                "SELECT id, ryu_open_soft('spaces.name', id, name) FROM spaces
                 WHERE name_bi = ryu_bi('spaces.name', ?1)",
            )?;
            let rows = stmt.query_map(params![name], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?;
            let mut found = None;
            for row in rows {
                let (id, opened) = row.context("looking up system space")?;
                if opened.as_deref() == Some(name) {
                    found = Some(id);
                    break;
                }
            }
            found
        };
        if let Some(id) = existing {
            conn.execute("UPDATE spaces SET system = 1 WHERE id = ?1", params![id])
                .context("asserting system flag")?;
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        // System spaces are node singletons with no owner — Unattributed + system=1.
        // The visibility predicate's `OR s.system = 1` keeps them shared to every
        // member, and the backfill deliberately skips them.
        upsert_space_row(
            &conn,
            &id,
            name,
            description,
            now,
            "vector",
            1,
            &DocOwner::unattributed(),
        )?;
        Ok(id)
    }

    /// Get-or-create an **ordinary** Space by name, owned by `tenancy`. Returns its id.
    ///
    /// The seam a headless writer needs before an app-owned document can exist at
    /// all: [`Self::app_create_doc`] takes a `space_id`, space ids are uuids, and a
    /// caller with no UI (a turn hook running in the plugin sandbox) has no route
    /// parameter to learn one from. Without this, the `spaces:docs` grant is
    /// reachable only by an app whose frame was already handed a space id.
    ///
    /// Deliberately NOT [`Self::ensure_system_space`]. A system Space is a node
    /// singleton the danger-zone bulk clear must preserve and the user may not
    /// delete; a Space a plugin keeps its ledger in is an ordinary one the user owns
    /// — renameable, re-scopable, deletable — so it is created with `system = 0` and
    /// a real owner, and re-creating it after a delete is the caller's next write.
    ///
    /// The lookup is scoped to the caller's own tenancy (`IS`, so NULL matches NULL)
    /// rather than by name alone. On a bound node two members can each hold a Space
    /// called "Mistakes"; a name-only match would resolve one member's writes into
    /// the other's Space, which the by-id ACL would then refuse to show them.
    pub async fn ensure_named_space(
        &self,
        name: &str,
        description: Option<&str>,
        tenancy: &DocOwner,
    ) -> Result<String> {
        let (owner_user_id, org_id) = tenancy.parts();
        let conn = self.conn.lock().await;
        // Blind-token candidates, then the old exact comparison on the opened
        // names, oldest first.
        let existing: Option<String> = {
            let mut stmt = conn.prepare(
                "SELECT id, ryu_open_soft('spaces.name', id, name) FROM spaces
                 WHERE name_bi = ryu_bi('spaces.name', :name)
                   AND owner_user_id IS :owner AND org_id IS :org
                 ORDER BY created_at ASC",
            )?;
            let rows = stmt.query_map(
                named_params! {
                    ":name": name,
                    ":owner": owner_user_id,
                    ":org": org_id,
                },
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )?;
            let mut found = None;
            for row in rows {
                let (id, opened) = row.context("looking up named space")?;
                if opened.as_deref() == Some(name) {
                    found = Some(id);
                    break;
                }
            }
            found
        };
        if let Some(id) = existing {
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        upsert_space_row(
            &conn,
            &id,
            name,
            description,
            now,
            RetrievalMode::Vector.as_str(),
            0,
            tenancy,
        )?;
        Ok(id)
    }

    /// Create a binary **file** document in a Space. Writes `bytes` to the content-
    /// addressed blob store, inserts a `kind = 'file'` document pointing at the
    /// blob, and embeds a short text descriptor (`title` + `mime`) so the file is
    /// discoverable via RAG search. Returns the new document id.
    ///
    /// This is the substrate the `create_artifact` tool and chat auto-filing sit
    /// on: a generated pptx/xlsx/csv/pdf/png lands here as a first-class Space doc.
    ///
    /// # The descriptor chunk obeys the Space's `retrieval_mode`, like every other
    /// # chunk
    ///
    /// This used to pass a hardcoded [`RetrievalMode::Vector`] to [`insert_chunks`],
    /// so a file added to a **graph**-mode Space got a chunk with no
    /// `graph_nodes`/`graph_edges` row. That is not a missing optimisation, it is an
    /// inconsistency with a user-visible edge: [`Self::set_retrieval_mode`] rebuilds
    /// from `SELECT id, content FROM chunks`, which **does** include file chunks. So
    /// the same file in the same Space was retrievable or not depending on the order
    /// the user happened to do things — upload-then-flip worked, create-Graph-Space-
    /// then-upload did not — and the natural flow was the broken one. The mode is now
    /// read from the Space row inside the same transaction that writes the document,
    /// exactly as [`Self::ingest_document`] and [`Self::update_document`] do.
    ///
    /// **What that does and does not make findable.** The only chunk a file has is
    /// the descriptor (`title` + `mime`) — a file's *bytes* are never chunked, in
    /// either mode. So the graph rows this now writes are entities of the filename
    /// and mime type, which is precisely what the rebuild would have written for the
    /// same row. Closing this makes ingest and rebuild agree; it does not make a
    /// PDF's prose reachable. Text extraction is the `document.parse` facade's job,
    /// and its output reaches a Space through [`Self::ingest_document`].
    ///
    /// # Why the transaction runs on the blocking pool
    ///
    /// It is the **fourth** `SpaceStore` write path that can now reach
    /// [`build_graph_for_chunks`], and it joins its three siblings on
    /// [`tokio::task::spawn_blocking`] for the same reason. "It is only one chunk" is
    /// true but is not a bound: the descriptor is never split by [`chunk_text`], and
    /// `title` is caller-supplied, so this method validates title and MIME byte caps
    /// before writing the blob or embedding the descriptor. The extractor also caps
    /// term bytes/count, bounding the descriptor's graph fan-out.
    pub async fn create_file(
        &self,
        space_id: &str,
        title: &str,
        bytes: &[u8],
        mime: &str,
        tenancy: &DocOwner,
    ) -> Result<String> {
        validate_document_metadata(title, Some(mime))?;
        let byte_size = bytes.len() as i64;

        // A file has no editable markdown, but a short descriptor keeps it findable
        // in RAG (title + mime). Embed it like a tiny page.
        let descriptor = format!("{title}\n{mime}");
        let emb = self.embedder_snapshot().await;
        let model_id = emb.model_id().to_string();
        let dims = emb.dims();
        let vector = emb.embed(&descriptor).await?;

        let document_id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        // Same ownership shape as `ingest_document`: the guard is acquired HERE (so
        // callers queue on the async mutex, not on a blocking-pool thread) and moved
        // into the closure, which releases it when the transaction ends.
        let space_id = space_id.to_owned();
        let title = title.to_owned();
        let mime = mime.to_owned();
        let tenancy = tenancy.clone();
        let blob_root = self.blob_root.clone();
        let blob_cipher = self.seal.keys.blob_cipher.clone();
        let blob_bytes = bytes.to_vec();
        self.ensure_writable()?;
        let guard = self.conn.clone().lock_owned().await;
        tokio::task::spawn_blocking(move || {
            Self::create_file_blocking(
                guard,
                &document_id,
                &space_id,
                &title,
                &mime,
                &blob_root,
                &blob_cipher,
                &blob_bytes,
                byte_size,
                &descriptor,
                vector,
                now,
                &model_id,
                dims,
                &tenancy,
            )
        })
        .await
        .context("file insert task panicked")?
    }

    /// Put source bytes in the content-addressed blob store for a conversion job.
    ///
    /// No document row is created. The caller schedules this synchronous disk write
    /// on a blocking thread, then passes the returned address to Core's
    /// `document.parse` facade. Content addressing makes retries idempotent and lets
    /// parser sidecars read the same allowlisted blob path as ordinary Space files.
    pub fn stage_import_blob(&self, bytes: &[u8]) -> Result<String> {
        self.ensure_writable()?;
        seal::write_blob(&self.blob_root, &self.seal.keys.blob_cipher, bytes)
    }

    /// Create the durable history row before an import worker is spawned.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_import_record(
        &self,
        space_id: &str,
        source_type: &str,
        source_name: &str,
        source_format: &str,
        destination_kind: &str,
        byte_size: i64,
    ) -> Result<SpaceImportRecord> {
        let id = format!("import_{}", uuid::Uuid::new_v4().simple());
        let now = now_millis();
        let conn = self.conn.lock().await;
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM spaces WHERE id = ?1)",
            params![space_id],
            |row| row.get(0),
        )?;
        if !exists {
            anyhow::bail!("space '{space_id}' not found");
        }
        conn.execute(
            "INSERT INTO space_imports
                (id, space_id, source_type, source_name, source_format,
                 destination_kind, status, result_documents, item_count,
                 byte_size, created_at, updated_at)
             VALUES (?1, ?2, ?3, ryu_seal('space_imports.source_name', ?1, ?4), ?5, ?6,
                     'pending', ryu_seal('space_imports.result_documents', ?1, '[]'), 0, ?7,
                     ?8, ?8)",
            params![
                id,
                space_id,
                source_type,
                source_name,
                source_format,
                destination_kind,
                byte_size,
                now,
            ],
        )
        .context("creating space import record")?;
        Ok(SpaceImportRecord {
            id,
            space_id: space_id.to_owned(),
            source_type: source_type.to_owned(),
            source_name: source_name.to_owned(),
            source_format: source_format.to_owned(),
            destination_kind: destination_kind.to_owned(),
            status: "pending".to_owned(),
            result_documents: Vec::new(),
            item_count: 0,
            byte_size,
            message: None,
            created_at: now,
            updated_at: now,
            completed_at: None,
        })
    }

    /// Mark a queued import as owned by a live worker.
    pub async fn start_import(&self, import_id: &str) -> Result<()> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        let claimed = conn
            .execute(
                "UPDATE space_imports SET status = 'running', updated_at = ?1
             WHERE id = ?2 AND status = 'pending'",
                params![now, import_id],
            )
            .context("starting space import")?;
        if claimed != 1 {
            anyhow::bail!("import '{import_id}' is not pending");
        }
        Ok(())
    }

    /// Finish an import and atomically publish all result documents to history.
    pub async fn complete_import(
        &self,
        import_id: &str,
        destination_kind: &str,
        documents: &[SpaceImportResultDocument],
        item_count: i64,
        message: Option<&str>,
    ) -> Result<()> {
        let now = now_millis();
        let encoded = serde_json::to_string(documents).context("encoding import results")?;
        let conn = self.conn.lock().await;
        let completed = conn
            .execute(
                "UPDATE space_imports
             SET status = 'completed', destination_kind = ?1,
                 result_documents = ryu_seal('space_imports.result_documents', id, ?2),
                 item_count = ?3, message = ryu_seal('space_imports.message', id, ?4),
                 updated_at = ?5, completed_at = ?5
             WHERE id = ?6 AND status = 'running'",
                params![
                    destination_kind,
                    encoded,
                    item_count.max(0),
                    message,
                    now,
                    import_id,
                ],
            )
            .context("completing space import")?;
        if completed != 1 {
            anyhow::bail!("import '{import_id}' is not running");
        }
        Ok(())
    }

    /// Record a terminal import failure without erasing its provenance.
    pub async fn fail_import(&self, import_id: &str, message: &str) -> Result<()> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        let failed = conn
            .execute(
                "UPDATE space_imports
             SET status = 'failed', message = ryu_seal('space_imports.message', id, ?1),
                 updated_at = ?2, completed_at = ?2
             WHERE id = ?3 AND status IN ('pending', 'running')",
                params![message, now, import_id],
            )
            .context("failing space import")?;
        if failed != 1 {
            anyhow::bail!("import '{import_id}' is not pending or running");
        }
        Ok(())
    }

    /// List a Space's newest imports. Authorization is enforced against the parent
    /// Space by the HTTP layer, so the store only applies the parent id and a cap.
    pub async fn list_imports(
        &self,
        space_id: &str,
        limit: usize,
    ) -> Result<Vec<SpaceImportRecord>> {
        let conn = self.conn.lock().await;
        let now = now_millis();
        conn.execute(
            "UPDATE space_imports
             SET status = 'failed',
                 message = ryu_seal('space_imports.message', id,
                     'Core restarted before this import finished'),
                 updated_at = ?1, completed_at = ?1
             WHERE space_id = ?2 AND status IN ('pending', 'running') AND updated_at < ?3",
            params![now, space_id, now - 10 * 60 * 1000],
        )
        .context("expiring abandoned space imports")?;
        let mut stmt = conn.prepare(
            "SELECT id, space_id, source_type,
                    ryu_open_soft('space_imports.source_name', id, source_name), source_format,
                    destination_kind, status,
                    ryu_open_soft('space_imports.result_documents', id, result_documents),
                    item_count, byte_size, ryu_open_soft('space_imports.message', id, message),
                    created_at, updated_at, completed_at
             FROM space_imports
             WHERE space_id = ?1
             ORDER BY created_at DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![space_id, limit.clamp(1, 200) as i64], |row| {
            let encoded: Option<String> = row.get(7)?;
            let result_documents = encoded
                .and_then(|encoded| serde_json::from_str(&encoded).ok())
                .unwrap_or_default();
            let Some(source_name) = row.get::<_, Option<String>>(3)? else {
                return Ok(None);
            };
            Ok(Some(SpaceImportRecord {
                id: row.get(0)?,
                space_id: row.get(1)?,
                source_type: row.get(2)?,
                source_name,
                source_format: row.get(4)?,
                destination_kind: row.get(5)?,
                status: row.get(6)?,
                result_documents,
                item_count: row.get(8)?,
                byte_size: row.get(9)?,
                message: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
                completed_at: row.get(13)?,
            }))
        })?;
        let rows = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("listing space imports")?;
        Ok(rows.into_iter().flatten().collect())
    }

    /// The blocking body of [`SpaceStore::create_file`]. Split out only so the
    /// `spawn_blocking` closure stays a one-liner; the reasoning lives on the public
    /// method. Takes the guard by value so the connection is released exactly when
    /// the transaction ends, on the blocking thread.
    #[allow(clippy::too_many_arguments)]
    fn create_file_blocking(
        mut guard: tokio::sync::OwnedMutexGuard<Connection>,
        document_id: &str,
        space_id: &str,
        title: &str,
        mime: &str,
        blob_root: &Path,
        blob_cipher: &ryu_crypto::ContentCipher,
        bytes: &[u8],
        byte_size: i64,
        descriptor: &str,
        vector: Vec<f32>,
        now: i64,
        model_id: &str,
        dims: usize,
        tenancy: &DocOwner,
    ) -> Result<String> {
        let conn = &mut *guard;
        let tx = conn.transaction().context("starting file insert")?;

        // Verify the Space exists and read its retrieval mode — one query, inside the
        // transaction, so the mode cannot change between the check and the write. The
        // "not found" wording is load-bearing: `POST /api/spaces/:id/files` maps it to
        // a 404 by substring.
        let mode_str: Option<String> = tx
            .query_row(
                "SELECT retrieval_mode FROM spaces WHERE id = ?1",
                params![space_id],
                |row| row.get(0),
            )
            .optional()
            .context("verifying space exists")?;
        let mode_str = mode_str.ok_or_else(|| anyhow::anyhow!("space '{space_id}' not found"))?;
        let mode = RetrievalMode::from_str(&mode_str);

        ensure_file_quota(&tx, byte_size, tenancy, None)?;
        // The transaction and mutex serialize quota decisions before any new
        // content-addressed bytes are persisted. A rejected upload writes none.
        let sha = seal::write_blob(blob_root, blob_cipher, bytes)?;

        upsert_document_row(
            &tx,
            document_id,
            space_id,
            title,
            now,
            descriptor,
            "file",
            None,
            Some(mime),
            Some(&sha),
            Some(byte_size),
            tenancy,
        )?;
        // Store the single descriptor chunk + its vector so the file is retrievable,
        // and (in graph mode) its entity rows so graph traversal can reach it too.
        insert_chunks(
            &tx,
            document_id,
            space_id,
            &[EmbeddedChunk {
                content: descriptor.to_owned(),
                embedding: vector,
                metadata: None,
            }],
            now,
            model_id,
            dims,
            mode,
        )?;
        tx.execute(
            "UPDATE spaces SET updated_at = ?1 WHERE id = ?2",
            params![now, space_id],
        )
        .context("bumping space updated_at")?;
        tx.commit().context("committing file insert")?;
        Ok(document_id.to_owned())
    }

    /// Replace a file document's bytes and reset its searchable content to the new
    /// `{title}\n{mime}` descriptor in one transaction.
    ///
    /// The content-addressed blob is written only after the replacement quota
    /// passes inside the database transaction. The row pointer, MIME, byte size,
    /// descriptor and chunk/vector/graph rows then move together. Core may
    /// replace the descriptor chunks again after its document parser finishes.
    pub async fn replace_file_blob(
        &self,
        doc_id: &str,
        bytes: &[u8],
        mime: &str,
    ) -> Result<FileMeta> {
        let byte_size = bytes.len() as i64;

        // Resolve the title before embedding, then verify the same row again inside
        // the write transaction. A concurrent delete/update therefore fails cleanly
        // instead of creating a detached chunk set.
        let current = self
            .get_file_meta(doc_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("file document '{doc_id}' not found"))?;
        let descriptor = format!("{}\n{mime}", current.title);
        let emb = self.embedder_snapshot().await;
        let model_id = emb.model_id().to_string();
        let dims = emb.dims();
        let vector = emb.embed(&descriptor).await?;

        let doc_id = doc_id.to_owned();
        let mime = mime.to_owned();
        let title = current.title;
        let now = now_millis();
        let blob_root = self.blob_root.clone();
        let blob_cipher = self.seal.keys.blob_cipher.clone();
        let blob_bytes = bytes.to_vec();
        self.ensure_writable()?;
        let mut guard = self.conn.clone().lock_owned().await;
        tokio::task::spawn_blocking(move || {
            let conn = &mut *guard;
            let tx = conn
                .transaction()
                .context("starting file blob replacement")?;
            let row: Option<(
                String,
                String,
                String,
                i64,
                String,
                Option<String>,
                Option<String>,
                Option<i64>,
            )> = tx
                .query_row(
                    "SELECT d.space_id, d.kind, s.retrieval_mode, d.created_at,
                            ryu_open('documents.title', d.id, d.title),
                            d.owner_user_id, d.org_id, d.byte_size
                     FROM documents d JOIN spaces s ON s.id = d.space_id
                     WHERE d.id = ?1",
                    params![doc_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                            row.get(7)?,
                        ))
                    },
                )
                .optional()
                .context("resolving file for blob replacement")?;
            let (space_id, kind, mode_str, created_at, current_title, owner_user_id, org_id, _) =
                row.ok_or_else(|| anyhow::anyhow!("document '{doc_id}' not found"))?;
            if kind != "file" {
                anyhow::bail!("document '{doc_id}' is kind '{kind}', not 'file'");
            }
            if current_title != title {
                anyhow::bail!(
                    "file document '{doc_id}' changed while its replacement was prepared"
                );
            }
            let tenancy = DocOwner::owned(owner_user_id.as_deref(), org_id.as_deref());
            ensure_file_quota(&tx, byte_size, &tenancy, Some(&doc_id))?;
            let sha = seal::write_blob(&blob_root, &blob_cipher, &blob_bytes)?;

            tx.execute(
                "DELETE FROM chunk_embeddings WHERE chunk_id IN
                 (SELECT id FROM chunks WHERE document_id = ?1)",
                params![doc_id],
            )
            .context("deleting old file chunk vectors")?;
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
                .context("deleting old file chunks")?;

            tx.execute(
                "UPDATE documents
                 SET mime = ?1, blob_sha256 = ?2, byte_size = ?3,
                     source = ryu_seal('documents.source', id, ?4), updated_at = ?5
                 WHERE id = ?6",
                params![mime, sha, byte_size, descriptor, now, doc_id],
            )
            .context("updating file blob pointer")?;
            insert_chunks(
                &tx,
                &doc_id,
                &space_id,
                &[EmbeddedChunk {
                    content: descriptor,
                    embedding: vector,
                    metadata: None,
                }],
                now,
                &model_id,
                dims,
                RetrievalMode::from_str(&mode_str),
            )?;
            tx.execute(
                "UPDATE spaces SET updated_at = ?1 WHERE id = ?2",
                params![now, space_id],
            )
            .context("bumping space updated_at")?;
            tx.commit().context("committing file blob replacement")?;

            Ok(FileMeta {
                id: doc_id,
                space_id,
                title,
                mime,
                sha256: sha,
                byte_size,
                created_at,
            })
        })
        .await
        .context("file blob replacement task panicked")?
    }

    /// Replace a **file** document's chunk set from extracted text, leaving every
    /// other column on the row alone. Returns the number of chunks written.
    ///
    /// # Why this exists rather than reusing `update_document`
    ///
    /// [`Self::create_file`] stores exactly one chunk — the `{title}\n{mime}`
    /// descriptor — so a PDF was findable by its *filename* and by nothing else. The
    /// bytes are extracted Core-side by the `document.parse` facade (which is
    /// apps/core code and must stay there: this crate has zero dependency on
    /// apps/core), and the result has to land as chunks on the document that already
    /// exists. [`Self::update_document`] is the obvious-looking seam and is the wrong
    /// one, for three reasons that are all invisible until they have already
    /// happened:
    ///
    /// 1. It writes `documents.source`. For `kind = 'file'` that column is the
    ///    descriptor, [`Self::create_file`] is its only writer, and `get_document`
    ///    hands it to clients. Repointing it at 400 KB of extracted markdown changes
    ///    what every file document returns, irreversibly — the descriptor is not
    ///    recoverable afterwards.
    /// 2. It runs [`store_doc_links`] over the new source, so `[[…]]`-shaped text
    ///    inside an *uploaded PDF* would mint wiki links, then unresolve and
    ///    re-resolve inbound links as if the page had been renamed.
    /// 3. It has nowhere to express "these chunks came from extraction" versus
    ///    "these chunks are the descriptor" — the distinction the caller's index
    ///    status is built on.
    ///
    /// So this is deliberately the *middle third* of [`Self::update_document_blocking`]
    /// and nothing else: drop the old chunk/vector/graph rows, insert the new ones,
    /// bump the Space. Title, `source`, and the link graph are untouched.
    ///
    /// # `kind = 'file'` is enforced, not assumed
    ///
    /// Skipping the `source` write is only *safe* for a file. For a page, `source`
    /// IS the text the chunks were derived from, and rewriting chunks without it
    /// would leave the row silently desynchronised from its own index — the exact
    /// class of bug this method was written to close. A non-file id is an error.
    ///
    /// # Chunking is this crate's, on purpose
    ///
    /// `text` arrives whole and is split here by [`chunk_text`], the same function
    /// [`Self::ingest_document`] and [`Self::update_document`] use. Chunking Core-side
    /// and passing a `&[String]` would put a second definition of "what a chunk is"
    /// one crate boundary away from the first, and the two would drift the moment
    /// [`CHUNK_CHAR_SIZE`] moved. The caller controls only *what text* is indexed
    /// (it prepends the descriptor as its own paragraph so filename retrieval
    /// survives), never *how it is cut*.
    ///
    /// Empty/whitespace `text` is refused rather than accepted: [`chunk_text`] maps
    /// it to a single empty chunk, which would replace a working descriptor chunk
    /// with an unretrievable blank and make the document *less* findable than
    /// before. The caller must keep the descriptor-only state instead.
    ///
    /// Runs the transaction on [`tokio::task::spawn_blocking`] with the guard taken
    /// outside the closure, for the same reasons — and with the same three caveats —
    /// as [`Self::ingest_document`]: in graph mode this reaches
    /// [`build_graph_for_chunks`], whose cost is quadratic in entities per chunk, and
    /// an extracted document is exactly the large input that makes that bite.
    pub async fn replace_file_chunks(&self, doc_id: &str, text: &str) -> Result<usize> {
        if text.trim().is_empty() {
            anyhow::bail!("refusing to replace file chunks with empty text");
        }
        let chunks = self.split_for_document(doc_id, text).await?;

        // Embed outside the lock — the embedder may do network I/O.
        let emb = self.embedder_snapshot().await;
        let model_id = emb.model_id().to_string();
        let dims = emb.dims();
        let embedded = embed_text_chunks(&emb, chunks).await?;

        let written = embedded.len();
        let doc_id = doc_id.to_owned();
        let now = now_millis();
        let guard = self.conn.clone().lock_owned().await;
        tokio::task::spawn_blocking(move || {
            Self::replace_file_chunks_blocking(guard, &doc_id, now, &model_id, dims, &embedded)
        })
        .await
        .context("file re-chunk task panicked")??;
        Ok(written)
    }

    /// The blocking body of [`SpaceStore::replace_file_chunks`]. Split out only so the
    /// `spawn_blocking` closure stays a one-liner; the reasoning lives on the public
    /// method. Takes the guard by value so the connection is released exactly when the
    /// transaction ends, on the blocking thread.
    fn replace_file_chunks_blocking(
        mut guard: tokio::sync::OwnedMutexGuard<Connection>,
        doc_id: &str,
        now: i64,
        model_id: &str,
        dims: usize,
        embedded: &[EmbeddedChunk],
    ) -> Result<()> {
        let conn = &mut *guard;
        let tx = conn.transaction().context("starting file re-chunk")?;

        // Resolve the document's space + kind + the Space's retrieval mode in ONE
        // query inside the transaction, so the mode cannot change between the read
        // and the write — the same guarantee `create_file_blocking` relies on, and
        // the reason a file added to a graph-mode Space gets graph rows.
        let row: Option<(String, String, String)> = tx
            .query_row(
                "SELECT d.space_id, d.kind, s.retrieval_mode
                 FROM documents d JOIN spaces s ON s.id = d.space_id
                 WHERE d.id = ?1",
                params![doc_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .context("resolving document for re-chunk")?;
        let (space_id, kind, mode_str) =
            row.ok_or_else(|| anyhow::anyhow!("document '{doc_id}' not found"))?;
        if kind != "file" {
            anyhow::bail!("document '{doc_id}' is kind '{kind}', not 'file'");
        }
        let mode = RetrievalMode::from_str(&mode_str);

        // Drop the old chunk set — vectors and graph rows first, since both are keyed
        // off the chunk rows this is about to delete.
        tx.execute(
            "DELETE FROM chunk_embeddings WHERE chunk_id IN
                 (SELECT id FROM chunks WHERE document_id = ?1)",
            params![doc_id],
        )
        .context("deleting old file chunk vectors")?;
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
            .context("deleting old file chunks")?;

        insert_chunks(&tx, doc_id, &space_id, embedded, now, model_id, dims, mode)?;

        // The row's own `updated_at` moves (its index changed) but `source`, `title`
        // and the link graph deliberately do NOT — see the method doc.
        tx.execute(
            "UPDATE documents SET updated_at = ?1 WHERE id = ?2",
            params![now, doc_id],
        )
        .context("bumping document updated_at")?;
        tx.execute(
            "UPDATE spaces SET updated_at = ?1 WHERE id = ?2",
            params![now, space_id],
        )
        .context("bumping space updated_at")?;
        tx.commit().context("committing file re-chunk")?;
        Ok(())
    }

    /// Fetch a file document's blob metadata (mime, sha256, size). Returns
    /// `Ok(None)` when the id is not a `kind = 'file'` document.
    pub async fn get_file_meta(&self, doc_id: &str) -> Result<Option<FileMeta>> {
        let conn = self.conn.lock().await;
        let meta = conn
            .query_row(
                "SELECT id, space_id, ryu_open('documents.title', id, title),
                        COALESCE(mime, 'application/octet-stream'),
                        blob_sha256, COALESCE(byte_size, 0), created_at
                 FROM documents WHERE id = ?1 AND kind = 'file'",
                params![doc_id],
                |row| {
                    let sha: Option<String> = row.get(4)?;
                    Ok(FileMeta {
                        id: row.get(0)?,
                        space_id: row.get(1)?,
                        title: row.get(2)?,
                        mime: row.get(3)?,
                        sha256: sha.unwrap_or_default(),
                        byte_size: row.get(5)?,
                        created_at: row.get(6)?,
                    })
                },
            )
            .optional()
            .context("reading file meta")?;
        Ok(meta)
    }

    /// Read a file document's bytes (mime + blob). Returns `Ok(None)` when the doc
    /// is not a file or its blob is missing from the store.
    pub async fn read_file_blob(&self, doc_id: &str) -> Result<Option<(String, Vec<u8>)>> {
        let Some(meta) = self.get_file_meta(doc_id).await? else {
            return Ok(None);
        };
        if meta.sha256.is_empty() {
            return Ok(None);
        }
        let root = self.blob_root.clone();
        let cipher = self.seal.keys.blob_cipher.clone();
        let sha = meta.sha256.clone();
        let read = tokio::task::spawn_blocking(move || seal::read_blob(&root, &cipher, &sha))
            .await
            .context("blob read task panicked")??;
        match read {
            Some(bytes) => Ok(Some((meta.mime, bytes))),
            None => Ok(None),
        }
    }

    /// Set the native visibility of a document. The server layer performs the
    /// caller/resource authorization; this store method owns the schema update so
    /// every document-access writer uses the same validated values.
    pub async fn set_document_access(
        &self,
        doc_id: &str,
        visibility: &str,
        team_id: Option<&str>,
    ) -> Result<bool> {
        let visibility = visibility.trim();
        if !matches!(visibility, "private" | "org" | "team") {
            anyhow::bail!(
                "invalid document visibility {visibility:?}: expected private, org, or team"
            );
        }
        let team_id = team_id.map(str::trim).filter(|id| !id.is_empty());
        if visibility == "team" && team_id.is_none() {
            anyhow::bail!("team visibility requires a team_id");
        }
        let now = now_millis();
        let conn = self.conn.lock().await;
        let updated = conn
            .execute(
                "UPDATE documents
                 SET visibility = ?1, team_id = ?2, updated_at = ?3
                 WHERE id = ?4",
                params![visibility, team_id, now, doc_id],
            )
            .context("updating document access")?;
        Ok(updated > 0)
    }

    /// Fetch a single document with its full markdown source.
    /// Load the tenancy quartet (owner / org / visibility / team) for a document,
    /// for the realtime WS gateway's access decision. Returns `Ok(None)` when the
    /// document row does not exist. These columns are plaintext additive Phase 0
    /// tenancy columns, so a raw `SELECT` compares correctly against a verified
    /// caller's id.
    /// The space a document ACTUALLY belongs to.
    ///
    /// Exists so an authorization gate never trusts a space id supplied in the
    /// URL. `/api/spaces/:id/documents/:doc_id` lets a caller name ANY space
    /// alongside a document, so resolving a per-resource ACL against the URL's id
    /// would let someone bypass a deny on the document's real space by naming a
    /// different space they can read. Returns `None` when the document does not
    /// exist, which callers must treat as not-found rather than as permitted.
    pub async fn document_space_id(&self, doc_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT space_id FROM documents WHERE id = ?1",
            params![doc_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .context("reading a document's parent space")
    }

    pub async fn get_access_meta(&self, doc_id: &str) -> Result<Option<DocAccessMeta>> {
        let conn = self.conn.lock().await;
        let meta = conn
            .query_row(
                "SELECT d.owner_user_id, d.org_id,
                        CASE
                            WHEN s.system = 1 THEN 'org'
                            WHEN s.visibility IN ('org', 'team') THEN s.visibility
                            ELSE d.visibility
                        END,
                        CASE
                            WHEN s.system = 1 OR s.visibility IN ('org', 'team')
                                THEN s.team_id
                            ELSE d.team_id
                        END
                 FROM documents d
                 JOIN spaces s ON s.id = d.space_id
                 WHERE d.id = ?1",
                params![doc_id],
                |row| {
                    Ok(DocAccessMeta {
                        owner_user_id: row.get(0)?,
                        org_id: row.get(1)?,
                        // NOT NULL DEFAULT 'private' in the schema, so always present.
                        visibility: row.get(2)?,
                        team_id: row.get(3)?,
                    })
                },
            )
            .optional()
            .context("reading document access metadata")?;
        Ok(meta)
    }

    /// Load a Space's tenancy quartet (owner / org / visibility / team) plus its
    /// `system` flag, for the by-id `delete_space` ACL gate. Twin of
    /// [`Self::get_access_meta`]. Returns `Ok(None)` when the space row does not
    /// exist. A system space has `system = 1` and NULL owner, which the shared
    /// `resource_access` gate reads as unattributable → denied on a bound node
    /// (system spaces are node singletons, not user-deletable via HTTP).
    pub async fn space_access_meta(&self, space_id: &str) -> Result<Option<SpaceAccessMeta>> {
        let conn = self.conn.lock().await;
        let meta = conn
            .query_row(
                "SELECT owner_user_id, org_id, visibility, team_id, system
                 FROM spaces WHERE id = ?1",
                params![space_id],
                |row| {
                    Ok(SpaceAccessMeta {
                        owner_user_id: row.get(0)?,
                        org_id: row.get(1)?,
                        // NOT NULL DEFAULT 'private' in the schema, so always present.
                        visibility: row.get(2)?,
                        team_id: row.get(3)?,
                        system: row.get::<_, i64>(4)? != 0,
                    })
                },
            )
            .optional()
            .context("reading space access metadata")?;
        Ok(meta)
    }

    pub async fn get_document(&self, doc_id: &str) -> Result<Option<DocumentContent>> {
        let conn = self.conn.lock().await;
        let doc = conn
            .query_row(
                "SELECT d.id, d.space_id, ryu_open('documents.title', d.id, d.title),
                        ryu_open('documents.source', d.id, d.source), d.created_at, d.updated_at,
                        (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id),
                        d.kind, d.parent_id, d.icon, d.revision
                 FROM documents d WHERE d.id = ?1",
                params![doc_id],
                |row| {
                    let icon_raw: Option<String> = row.get(9)?;
                    Ok(DocumentContent {
                        id: row.get(0)?,
                        space_id: row.get(1)?,
                        title: row.get(2)?,
                        source: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                        revision: row.get(10)?,
                        chunk_count: row.get(6)?,
                        kind: row.get(7)?,
                        parent_id: row.get(8)?,
                        icon: icon_raw.and_then(|s| serde_json::from_str(&s).ok()),
                    })
                },
            )
            .optional()
            .context("reading document")?;
        Ok(doc)
    }

    /// Rename an ordinary Space without changing its documents or retrieval
    /// index. System Spaces are node-owned filing drawers and cannot be renamed.
    /// Returns `false` when no Space row matches.
    pub async fn rename_space(&self, space_id: &str, name: &str) -> Result<bool> {
        let name = name.trim();
        if name.is_empty() {
            anyhow::bail!("space name is required");
        }
        let now = now_millis();
        let conn = self.conn.lock().await;
        let is_system: Option<i64> = conn
            .query_row(
                "SELECT system FROM spaces WHERE id = ?1",
                params![space_id],
                |row| row.get(0),
            )
            .optional()
            .context("checking system flag before rename")?;
        if is_system == Some(1) {
            anyhow::bail!("space '{space_id}' is a system space and cannot be renamed");
        }
        let updated = conn
            .execute(
                "UPDATE spaces SET name = ryu_seal('spaces.name', id, ?1),
                     name_bi = ryu_bi('spaces.name', ?1), updated_at = ?2 WHERE id = ?3",
                params![name, now, space_id],
            )
            .context("renaming space")?;
        Ok(updated > 0)
    }

    /// Set (or clear) a Space's Notion-style glyph. Does not touch documents.
    /// Returns `false` when no such space exists.
    pub async fn set_space_icon(
        &self,
        space_id: &str,
        icon: Option<&serde_json::Value>,
    ) -> Result<bool> {
        let now = now_millis();
        let icon_str = match icon {
            Some(v) => Some(serde_json::to_string(v).context("serializing space icon")?),
            None => None,
        };
        let conn = self.conn.lock().await;
        let n = conn
            .execute(
                "UPDATE spaces SET icon = ?1, updated_at = ?2 WHERE id = ?3",
                params![icon_str, now, space_id],
            )
            .context("updating space icon")?;
        Ok(n > 0)
    }

    /// Set a Space's sharing visibility. Pages in the Space inherit this scope
    /// through the document visibility predicates and by-id access metadata.
    /// System Spaces remain node-owned and cannot be changed.
    pub async fn set_visibility(
        &self,
        space_id: &str,
        visibility: &str,
        team_id: Option<&str>,
        admin_authorized: bool,
    ) -> Result<bool> {
        if !matches!(visibility, "private" | "org" | "team") {
            anyhow::bail!(
                "unknown visibility {visibility:?}: expected \"private\", \"org\", or \"team\""
            );
        }
        if visibility == "team" && team_id.is_none() {
            anyhow::bail!("team visibility requires team_id");
        }
        let now = now_millis();
        let conn = self.conn.lock().await;
        let system: Option<i64> = conn
            .query_row(
                "SELECT system FROM spaces WHERE id = ?1",
                params![space_id],
                |row| row.get(0),
            )
            .optional()
            .context("checking system flag before changing visibility")?;
        if system == Some(1) {
            anyhow::bail!("system spaces cannot change visibility");
        }
        if visibility == "private" {
            let current: Option<String> = conn
                .query_row(
                    "SELECT visibility FROM spaces WHERE id = ?1",
                    params![space_id],
                    |row| row.get(0),
                )
                .optional()
                .context("reading current space visibility")?;
            if matches!(current.as_deref(), Some("org" | "team")) && !admin_authorized {
                anyhow::bail!("only organization admins can make shared spaces private");
            }
        }
        let updated = conn
            .execute(
                "UPDATE spaces SET visibility = ?1, team_id = ?2, updated_at = ?3 WHERE id = ?4",
                params![visibility, team_id, now, space_id],
            )
            .context("updating space visibility")?;
        Ok(updated > 0)
    }

    /// Change a Space's [`RetrievalMode`], **rebuilding its entity graph so the new
    /// mode actually takes effect**. Returns `None` when no such space exists.
    ///
    /// Why this is not a one-line `UPDATE`: graph extraction is gated on the mode
    /// *at ingest time* (`insert_chunks`), so a Space ingested in `Vector` mode has
    /// zero `graph_nodes`/`graph_edges` rows. Flipping only the column would point
    /// `search_ext` at `graph_search`, which seeds its BFS from `graph_nodes` — and
    /// an empty graph returns an empty result set. The Space would answer *nothing*
    /// while reporting `retrieval_mode: "graph"`. So:
    ///
    /// - **→ `Graph`**: drop this space's graph rows and rebuild them from every
    ///   chunk currently on disk, via the shared [`build_graph_for_chunks`].
    ///   Re-asserting `Graph` on a Space that is already `Graph` therefore doubles
    ///   as a graph *repair*.
    /// - **→ `Vector`**: drop this space's graph rows. Nothing maintains them in
    ///   vector mode, so keeping them would leave a graph that silently rots as
    ///   documents change, and a later switch back would either double-insert or
    ///   serve stale entities. The switch back rebuilds from scratch, so dropping
    ///   loses nothing.
    ///
    /// The column write and the graph rebuild share ONE transaction: a crash
    /// between them would leave `retrieval_mode = 'graph'` over an empty graph,
    /// which is the precise failure this method exists to prevent.
    ///
    /// Chunk *vectors* are untouched in both directions — switching modes never
    /// re-embeds, so it is safe to toggle back and forth.
    ///
    /// # What this costs, and what running it off the async worker does and does
    /// # not buy
    ///
    /// The rebuild is **not** cheap, and this used to say it was ("pure SQL +
    /// string work and runs inline") on the strength of "no model call". Measured on
    /// an **on-disk** db, which is what a real Space is: a 1,566-chunk Space of
    /// English prose writes 5.1M `graph_edges` rows and takes **46–87 s** across two
    /// runs — 392 chunks takes ~10 s, and per-chunk cost *rises* with size. See
    /// [`build_graph_for_chunks`] for the full table, the reproduction command, and
    /// the `O(chunks × entities²)` shape. The unbounded dimension is the chunk
    /// count, which is whatever the Space happens to hold, so one UI click on a
    /// large Space is **minutes** of SQLite work.
    ///
    /// The direct store method still runs its all-or-nothing transaction on
    /// [`tokio::task::spawn_blocking`]. The background HTTP path uses staged,
    /// 32-chunk transactions instead, then atomically swaps the staged graph after
    /// validating that the source chunks did not change.
    ///
    /// - **Fixed:** the tokio worker thread is no longer occupied for the duration.
    ///   Before, a large rebuild parked a runtime worker in a minutes-long
    ///   `rusqlite` call with no yield point, so unrelated Core requests scheduled
    ///   onto that worker stalled behind a Spaces button.
    /// - **Background path fixed:** the connection mutex is released between
    ///   staging batches, so unrelated calls can run between bounded bursts. The
    ///   mode and live graph remain unchanged until the final atomic swap.
    /// - **The direct store method remains synchronous.** The HTTP layer uses
    ///   [`Self::start_retrieval_mode_rebuild`] instead: it returns a job id,
    ///   exposes progress, and cooperatively cancels at chunk boundaries. A
    ///   cancelled job returns before commit, so the transaction rolls back.
    ///
    /// The background path is cancellable at batch boundaries and rejects source
    /// changes before the swap. Its staging commits are not user-visible, so a
    /// crash or cancellation leaves the previous mode and graph intact.
    pub async fn set_retrieval_mode(
        &self,
        space_id: &str,
        mode: RetrievalMode,
    ) -> Result<Option<RetrievalModeChange>> {
        // Direct and background changes share one arbitration domain. Without this
        // flag a staged Graph rebuild could overwrite a later direct Vector change
        // during finalization.
        let _direct_guard = {
            let mut state = self
                .retrieval_mode
                .lock()
                .expect("retrieval-mode state mutex poisoned");
            let background_active = state
                .statuses
                .values()
                .any(|status| matches!(status.state.as_str(), "running" | "cancelling"));
            if state.direct_active || background_active {
                return Err(RetrievalModeRebuildConflict.into());
            }
            state.direct_active = true;
            DirectRetrievalModeGuard {
                state: self.retrieval_mode.clone(),
            }
        };
        // `spawn_blocking` demands `'static`, so the borrowed id is cloned and the
        // guard is taken as an *owned* one. Acquiring the lock here rather than
        // inside the closure keeps the wait itself asynchronous: callers queue on
        // the tokio mutex, they do not occupy a blocking-pool thread while waiting.
        let space_id = space_id.to_owned();
        let mut guard = self.conn.clone().lock_owned().await;
        tokio::task::spawn_blocking(move || {
            Self::set_retrieval_mode_blocking(&mut guard, &space_id, mode)
        })
        .await
        .context("retrieval-mode rebuild task panicked")?
    }

    /// The blocking body of [`SpaceStore::set_retrieval_mode`]. Split out only so
    /// the `spawn_blocking` closure stays a one-liner; all the reasoning about
    /// *why* it is shaped this way lives on the public method.
    fn set_retrieval_mode_blocking(
        conn: &mut Connection,
        space_id: &str,
        mode: RetrievalMode,
    ) -> Result<Option<RetrievalModeChange>> {
        Self::set_retrieval_mode_blocking_with_control(
            conn,
            space_id,
            mode,
            &|| false,
            &mut |_processed, _nodes, _edges, _total| {},
        )
    }

    fn set_retrieval_mode_chunked_with_control(
        store: &Self,
        space_id: &str,
        mode: RetrievalMode,
        should_cancel: &dyn Fn() -> bool,
        prepare_finalization: &dyn Fn() -> bool,
        progress: &mut dyn FnMut(usize, usize, usize, usize),
    ) -> Result<Option<RetrievalModeChange>> {
        let (previous, total_chunks) = {
            let conn = store.conn.blocking_lock();
            let previous = conn
                .query_row(
                    "SELECT retrieval_mode FROM spaces WHERE id = ?1",
                    params![space_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .map(|value| RetrievalMode::from_str(&value));
            let Some(previous) = previous else {
                return Ok(None);
            };
            let total = conn.query_row(
                "SELECT COUNT(*) FROM chunks WHERE space_id = ?1",
                params![space_id],
                |row| row.get::<_, i64>(0),
            )? as usize;
            (previous, total)
        };
        progress(
            0,
            0,
            0,
            if mode == RetrievalMode::Graph {
                total_chunks
            } else {
                0
            },
        );
        if mode == RetrievalMode::Vector {
            if !prepare_finalization() {
                return Err(RetrievalModeCancelled.into());
            }
            let mut conn = store.conn.blocking_lock();
            return Self::set_retrieval_mode_blocking_with_control(
                &mut conn,
                space_id,
                mode,
                should_cancel,
                &mut |_p, _n, _e, _t| {},
            );
        }

        {
            let conn = store.conn.blocking_lock();
            create_retrieval_staging(&conn)?;
        }

        let mut fingerprint = Sha256::new();
        let mut last_rowid = 0i64;
        let mut processed = 0usize;
        let mut nodes = 0usize;
        let mut edges = 0usize;
        loop {
            if should_cancel() {
                break;
            }
            let mut conn = store.conn.blocking_lock();
            let rows: Vec<(i64, String, String)> = {
                let mut stmt = conn.prepare(
                    "SELECT rowid, id, COALESCE(ryu_open_soft('chunks.content', id, content), '')
                     FROM chunks
                     WHERE space_id = ?1 AND rowid > ?2 ORDER BY rowid LIMIT ?3",
                )?;
                let rows = stmt
                    .query_map(
                        params![space_id, last_rowid, RETRIEVAL_REBUILD_BATCH_SIZE as i64],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            if rows.is_empty() {
                break;
            }
            for (rowid, id, content) in &rows {
                update_rebuild_fingerprint(&mut fingerprint, *rowid, id, content);
            }
            let pairs: Vec<(&str, &str)> = rows
                .iter()
                .map(|(_, id, content)| (id.as_str(), content.as_str()))
                .collect();
            let tx = conn.transaction()?;
            let (batch_nodes, batch_edges) = build_graph_for_tables(
                &tx,
                "retrieval_rebuild_nodes",
                "retrieval_rebuild_edges",
                space_id,
                &pairs,
                should_cancel,
            )?;
            tx.commit()?;
            processed += rows.len();
            nodes += batch_nodes;
            edges += batch_edges;
            anyhow::ensure!(
                nodes.saturating_add(edges) <= MAX_GRAPH_ROWS_PER_SPACE,
                "graph row budget exceeded; a Space supports at most {MAX_GRAPH_ROWS_PER_SPACE} term and co-occurrence rows"
            );
            last_rowid = rows
                .last()
                .map(|(rowid, _, _)| *rowid)
                .unwrap_or(last_rowid);
            progress(processed, nodes, edges, total_chunks);
        }
        if should_cancel() {
            let conn = store.conn.blocking_lock();
            cleanup_retrieval_staging(&conn)?;
            return Err(RetrievalModeCancelled.into());
        }

        let fingerprint = format!("{:x}", fingerprint.finalize());
        if !prepare_finalization() {
            let conn = store.conn.blocking_lock();
            cleanup_retrieval_staging(&conn)?;
            return Err(RetrievalModeCancelled.into());
        }
        let mut conn = store.conn.blocking_lock();
        let result = finalize_chunked_retrieval_mode(
            &mut conn,
            space_id,
            previous,
            total_chunks,
            processed,
            nodes,
            edges,
            &fingerprint,
            should_cancel,
        );
        cleanup_retrieval_staging(&conn)?;
        result
    }

    /// Start a single crash-consistent retrieval-mode rebuild in the background.
    ///
    /// The worker stages graph rows in bounded transactions and holds the
    /// connection only for each batch. The live mode and graph change only in the
    /// final atomic swap. Cancellation is cooperative at batch boundaries and
    /// therefore never commits a partial user-visible graph.
    pub async fn start_retrieval_mode_rebuild(
        &self,
        space_id: &str,
        mode: RetrievalMode,
    ) -> Result<Option<RetrievalModeJob>> {
        let previous = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT retrieval_mode FROM spaces WHERE id = ?1",
                params![space_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading current retrieval_mode")?
            .map(|value| RetrievalMode::from_str(&value))
        };
        let Some(previous) = previous else {
            return Ok(None);
        };

        let cancel = Arc::new(AtomicBool::new(false));
        let job = RetrievalModeJob {
            job_id: uuid::Uuid::new_v4().simple().to_string(),
            space_id: space_id.to_owned(),
            requested_mode: mode,
        };
        {
            let mut state = self
                .retrieval_mode
                .lock()
                .expect("retrieval-mode state mutex poisoned");
            if state.direct_active {
                return Err(RetrievalModeRebuildConflict.into());
            }
            if let Some(current) = state
                .statuses
                .values()
                .find(|s| matches!(s.state.as_str(), "running" | "cancelling"))
            {
                if current.space_id == space_id && current.requested_mode == mode {
                    return Ok(Some(RetrievalModeJob {
                        job_id: current.job_id.clone(),
                        space_id: current.space_id.clone(),
                        requested_mode: current.requested_mode,
                    }));
                }
                return Err(RetrievalModeRebuildConflict.into());
            }
            state.statuses.insert(
                job.job_id.clone(),
                RetrievalModeJobStatus {
                    job_id: job.job_id.clone(),
                    space_id: job.space_id.clone(),
                    requested_mode: mode,
                    previous_mode: Some(previous),
                    state: "running".to_owned(),
                    total_chunks: 0,
                    processed_chunks: 0,
                    graph_nodes: 0,
                    graph_edges: 0,
                    change: None,
                    error: None,
                },
            );
            state.cancel = Some(cancel.clone());
        }

        let store = self.clone();
        let job_id = job.job_id.clone();
        let space_id = job.space_id.clone();
        tokio::spawn(async move {
            let result = async {
                let worker_store = store.clone();
                let worker_cancel = cancel.clone();
                let worker_job_id = job_id.clone();
                tokio::task::spawn_blocking(move || {
                    let mut progress = |processed, nodes, edges, total| {
                        worker_store.update_retrieval_mode_progress(
                            &worker_job_id,
                            processed,
                            nodes,
                            edges,
                            total,
                        );
                    };
                    let result = Self::set_retrieval_mode_chunked_with_control(
                        &worker_store,
                        &space_id,
                        mode,
                        &|| worker_cancel.load(Ordering::SeqCst),
                        &|| worker_store.begin_retrieval_mode_finalization(&worker_job_id),
                        &mut progress,
                    );
                    if result.is_err() {
                        if let Ok(conn) = worker_store.conn.try_lock() {
                            let _ = cleanup_retrieval_staging(&conn);
                        }
                    }
                    result
                })
                .await
                .context("retrieval-mode rebuild task panicked")?
            }
            .await;
            store.finish_retrieval_mode_job(&job_id, result);
        });
        Ok(Some(job))
    }

    /// Return the requested job for `space_id`, if it is retained.
    pub fn retrieval_mode_status(
        &self,
        space_id: &str,
        job_id: &str,
    ) -> Option<RetrievalModeJobStatus> {
        let state = self
            .retrieval_mode
            .lock()
            .expect("retrieval-mode state mutex poisoned");
        state
            .statuses
            .get(job_id)
            .filter(|status| status.space_id == space_id)
            .cloned()
    }

    /// Request cooperative cancellation. The worker checks this flag between
    /// chunks and exits before commit, so callers never observe a partial graph.
    pub fn cancel_retrieval_mode_rebuild(&self, space_id: &str, job_id: &str) -> bool {
        let mut state = self
            .retrieval_mode
            .lock()
            .expect("retrieval-mode state mutex poisoned");
        if state.finalizing {
            return false;
        }
        let Some(status) = state.statuses.get_mut(job_id) else {
            return false;
        };
        if status.space_id != space_id || status.job_id != job_id {
            return false;
        }
        if status.state == "cancelling" {
            return true;
        }
        if status.state != "running" {
            return false;
        }
        status.state = "cancelling".to_owned();
        if let Some(cancel) = state.cancel.as_ref() {
            cancel.store(true, Ordering::SeqCst);
        }
        true
    }

    fn begin_retrieval_mode_finalization(&self, job_id: &str) -> bool {
        let mut state = self
            .retrieval_mode
            .lock()
            .expect("retrieval-mode state mutex poisoned");
        if state
            .cancel
            .as_ref()
            .is_some_and(|cancel| cancel.load(Ordering::SeqCst))
        {
            return false;
        }
        let Some(_status) = state
            .statuses
            .get_mut(job_id)
            .filter(|status| status.job_id == job_id && status.state == "running")
        else {
            return false;
        };
        state.finalizing = true;
        true
    }

    fn update_retrieval_mode_progress(
        &self,
        job_id: &str,
        processed: usize,
        nodes: usize,
        edges: usize,
        total: usize,
    ) {
        let mut state = self
            .retrieval_mode
            .lock()
            .expect("retrieval-mode state mutex poisoned");
        if let Some(status) = state.statuses.get_mut(job_id) {
            status.processed_chunks = processed;
            status.graph_nodes = nodes;
            status.graph_edges = edges;
            status.total_chunks = total;
        }
    }

    fn finish_retrieval_mode_job(&self, job_id: &str, result: Result<Option<RetrievalModeChange>>) {
        let mut state = self
            .retrieval_mode
            .lock()
            .expect("retrieval-mode state mutex poisoned");
        let Some(status) = state.statuses.get_mut(job_id) else {
            return;
        };
        match result {
            Ok(Some(change)) => {
                status.state = "completed".to_owned();
                status.previous_mode = Some(change.previous);
                status.processed_chunks = change.chunks_scanned;
                status.total_chunks = change.chunks_scanned;
                status.graph_nodes = change.graph_nodes;
                status.graph_edges = change.graph_edges;
                status.change = Some(change);
            }
            Ok(None) => {
                status.state = "failed".to_owned();
                status.error = Some("space not found".to_owned());
            }
            Err(error) if error.downcast_ref::<RetrievalModeCancelled>().is_some() => {
                status.state = "cancelled".to_owned();
            }
            Err(error) => {
                status.state = "failed".to_owned();
                status.error = Some(format!("{error:#}"));
            }
        }
        state.terminal_job_ids.push_back(job_id.to_owned());
        while state.terminal_job_ids.len() > MAX_RETRIEVAL_MODE_TERMINAL_STATUSES {
            if let Some(expired_job_id) = state.terminal_job_ids.pop_front() {
                state.statuses.remove(&expired_job_id);
            }
        }
        state.finalizing = false;
        state.cancel = None;
    }

    fn set_retrieval_mode_blocking_with_control(
        conn: &mut Connection,
        space_id: &str,
        mode: RetrievalMode,
        should_cancel: &dyn Fn() -> bool,
        progress: &mut dyn FnMut(usize, usize, usize, usize),
    ) -> Result<Option<RetrievalModeChange>> {
        let now = now_millis();
        let tx = conn
            .transaction()
            .context("starting retrieval-mode transaction")?;

        let previous: Option<String> = tx
            .query_row(
                "SELECT retrieval_mode FROM spaces WHERE id = ?1",
                params![space_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading current retrieval_mode")?;
        let Some(previous) = previous else {
            return Ok(None);
        };
        let previous = RetrievalMode::from_str(&previous);

        if should_cancel() {
            return Err(RetrievalModeCancelled.into());
        }

        tx.execute(
            "UPDATE spaces SET retrieval_mode = ?1, updated_at = ?2 WHERE id = ?3",
            params![mode.as_str(), now, space_id],
        )
        .context("updating space retrieval_mode")?;

        // Always clear first: in the → `Graph` direction this makes the rebuild
        // idempotent (the tables carry no UNIQUE constraint, so a second pass over
        // the same chunks would duplicate every node and edge); in the → `Vector`
        // direction it is the whole point.
        tx.execute(
            "DELETE FROM graph_edges WHERE space_id = ?1",
            params![space_id],
        )
        .context("clearing graph edges")?;
        tx.execute(
            "DELETE FROM graph_nodes WHERE space_id = ?1",
            params![space_id],
        )
        .context("clearing graph nodes")?;

        let mut chunks_scanned = 0usize;
        let mut graph_nodes = 0usize;
        let mut graph_edges = 0usize;
        if mode == RetrievalMode::Graph {
            let rows: Vec<(String, String)> = {
                let mut stmt = tx
                    .prepare(
                        "SELECT id, COALESCE(ryu_open_soft('chunks.content', id, content), '')
                         FROM chunks WHERE space_id = ?1 ORDER BY rowid",
                    )
                    .context("preparing chunk scan for graph rebuild")?;
                let mapped =
                    stmt.query_map(params![space_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
                let mut v = Vec::new();
                for row in mapped {
                    v.push(row?);
                }
                v
            };
            chunks_scanned = rows.len();
            let pairs: Vec<(&str, &str)> = rows
                .iter()
                .map(|(id, content)| (id.as_str(), content.as_str()))
                .collect();
            let (n, e) = build_graph_for_chunks_with_control(
                &tx,
                space_id,
                &pairs,
                should_cancel,
                &mut |processed, nodes, edges| {
                    progress(processed, nodes, edges, chunks_scanned);
                },
            )?;
            graph_nodes = n;
            graph_edges = e;
        }

        if should_cancel() {
            return Err(RetrievalModeCancelled.into());
        }

        tx.commit().context("committing retrieval-mode change")?;
        Ok(Some(RetrievalModeChange {
            previous,
            mode,
            changed: previous != mode,
            graph_rebuilt: mode == RetrievalMode::Graph,
            chunks_scanned,
            graph_nodes,
            graph_edges,
        }))
    }

    /// Set (or clear) a document's Notion-style glyph without re-embedding.
    /// Returns `false` when no such document exists.
    pub async fn set_document_icon(
        &self,
        doc_id: &str,
        icon: Option<&serde_json::Value>,
    ) -> Result<bool> {
        let now = now_millis();
        let icon_str = match icon {
            Some(v) => Some(serde_json::to_string(v).context("serializing document icon")?),
            None => None,
        };
        let mut conn = self.conn.lock().await;
        let tx = conn
            .transaction()
            .context("starting document icon transaction")?;
        let space_id: Option<String> = tx
            .query_row(
                "SELECT space_id FROM documents WHERE id = ?1",
                params![doc_id],
                |row| row.get(0),
            )
            .optional()
            .context("looking up document for icon update")?;
        let Some(space_id) = space_id else {
            return Ok(false);
        };
        tx.execute(
            "UPDATE documents SET icon = ?1, updated_at = ?2 WHERE id = ?3",
            params![icon_str, now, doc_id],
        )
        .context("updating document icon")?;
        tx.execute(
            "UPDATE spaces SET updated_at = ?1 WHERE id = ?2",
            params![now, space_id],
        )
        .context("bumping space updated_at")?;
        tx.commit().context("committing document icon update")?;
        Ok(true)
    }

    /// Apply a stable-id document snapshot from the opt-in cross-device mirror.
    /// The timestamp comparison and replacement happen in one transaction, so a
    /// local edit that lands while embedding is in flight cannot be overwritten by
    /// an older remote snapshot.
    pub async fn apply_synced_document(
        &self,
        record: &DocumentSyncRecord,
        tenancy: &DocOwner,
    ) -> Result<bool> {
        let document = &record.document;
        if document.kind == "file" {
            anyhow::bail!("binary file documents require the blob transfer protocol")
        }
        let chunk_source = match document.kind.as_str() {
            "database" => flatten_database_source(&document.source),
            "whiteboard" => flatten_whiteboard_source(&document.source),
            kind if kind.starts_with("app:") => flatten_app_source(&document.source),
            _ => document.source.clone(),
        };
        let chunks = self
            .split_for_space(&document.space_id, &chunk_source)
            .await?;
        let emb = self.embedder_snapshot().await;
        let model_id = emb.model_id().to_string();
        let dims = emb.dims();
        let embedded = embed_text_chunks(&emb, chunks).await?;

        let record = record.clone();
        let tenancy = tenancy.clone();
        let icon = record
            .document
            .icon
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let guard = self.conn.clone().lock_owned().await;
        tokio::task::spawn_blocking(move || {
            Self::apply_synced_document_blocking(
                guard,
                &record,
                &tenancy,
                icon.as_deref(),
                &model_id,
                dims,
                &embedded,
            )
        })
        .await
        .context("synced document apply task panicked")?
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_synced_document_blocking(
        mut guard: tokio::sync::OwnedMutexGuard<Connection>,
        record: &DocumentSyncRecord,
        tenancy: &DocOwner,
        icon: Option<&str>,
        model_id: &str,
        dims: usize,
        embedded: &[EmbeddedChunk],
    ) -> Result<bool> {
        let document = &record.document;
        let conn = &mut *guard;
        let tx = conn
            .transaction()
            .context("starting synced document transaction")?;
        let existing: Option<LocalSyncedDocument> = tx
            .query_row(
                "SELECT updated_at, sync_base_updated_at, ryu_open('documents.title', id, title),
                        ryu_open('documents.source', id, source), kind, space_id,
                        revision, updated_by
                 FROM documents WHERE id = ?1",
                params![document.id],
                |row| {
                    Ok(LocalSyncedDocument {
                        updated_at: row.get(0)?,
                        sync_base_updated_at: row.get(1)?,
                        title: row.get(2)?,
                        source: row.get(3)?,
                        kind: row.get(4)?,
                        space_id: row.get(5)?,
                        revision: row.get(6)?,
                        updated_by: row.get(7)?,
                    })
                },
            )
            .optional()?;
        if existing
            .as_ref()
            .is_some_and(|local| local.updated_at >= document.updated_at)
        {
            return Ok(false);
        }
        // Newest-wins decides what the document shows, but it must not destroy
        // concurrent work: when this device edited the document since the last
        // snapshot it received and the incoming body differs, keep the local body
        // as a pinned history version the owner can compare and restore.
        if let Some(local) = existing.as_ref() {
            if local.has_unsynced_edits_diverging_from(document) {
                Self::insert_history_version(
                    &tx,
                    &document.id,
                    &local.space_id,
                    &SnapshotPayload {
                        kind: local.kind.clone(),
                        source: local.source.clone(),
                        title: local.title.clone(),
                    },
                    Some(SYNC_CONFLICT_LABEL),
                    SYNC_CONFLICT_CAPTURE_TYPE,
                    "exact",
                    local.revision,
                    local.updated_by.as_deref(),
                    None,
                    true,
                    now_millis(),
                )?;
                tracing::warn!(
                    document_id = %document.id,
                    "spaces sync: kept this device's concurrent edit as a history version"
                );
            }
        }

        upsert_document_row(
            &tx,
            &document.id,
            &document.space_id,
            &document.title,
            document.created_at,
            &document.source,
            &document.kind,
            document.parent_id.as_deref(),
            None,
            None,
            None,
            tenancy,
        )?;
        let mode_str: String = tx.query_row(
            "SELECT retrieval_mode FROM spaces WHERE id = ?1",
            params![document.space_id],
            |row| row.get(0),
        )?;
        let mode = RetrievalMode::from_str(&mode_str);

        tx.execute(
            "DELETE FROM chunk_embeddings WHERE chunk_id IN
                 (SELECT id FROM chunks WHERE document_id = ?1)",
            params![document.id],
        )?;
        tx.execute(
            "DELETE FROM graph_nodes WHERE chunk_id IN
                 (SELECT id FROM chunks WHERE document_id = ?1)",
            params![document.id],
        )?;
        tx.execute(
            "DELETE FROM graph_edges WHERE chunk_id IN
                 (SELECT id FROM chunks WHERE document_id = ?1)",
            params![document.id],
        )?;
        tx.execute(
            "DELETE FROM chunks WHERE document_id = ?1",
            params![document.id],
        )?;
        insert_chunks(
            &tx,
            &document.id,
            &document.space_id,
            embedded,
            document.updated_at,
            model_id,
            dims,
            mode,
        )?;
        tx.execute(
            "UPDATE documents
             SET space_id = ?1, title = ryu_seal('documents.title', id, ?2),
                 title_bi = ryu_bi('documents.title', ?2),
                 source = ryu_seal('documents.source', id, ?3), created_at = ?4,
                 updated_at = ?5, kind = ?6, parent_id = ?7, icon = ?8,
                 sync_base_updated_at = ?5
             WHERE id = ?9",
            params![
                document.space_id,
                document.title,
                document.source,
                document.created_at,
                document.updated_at,
                document.kind,
                document.parent_id,
                icon,
                document.id,
            ],
        )?;
        tx.execute(
            "UPDATE spaces SET updated_at = MAX(updated_at, ?1) WHERE id = ?2",
            params![document.updated_at, document.space_id],
        )?;
        store_doc_links(
            &tx,
            &document.space_id,
            &document.id,
            &document.source,
            document.updated_at,
        )?;
        tx.execute(
            "UPDATE document_links SET dst_doc_id = NULL
             WHERE dst_doc_id = ?1
               AND dst_title_bi IS NOT ryu_bi('document_links.dst_title', ?2)",
            params![document.id, document.title],
        )?;
        reresolve_pending_links(&tx, &document.space_id, &document.id, &document.title)?;
        tx.commit().context("committing synced document")?;
        Ok(true)
    }

    /// Save an edited page: replace the document's chunks + vectors (+ graph) from
    /// the new markdown `source`, re-embedding with the current model. This is the
    /// embed-on-save path; the desktop debounces calls to it.
    pub async fn update_document(&self, doc_id: &str, title: &str, source: &str) -> Result<()> {
        match self
            .update_document_versioned(doc_id, title, source, None, None, None)
            .await?
        {
            DocumentUpdateOutcome::Applied(_) => Ok(()),
            DocumentUpdateOutcome::Conflict { current_revision } => Err(anyhow::anyhow!(
                "document revision conflict at {current_revision}"
            )),
        }
    }

    /// Revision-aware, retry-safe document update. A missing expected revision is
    /// the compatibility path for older clients; new clients should always send it.
    pub async fn update_document_versioned(
        &self,
        doc_id: &str,
        title: &str,
        source: &str,
        expected_revision: Option<i64>,
        operation_id: Option<&str>,
        created_by: Option<&str>,
    ) -> Result<DocumentUpdateOutcome> {
        self.update_document_with_history(
            doc_id,
            title,
            source,
            expected_revision,
            operation_id,
            created_by,
            DocumentHistoryAction::Automatic,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn update_document_with_history(
        &self,
        doc_id: &str,
        title: &str,
        source: &str,
        expected_revision: Option<i64>,
        operation_id: Option<&str>,
        created_by: Option<&str>,
        history_action: DocumentHistoryAction,
    ) -> Result<DocumentUpdateOutcome> {
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
        let chunk_source = match kind.as_deref() {
            Some("database") => flatten_database_source(source),
            Some("whiteboard") => flatten_whiteboard_source(source),
            // App-owned docs (`kind = app:<plugin_id>`) carry app-defined JSON we
            // can't know the shape of; extract every string value so they stay
            // search-embeddable like a whiteboard/database.
            Some(k) if k.starts_with("app:") => flatten_app_source(source),
            _ => source.to_string(),
        };
        let chunks = self.split_for_document(doc_id, &chunk_source).await?;
        // Embed outside the lock — the embedder may do network I/O.
        let emb = self.embedder_snapshot().await;
        let model_id = emb.model_id().to_string();
        let dims = emb.dims();
        let embedded = embed_text_chunks(&emb, chunks).await?;

        let now = now_millis();
        // Same reasoning (and the same three caveats) as [`Self::ingest_document`]:
        // in graph mode this transaction re-runs [`build_graph_for_chunks`] over the
        // whole document, so an editor save on a large page is the same quadratic
        // SQLite burst. Guard acquired here, outside the closure, so callers queue on
        // the async mutex rather than on a blocking-pool thread.
        let doc_id = doc_id.to_owned();
        let title = title.to_owned();
        let source = source.to_owned();
        let history_source = source.clone();
        let blocking_doc_id = doc_id.clone();
        let operation_id = operation_id.map(str::to_owned);
        let created_by = created_by.map(str::to_owned);
        let guard = self.conn.clone().lock_owned().await;
        let outcome = tokio::task::spawn_blocking(move || {
            Self::update_document_blocking(
                guard,
                &blocking_doc_id,
                &title,
                &source,
                now,
                &model_id,
                dims,
                &embedded,
                expected_revision,
                operation_id.as_deref(),
                created_by.as_deref(),
                history_action,
            )
        })
        .await
        .context("document update task panicked")??;
        if let DocumentUpdateOutcome::Applied(result) = &outcome {
            if result.changed && matches!(history_action, DocumentHistoryAction::Automatic) {
                if let Some(document) = self.get_document(&doc_id).await? {
                    let label = match history_action {
                        DocumentHistoryAction::Automatic => "Document saved",
                        DocumentHistoryAction::RestoreGuard => "Document restored",
                    };
                    checkpoint_source_history_best_effort(
                        source_history_path(&document.id, &document.kind, &document.space_id),
                        history_source,
                        Some(label.to_owned()),
                    )
                    .await;
                }
            }
        }
        Ok(outcome)
    }

    /// The blocking body of [`SpaceStore::update_document`]. Split out only so the
    /// `spawn_blocking` closure stays a one-liner; the reasoning lives on the public
    /// method. Takes the guard by value so the connection is released exactly when
    /// the transaction ends, on the blocking thread.
    #[allow(clippy::too_many_arguments)]
    fn update_document_blocking(
        mut guard: tokio::sync::OwnedMutexGuard<Connection>,
        doc_id: &str,
        title: &str,
        source: &str,
        now: i64,
        model_id: &str,
        dims: usize,
        embedded: &[EmbeddedChunk],
        expected_revision: Option<i64>,
        operation_id: Option<&str>,
        created_by: Option<&str>,
        history_action: DocumentHistoryAction,
    ) -> Result<DocumentUpdateOutcome> {
        let conn = &mut *guard;
        let tx = conn.transaction().context("starting update transaction")?;

        if let Some(operation_id) = operation_id {
            let receipt: Option<(i64, Option<String>, bool)> = tx
                .query_row(
                    "SELECT revision, version_id, changed
                     FROM document_version_operations
                     WHERE document_id = ?1 AND operation_id = ?2",
                    params![doc_id, operation_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? != 0)),
                )
                .optional()
                .context("reading document write receipt")?;
            if let Some((revision, version_id, changed)) = receipt {
                let updated_at = tx.query_row(
                    "SELECT updated_at FROM documents WHERE id = ?1",
                    params![doc_id],
                    |row| row.get(0),
                )?;
                return Ok(DocumentUpdateOutcome::Applied(DocumentUpdateResult {
                    revision,
                    updated_at,
                    version_id,
                    duplicate: true,
                    changed,
                }));
            }
        }

        // Resolve the current state inside the same transaction that will replace
        // it. The revision check happens here, after embeddings were prepared.
        let row: Option<DocumentHistoryHead> = tx
            .query_row(
                "SELECT d.space_id, s.retrieval_mode, ryu_open('documents.title', d.id, d.title),
                        ryu_open('documents.source', d.id, d.source), d.kind,
                        d.revision, d.updated_by,
                        (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id)
                 FROM documents d JOIN spaces s ON s.id = d.space_id
                 WHERE d.id = ?1",
                params![doc_id],
                |row| {
                    Ok(DocumentHistoryHead {
                        chunk_count: row.get(7)?,
                        space_id: row.get(0)?,
                        mode: row.get(1)?,
                        title: row.get(2)?,
                        source: row.get(3)?,
                        kind: row.get(4)?,
                        revision: row.get(5)?,
                        updated_by: row.get(6)?,
                    })
                },
            )
            .optional()
            .context("resolving document space")?;
        let DocumentHistoryHead {
            chunk_count,
            kind,
            mode: mode_str,
            revision: current_revision,
            source: old_source,
            space_id,
            title: old_title,
            updated_by: old_updated_by,
        } = row.ok_or_else(|| anyhow::anyhow!("document '{doc_id}' not found"))?;
        if expected_revision.is_some_and(|expected| expected != current_revision) {
            return Ok(DocumentUpdateOutcome::Conflict { current_revision });
        }
        if old_title == title && old_source == source && chunk_count > 0 {
            if let Some(operation_id) = operation_id {
                tx.execute(
                    "INSERT INTO document_version_operations
                         (document_id, operation_id, revision, version_id, changed, created_at)
                     VALUES (?1, ?2, ?3, NULL, 0, ?4)",
                    params![doc_id, operation_id, current_revision, now],
                )?;
            }
            tx.commit().context("committing no-op document update")?;
            return Ok(DocumentUpdateOutcome::Applied(DocumentUpdateResult {
                revision: current_revision,
                updated_at: now,
                version_id: None,
                duplicate: false,
                changed: false,
            }));
        }
        let mode = RetrievalMode::from_str(&mode_str);

        // Drop the document's old chunks, vectors, and graph rows.
        tx.execute(
            "DELETE FROM chunk_embeddings WHERE chunk_id IN
                 (SELECT id FROM chunks WHERE document_id = ?1)",
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

        insert_chunks(&tx, doc_id, &space_id, embedded, now, model_id, dims, mode)?;

        let new_revision = current_revision.saturating_add(1);
        tx.execute(
            "UPDATE documents
             SET title = ryu_seal('documents.title', id, ?1),
                 title_bi = ryu_bi('documents.title', ?1),
                 source = ryu_seal('documents.source', id, ?2), updated_at = ?3, revision = ?4,
                 updated_by = COALESCE(?5, updated_by)
             WHERE id = ?6",
            params![title, source, now, new_revision, created_by, doc_id],
        )
        .context("updating document")?;
        tx.execute(
            "UPDATE spaces SET updated_at = ?1 WHERE id = ?2",
            params![now, space_id],
        )?;

        // Wiki page-links. Re-derive this document's outgoing links from the new
        // source. On a rename, inbound links that were resolved to this doc by its
        // *old* title no longer match → unresolve them (back to pending); then
        // re-resolve any pending links that match the *new* title.
        store_doc_links(&tx, &space_id, doc_id, source, now)?;
        tx.execute(
            "UPDATE document_links SET dst_doc_id = NULL
             WHERE dst_doc_id = ?1
               AND dst_title_bi IS NOT ryu_bi('document_links.dst_title', ?2)",
            params![doc_id, title],
        )
        .context("unresolving stale inbound links on rename")?;
        reresolve_pending_links(&tx, &space_id, doc_id, title)?;

        let version_id = match history_action {
            DocumentHistoryAction::Automatic => Self::capture_automatic_version(
                &tx,
                doc_id,
                &space_id,
                &old_title,
                &old_source,
                &kind,
                current_revision,
                old_updated_by.as_deref(),
                title,
                source,
                new_revision,
                created_by,
                now,
            )?,
            DocumentHistoryAction::RestoreGuard => Some(Self::insert_history_version(
                &tx,
                doc_id,
                &space_id,
                &SnapshotPayload {
                    kind: kind.clone(),
                    source: old_source.clone(),
                    title: old_title.clone(),
                },
                Some("Before restore"),
                "restore_guard",
                "exact",
                current_revision,
                old_updated_by.as_deref(),
                None,
                true,
                now,
            )?),
        };
        Self::prune_document_history(&tx, doc_id, &space_id, now)?;
        if let Some(operation_id) = operation_id {
            tx.execute(
                "INSERT INTO document_version_operations
                     (document_id, operation_id, revision, version_id, changed, created_at)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5)",
                params![doc_id, operation_id, new_revision, version_id, now],
            )
            .context("recording document write receipt")?;
            Self::prune_document_operation_receipts(&tx, doc_id, now)?;
        }

        tx.commit().context("committing update transaction")?;
        Ok(DocumentUpdateOutcome::Applied(DocumentUpdateResult {
            revision: new_revision,
            updated_at: now,
            version_id,
            duplicate: false,
            changed: true,
        }))
    }

    fn insert_history_blob(
        tx: &rusqlite::Transaction<'_>,
        snapshot: &SnapshotPayload,
        now: i64,
    ) -> Result<String> {
        let encoded = encode_snapshot(snapshot)?;
        let hash = history_hash(tx, &encoded.raw)?;
        tx.execute(
            "INSERT OR IGNORE INTO document_version_blobs
                 (hash, codec, payload, raw_bytes, stored_bytes, created_at)
             VALUES (?1, ?2, ryu_seal_blob('document_version_blobs.payload', ?1, ?3),
                     ?4, ?5, ?6)",
            params![
                hash,
                SNAPSHOT_CODEC,
                encoded.payload,
                encoded.raw_bytes,
                encoded.stored_bytes,
                now
            ],
        )
        .context("storing document history blob")?;
        Ok(hash)
    }

    /// Move history snapshots stored under the unkeyed digest of older builds
    /// (64 hex of `SHA-256(raw)`, confirmable offline for short pages) to the
    /// keyed address (32 hex, [`seal::SpacesKeys::history_hash`]). Per row, in
    /// one transaction: open the payload under its old id, insert it resealed
    /// under the new id, repoint `document_versions.blob_hash`, delete the old
    /// row (`secure_delete` is on) and mark the store's scrub owed. Resumable
    /// (a cursor over the old ids; finished rows no longer match) and
    /// idempotent. A payload that does not open is left in place and counted.
    /// Returns the rows moved.
    fn rekey_history_blobs(conn: &mut Connection, seal: &seal::SealState) -> Result<u64> {
        const PURPOSE: &str = "document_version_blobs.payload";
        let mut moved = 0u64;
        let mut cursor = String::new();
        loop {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let rows: Vec<(String, String, Vec<u8>)> = {
                let mut stmt = tx.prepare(
                    "SELECT hash, codec, payload FROM document_version_blobs
                     WHERE length(hash) = 64 AND hash > ?1 ORDER BY hash LIMIT 64",
                )?;
                let mapped = stmt.query_map(params![cursor], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?;
                mapped.collect::<rusqlite::Result<_>>()?
            };
            let Some(last) = rows.last().map(|(hash, _, _)| hash.clone()) else {
                tx.commit()?;
                return Ok(moved);
            };
            for (old, codec, stored) in rows {
                let opened = match seal
                    .keys
                    .cipher
                    .open_bytes(&stored, &ContentContext::for_id(PURPOSE, old.as_str()))
                {
                    Ok(opened) => opened.value,
                    Err(error) => {
                        tracing::warn!("spaces store: a history snapshot does not open: {error:#}");
                        seal.note_unreadable(PURPOSE);
                        continue;
                    }
                };
                let raw = history::snapshot_raw(&codec, &opened)?;
                let new = seal.keys.history_hash(&raw)?;
                tx.execute(
                    "INSERT OR IGNORE INTO document_version_blobs
                         (hash, codec, payload, raw_bytes, stored_bytes, created_at)
                     SELECT ?1, codec, ryu_seal_blob(?2, ?1, ?3), raw_bytes, stored_bytes,
                            created_at
                     FROM document_version_blobs WHERE hash = ?4",
                    params![new, PURPOSE, opened, old],
                )
                .context("storing a history snapshot under its keyed address")?;
                tx.execute(
                    "UPDATE document_versions SET blob_hash = ?1 WHERE blob_hash = ?2",
                    params![new, old],
                )?;
                tx.execute(
                    "DELETE FROM document_version_blobs WHERE hash = ?1",
                    params![old],
                )?;
                moved += 1;
            }
            if moved > 0 {
                // The old rows' cells are zeroed by secure_delete; the
                // compaction (finish_store) is owed for the rest.
                mark_scrub_owed(&tx)?;
            }
            tx.commit()
                .context("committing a history re-address batch")?;
            cursor = last;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_history_version(
        tx: &rusqlite::Transaction<'_>,
        document_id: &str,
        space_id: &str,
        snapshot: &SnapshotPayload,
        label: Option<&str>,
        capture_type: &str,
        granularity: &str,
        revision: i64,
        created_by: Option<&str>,
        group_key: Option<&str>,
        pinned: bool,
        now: i64,
    ) -> Result<String> {
        let version_id = format!("dv_{}", uuid::Uuid::new_v4());
        let blob_hash = Self::insert_history_blob(tx, snapshot, now)?;
        tx.execute(
            "INSERT INTO document_versions
                 (id, document_id, space_id, title, source, label, kind, created_at,
                  blob_hash, capture_type, granularity, revision, updated_at,
                  created_by, group_key, pinned)
             VALUES (?1, ?2, ?3, ryu_seal('document_versions.title', ?1, ?4),
                     ryu_seal('document_versions.source', ?1, ''),
                     ryu_seal('document_versions.label', ?1, ?5), ?6, ?7, ?8, ?9, ?10, ?11,
                     ?7, ?12, ?13, ?14)",
            params![
                version_id,
                document_id,
                space_id,
                snapshot.title,
                label,
                snapshot.kind,
                now,
                blob_hash,
                capture_type,
                granularity,
                revision,
                created_by,
                group_key,
                i64::from(pinned)
            ],
        )
        .context("inserting document history version")?;
        Ok(version_id)
    }

    #[allow(clippy::too_many_arguments)]
    fn capture_automatic_version(
        tx: &rusqlite::Transaction<'_>,
        document_id: &str,
        space_id: &str,
        old_title: &str,
        old_source: &str,
        kind: &str,
        old_revision: i64,
        old_updated_by: Option<&str>,
        new_title: &str,
        new_source: &str,
        new_revision: i64,
        created_by: Option<&str>,
        now: i64,
    ) -> Result<Option<String>> {
        let has_baseline: bool = tx.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM document_versions
                 WHERE document_id = ?1 AND capture_type = 'baseline'
             )",
            params![document_id],
            |row| row.get(0),
        )?;
        if !has_baseline {
            Self::insert_history_version(
                tx,
                document_id,
                space_id,
                &SnapshotPayload {
                    kind: kind.to_owned(),
                    source: old_source.to_owned(),
                    title: old_title.to_owned(),
                },
                None,
                "baseline",
                "exact",
                old_revision,
                old_updated_by,
                None,
                true,
                now,
            )?;
        }

        let group_key = format!("auto:{}", now.div_euclid(AUTO_BUCKET_MS));
        let snapshot = SnapshotPayload {
            kind: kind.to_owned(),
            source: new_source.to_owned(),
            title: new_title.to_owned(),
        };
        let blob_hash = Self::insert_history_blob(tx, &snapshot, now)?;
        let existing_id: Option<String> = tx
            .query_row(
                "SELECT id FROM document_versions
                 WHERE document_id = ?1 AND group_key = ?2",
                params![document_id, group_key],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(version_id) = existing_id {
            tx.execute(
                "UPDATE document_versions
                 SET title = ryu_seal('document_versions.title', id, ?1), blob_hash = ?2,
                     revision = ?3, updated_at = ?4,
                     created_by = ?5, granularity = 'ten_minute'
                 WHERE id = ?6",
                params![
                    new_title,
                    blob_hash,
                    new_revision,
                    now,
                    created_by,
                    version_id
                ],
            )?;
            Ok(Some(version_id))
        } else {
            Self::insert_history_version(
                tx,
                document_id,
                space_id,
                &snapshot,
                None,
                "automatic",
                "ten_minute",
                new_revision,
                created_by,
                Some(&group_key),
                false,
                now,
            )
            .map(Some)
        }
    }

    fn prune_document_history(
        tx: &rusqlite::Transaction<'_>,
        document_id: &str,
        space_id: &str,
        now: i64,
    ) -> Result<()> {
        let candidates: Vec<RetentionCandidate> = {
            let mut stmt = tx.prepare(
                "SELECT id, updated_at FROM document_versions
                 WHERE document_id = ?1 AND capture_type = 'automatic' AND pinned = 0
                 ORDER BY updated_at DESC, id DESC",
            )?;
            let rows = stmt.query_map(params![document_id], |row| {
                Ok(RetentionCandidate {
                    id: row.get(0)?,
                    updated_at: row.get(1)?,
                })
            })?;
            rows.filter_map(std::result::Result::ok).collect()
        };
        let plan = plan_automatic_retention(now, &candidates);
        for (id, granularity) in plan.granularity_updates {
            tx.execute(
                "UPDATE document_versions SET granularity = ?1 WHERE id = ?2",
                params![granularity, id],
            )?;
        }
        for id in plan.delete_ids {
            tx.execute("DELETE FROM document_versions WHERE id = ?1", params![id])?;
        }

        loop {
            let bytes: i64 = tx.query_row(
                "SELECT COALESCE(SUM(b.stored_bytes), 0)
                 FROM document_version_blobs b
                 WHERE EXISTS (
                     SELECT 1 FROM document_versions v
                     WHERE v.space_id = ?1 AND v.blob_hash = b.hash
                 )",
                params![space_id],
                |row| row.get(0),
            )?;
            if bytes <= MAX_HISTORY_BYTES_PER_SPACE {
                break;
            }
            let oldest_automatic: Option<String> = tx
                .query_row(
                    "SELECT id FROM document_versions
                     WHERE space_id = ?1 AND capture_type = 'automatic' AND pinned = 0
                     ORDER BY updated_at ASC, id ASC LIMIT 1",
                    params![space_id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(id) = oldest_automatic else {
                break;
            };
            tx.execute("DELETE FROM document_versions WHERE id = ?1", params![id])?;
            Self::delete_orphaned_history_blobs(tx)?;
        }
        Self::delete_orphaned_history_blobs(tx)
    }

    fn delete_orphaned_history_blobs(tx: &rusqlite::Transaction<'_>) -> Result<()> {
        tx.execute(
            "DELETE FROM document_version_blobs
             WHERE NOT EXISTS (
                 SELECT 1 FROM document_versions v WHERE v.blob_hash = hash
             )",
            [],
        )
        .context("collecting unreferenced document history blobs")?;
        Ok(())
    }

    fn prune_document_operation_receipts(
        tx: &rusqlite::Transaction<'_>,
        document_id: &str,
        now: i64,
    ) -> Result<()> {
        const RECEIPT_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
        const MAX_RECEIPTS_PER_DOCUMENT: i64 = 1_000;
        tx.execute(
            "DELETE FROM document_version_operations
             WHERE document_id = ?1 AND created_at < ?2",
            params![document_id, now.saturating_sub(RECEIPT_RETENTION_MS)],
        )?;
        tx.execute(
            "DELETE FROM document_version_operations
             WHERE document_id = ?1 AND operation_id NOT IN (
                 SELECT operation_id FROM document_version_operations
                 WHERE document_id = ?1
                 ORDER BY created_at DESC, operation_id DESC LIMIT ?2
             )",
            params![document_id, MAX_RECEIPTS_PER_DOCUMENT],
        )?;
        Ok(())
    }

    /// Capture the current state as a pinned manual or named version.
    pub async fn snapshot_document(
        &self,
        doc_id: &str,
        label: Option<&str>,
    ) -> Result<DocumentVersionMeta> {
        self.snapshot_document_as(doc_id, label, None).await
    }

    pub async fn snapshot_document_as(
        &self,
        doc_id: &str,
        label: Option<&str>,
        created_by: Option<&str>,
    ) -> Result<DocumentVersionMeta> {
        let (space_id, title, source, kind, revision): (String, String, String, String, i64) = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT space_id, ryu_open('documents.title', id, title),
                        ryu_open('documents.source', id, source), kind, revision
                 FROM documents WHERE id = ?1",
                params![doc_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .context("reading document for snapshot")?
            .ok_or_else(|| anyhow::anyhow!("document '{doc_id}' not found"))?
        };
        let version = checkpoint_source_history(
            source_history_path(doc_id, &kind, &space_id),
            source,
            label.map(str::to_owned),
        )
        .await?;

        Ok(DocumentVersionMeta {
            id: version.id,
            document_id: doc_id.to_string(),
            title,
            label: version.label,
            kind,
            created_at: version.created_at,
            updated_at: version.created_at,
            capture_type: "manual".to_owned(),
            granularity: "exact".to_owned(),
            revision,
            created_by: created_by.map(str::to_owned),
        })
    }

    /// List a document's saved versions, newest first (metadata only).
    pub async fn list_document_versions(&self, doc_id: &str) -> Result<Vec<DocumentVersionMeta>> {
        let current: Option<(String, String, String, i64)> = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT space_id, ryu_open('documents.title', id, title), kind, revision
                 FROM documents WHERE id = ?1",
                params![doc_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .context("reading document for version list")?
        };
        let Some((space_id, current_title, kind, revision)) = current else {
            return Ok(Vec::new());
        };
        let path = source_history_path(doc_id, &kind, &space_id);
        let mut versions = list_source_history(path.clone(), None)
            .await?
            .into_iter()
            .map(|version| DocumentVersionMeta {
                id: version.id,
                document_id: doc_id.to_owned(),
                title: current_title.clone(),
                label: version.label,
                kind: kind.clone(),
                created_at: version.created_at,
                updated_at: version.created_at,
                capture_type: "git".to_owned(),
                granularity: "exact".to_owned(),
                revision,
                created_by: None,
            })
            .collect::<Vec<_>>();
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, document_id, ryu_open_soft('document_versions.title', id, title),
                    ryu_open_soft('document_versions.label', id, label), kind, created_at,
                    updated_at, capture_type, granularity, revision, created_by
             FROM document_versions
             WHERE document_id = ?1
             ORDER BY updated_at DESC, id DESC",
        )?;
        let rows = stmt.query_map(params![doc_id], |row| {
            let Some(title) = row.get::<_, Option<String>>(2)? else {
                return Ok(None);
            };
            Ok(Some(DocumentVersionMeta {
                id: row.get(0)?,
                document_id: row.get(1)?,
                title,
                label: row.get(3)?,
                kind: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                capture_type: row.get(7)?,
                granularity: row.get(8)?,
                revision: row.get(9)?,
                created_by: row.get(10)?,
            }))
        })?;
        let legacy = rows
            .filter_map(std::result::Result::ok)
            .flatten()
            .collect::<Vec<_>>();
        if versions.is_empty() {
            // Pre-Git documents keep their complete legacy history as a
            // compatibility fallback.
            versions.extend(legacy);
        } else {
            // Once a document has Git checkpoints, SQLite snapshots remain the
            // multiplayer/conflict primitive but are not duplicated in the
            // user-facing history list. A body kept from a sync conflict exists
            // only here, so it stays listed or the owner could never find it.
            versions.extend(
                legacy
                    .into_iter()
                    .filter(|version| version.capture_type == SYNC_CONFLICT_CAPTURE_TYPE),
            );
        }
        versions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(versions)
    }

    /// Fetch one saved version in full (including its captured `source`).
    pub async fn get_document_version(&self, version_id: &str) -> Result<Option<DocumentVersion>> {
        let conn = self.conn.lock().await;
        let row = conn
            .query_row(
                "SELECT id, document_id, ryu_open('document_versions.title', id, title),
                        ryu_open('document_versions.source', id, source),
                        ryu_open('document_versions.label', id, label), kind, created_at,
                        updated_at, capture_type, granularity, revision, created_by,
                        blob_hash
                 FROM document_versions WHERE id = ?1",
                params![version_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, i64>(10)?,
                        row.get::<_, Option<String>>(11)?,
                        row.get::<_, Option<String>>(12)?,
                    ))
                },
            )
            .optional()
            .context("reading document version")?;
        let Some((
            id,
            document_id,
            title,
            legacy_source,
            label,
            kind,
            created_at,
            updated_at,
            capture_type,
            granularity,
            revision,
            created_by,
            blob_hash,
        )) = row
        else {
            return Ok(None);
        };
        let source = if let Some(blob_hash) = blob_hash {
            let (codec, payload): (String, Vec<u8>) = conn
                .query_row(
                    "SELECT codec, ryu_open_blob('document_version_blobs.payload', hash, payload)
                     FROM document_version_blobs WHERE hash = ?1",
                    params![blob_hash],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .context("reading document history blob")?;
            decode_snapshot(&codec, &payload)?.source
        } else {
            legacy_source
        };
        Ok(Some(DocumentVersion {
            id,
            document_id,
            title,
            source,
            label,
            kind,
            created_at,
            updated_at,
            capture_type,
            granularity,
            revision,
            created_by,
        }))
    }

    /// Fetch a Git-backed source checkpoint for a known document. The document id
    /// is part of the path because a Git commit hash alone does not identify which
    /// source file the caller intends to read.
    pub async fn get_source_history_version(
        &self,
        doc_id: &str,
        version_id: &str,
    ) -> Result<Option<DocumentVersion>> {
        if !is_git_version_id(version_id) {
            return Ok(None);
        }
        let current: Option<(String, String, String, String, i64)> = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT id, space_id, ryu_open('documents.title', id, title), kind, revision
                 FROM documents WHERE id = ?1",
                params![doc_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .context("reading document for Git history")?
        };
        let Some((document_id, space_id, title, kind, revision)) = current else {
            return Ok(None);
        };
        let path = source_history_path(doc_id, &kind, &space_id);
        let Some(source) = read_source_history(path.clone(), version_id.to_owned()).await? else {
            return Ok(None);
        };
        let metadata = list_source_history(path, Some(1000))
            .await?
            .into_iter()
            .find(|version| version.id == version_id);
        let Some(metadata) = metadata else {
            return Ok(None);
        };
        Ok(Some(DocumentVersion {
            id: version_id.to_owned(),
            document_id,
            title,
            source,
            label: metadata.label,
            kind,
            created_at: metadata.created_at,
            updated_at: metadata.created_at,
            capture_type: "git".to_owned(),
            granularity: "exact".to_owned(),
            revision,
            created_by: None,
        }))
    }

    /// Restore a saved version as a new document head. The existing SQLite update
    /// remains the concurrency/receipt boundary; Git checkpoints before and after
    /// the update make the source restore visible in the user-facing history.
    pub async fn restore_document_version_versioned(
        &self,
        doc_id: &str,
        version_id: &str,
        expected_revision: i64,
        operation_id: &str,
        created_by: Option<&str>,
    ) -> Result<DocumentUpdateOutcome> {
        let version = match self.get_document_version(version_id).await? {
            Some(version) if version.document_id == doc_id => version,
            _ => self
                .get_source_history_version(doc_id, version_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("version not found"))?,
        };
        let (space_id, kind) = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT space_id, kind FROM documents WHERE id = ?1",
                params![doc_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .context("reading document for Git restore")?
            .ok_or_else(|| anyhow::anyhow!("document '{doc_id}' not found"))?
        };
        let duplicate = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM document_version_operations
                     WHERE document_id = ?1 AND operation_id = ?2
                 )",
                params![doc_id, operation_id],
                |row| row.get::<_, bool>(0),
            )?
        };
        if duplicate {
            return self
                .update_document_with_history(
                    doc_id,
                    version.title.trim(),
                    &version.source,
                    Some(expected_revision),
                    Some(operation_id),
                    created_by,
                    DocumentHistoryAction::RestoreGuard,
                )
                .await;
        }
        if let Some(current) = self.get_document(doc_id).await? {
            checkpoint_source_history(
                source_history_path(doc_id, &kind, &space_id),
                current.source,
                Some("Before restore".to_owned()),
            )
            .await?;
        }
        let outcome = self
            .update_document_with_history(
                doc_id,
                version.title.trim(),
                &version.source,
                Some(expected_revision),
                Some(operation_id),
                created_by,
                DocumentHistoryAction::RestoreGuard,
            )
            .await?;
        if let DocumentUpdateOutcome::Applied(_) = &outcome {
            checkpoint_source_history_best_effort(
                source_history_path(doc_id, &kind, &space_id),
                version.source.clone(),
                Some("Restore document version".to_owned()),
            )
            .await;
        }
        Ok(outcome)
    }

    /// Delete a document and all its chunks/vectors/graph rows. If the document
    /// has child documents (e.g. a database's row pages, linked by `parent_id`),
    /// they are removed too — including their vec0 vectors, which no FK cascade
    /// reaches. Returns whether the target document row was removed.
    pub async fn delete_document(&self, doc_id: &str) -> Result<bool> {
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction().context("starting delete transaction")?;

        // Collect child document ids (one level — row pages have no children).
        let child_ids: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT id FROM documents WHERE parent_id = ?1")
                .context("preparing child lookup")?;
            let ids = stmt.query_map(params![doc_id], |row| row.get::<_, String>(0))?;
            ids.filter_map(std::result::Result::ok).collect()
        };

        // Delete vec0 vectors for the target AND every child (vec0 has no cascade).
        for id in std::iter::once(doc_id.to_string()).chain(child_ids.iter().cloned()) {
            tx.execute(
                "DELETE FROM chunk_embeddings WHERE chunk_id IN
                 (SELECT id FROM chunks WHERE document_id = ?1)",
                params![id],
            )
            .context("deleting doc chunk vectors")?;
        }

        // Delete child document rows first (their chunks/graph cascade), then the
        // target document row (its chunks + graph rows cascade via ON DELETE CASCADE).
        for id in &child_ids {
            tx.execute("DELETE FROM documents WHERE id = ?1", params![id])
                .context("deleting child document")?;
        }
        let removed = tx
            .execute("DELETE FROM documents WHERE id = ?1", params![doc_id])
            .context("deleting document")?;

        // Wiki page-links have no FK cascade (plain-text ids): drop each removed
        // document's outgoing links, and turn inbound links back into pending
        // (`dst_doc_id → NULL`) so a re-created page re-resolves them later.
        for id in std::iter::once(doc_id.to_string()).chain(child_ids.iter().cloned()) {
            tx.execute(
                "DELETE FROM document_links WHERE src_doc_id = ?1",
                params![id],
            )
            .context("deleting outbound links")?;
            tx.execute(
                "UPDATE document_links SET dst_doc_id = NULL WHERE dst_doc_id = ?1",
                params![id],
            )
            .context("unresolving inbound links")?;
            // Version history has no FK cascade (plain-text ids) — drop it too.
            tx.execute(
                "DELETE FROM document_versions WHERE document_id = ?1",
                params![id],
            )
            .context("deleting document versions")?;
            tx.execute(
                "DELETE FROM document_version_operations WHERE document_id = ?1",
                params![id],
            )
            .context("deleting document write receipts")?;
        }
        Self::delete_orphaned_history_blobs(&tx)?;

        tx.commit().context("committing delete transaction")?;
        Ok(removed > 0)
    }

    /// Run a retrieval search across a Space. Branches on the Space's
    /// `retrieval_mode`:
    ///
    /// - `vector`: KNN similarity search (original behaviour, unchanged).
    /// - `graph`: entity-match + BFS traversal, returns grounded chunks.
    ///
    /// Both paths return `Vec<ChunkMatch>`. For graph results `distance` is the
    /// constant `0.0` — a traversal hit has no metric distance, and no
    /// hop-count-derived value is synthesised. Do not rank on `distance` across
    /// modes: it is a real `vec0` distance only on the vector path.
    pub async fn search(
        &self,
        space_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<ChunkMatch>> {
        self.search_ext(space_id, query, limit, None, DocFilter::unrestricted())
            .await
    }

    /// Like [`search`](Self::search) but with an explicit `link_expansion`
    /// override (`None` = use the `RYU_SPACES_LINK_EXPANSION` default) and a
    /// per-caller tenancy `filter`. On an org-bound node the returned chunks are
    /// restricted to documents the caller may READ (so RAG search never leaks a
    /// colleague's private document text); [`DocFilter::unrestricted`] keeps the
    /// in-process / unbound path unchanged.
    pub async fn search_ext(
        &self,
        space_id: &str,
        query: &str,
        limit: usize,
        link_expansion: Option<bool>,
        filter: DocFilter<'_>,
    ) -> Result<Vec<ChunkMatch>> {
        // Over-fetch candidates so the neural reranker (bge cross-encoder, served
        // by the lazily-started `llamacpp-rerank` sidecar) has a fuller set to
        // re-score, expand seed hits along resolved `[[page]]` links (wiki
        // GraphRAG, fail-open), then rerank and truncate. The pipeline lives in
        // `search_with`; this is it with no hybrid, filter, or parent options.
        let opts = SpaceSearchOptions {
            limit,
            link_expansion,
            ..SpaceSearchOptions::default()
        };
        self.search_with(space_id, query, &opts, filter).await
    }

    /// Re-score retrieval `candidates` with the neural reranker and truncate to
    /// `limit`. Fails open: any reranker error (server not started yet, HTTP
    /// failure) preserves the original retrieval order. Neural reranking of Spaces
    /// RAG is the reason the bge cross-encoder is bundled; the `llamacpp-rerank`
    /// server is started lazily by the search HTTP handler, so the first search
    /// after boot may fall open to the vector order before the server warms.
    async fn apply_reranking(
        &self,
        query: &str,
        candidates: Vec<ChunkMatch>,
        limit: usize,
    ) -> Vec<ChunkMatch> {
        if candidates.len() <= 1 {
            return candidates.into_iter().take(limit).collect();
        }
        let docs: Vec<String> = candidates.iter().map(|c| c.content.clone()).collect();
        match self.reranker.rank_documents(query, &docs).await {
            Ok(ranked) => {
                let mut reordered = Vec::with_capacity(limit.min(ranked.len()));
                for (idx, _score) in ranked.into_iter().take(limit) {
                    if let Some(chunk) = candidates.get(idx) {
                        reordered.push(chunk.clone());
                    }
                }
                // Defensive: an empty/degenerate rerank result must not drop all
                // hits — fall back to the original order.
                if reordered.is_empty() {
                    candidates.into_iter().take(limit).collect()
                } else {
                    reordered
                }
            }
            Err(e) => {
                tracing::debug!("Spaces reranking unavailable ({e:#}); using vector order");
                candidates.into_iter().take(limit).collect()
            }
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

    /// KNN cosine-similarity search (vector mode), restricted to the chunk
    /// rowids in `allowed_rowids` (a JSON array) when it is `Some` — the metadata
    /// filter's allowlist, applied inside the KNN so a filtered search still
    /// returns its `limit` nearest matching chunks.
    async fn vector_search(
        &self,
        space_id: &str,
        query: &str,
        limit: usize,
        filter: &DocFilter<'_>,
        allowed_rowids: Option<&str>,
    ) -> Result<Vec<ChunkMatch>> {
        let emb = self.embedder_snapshot().await;
        // A caller can temporarily install a new embedder before its reindex has
        // completed. Never send a vector of the new width to the old vec0 table:
        // sqlite-vec rejects that query, and treating the old vectors as valid
        // would be silent cross-dimension corruption.
        if self.vec_dims.load(Ordering::SeqCst) != emb.dims() {
            return Ok(Vec::new());
        }
        let model_id = emb.model_id().to_string();
        let dims = emb.dims();
        let query_vec = emb.embed(query).await?;
        // Vectors are sealed at rest and scored in memory. A partition that is
        // not hydrated (evicted, too large to load inline, or still being
        // migrated) is served by the blind term index while it loads in the
        // background; `vector_coverage` reports the gap.
        if !self.ensure_partition(space_id, &model_id, dims).await? {
            return self
                .term_fallback_search(space_id, query, limit, filter, allowed_rowids)
                .await;
        }
        let conn = self.conn.lock().await;
        // Only chunks embedded by the *current* model and visible to the caller:
        // a vector from another model lives in an incomparable space, and the
        // tenancy filter applies before the limit (as the old KNN query did).
        let visible_sql = format!(
            "SELECT c.id FROM chunks c
             JOIN documents d ON d.id = c.document_id
             WHERE c.space_id = :space_id
               AND c.embed_model = :model_id
               AND c.embed_dims = :dims
               AND (:allowed IS NULL OR c.rowid IN (SELECT value FROM json_each(:allowed)))
               AND {DOC_TENANCY_VISIBLE_PREDICATE}"
        );
        let visible: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare(&visible_sql)?;
            let rows = stmt.query_map(
                named_params! {
                    ":space_id": space_id,
                    ":model_id": model_id,
                    ":dims": dims as i64,
                    ":allowed": allowed_rowids,
                    ":bound": filter.bound_flag(),
                    ":uid": filter.owner_user_id,
                    ":org": filter.org_id,
                    ":teams": filter.team_ids_json.as_str(),
                },
                |row| row.get::<_, String>(0),
            )?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        if visible.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let Some(ranked) = self.vectors.search(space_id, &query_vec, usize::MAX) else {
            drop(conn);
            return self
                .term_fallback_search(space_id, query, limit, filter, allowed_rowids)
                .await;
        };
        let mut out = Vec::new();
        for (chunk_id, score) in ranked {
            if out.len() >= limit {
                break;
            }
            if !visible.contains(&chunk_id) {
                continue;
            }
            let row = conn
                .query_row(
                    "SELECT id, document_id, ryu_open_soft('chunks.content', id, content)
                     FROM chunks WHERE id = ?1",
                    params![chunk_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()?;
            if let Some((chunk_id, document_id, Some(content))) = row {
                out.push(ChunkMatch {
                    chunk_id,
                    document_id,
                    content,
                    // Cosine distance (0 = identical direction).
                    distance: 1.0 - score,
                    ..Default::default()
                });
            }
        }
        Ok(out)
    }

    /// Make sure the Space's vector partition reflects the current embeddings
    /// of `model_id`/`dims`. A hydrated partition takes the writes made since
    /// from the vector journal (opening only those vectors); a missing or
    /// stale one is reloaded on a blocking thread, or in the background when
    /// large (or while legacy vectors are still being converted), and this
    /// returns `false` meanwhile. A partition larger than the whole budget is
    /// not opened again until it shrinks.
    async fn ensure_partition(&self, space_id: &str, model_id: &str, dims: usize) -> Result<bool> {
        const INLINE_HYDRATE_MAX: i64 = 50_000;
        {
            let conn = self.conn.lock().await;
            let legacy: bool = conn
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE name = 'chunk_vectors'",
                    [],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);
            if legacy {
                // Legacy vectors are being sealed by the background migration.
                return Ok(false);
            }
            self.retire_evicted_partitions(&conn)?;
            let generation = space_vector_gen(&conn, space_id)?;
            let total: i64 = conn.query_row(
                "SELECT COUNT(*) FROM chunk_embeddings
                 WHERE space_id = ?1 AND model = ?2 AND dims = ?3",
                params![space_id, model_id, dims as i64],
                |row| row.get(0),
            )?;
            match self.partition_state(space_id) {
                Some(PartitionState::Refused {
                    model,
                    dims: refused_dims,
                    total: refused_total,
                }) if model == model_id && refused_dims == dims && total >= refused_total => {
                    return Ok(false);
                }
                Some(PartitionState::Ready {
                    gen,
                    model,
                    dims: ready_dims,
                    ..
                }) if model == model_id
                    && ready_dims == dims
                    && self.vectors.is_hydrated(space_id) =>
                {
                    if gen == generation
                        || self.apply_vector_journal(
                            &conn, space_id, gen, generation, model_id, dims,
                        )?
                    {
                        return Ok(true);
                    }
                }
                _ => {}
            }
            if total > INLINE_HYDRATE_MAX {
                self.vectors.set_partition_total(space_id, total as u64);
                drop(conn);
                self.spawn_hydration(space_id, model_id, dims);
                return Ok(false);
            }
        }
        Ok(self.hydrate_partition(space_id, model_id, dims).await)
    }

    /// Stop journaling the Spaces whose `Ready` partition was evicted (by
    /// any index sharing the vector budget) and drop their journals: a
    /// search on one reloads it anyway. Called under the connection lock, so
    /// no write interleaves.
    fn retire_evicted_partitions(&self, conn: &Connection) -> Result<()> {
        let evicted: Vec<String> = {
            let Ok(mut states) = self.vector_state.lock() else {
                return Ok(());
            };
            let evicted: Vec<String> = states
                .iter()
                .filter(|(space_id, state)| {
                    matches!(state, PartitionState::Ready { .. })
                        && !self.vectors.is_hydrated(space_id)
                })
                .map(|(space_id, _)| space_id.clone())
                .collect();
            for space_id in &evicted {
                states.remove(space_id);
            }
            evicted
        };
        for space_id in evicted {
            conn.execute(
                "DELETE FROM temp.space_vector_journal WHERE space_id = ?1",
                params![space_id],
            )?;
        }
        Ok(())
    }

    fn partition_state(&self, space_id: &str) -> Option<PartitionState> {
        self.vector_state
            .lock()
            .ok()
            .and_then(|states| states.get(space_id).cloned())
    }

    /// Open one sealed embedding (bound to its chunk id and model); `None`
    /// (counted) when it does not open or has the wrong width.
    fn open_embedding(
        &self,
        chunk_id: &str,
        model_id: &str,
        dims: usize,
        sealed: &[u8],
    ) -> Option<Vec<f32>> {
        let vector = self
            .seal
            .keys
            .cipher
            .open_bytes(sealed, &embedding_context(chunk_id, model_id))
            .ok()
            .and_then(|opened| seal::bytes_to_vec(&opened.value))
            .filter(|vector| vector.len() == dims);
        if vector.is_none() {
            self.seal.note_unreadable("chunk_embeddings.embedding");
        }
        vector
    }

    /// Apply the journaled writes since `from_gen` to the Space's hydrated
    /// partition, under the connection lock (so no write interleaves), and
    /// record it as current at `to_gen`. `false` (nothing recorded) when the
    /// journal does not account for every generation bump, is too long, or
    /// the partition was evicted meanwhile: the caller reloads it.
    fn apply_vector_journal(
        &self,
        conn: &Connection,
        space_id: &str,
        from_gen: i64,
        to_gen: i64,
        model_id: &str,
        dims: usize,
    ) -> Result<bool> {
        let journal: Vec<(String, bool)> = {
            let mut stmt = conn.prepare_cached(
                "SELECT chunk_id, put FROM temp.space_vector_journal
                 WHERE space_id = ?1 ORDER BY seq",
            )?;
            let rows = stmt.query_map(params![space_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        if from_gen + journal.len() as i64 != to_gen || journal.len() > VECTOR_JOURNAL_APPLY_MAX {
            return Ok(false);
        }
        // The last write to a chunk decides.
        let mut last: HashMap<String, bool> = HashMap::with_capacity(journal.len());
        for (chunk_id, put) in journal {
            last.insert(chunk_id, put);
        }
        let mut read = conn.prepare_cached(
            "SELECT embedding FROM chunk_embeddings
             WHERE chunk_id = ?1 AND space_id = ?2 AND model = ?3 AND dims = ?4",
        )?;
        for (chunk_id, put) in last {
            let sealed: Option<Vec<u8>> = if put {
                read.query_row(params![chunk_id, space_id, model_id, dims as i64], |row| {
                    row.get(0)
                })
                .optional()?
            } else {
                None
            };
            match sealed.and_then(|sealed| self.open_embedding(&chunk_id, model_id, dims, &sealed))
            {
                Some(vector) => {
                    if !self.vectors.upsert(space_id, &chunk_id, &vector) {
                        return Ok(false);
                    }
                }
                // Deleted, embedded by another model, or not opening.
                None => self.vectors.remove(space_id, &chunk_id),
            }
        }
        conn.execute(
            "DELETE FROM temp.space_vector_journal WHERE space_id = ?1",
            params![space_id],
        )?;
        if let Ok(mut states) = self.vector_state.lock() {
            states.insert(
                space_id.to_owned(),
                PartitionState::Ready {
                    gen: to_gen,
                    model: model_id.to_owned(),
                    dims,
                    journaled: 0,
                },
            );
        }
        Ok(true)
    }

    fn spawn_hydration(&self, space_id: &str, model_id: &str, dims: usize) {
        let inserted = self
            .hydrating
            .lock()
            .map(|mut set| set.insert(space_id.to_owned()))
            .unwrap_or(false);
        if !inserted {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            if let Ok(mut set) = self.hydrating.lock() {
                set.remove(space_id);
            }
            return;
        };
        let store = self.clone();
        let space_id = space_id.to_owned();
        let model_id = model_id.to_owned();
        handle.spawn(async move {
            store.hydrate_partition(&space_id, &model_id, dims).await;
            if let Ok(mut set) = store.hydrating.lock() {
                set.remove(&space_id);
            }
        });
    }

    /// Load and open all of a Space's sealed vectors into its partition, on a
    /// blocking thread. Vectors that do not open are skipped and counted.
    /// Writes made while it runs are journaled and applied by the next search.
    /// Returns whether the partition is now hydrated and recorded (a partition
    /// larger than the whole budget is not, and is recorded as refused).
    async fn hydrate_partition(&self, space_id: &str, model_id: &str, dims: usize) -> bool {
        let token = self.hydration_token.fetch_add(1, Ordering::Relaxed) + 1;
        let (generation, rows) = {
            let conn = self.conn.lock().await;
            let result = (|| -> Result<(i64, Vec<(String, Vec<u8>)>)> {
                let generation = space_vector_gen(&conn, space_id)?;
                let mut stmt = conn.prepare(
                    "SELECT chunk_id, embedding FROM chunk_embeddings
                     WHERE space_id = ?1 AND model = ?2 AND dims = ?3",
                )?;
                let rows = stmt.query_map(params![space_id, model_id, dims as i64], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?;
                let rows = rows.collect::<rusqlite::Result<_>>()?;
                // Everything journaled so far is in `rows`.
                conn.execute(
                    "DELETE FROM temp.space_vector_journal WHERE space_id = ?1",
                    params![space_id],
                )?;
                Ok((generation, rows))
            })();
            match result {
                Ok(read) => {
                    if let Ok(mut states) = self.vector_state.lock() {
                        states.insert(
                            space_id.to_owned(),
                            PartitionState::Hydrating {
                                token,
                                gen: read.0,
                                model: model_id.to_owned(),
                                dims,
                                journaled: 0,
                            },
                        );
                    }
                    read
                }
                Err(error) => {
                    tracing::warn!("spaces: reading sealed vectors failed: {error:#}");
                    return false;
                }
            }
        };
        self.full_hydrations.fetch_add(1, Ordering::Relaxed);
        let total = rows.len() as i64;
        let store = self.clone();
        let partition = space_id.to_owned();
        let model = model_id.to_owned();
        let built = tokio::task::spawn_blocking(move || {
            let vectors: Vec<(String, Vec<f32>)> = rows
                .into_iter()
                .filter_map(|(chunk_id, sealed)| {
                    store
                        .open_embedding(&chunk_id, &model, dims, &sealed)
                        .map(|vector| (chunk_id, vector))
                })
                .collect();
            store.vectors.set_partition_total(&partition, total as u64);
            store.vectors.hydrate_partition(&partition, vectors)
        })
        .await;
        let Ok(mut states) = self.vector_state.lock() else {
            return false;
        };
        let journaled = match states.get(space_id) {
            Some(PartitionState::Hydrating {
                token: running,
                journaled,
                ..
            }) if *running == token => *journaled,
            // Another hydration replaced this one, the Space was deleted, or
            // its journal overflowed.
            _ => return false,
        };
        match built {
            Ok(Ok(())) => {
                states.insert(
                    space_id.to_owned(),
                    PartitionState::Ready {
                        gen: generation,
                        model: model_id.to_owned(),
                        dims,
                        journaled,
                    },
                );
                true
            }
            Ok(Err(error)) => {
                tracing::warn!("spaces: vector partition not cached: {error}");
                states.insert(
                    space_id.to_owned(),
                    PartitionState::Refused {
                        model: model_id.to_owned(),
                        dims,
                        total,
                    },
                );
                false
            }
            Err(error) => {
                tracing::warn!("spaces: vector hydration task failed: {error}");
                states.remove(space_id);
                false
            }
        }
    }

    /// Serve a semantic query from the blind term index (any query word),
    /// best match first, when the Space's vectors are not in memory.
    async fn term_fallback_search(
        &self,
        space_id: &str,
        query: &str,
        limit: usize,
        filter: &DocFilter<'_>,
        allowed_rowids: Option<&str>,
    ) -> Result<Vec<ChunkMatch>> {
        let tokens = self.seal.keys.terms.term_tokens(query);
        if tokens.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let match_expr = tokens.join(" OR ");
        let conn = self.conn.lock().await;
        let sql = format!(
            "SELECT c.id, c.document_id, ryu_open_soft('chunks.content', c.id, c.content)
             FROM spaces_terms
             JOIN spaces_terms_map m ON m.term_rowid = spaces_terms.rowid AND m.kind = 'chunk'
             JOIN chunks c ON c.id = m.ref_id
             JOIN documents d ON d.id = c.document_id
             WHERE spaces_terms MATCH :query
               AND c.space_id = :space_id
               AND (:allowed IS NULL OR c.rowid IN (SELECT value FROM json_each(:allowed)))
               AND {DOC_TENANCY_VISIBLE_PREDICATE}
             ORDER BY bm25(spaces_terms)
             LIMIT :limit"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":query": match_expr,
                ":allowed": allowed_rowids,
                ":space_id": space_id,
                ":limit": limit as i64,
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json.as_str(),
            },
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )?;
        let mut out = Vec::new();
        for row in rows {
            if let (chunk_id, document_id, Some(content)) = row? {
                out.push(ChunkMatch {
                    chunk_id,
                    document_id,
                    content,
                    distance: 1.0,
                    ..Default::default()
                });
            }
        }
        Ok(out)
    }

    /// Coverage of the in-memory vector index (hydrated vs total vectors,
    /// evicted partitions), for the recall API and health.
    pub fn vector_coverage(&self) -> ryu_crypto::VectorCoverage {
        self.vectors.coverage()
    }

    async fn graph_search(
        &self,
        space_id: &str,
        query: &str,
        limit: usize,
        filter: &DocFilter<'_>,
    ) -> Result<Vec<ChunkMatch>> {
        // Graph rows hold blind entity tokens, never entity text: the query's
        // entities are tokenized the same way and the traversal runs on tokens.
        let query_entities: Vec<String> = extract_entities(query)
            .iter()
            .map(|entity| self.seal.keys.entity_token(entity))
            .collect();
        if query_entities.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock().await;
        let query_entities = seed_entities_above_floor(&conn, space_id, query_entities, filter)?;

        // Prepared once for the whole traversal. These used to be re-prepared per
        // entity per hop, i.e. `2 × Σ frontier` SQL parses for one search.
        let chunk_sql = format!(
            "SELECT DISTINCT n.chunk_id
             FROM graph_nodes n
             JOIN chunks c ON c.id = n.chunk_id
             JOIN documents d ON d.id = c.document_id
             WHERE n.space_id = :space_id AND n.entity = :entity
               AND {DOC_TENANCY_VISIBLE_PREDICATE}
             ORDER BY n.chunk_id LIMIT :limit"
        );
        let edge_sql = format!(
            "SELECT DISTINCT e.dst_entity
             FROM graph_edges e
             JOIN chunks c ON c.id = e.chunk_id
             JOIN documents d ON d.id = c.document_id
             WHERE e.space_id = :space_id AND e.src_entity = :entity
               AND {DOC_TENANCY_VISIBLE_PREDICATE}
             ORDER BY e.dst_entity LIMIT :limit"
        );
        let mut chunk_stmt = conn.prepare(&chunk_sql)?;
        let mut edge_stmt = conn.prepare(&edge_sql)?;

        // Seed: find chunks that directly contain a query entity.
        let mut visited_chunks = LinkedHashSet::<String>::new();
        // Every entity that has been (or is about to be) expanded, so no entity is
        // walked twice across hops.
        let mut expanded = LinkedHashSet::<String>::new();
        let mut frontier: Vec<String> = Vec::new();
        for entity in query_entities {
            if expanded.insert(entity.clone()) {
                frontier.push(entity);
            }
        }

        // Processing the seed frontier is distance zero. Include one iteration for
        // each of the three edge traversals promised by the public contract.
        let max_edge_hops = 3usize;
        'hops: for _ in 0..=max_edge_hops {
            if frontier.is_empty() || visited_chunks.len() >= limit {
                break;
            }
            let mut next_frontier: Vec<String> = Vec::new();
            // For each frontier entity, collect the chunks it appears in.
            for entity in &frontier {
                let chunk_rows = chunk_stmt.query_map(
                    named_params! {
                        ":space_id": space_id,
                        ":entity": entity,
                        ":limit": limit as i64,
                        ":bound": filter.bound_flag(),
                        ":uid": filter.owner_user_id,
                        ":org": filter.org_id,
                        ":teams": filter.team_ids_json.as_str(),
                    },
                    |row| row.get::<_, String>(0),
                )?;
                for row in chunk_rows {
                    visited_chunks.insert(row?);
                    // Stop the moment the caller's budget is met: any further
                    // traversal can only produce chunks that would be truncated.
                    if visited_chunks.len() >= limit {
                        break 'hops;
                    }
                }
                // Collect neighbour entities via outgoing edges from this entity,
                // up to the per-hop frontier bound.
                if next_frontier.len() >= MAX_FRONTIER_ENTITIES {
                    continue;
                }
                let edge_rows = edge_stmt.query_map(
                    named_params! {
                        ":space_id": space_id,
                        ":entity": entity,
                        ":limit": MAX_FRONTIER_ENTITIES as i64,
                        ":bound": filter.bound_flag(),
                        ":uid": filter.owner_user_id,
                        ":org": filter.org_id,
                        ":teams": filter.team_ids_json.as_str(),
                    },
                    |row| row.get::<_, String>(0),
                )?;
                for row in edge_rows {
                    let neighbour = row?;
                    if expanded.insert(neighbour.clone()) {
                        next_frontier.push(neighbour);
                        if next_frontier.len() >= MAX_FRONTIER_ENTITIES {
                            break;
                        }
                    }
                }
            }
            frontier = next_frontier;
        }

        // Load the matched chunks.
        let mut results = Vec::new();
        for chunk_id in visited_chunks.iter().take(limit) {
            let row = conn.query_row(
                "SELECT c.id, c.document_id, ryu_open_soft('chunks.content', c.id, c.content)
                 FROM chunks c WHERE c.id = ?1",
                params![chunk_id],
                |row| {
                    let Some(content) = row.get::<_, Option<String>>(2)? else {
                        return Ok(None);
                    };
                    Ok(Some(ChunkMatch {
                        chunk_id: row.get(0)?,
                        document_id: row.get(1)?,
                        content,
                        // Synthetic distance: 0.0 = direct entity hit.
                        distance: 0.0,
                        ..Default::default()
                    }))
                },
            );
            if let Ok(Some(chunk_match)) = row {
                results.push(chunk_match);
            }
        }
        Ok(results)
    }

    /// Documents that link **to** `doc_id` (backlinks / "linked references").
    /// Each result carries the source document's title and a context snippet.
    pub async fn get_backlinks(&self, doc_id: &str, filter: DocFilter<'_>) -> Result<Vec<DocLink>> {
        let conn = self.conn.lock().await;
        let target_title: String = conn
            .query_row(
                "SELECT ryu_open('documents.title', id, title) FROM documents WHERE id = ?1",
                params![doc_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading target title")?
            .unwrap_or_default();
        // Titles are sealed: open, then order by the source title in memory
        // (byte order, as SQLite's BINARY collation did).
        let sql = format!(
            "SELECT l.src_doc_id, ryu_open_soft('document_links.dst_title', l.id, l.dst_title),
                    l.link_kind, ryu_open_soft('documents.title', d.id, d.title),
                    ryu_open_soft('documents.source', d.id, d.source)
             FROM document_links l
             JOIN documents d ON d.id = l.src_doc_id
             WHERE l.dst_doc_id = :doc_id
               AND {DOC_TENANCY_VISIBLE_PREDICATE}"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":doc_id": doc_id,
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json.as_str(),
            },
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )?;
        let mut opened = Vec::new();
        for row in rows {
            let (src_doc_id, dst_title, kind, src_title, source) = row?;
            let (Some(dst_title), Some(src_title), Some(source)) = (dst_title, src_title, source)
            else {
                continue;
            };
            opened.push((src_doc_id, dst_title, kind, src_title, source));
        }
        opened.sort_by(|left, right| left.3.cmp(&right.3));
        let mut out = Vec::new();
        for (src_doc_id, dst_title, kind, src_title, source) in opened {
            let snippet = link_snippet(&source, &target_title);
            out.push(DocLink {
                src_doc_id,
                dst_doc_id: Some(doc_id.to_string()),
                dst_title,
                kind,
                src_title: Some(src_title),
                snippet,
            });
        }
        Ok(out)
    }

    /// Outgoing links **from** `doc_id` (resolved doc refs + pending titles).
    pub async fn get_outgoing_links(&self, doc_id: &str) -> Result<Vec<DocLink>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT dst_doc_id, ryu_open_soft('document_links.dst_title', id, dst_title),
                    link_kind
             FROM document_links WHERE src_doc_id = ?1",
        )?;
        let rows = stmt.query_map(params![doc_id], |row| {
            let Some(dst_title) = row.get::<_, Option<String>>(1)? else {
                return Ok(None);
            };
            Ok(Some(DocLink {
                src_doc_id: doc_id.to_string(),
                dst_doc_id: row.get(0)?,
                dst_title,
                kind: row.get(2)?,
                src_title: None,
                snippet: None,
            }))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.extend(row?);
        }
        out.sort_by(|left, right| left.dst_title.cmp(&right.dst_title));
        Ok(out)
    }

    /// Build the document-link graph. `space_filter = Some(id)` scopes to one
    /// Space; `None` returns the global graph across every Space. Nodes are
    /// documents plus synthetic *pending* nodes for unresolved link targets;
    /// edges are wiki/mention links and the `parent_id` hierarchy.
    ///
    /// `filter` applies [`DOC_TENANCY_VISIBLE_PREDICATE`] so on a bound node a
    /// member never sees another member's private document node — nor its title
    /// or link topology leaking through an edge. An edge (and its resolved dst /
    /// pending title) is surfaced ONLY when the caller can read its `src`
    /// document, because the link and the target title originate from the src's
    /// body; a resolved dst the caller cannot read is dropped too. Pass
    /// [`DocFilter::unrestricted`] for the in-process / unbound-node full graph
    /// (byte-identical to the pre-ACL behaviour).
    async fn build_graph(
        &self,
        space_filter: Option<&str>,
        filter: DocFilter<'_>,
    ) -> Result<DocGraph> {
        let conn = self.conn.lock().await;
        let mut graph = DocGraph::default();

        // Nodes: every document the caller may read (top-level and child row-pages
        // are all real pages).
        let doc_sql = format!(
            "SELECT d.id, d.space_id, ryu_open_soft('documents.title', d.id, d.title), d.kind,
                    d.parent_id
             FROM documents d
             WHERE (:space IS NULL OR d.space_id = :space)
               AND {DOC_TENANCY_VISIBLE_PREDICATE}"
        );
        let mut doc_stmt = conn.prepare(&doc_sql)?;
        let doc_rows = doc_stmt.query_map(
            named_params! {
                ":space": space_filter,
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json.as_str(),
            },
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )?;
        // Collect nodes first; defer parent edges until the full visible set is
        // known, so a `parent` the caller cannot read never appears as an edge.
        let mut pending_parent_edges: Vec<(String, String)> = Vec::new();
        for row in doc_rows {
            let (id, space_id, title, kind, parent_id) = row?;
            // A title that does not open drops the node (counted); its edges
            // are dropped below with it.
            let Some(title) = title else {
                continue;
            };
            graph.nodes.push(DocGraphNode {
                id: id.clone(),
                title,
                kind,
                space_id,
                pending: false,
            });
            // parent_id hierarchy edge (database → row page).
            if let Some(parent) = parent_id {
                pending_parent_edges.push((parent, id));
            }
        }
        let visible: std::collections::HashSet<String> =
            graph.nodes.iter().map(|n| n.id.clone()).collect();
        for (parent, id) in pending_parent_edges {
            if visible.contains(&parent) {
                graph.edges.push(DocGraphEdge {
                    src: parent,
                    dst: id,
                    kind: "parent".to_string(),
                });
            }
        }

        // Link edges + pending nodes. The link (and any pending/resolved target
        // title) originates from `src`'s body, so gate on `src` being visible; a
        // resolved dst the caller cannot read is dropped so it never surfaces even
        // as a node.
        let mut seen_pending: std::collections::HashSet<String> = std::collections::HashSet::new();
        let src_visible = DOC_TENANCY_VISIBLE_PREDICATE.replace("d.", "src.");
        let dst_visible = DOC_TENANCY_VISIBLE_PREDICATE.replace("d.", "dst.");
        let link_sql = format!(
            "SELECT l.space_id, l.src_doc_id, l.dst_doc_id,
                    ryu_open_soft('document_links.dst_title', l.id, l.dst_title), l.link_kind
             FROM document_links l
             JOIN documents src ON src.id = l.src_doc_id
             WHERE (:space IS NULL OR l.space_id = :space)
               AND {src_visible}
               AND (
                   l.dst_doc_id IS NULL
                   OR EXISTS (
                       SELECT 1 FROM documents dst
                       WHERE dst.id = l.dst_doc_id AND {dst_visible}
                   )
               )"
        );
        let mut link_stmt = conn.prepare(&link_sql)?;
        let link_rows = link_stmt.query_map(
            named_params! {
                ":space": space_filter,
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json.as_str(),
            },
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )?;
        for row in link_rows {
            let (space_id, src, dst_doc_id, dst_title, kind) = row?;
            let Some(dst_title) = dst_title else {
                continue;
            };
            if !visible.contains(&src) {
                continue;
            }
            let dst = match dst_doc_id {
                Some(id) if visible.contains(&id) => id,
                Some(_) => continue,
                None => {
                    let pending_id = pending_node_id(&space_id, &dst_title);
                    if seen_pending.insert(pending_id.clone()) {
                        graph.nodes.push(DocGraphNode {
                            id: pending_id.clone(),
                            title: dst_title,
                            kind: "pending".to_string(),
                            space_id,
                            pending: true,
                        });
                    }
                    pending_id
                }
            };
            graph.edges.push(DocGraphEdge { src, dst, kind });
        }
        Ok(graph)
    }

    /// The document-link graph for one Space, filtered to what `filter` may read.
    pub async fn space_graph(&self, space_id: &str, filter: DocFilter<'_>) -> Result<DocGraph> {
        self.build_graph(Some(space_id), filter).await
    }

    /// The global document-link graph across all Spaces, filtered to what `filter`
    /// may read.
    pub async fn global_graph(&self, filter: DocFilter<'_>) -> Result<DocGraph> {
        self.build_graph(None, filter).await
    }

    /// Follow resolved wiki links out from `seed_doc_ids` up to `hops` and return
    /// a capped number of chunks from each newly-reached document. This is the
    /// "wiki GraphRAG" expansion: it surfaces context from pages the seed hits
    /// link to, even when those pages are not the closest vectors. Fail-open:
    /// callers treat an error as "no expansion".
    async fn expand_by_links(
        &self,
        space_id: &str,
        seed_doc_ids: &[String],
        hops: usize,
        per_doc_cap: usize,
        document_cap: usize,
        total_chunk_cap: usize,
        filter: &DocFilter<'_>,
    ) -> Result<Vec<ChunkMatch>> {
        if seed_doc_ids.is_empty() || document_cap == 0 || total_chunk_cap == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().await;
        let mut visited: std::collections::HashSet<String> = seed_doc_ids.iter().cloned().collect();
        let mut frontier: Vec<String> = seed_doc_ids.to_vec();
        let mut reached: Vec<String> = Vec::new();
        for _ in 0..hops {
            if frontier.is_empty() || reached.len() >= document_cap {
                break;
            }
            let mut next = Vec::new();
            for doc in &frontier {
                let remaining = document_cap.saturating_sub(reached.len());
                if remaining == 0 {
                    break;
                }
                let sql = format!(
                    "SELECT DISTINCT l.dst_doc_id FROM document_links l
                     JOIN documents d ON d.id = l.dst_doc_id
                     WHERE l.space_id = :space_id AND l.src_doc_id = :src_doc_id
                       AND l.dst_doc_id IS NOT NULL
                       AND {DOC_TENANCY_VISIBLE_PREDICATE}
                     ORDER BY l.dst_doc_id LIMIT :limit"
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(
                    named_params! {
                        ":space_id": space_id,
                        ":src_doc_id": doc,
                        ":limit": remaining as i64,
                        ":bound": filter.bound_flag(),
                        ":uid": filter.owner_user_id,
                        ":org": filter.org_id,
                        ":teams": filter.team_ids_json.as_str(),
                    },
                    |row| row.get::<_, String>(0),
                )?;
                for row in rows {
                    let d = row?;
                    if visited.insert(d.clone()) {
                        next.push(d.clone());
                        reached.push(d);
                        if reached.len() >= document_cap {
                            break;
                        }
                    }
                }
            }
            frontier = next;
        }

        let mut out = Vec::new();
        for doc in &reached {
            let remaining = total_chunk_cap.saturating_sub(out.len());
            if remaining == 0 {
                break;
            }
            let mut stmt = conn.prepare(
                "SELECT id, document_id, ryu_open_soft('chunks.content', id, content) FROM chunks
                 WHERE document_id = ?1 ORDER BY ordinal LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![doc, per_doc_cap.min(remaining) as i64], |row| {
                let Some(content) = row.get::<_, Option<String>>(2)? else {
                    return Ok(None);
                };
                Ok(Some(ChunkMatch {
                    chunk_id: row.get(0)?,
                    document_id: row.get(1)?,
                    content,
                    // Synthetic: link-reached chunks re-scored by the reranker.
                    distance: 1.0,
                    ..Default::default()
                }))
            })?;
            for row in rows {
                out.extend(row?);
            }
        }
        Ok(out)
    }

    /// Delete a Space, its documents, chunks, and their vectors. Returns true if
    /// a Space row was removed.
    pub async fn delete_space(&self, space_id: &str) -> Result<bool> {
        let mut conn = self.conn.lock().await;
        // System spaces (Artifacts, Meetings) are Ryu-owned and undeletable.
        let is_system: Option<i64> = conn
            .query_row(
                "SELECT system FROM spaces WHERE id = ?1",
                params![space_id],
                |row| row.get(0),
            )
            .optional()
            .context("checking system flag")?;
        if is_system == Some(1) {
            anyhow::bail!("space '{space_id}' is a system space and cannot be deleted");
        }
        let tx = conn.transaction().context("starting delete transaction")?;
        // Remove vectors first (explicit, whatever the connection's FK setting).
        if let Ok(mut states) = self.vector_state.lock() {
            states.remove(space_id);
        }
        self.vectors.drop_partition(space_id);
        tx.execute(
            "DELETE FROM chunk_embeddings WHERE space_id = ?1",
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
            "SELECT COUNT(*) FROM spaces WHERE system = 0
               AND COALESCE(ryu_open_soft('spaces.name', id, name), '') != ?1",
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
            "DELETE FROM chunk_embeddings WHERE chunk_id IN (
                 SELECT c.id FROM chunks c
                 JOIN spaces s ON s.id = c.space_id
                 WHERE s.system = 0
                   AND COALESCE(ryu_open_soft('spaces.name', s.id, s.name), '') != ?1
             )",
            params![MEETINGS_SPACE_NAME],
        )
        .context("deleting chunk vectors")?;
        let removed = tx
            .execute(
                "DELETE FROM spaces WHERE system = 0
                   AND COALESCE(ryu_open_soft('spaces.name', id, name), '') != ?1",
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
        let (active_model, active_dims) = {
            let emb = self.embedder.lock().await;
            (emb.model_id().to_string(), emb.dims())
        };
        let (current_model, current_dims, running, errored) = {
            let g = self.reindex.lock().await;
            (
                g.target_model
                    .clone()
                    .unwrap_or_else(|| active_model.clone()),
                g.target_dims.unwrap_or(active_dims),
                g.running,
                g.errored.clone(),
            )
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
    /// model/dims, into the current model. The new sealed vectors are staged and
    /// swapped in with the chunk metadata in one transaction. Idempotent + resumable: re-running only touches chunks that
    /// are still stale. Guarded so only one pass runs at a time.
    pub async fn reindex_all(&self) -> Result<()> {
        let embedder = self.embedder_snapshot().await;
        self.run_reindex(embedder).await.map(|_| ())
    }

    async fn index_unindexed_documents(&self) -> Result<()> {
        self.index_unindexed_documents_where(None).await.map(|_| ())
    }

    /// Embed the pages and databases in one Space that have source text but no
    /// chunks yet, i.e. documents written by [`Self::import_document`]. Returns
    /// how many were indexed. The node-wide pass inside [`Self::reindex_all`]
    /// covers the same rows; this lets a seeder index its own Space without
    /// touching every other Space's pending imports.
    pub async fn index_unindexed_documents_in_space(&self, space_id: &str) -> Result<usize> {
        self.index_unindexed_documents_where(Some(space_id)).await
    }

    async fn index_unindexed_documents_where(&self, space_id: Option<&str>) -> Result<usize> {
        let documents: Vec<(String, String, String)> = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT d.id, ryu_open_soft('documents.title', d.id, d.title),
                        ryu_open_soft('documents.source', d.id, d.source)
                 FROM documents d
                 WHERE d.kind IN ('page', 'database')
                   AND (?1 IS NULL OR d.space_id = ?1)
                   AND NOT EXISTS (
                       SELECT 1 FROM chunks c WHERE c.document_id = d.id
                   )
                 ORDER BY d.created_at ASC, d.id ASC",
            )?;
            let rows = stmt.query_map(params![space_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?;
            // `source` is sealed, so the old `source != ''` filter runs here.
            rows.collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .filter_map(|(id, title, source)| match (title, source) {
                    (Some(title), Some(source)) if !source.is_empty() => Some((id, title, source)),
                    _ => None,
                })
                .collect()
        };
        let indexed = documents.len();
        for (id, title, source) in documents {
            self.update_document(&id, &title, &source).await?;
        }
        Ok(indexed)
    }

    async fn run_reindex(&self, embedder: Embedder) -> Result<bool> {
        let target_model = embedder.model_id().to_string();
        let target_dims = embedder.dims();
        {
            let mut g = self.reindex.lock().await;
            if g.running {
                return Ok(false);
            }
            g.running = true;
            g.errored = None;
            g.target_model = Some(target_model);
            g.target_dims = Some(target_dims);
        }
        let result = self.reindex_inner(&embedder).await.map(|_| true);
        if result.is_err() {
            // The staged table holds a sealed copy of every vector; a failed run
            // must not leave it behind.
            let conn = self.conn.lock().await;
            if let Err(error) = drop_embedding_reindex_staging(&conn) {
                tracing::warn!(
                    "spaces store: could not drop the staged embedding table: {error:#}"
                );
            }
        }
        let mut g = self.reindex.lock().await;
        g.running = false;
        if let Err(e) = &result {
            g.errored = Some(format!("{e:#}"));
        } else {
            g.target_model = None;
            g.target_dims = None;
        }
        result
    }

    async fn reindex_inner(&self, embedder: &Embedder) -> Result<bool> {
        self.index_unindexed_documents().await?;
        let model_id = embedder.model_id().to_string();
        let dims = embedder.dims();
        let old_dims = self.vec_dims.load(Ordering::SeqCst);

        // Snapshot the source rows before doing network work. The active table is
        // intentionally left untouched until every replacement vector exists.
        let snapshot: Vec<(String, i64, String, String, i64)> = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, rowid, COALESCE(ryu_open_soft('chunks.content', id, content), ''),
                        embed_model, embed_dims
                 FROM chunks ORDER BY rowid",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        // The staged table is an ordinary table of sealed vectors (bound to the
        // chunk id and the target model), swapped in with the chunk metadata in
        // one transaction.
        let rebuild_table = EMBEDDING_REBUILD_TABLE;
        {
            let conn = self.conn.lock().await;
            conn.execute_batch(&format!(
                "DROP TABLE IF EXISTS {rebuild_table};
                 CREATE TABLE {rebuild_table} (
                     chunk_id  TEXT PRIMARY KEY,
                     space_id  TEXT NOT NULL,
                     model     TEXT NOT NULL,
                     dims      INTEGER NOT NULL,
                     embedding BLOB NOT NULL
                 );"
            ))
            .context("creating staged embedding table")?;

            // Vectors the target model already produced are copied as stored: the
            // chunk id and model they are bound to do not change. A dimension
            // change cannot copy anything safely.
            if old_dims == dims {
                conn.execute(
                    &format!(
                        "INSERT INTO {rebuild_table} (chunk_id, space_id, model, dims, embedding)
                         SELECT e.chunk_id, e.space_id, e.model, e.dims, e.embedding
                         FROM chunk_embeddings e
                         JOIN chunks c ON c.id = e.chunk_id
                         WHERE c.embed_model = ?1 AND c.embed_dims = ?2
                           AND e.model = ?1 AND e.dims = ?2"
                    ),
                    params![model_id, dims as i64],
                )?;
            }
        }

        // Embed stale rows outside the SQLite mutex. If any provider request
        // fails, the staged table is discarded and the active index remains
        // searchable with the previous model.
        for batch in snapshot.chunks(64) {
            let stale: Vec<_> = batch
                .iter()
                .filter(|(_, _, _, stored_model, stored_dims)| {
                    !(old_dims == dims && stored_model == &model_id && *stored_dims == dims as i64)
                })
                .collect();
            let contents: Vec<String> = stale
                .iter()
                .map(|(_, _, content, _, _)| content.clone())
                .collect();
            let vectors = embedder.embed_batch(&contents).await?;
            let embedded: Vec<_> = stale
                .into_iter()
                .zip(vectors)
                .map(|((id, _, _, _, _), vector)| (id.clone(), vector))
                .collect();
            if embedded.is_empty() {
                continue;
            }
            let mut conn = self.conn.lock().await;
            let tx = conn.transaction()?;
            for (id, vector) in embedded {
                tx.execute(
                    &format!(
                        "INSERT OR REPLACE INTO {rebuild_table}
                             (chunk_id, space_id, model, dims, embedding)
                         SELECT id, space_id, ?2, ?3, ryu_seal_vec(id, ?2, ?4)
                         FROM chunks WHERE id = ?1"
                    ),
                    params![id, model_id, dims as i64, vec_to_bytes(&vector)],
                )?;
            }
            tx.commit()?;
        }

        let mut conn = self.conn.lock().await;
        let current: Vec<(String, i64, String)> = {
            let mut stmt = conn.prepare(
                "SELECT id, rowid, COALESCE(ryu_open_soft('chunks.content', id, content), '')
                 FROM chunks ORDER BY rowid",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let expected: Vec<(String, i64, String)> = snapshot
            .iter()
            .map(|(id, rowid, content, _, _)| (id.clone(), *rowid, content.clone()))
            .collect();
        anyhow::ensure!(
            current == expected,
            "space contents changed during embedding reindex; active index was preserved"
        );
        let staged_count: i64 =
            conn.query_row(&format!("SELECT COUNT(*) FROM {rebuild_table}"), [], |r| {
                r.get(0)
            })?;
        anyhow::ensure!(
            staged_count == snapshot.len() as i64,
            "staged embedding index is incomplete; active index was preserved"
        );

        // Swap the staged vectors and the chunk metadata together; rollback
        // keeps the previous index if any step fails.
        let tx = conn.transaction()?;
        tx.execute_batch(&format!(
            "DELETE FROM chunk_embeddings;
             INSERT INTO chunk_embeddings (chunk_id, space_id, model, dims, embedding)
                 SELECT chunk_id, space_id, model, dims, embedding FROM {rebuild_table};
             DROP TABLE {rebuild_table};"
        ))?;
        tx.execute(
            "UPDATE chunks SET embed_model = ?1, embed_dims = ?2",
            params![model_id, dims as i64],
        )?;
        tx.commit()?;
        self.vec_dims.store(dims, Ordering::SeqCst);
        Ok(true)
    }

    pub async fn apply_embedder_change(&self, embedder: Embedder) {
        let changed = {
            let g = self.embedder.lock().await;
            g.model_id() != embedder.model_id() || g.dims() != embedder.dims()
        };
        if !changed {
            let pending = self
                .reindex_status()
                .await
                .map(|status| status.pending_chunks > 0)
                .unwrap_or(false);
            if pending {
                let store = self.clone();
                tokio::spawn(async move {
                    let _ = store.reindex_all().await;
                });
            }
            return;
        }
        let store = self.clone();
        tokio::spawn(async move {
            if matches!(store.run_reindex(embedder.clone()).await, Ok(true)) {
                store.set_embedder(embedder).await;
            }
        });
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

/// Content-seal state "store" that records which root the blind tokens of
/// `spaces.db` were computed under (kept apart from the store's own items so
/// it never counts as an unfinished column migration).
const BLIND_STORE: &str = "spaces.db#blind";
const BLIND_ITEM: &str = "__blind__";

mod blind_states {
    /// Every blind token was computed under the recorded root.
    pub(crate) const OK: &str = "ok";
    /// Equality tokens are current; the term index and graph still need a
    /// rebuild (background migration).
    pub(crate) const REINDEXING: &str = "reindexing";
}

/// The recorded blind-token generation (key check value) and its state.
fn blind_generation(conn: &Connection) -> Result<Option<(Option<String>, String)>> {
    content_sqlite::ensure_state_table(conn)?;
    conn.query_row(
        &format!(
            "SELECT kcv, state FROM {} WHERE store = ?1 AND item = ?2",
            content_sqlite::STATE_TABLE
        ),
        params![BLIND_STORE, BLIND_ITEM],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .context("reading the Spaces blind-token generation")
}

fn record_blind_generation(conn: &Connection, kcv: &str, state: &str) -> Result<()> {
    content_sqlite::ensure_state_table(conn)?;
    conn.execute(
        &format!(
            "INSERT INTO {} (store, item, state, kcv, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(store, item) DO UPDATE SET
                state = excluded.state, kcv = excluded.kcv, updated_at = excluded.updated_at",
            content_sqlite::STATE_TABLE
        ),
        params![BLIND_STORE, BLIND_ITEM, state, kcv, now_millis() / 1000],
    )
    .context("recording the Spaces blind-token generation")?;
    Ok(())
}

/// Settings every `spaces.db` connection needs before it touches sealed
/// content: `secure_delete` (rewritten cells leave no plaintext behind) and
/// `temp_store = MEMORY`. Values are opened inside SQL (`ryu_open_soft` in a
/// select list), so a sort no index serves runs decrypted rows through the
/// sorter, which with file temp storage spills them to an unlinked temp file.
/// With MEMORY the sorter never writes to disk. Set it before creating TEMP
/// objects: changing `temp_store` drops them.
pub(crate) fn secure_connection(conn: &Connection) -> Result<()> {
    content_sqlite::enable_secure_delete(conn)?;
    conn.pragma_update(None, "temp_store", "MEMORY")
        .context("keeping SQLite temp storage in memory")?;
    Ok(())
}

/// Record that `spaces.db` owes a scrub (`vacuum_pending`): rows holding
/// plaintext or order-revealing data were removed, so [`content_sqlite::finish_store`]
/// (or the deferred compaction at the next start) must run. The store record
/// exists from the first open ([`content_sqlite::check_store_key`]).
fn mark_scrub_owed(conn: &Connection) -> Result<()> {
    conn.execute(
        &format!(
            "UPDATE {} SET state = ?1 WHERE store = ?2 AND item = ?3 AND state != ?1",
            content_sqlite::STATE_TABLE
        ),
        params![
            content_sqlite::states::VACUUM_PENDING,
            SPACES_STORE,
            content_sqlite::STORE_ITEM
        ],
    )
    .context("recording the Spaces scrub as owed")?;
    Ok(())
}

/// State-table item of the `spaces_terms` row format (tokens sorted by token
/// value, [`seal::term_document`]).
const TERMS_FORMAT_ITEM: &str = "format:terms";
/// State-table item of the graph row format (tokens sorted by token value per
/// chunk, [`entity_tokens`]).
const GRAPH_FORMAT_ITEM: &str = "format:graph";
/// State-table item recording that `spaces_terms` has FTS5 secure-delete on and
/// its pre-existing tombstoned postings were merged away once.
const TERMS_SECURE_ITEM: &str = "format:terms-secure";
const TERMS_SECURE_DONE: &str = "secure-delete-v1";
/// The current format of both derived indexes.
const DERIVED_FORMAT_SORTED: &str = "sorted-v1";
/// A term-index rebuild that cleared the old rows and is still refilling.
const DERIVED_FORMAT_FILLING: &str = "filling";

/// The recorded format of a derived index (`None`: written by a build that
/// stored tokens in plaintext order).
fn derived_format(conn: &Connection, item: &str) -> Result<Option<String>> {
    content_sqlite::ensure_state_table(conn)?;
    conn.query_row(
        &format!(
            "SELECT state FROM {} WHERE store = ?1 AND item = ?2",
            content_sqlite::STATE_TABLE
        ),
        params![BLIND_STORE, item],
        |row| row.get(0),
    )
    .optional()
    .context("reading the Spaces derived-index format")
}

fn set_derived_format(conn: &Connection, item: &str, state: &str) -> Result<()> {
    content_sqlite::ensure_state_table(conn)?;
    conn.execute(
        &format!(
            "INSERT INTO {} (store, item, state, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(store, item) DO UPDATE SET
                state = excluded.state, updated_at = excluded.updated_at",
            content_sqlite::STATE_TABLE
        ),
        params![BLIND_STORE, item, state, now_millis() / 1000],
    )
    .context("recording the Spaces derived-index format")?;
    Ok(())
}

/// The keyed content address of a serialized history snapshot, computed by
/// the connection's `ryu_history_hash` (registered with the store's keys).
fn history_hash(conn: &Connection, raw: &[u8]) -> Result<String> {
    conn.query_row("SELECT ryu_history_hash(?1)", params![raw], |row| {
        row.get(0)
    })
    .context("computing a history snapshot address")
}

/// State-table item of the term-index clear of a blind-token rebuild.
const REINDEX_TERMS_ITEM: &str = "reindex:terms";
/// State-table item prefix of one Space's graph rebuild cursor.
const REINDEX_GRAPH_ITEM_PREFIX: &str = "reindex:graph:";

/// The recorded cursor of one rebuild step under the key `kcv` (`None`: not
/// started under this key).
fn reindex_progress(conn: &Connection, kcv: &str, item: &str) -> Result<Option<i64>> {
    content_sqlite::ensure_state_table(conn)?;
    let cursor: Option<Option<String>> = conn
        .query_row(
            &format!(
                "SELECT cursor FROM {} WHERE store = ?1 AND item = ?2 AND kcv = ?3",
                content_sqlite::STATE_TABLE
            ),
            params![BLIND_STORE, item, kcv],
            |row| row.get(0),
        )
        .optional()
        .context("reading the Spaces rebuild progress")?;
    Ok(cursor.map(|value| value.and_then(|v| v.parse().ok()).unwrap_or(0)))
}

fn set_reindex_progress(conn: &Connection, kcv: &str, item: &str, cursor: i64) -> Result<()> {
    content_sqlite::ensure_state_table(conn)?;
    conn.execute(
        &format!(
            "INSERT INTO {} (store, item, state, cursor, kcv, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(store, item) DO UPDATE SET
                state = excluded.state, cursor = excluded.cursor, kcv = excluded.kcv,
                updated_at = excluded.updated_at",
            content_sqlite::STATE_TABLE
        ),
        params![
            BLIND_STORE,
            item,
            blind_states::REINDEXING,
            cursor.to_string(),
            kcv,
            now_millis() / 1000
        ],
    )
    .context("recording the Spaces rebuild progress")?;
    Ok(())
}

fn clear_reindex_progress(conn: &Connection) -> Result<()> {
    content_sqlite::ensure_state_table(conn)?;
    conn.execute(
        &format!(
            "DELETE FROM {} WHERE store = ?1 AND item LIKE 'reindex:%'",
            content_sqlite::STATE_TABLE
        ),
        params![BLIND_STORE],
    )
    .context("clearing the Spaces rebuild progress")?;
    Ok(())
}

/// Run `body` with `temp_store = FILE` (for `VACUUM`, whose transient copy of
/// the whole database lives in temp storage: with MEMORY a large store would
/// be copied into RAM). The connection stays on FILE afterwards and its TEMP
/// objects are gone (changing `temp_store` drops them): call
/// [`secure_connection`] again before using it for sealed reads.
pub(crate) fn with_file_temp_store<T>(
    conn: &Connection,
    body: impl FnOnce(&Connection) -> T,
) -> Result<T> {
    conn.pragma_update(None, "temp_store", "FILE")
        .context("using file temp storage for a compaction")?;
    Ok(body(conn))
}

/// Owner-only permissions on the database file (Unix).
fn restrict_db_permissions(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
    #[cfg(not(unix))]
    let _ = path;
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

/// Flatten an Excalidraw scene's text elements into a plain-text rendering so a
/// whiteboard document stays searchable like a page. The stored `source` remains
/// the raw scene JSON; this is only the embedding text. Returns an empty string
/// if `source` is not valid Excalidraw scene JSON.
fn flatten_whiteboard_source(source: &str) -> String {
    let Ok(scene) = serde_json::from_str::<serde_json::Value>(source) else {
        return String::new();
    };
    let Some(elements) = scene.get("elements").and_then(|e| e.as_array()) else {
        return String::new();
    };
    let mut parts: Vec<String> = Vec::new();
    for el in elements {
        if let Some(text) = el.get("text").and_then(|t| t.as_str()) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
        }
    }
    parts.join("\n")
}

/// Max bytes of flattened text kept from an app document's source. Bounds the
/// embedding work + row size for an arbitrarily large app-defined JSON blob.
const APP_FLATTEN_CAP: usize = 64 * 1024;

/// Flatten an app document's source into searchable text: recursively concatenate
/// every string value in the source JSON (object values + array items, at any
/// depth), newline-joined and capped at [`APP_FLATTEN_CAP`]. App docs carry
/// app-defined JSON whose shape Core can't know, so — unlike the database/
/// whiteboard flatteners — this extracts strings generically. If `source` is not
/// valid JSON it falls back to the raw text (capped) so the doc is still
/// searchable. The stored `source` is never modified; this is only the embedding
/// text.
fn flatten_app_source(source: &str) -> String {
    let mut out = String::new();
    match serde_json::from_str::<serde_json::Value>(source) {
        Ok(value) => collect_json_strings(&value, &mut out),
        // Not JSON — treat the whole source as one text blob.
        Err(_) => out.push_str(source),
    }
    if out.len() > APP_FLATTEN_CAP {
        let mut end = APP_FLATTEN_CAP;
        while end > 0 && !out.is_char_boundary(end) {
            end -= 1;
        }
        out.truncate(end);
    }
    out
}

/// Recursively append every string value found in `value` to `out`, newline-
/// separated. Object keys and non-string scalars (numbers/booleans/null) are
/// skipped — only string *values* are searchable text. Stops descending once
/// `out` has reached [`APP_FLATTEN_CAP`] to bound work on a huge/deeply-nested
/// blob (the final truncation still enforces the exact cap).
fn collect_json_strings(value: &serde_json::Value, out: &mut String) {
    if out.len() >= APP_FLATTEN_CAP {
        return;
    }
    match value {
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(trimmed);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_json_strings(item, out);
            }
        }
        serde_json::Value::Object(obj) => {
            for v in obj.values() {
                collect_json_strings(v, out);
            }
        }
        _ => {}
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

/// The historical splitter (`ChunkingStrategy::Default`), kept as the name the
/// tests and graph budget calculations use.
#[cfg(test)]
fn chunk_text(content: &str) -> Vec<String> {
    ryu_rag::splitter::legacy_word_chunks(content, CHUNK_CHAR_SIZE)
}

/// The Space's `space_vector_gen` generation (0 before its first vector write).
fn space_vector_gen(conn: &Connection, space_id: &str) -> Result<i64> {
    Ok(conn
        .query_row(
            "SELECT gen FROM space_vector_gen WHERE space_id = ?1",
            params![space_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

/// Insert a document's chunks + their vectors (and, in graph mode, the entity
/// graph). Shared by `ingest_document` and `update_document` so both paths stamp
/// the embedder identity (`embed_model`/`embed_dims`) onto every chunk.
#[allow(clippy::too_many_arguments)]
fn insert_chunks(
    tx: &rusqlite::Transaction<'_>,
    document_id: &str,
    space_id: &str,
    embedded: &[EmbeddedChunk],
    now: i64,
    model_id: &str,
    dims: usize,
    mode: RetrievalMode,
) -> Result<()> {
    if mode == RetrievalMode::Graph {
        anyhow::ensure!(
            embedded.len() <= MAX_GRAPH_CHUNKS_PER_DOCUMENT,
            "document has {} chunks; graph mode supports at most {MAX_GRAPH_CHUNKS_PER_DOCUMENT} chunks per document",
            embedded.len()
        );
        let new_rows = embedded.iter().try_fold(0usize, |total, chunk| {
            let terms = extract_entities(&chunk.content).len();
            total
                .checked_add(terms.saturating_mul(terms))
                .context("graph row estimate overflow")
        })?;
        let existing_rows: i64 = tx.query_row(
            "SELECT
               (SELECT COUNT(*) FROM graph_nodes WHERE space_id = ?1) +
               (SELECT COUNT(*) FROM graph_edges WHERE space_id = ?1)",
            params![space_id],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            (existing_rows as usize).saturating_add(new_rows) <= MAX_GRAPH_ROWS_PER_SPACE,
            "graph row budget exceeded; a Space supports at most {MAX_GRAPH_ROWS_PER_SPACE} term and co-occurrence rows"
        );
    }
    let mut chunk_ids: Vec<String> = Vec::with_capacity(embedded.len());
    for (ordinal, chunk) in embedded.iter().enumerate() {
        let chunk_id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO chunks
                 (id, document_id, space_id, ordinal, content, created_at, embed_model, embed_dims,
                  metadata)
             VALUES (?1, ?2, ?3, ?4, ryu_seal('chunks.content', ?1, ?5), ?6, ?7, ?8,
                     ryu_seal('chunks.metadata', ?1, ?9))",
            params![
                chunk_id,
                document_id,
                space_id,
                ordinal as i64,
                chunk.content,
                now,
                model_id,
                dims as i64,
                chunk.metadata
            ],
        )
        .context("inserting chunk")?;
        tx.execute(
            "INSERT INTO chunk_embeddings (chunk_id, space_id, model, dims, embedding)
             VALUES (?1, ?2, ?3, ?4, ryu_seal_vec(?1, ?3, ?5))",
            params![
                chunk_id,
                space_id,
                model_id,
                dims as i64,
                vec_to_bytes(&chunk.embedding)
            ],
        )
        .context("inserting chunk vector")?;
        chunk_ids.push(chunk_id);
    }

    if mode == RetrievalMode::Graph {
        let pairs: Vec<(&str, &str)> = chunk_ids
            .iter()
            .map(String::as_str)
            .zip(embedded.iter().map(|c| c.content.as_str()))
            .collect();
        build_graph_for_chunks(tx, space_id, &pairs)?;
    }
    Ok(())
}

/// The blind tokens of extracted entities, sorted by token value: graph rows
/// store only these (one HMAC per entity per chunk, not per edge).
///
/// [`extract_entities`] returns a chunk's terms in the order they first occur
/// in the text, and graph row ids and rowids grow with each insert, so rows
/// written in that order would let anyone with the file read each chunk's
/// token sequence back (`ORDER BY id`): word-order statistics on the tokens.
/// Sorting by token keeps only the set. Traversal is order-independent, and
/// the entity cap is applied before this, so the graph's content is unchanged.
fn entity_tokens(conn: &Connection, entities: &[String]) -> Result<Vec<String>> {
    let mut stmt = conn.prepare_cached("SELECT ryu_bi('graph.entity', ?1)")?;
    let mut tokens = entities
        .iter()
        .map(|entity| {
            stmt.query_row(params![entity], |row| row.get::<_, String>(0))
                .context("tokenizing a graph entity")
        })
        .collect::<Result<Vec<_>>>()?;
    tokens.sort_unstable();
    Ok(tokens)
}

/// Monotonic row-id source for `graph_nodes` / `graph_edges`.
///
/// # Why these two tables do not get a `Uuid::new_v4()` like everything else
///
/// Both tables declare `id TEXT PRIMARY KEY`. On a rowid table that is **not** an
/// alias for the rowid (only `INTEGER PRIMARY KEY` is); SQLite materialises it as a
/// separate `sqlite_autoindex_*` b-tree keyed by the text. So every graph row pays
/// an insertion into a second index, and with a v4 UUID that insertion lands at a
/// uniformly random point in the key space — no write locality, a dirty page per
/// row once the index outgrows the page cache, and page splits all the way down.
/// That is a per-row tax on the one table this crate writes *millions* of rows to:
/// [`build_graph_for_chunks`] emits `n·(n−1)` edges per chunk.
///
/// Ids here are also **write-only** — `grep 'FROM graph_nodes\|FROM graph_edges'`
/// returns counts, joins on `chunk_id`, and traversals on `src_entity`/`dst_entity`;
/// nothing anywhere selects, returns, or filters on `id`. It is a uniqueness token
/// and nothing else, so its *shape* is free to change as long as uniqueness holds.
///
/// The shape chosen is `{process-start millis:012x}{process nonce:010x}{seq:010x}`:
/// 32 hex characters, exactly the width of a `Uuid::simple()`, so the index does not
/// grow. It sorts ascending within a process (the counter) and across process
/// restarts (the timestamp), which turns a random-scatter insert into an append at
/// the right-hand edge of the b-tree.
///
/// **Uniqueness is not weakened, which is the constraint that matters.**
/// `INSERT OR IGNORE` on these tables is documented as inert — a colliding id would
/// silently *drop an edge*, i.e. change what the graph contains, which is precisely
/// the thing this work is not allowed to do. Within one process `(millis, nonce)` is
/// fixed and the `AtomicU64` counter makes every id distinct by construction (10 hex
/// = 1.1e12 ids, ~800× the largest graph ever measured here). Two *different*
/// processes collide only if they start in the same millisecond **and** draw the
/// same 40-bit nonce — 2⁻⁴⁰ — and Core runs one `SpaceStore` per process anyway.
/// A backwards clock step costs locality, never uniqueness.
///
/// Measured effect: see the table on [`build_graph_for_chunks`].
fn graph_row_id() -> String {
    static PREFIX: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let prefix = PREFIX.get_or_init(|| {
        let millis = now_millis().max(0) as u64;
        // Low 40 bits of a fresh v4 UUID: same entropy source as the ids this
        // replaces, drawn once instead of once per row.
        let nonce = uuid::Uuid::new_v4().as_u128() as u64 & 0xff_ffff_ffff;
        format!("{millis:012x}{nonce:010x}")
    });
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{prefix}{seq:010x}")
}

/// Counts written by one [`build_graph_for_chunks`] pass: `(nodes, edges)`.
type GraphCounts = (usize, usize);

/// Write the entity/co-occurrence graph for `chunks` (`(chunk_id, content)` pairs).
///
/// **The single definition of "what a Space's graph looks like."** Both writers go
/// through it: `insert_chunks` (ingest / document update, graph mode only) and
/// [`SpaceStore::set_retrieval_mode`] (rebuild when a Space is switched to graph).
/// It exists as one function precisely so those two cannot drift — a rebuilt graph
/// that differed from an ingested one would be invisible until a query returned
/// different chunks depending on *how* the graph happened to be built.
///
/// Extraction is [`extract_entities`]: deterministic, offline co-occurrence over
/// the chunk text. No embedder, no network, no model call.
///
/// # Cost — measured, because "no model call" is not the same as "cheap"
///
/// This used to claim the absence of a model call made the rebuild "affordable
/// enough to run inline". That was never measured, and it is wrong: the expense
/// here is not the extractor, it is the **quadratic edge fan-out** it feeds.
/// [`extract_entities`] keeps every token ≥ 3 chars that is capitalised OR longer
/// than 4 — i.e. most words of ordinary prose — and this function then emits
/// `n·(n−1)` directed edges for a chunk with `n` distinct entities.
///
/// Measured, and **re-measurable** — that matters more than the exact seconds. The
/// numbers below come from `measure_graph_rebuild_cost`, an `#[ignore]`d test in
/// this file that prints them. Re-derive rather than trust:
///
/// ```text
/// cargo test --release -p ryu-spaces measure_graph_rebuild_cost -- --ignored --nocapture --test-threads=1
/// ```
///
/// Release build, English prose, `chunk_text` output averaging ~990 chars/chunk and
/// **≈57 distinct entities/chunk** (see `PROSE`; per-chunk minima of 44 appear only
/// at the short first/last boundary chunks of a small corpus and wash out as it
/// grows — a full 1,000-char prose chunk sits at 57–58):
///
/// Two rows per size, because the interesting quantity is the **difference**: the
/// `v4` line is the original measurement, taken while `graph_nodes.id` /
/// `graph_edges.id` were `Uuid::new_v4()`; the `ordered` line is the same harness
/// after [`graph_row_id`] replaced them. Same code otherwise, same corpus.
///
/// | chunks | nodes  | edge rows | id      | in-memory db | **on-disk db** | on-disk per chunk |
/// |--------|--------|-----------|---------|--------------|----------------|-------------------|
/// |     98 |  5,638 |   318,926 | v4      |       ~0.9 s |        ~2.0 s  |            ~20 ms |
/// |     98 |  5,638 |   318,926 | ordered |       0.56 s |        0.97 s  |            ~10 ms |
/// |    392 | 22,592 | 1,279,718 | v4      |       ~4.1 s |        ~9.6 s  |            ~24 ms |
/// |    392 | 22,592 | 1,279,718 | ordered |       2.39 s |        4.35 s  |            ~11 ms |
/// |  1,566 | 90,306 | 5,117,688 | v4      |      ~18.0 s |  **46 – 87 s** |         29 – 55 ms |
/// |  1,566 | 90,306 | 5,117,688 | ordered |      10.09 s |     **16.3 s** |            ~10 ms |
///
/// The **row counts are exact and reproduce byte for byte** across runs *and across
/// the id change* — 5,638/318,926, 22,592/1,279,718, 90,306/5,117,688 came back
/// identical afterwards, which is the direct evidence that the speed-up did not cost
/// a single graph row. They are a property of the algorithm, and
/// `graph_edge_count_matches_the_quadratic_fan_out` asserts the formula behind them.
///
/// The **wall clocks are not exact**: two runs of the `v4` shape on the same
/// idle-ish laptop put the 1,566-chunk on-disk case at 87 s and 46 s. That ~2× spread
/// is the honest error bar on the old rows — and it is not mere noise, it is the
/// mechanism, since a randomly-addressed index costs whatever happens to be resident.
/// The `ordered` rows vary by ~10 %, and the two sets were taken on the same machine
/// in different sessions, so read the ratio (2.8–5.3× at the bottom row) rather than
/// subtracting seconds.
///
/// **Always compare within a session.** Free disk space moves the absolute figures
/// by roughly 2× on its own: every A/B pair quoted here and on
/// `measure_attachment_stall` was taken back to back on a volume that was ~100 %
/// full, and re-running the ordered shape once the volume had ~56 GB free landed
/// materially lower again (406 KB: 7.46 s → 3.77 s) with no code change whatsoever.
/// That is why the claim made here is a ratio and never a wall clock.
///
/// **Read the on-disk column anyway.** A real Space is a file, so on-disk is the
/// production number, and at 1,566 chunks it is still **~16 s** of uninterruptible
/// SQLite work inside ONE transaction, from one UI click. What changed is the
/// *shape*: per-chunk cost used to grow with the Space (20 → 24 → 29–55 ms) as
/// `graph_edges` and its indexes outgrew the page cache, and is now flat at ~10 ms
/// across a 16× range. A bigger Space is finally a straight multiple rather than
/// worse than one — so extrapolate linearly, which the previous version of this
/// paragraph explicitly told you not to do.
///
/// Order of magnitude — seconds to tens of seconds — is all the precision the "can
/// this block a runtime worker" question needs, and it is the precision these
/// numbers actually support. Concurrent load inflates them further.
///
/// The shape is `O(chunks × entities²)`. Both factors are bounded differently:
/// - **entities per chunk is bounded by a constant.** [`chunk_text`] appends a word
///   only while the running chunk stays under [`CHUNK_CHAR_SIZE`], so a chunk holds
///   ≲ 250 tokens of ≥ 3 chars and therefore ≤ ~250 distinct entities → ≤ ~62,250
///   edges. (`chunk_text` breaks *before* appending, so a single token longer than
///   `CHUNK_CHAR_SIZE` does produce one oversized chunk — but one giant token is
///   one entity, so it cannot inflate the fan-out.)
/// - **chunk count is NOT bounded.** It is whatever the caller hands over. That is
///   the dimension to budget for.
///
/// # Every path that can reach this function runs off the async worker
///
/// That is the checkable claim, and here is the whole set to check it against —
/// **two callers, reached from four public paths, all four of which can carry graph
/// work** (`grep 'build_graph_for_chunks('`; and `grep 'INTO graph_nodes\|INTO
/// graph_edges'` returns only this function's two prepared statements, so nothing
/// writes graph rows around it — `reindex_all` re-embeds vectors and never touches
/// the graph tables):
///
/// - caller 1 — `set_retrieval_mode_blocking`, i.e.
///   [`SpaceStore::set_retrieval_mode`]: passes **every chunk in the Space** from a
///   single UI click, with no upper bound at all.
/// - caller 2 — `insert_chunks`, itself reached from three places:
///   - [`SpaceStore::ingest_document`] and [`SpaceStore::update_document`] pass
///     **one document's** chunks — which is not a bound either, since one uploaded
///     book is one document;
///   - [`SpaceStore::create_file`] passes the file's single descriptor chunk
///     (`title` + `mime`). It used to hardcode `RetrievalMode::Vector` and so never
///     reached this function — which meant a file added to a graph-mode Space got no
///     graph rows, while `set_retrieval_mode`'s rebuild (which scans that same chunk
///     row) *did* give it some. That inconsistency is fixed; the budget note is that
///     the descriptor is **not** split by [`chunk_text`] and `title` is uncapped at
///     the HTTP/MCP entry points, so this path's fan-out is bounded by the caller's
///     filename, not by `CHUNK_CHAR_SIZE`.
///
/// All four graph-carrying paths now wrap their transaction in
/// [`tokio::task::spawn_blocking`]. Ingest used to be inline, on the reasoning that
/// "one document" was a smaller input than "a whole Space" — true, and irrelevant:
/// the per-chunk cost is this same `O(chunks × entities²)` fan-out either way, so a
/// large upload parked a runtime worker for exactly as long as its own chunk count
/// implied. `graph_ingest_does_not_occupy_the_async_worker` is the guard; it counted
/// **0** scheduler ticks against the inline shape.
///
/// (The table above is *not* a measurement of ingest — it times a cold
/// `set_retrieval_mode` rebuild over already-stored chunks, whereas ingest also
/// embeds and writes the sealed `chunk_embeddings`. Nobody has measured ingest end to end; if you
/// need its real number, measure it rather than reusing these digits.)
///
/// The per-row work is a bound-and-step on ONE prepared statement per table,
/// hoisted out of the loops: `rusqlite`'s `Transaction::execute` re-parses and
/// re-plans its SQL on every call, so the old shape paid one parse per row. A/B'd
/// in a single process over an identical 392-chunk / 1,279,718-edge corpus, run in
/// both orderings so cache warmth cannot explain the gap:
///
/// | ordering       | `execute` per row | one prepared statement |
/// |----------------|-------------------|------------------------|
/// | prepared first |            4.93 s |                 3.75 s |
/// | `execute` first|            5.03 s |                 3.88 s |
///
/// **≈23 % off**, with byte-identical output (22,592 nodes / 1,279,718 edges either
/// way). So the parse was real but never dominant: the remaining ~3.8 s is b-tree
/// insertion into `graph_edges` and its **three** indexes.
///
/// Three, not two — and the third is the interesting one. `idx_graph_edges_space_src`
/// and `idx_graph_edges_space_dst` are declared; the third is the
/// `sqlite_autoindex_*` SQLite materialises for `id TEXT PRIMARY KEY`, because only
/// an `INTEGER PRIMARY KEY` aliases the rowid. That index was invisible in the
/// schema and in the sentence this replaces, which used to end:
///
/// > *Nothing short of writing fewer rows changes the order of magnitude.*
///
/// **That was wrong, and it was wrong for the same reason "affordable enough to run
/// inline" was wrong before it: nobody had looked.** Feeding that hidden index a v4
/// UUID per row meant every insert landed at a uniformly random point in the key
/// space, so once it outgrew the page cache each row dirtied its own page. Replacing
/// the UUID with the ascending [`graph_row_id`] — same rows, same columns, same
/// counts, one fewer random write per row — took the chat-attachment path
/// **2–5× faster**, measured by `measure_attachment_stall`, A/B'd in both orderings
/// (v4 UUID → ordered → v4 UUID) so cache warmth cannot explain it:
///
/// | corpus | chunks | edge rows | v4 UUID id  | ordered id | speed-up |
/// |--------|--------|-----------|-------------|------------|----------|
/// |   8 KB |      8 |    26,106 | 236 / 129ms |  103–114ms |  ~1.2–2× |
/// |  32 KB |     33 |   104,918 | 1.89 / 0.78s|  414–488ms |  ~1.9–4× |
/// | 101 KB |    102 |   333,336 | 6.53 / 3.32s|  1.60–1.86s|  ~2–3.5× |
/// | 406 KB |    409 | 1,336,650 |19.9 / 38.4s |  7.46–7.83s|  ~2.7–5× |
///
/// Two figures in the UUID column because its run-to-run spread is ~2×, and that
/// spread is not noise — it *is* the mechanism, since the cost depends on how much
/// of a randomly-addressed index happens to be resident. The ordered column varies
/// by ~10 %. Note also that per-chunk cost stopped growing with corpus size (v4:
/// 29 → 94 ms/chunk; ordered: 13 → 19 ms/chunk): the super-linearity was the random
/// index outgrowing cache, not the algorithm.
///
/// One caveat on those numbers: they were taken against a **fresh** database. An
/// existing install's graph tables already hold random UUID keys, so ordered ids
/// cluster into one region of that key space rather than appending past its end. The
/// locality win holds — all new ids share a 22-character prefix and so hit one hot
/// region — but the upgrade case was not measured.
///
/// Unlike the table above, that A/B is a **one-off against code that no longer
/// exists** — there is no harness to re-run, because keeping one would mean keeping
/// a second copy of the graph builder in the test module, and "one definition of
/// what a Space's graph looks like" is the property this function exists to hold.
/// Take the 23 % as history explaining why the current shape was chosen, not as a
/// number to re-verify.
///
/// Extraction deliberately caps a chunk at [`MAX_EXTRACTED_GRAPH_TERMS`]. That is a
/// retrieval-quality trade: source-order terms beyond the cap cannot become graph
/// bridges, but one adversarial title or chunk also cannot create unbounded
/// quadratic rows. The multi-hop and fan-out tests pin both the retained behavior
/// and the exact `n·(n−1)` shape inside the cap.
///
/// Note on `INSERT OR IGNORE`: `graph_nodes`/`graph_edges` have no UNIQUE
/// constraint beyond their `id` primary key, and [`graph_row_id`] cannot collide
/// (see its doc), so the conflict clause never actually fires today — it is inert,
/// not a de-duplicator. Callers that may run over chunks whose rows already exist
/// MUST delete the space's rows first (as `set_retrieval_mode` does), or they will
/// double-insert. **This is the constraint any future id scheme has to satisfy**: a
/// collidable id would make the clause fire and drop an edge with no error anywhere.
///
/// # What this function still does NOT fix: it holds the global connection mutex
///
/// `SpaceStore` is one `Connection` behind one `tokio::Mutex`, and every caller
/// takes that mutex for the whole transaction. So the cost above is not merely the
/// caller's latency — it is a **node-wide stall**: while a graph-mode attachment is
/// indexed, every other Space's search, every sidebar list, every concurrent upload
/// waits. `measure_attachment_stall` measures exactly that, by racing a
/// `count_spaces()` probe against the ingest, and it reports the probe's worst
/// latency as equal to the whole call to the millisecond — i.e. 100 % of the work is
/// lock-held, at every size.
///
/// [`graph_row_id`] shrank that stall by 2–5×; it did not change its shape. Two
/// follow-ups remain, both deliberately out of scope here:
///
/// - **Batch the graph phase across several transactions**, taking the mutex per
///   batch, so the *hold* is bounded by batch size rather than by document size.
///   Cheap to describe, not cheap to land: it moves the graph write out of the chunk
///   write's transaction (a crash between them leaves chunks with a partial graph,
///   repairable only by re-asserting the retrieval mode), and because
///   `graph_nodes.chunk_id`/`graph_edges.chunk_id` are `REFERENCES chunks(id)` under
///   `PRAGMA foreign_keys = ON`, a chunk deleted by a concurrent writer between two
///   batches turns today's benign race into a hard FK failure — each batch would
///   have to re-check that its chunks still exist.
/// - **A second write connection** for ingest, so bulk graph writes stop sharing a
///   mutex with interactive reads at all. That is the structural fix; the mutex, not
///   this function, is the thing that makes one slow write everyone's problem.
///
/// [`SpaceStore::set_retrieval_mode`] is the same stall an order of magnitude worse
/// (a whole-Space rebuild from one UI click) and got the same speed-up for free —
/// 46–87 s down to 16.3 s at 1,566 chunks. Sixteen seconds of node-wide freeze is
/// still a defect; it is just no longer a minute and a half of one.
///
/// The returned counts accumulate each `execute`'s **rows-affected** return value,
/// not the number of statements issued. Those are equal today precisely because the
/// conflict clause is inert — but the counts are surfaced to callers as "how big is
/// this Space's graph", and a reported number that stops matching what is stored is
/// the second defect class this work exists to remove. Reading rows-affected makes
/// them right by construction, so adding the UNIQUE index the note above invites
/// cannot silently turn these into over-reports.
fn build_graph_for_chunks(
    tx: &rusqlite::Transaction<'_>,
    space_id: &str,
    chunks: &[(&str, &str)],
) -> Result<GraphCounts> {
    build_graph_for_chunks_with_control(tx, space_id, chunks, &|| false, &mut |_p, _n, _e| {})
}

fn update_rebuild_fingerprint(hasher: &mut Sha256, rowid: i64, id: &str, content: &str) {
    hasher.update(rowid.to_le_bytes());
    hasher.update((id.len() as u64).to_le_bytes());
    hasher.update(id.as_bytes());
    hasher.update((content.len() as u64).to_le_bytes());
    hasher.update(content.as_bytes());
}

fn build_graph_for_tables(
    tx: &rusqlite::Transaction<'_>,
    node_table: &str,
    edge_table: &str,
    space_id: &str,
    chunks: &[(&str, &str)],
    should_cancel: &dyn Fn() -> bool,
) -> Result<GraphCounts> {
    let node_sql = format!(
        "INSERT INTO {node_table} (id, space_id, entity, chunk_id) VALUES (?1, ?2, ?3, ?4)"
    );
    let edge_sql = format!(
        "INSERT INTO {edge_table} (id, space_id, src_entity, dst_entity, chunk_id)
         VALUES (?1, ?2, ?3, ?4, ?5)"
    );
    let mut node_stmt = tx.prepare(&node_sql)?;
    let mut edge_stmt = tx.prepare(&edge_sql)?;
    let mut nodes = 0usize;
    let mut edges = 0usize;
    for (chunk_id, content) in chunks {
        if should_cancel() {
            return Err(RetrievalModeCancelled.into());
        }
        let entities = entity_tokens(tx, &extract_entities(content))?;
        for entity in &entities {
            nodes += node_stmt.execute(params![graph_row_id(), space_id, entity, chunk_id])?;
        }
        for i in 0..entities.len() {
            for j in 0..entities.len() {
                if i == j {
                    continue;
                }
                edges += edge_stmt.execute(params![
                    graph_row_id(),
                    space_id,
                    &entities[i],
                    &entities[j],
                    chunk_id
                ])?;
            }
        }
        anyhow::ensure!(
            nodes.saturating_add(edges) <= MAX_GRAPH_ROWS_PER_SPACE,
            "graph row budget exceeded; a Space supports at most {MAX_GRAPH_ROWS_PER_SPACE} term and co-occurrence rows"
        );
    }
    Ok((nodes, edges))
}

fn finalize_chunked_retrieval_mode(
    conn: &mut Connection,
    space_id: &str,
    previous: RetrievalMode,
    total_chunks: usize,
    processed: usize,
    nodes: usize,
    edges: usize,
    expected_fingerprint: &str,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Option<RetrievalModeChange>> {
    let tx = conn.transaction()?;
    let mut actual = Sha256::new();
    let mut stmt = tx.prepare(
        "SELECT rowid, id, COALESCE(ryu_open_soft('chunks.content', id, content), '')
             FROM chunks WHERE space_id = ?1 ORDER BY rowid",
    )?;
    let mut rows = stmt.query(params![space_id])?;
    let mut actual_chunks = 0usize;
    while let Some(row) = rows.next()? {
        update_rebuild_fingerprint(
            &mut actual,
            row.get(0)?,
            &row.get::<_, String>(1)?,
            &row.get::<_, String>(2)?,
        );
        actual_chunks += 1;
    }
    drop(rows);
    drop(stmt);
    if should_cancel() {
        return Err(RetrievalModeCancelled.into());
    }
    if actual_chunks != total_chunks
        || processed != total_chunks
        || format!("{:x}", actual.finalize()) != expected_fingerprint
    {
        anyhow::bail!("chunks changed during retrieval-mode rebuild");
    }
    if should_cancel() {
        return Err(RetrievalModeCancelled.into());
    }
    let updated = tx.execute(
        "UPDATE spaces SET retrieval_mode = ?1, updated_at = ?2
         WHERE id = ?3 AND retrieval_mode = ?4",
        params![
            RetrievalMode::Graph.as_str(),
            now_millis(),
            space_id,
            previous.as_str()
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "space was deleted or its retrieval mode changed during rebuild"
    );
    if should_cancel() {
        return Err(RetrievalModeCancelled.into());
    }
    tx.execute(
        "DELETE FROM graph_edges WHERE space_id = ?1",
        params![space_id],
    )?;
    if should_cancel() {
        return Err(RetrievalModeCancelled.into());
    }
    tx.execute(
        "DELETE FROM graph_nodes WHERE space_id = ?1",
        params![space_id],
    )?;
    copy_staged_graph_table(
        &tx,
        "retrieval_rebuild_nodes",
        "graph_nodes",
        "id, space_id, entity, chunk_id",
        space_id,
        should_cancel,
    )?;
    copy_staged_graph_table(
        &tx,
        "retrieval_rebuild_edges",
        "graph_edges",
        "id, space_id, src_entity, dst_entity, chunk_id",
        space_id,
        should_cancel,
    )?;
    if should_cancel() {
        return Err(RetrievalModeCancelled.into());
    }
    tx.commit()?;
    Ok(Some(RetrievalModeChange {
        previous,
        mode: RetrievalMode::Graph,
        changed: previous != RetrievalMode::Graph,
        graph_rebuilt: true,
        chunks_scanned: total_chunks,
        graph_nodes: nodes,
        graph_edges: edges,
    }))
}

fn copy_staged_graph_table(
    tx: &rusqlite::Transaction<'_>,
    source_table: &str,
    destination_table: &str,
    columns: &str,
    space_id: &str,
    should_cancel: &dyn Fn() -> bool,
) -> Result<()> {
    if should_cancel() {
        return Err(RetrievalModeCancelled.into());
    }
    let sql = format!(
        "INSERT INTO {destination_table} SELECT {columns}
         FROM {source_table} WHERE space_id = ?1"
    );
    tx.execute(&sql, params![space_id])?;
    if should_cancel() {
        return Err(RetrievalModeCancelled.into());
    }
    Ok(())
}

/// Create (or empty) the staging tables of a graph retrieval-mode rebuild.
///
/// They are ordinary `main`-schema tables, not TEMP: the main connection runs
/// with `temp_store = MEMORY` (see [`secure_connection`]), and a rebuild can
/// stage up to [`MAX_GRAPH_ROWS_PER_SPACE`] rows, which must spill to disk, not
/// sit in RAM. The rows hold only ids and blind tokens (what `graph_nodes` and
/// `graph_edges` store on disk anyway), and `secure_delete` zeroes their pages
/// when they are dropped ([`cleanup_retrieval_staging`]; leftovers of a crash
/// are dropped at open).
fn create_retrieval_staging(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS main.retrieval_rebuild_nodes (
           id TEXT PRIMARY KEY, space_id TEXT NOT NULL, entity TEXT NOT NULL, chunk_id TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS main.retrieval_rebuild_edges (
           id TEXT PRIMARY KEY, space_id TEXT NOT NULL, src_entity TEXT NOT NULL,
           dst_entity TEXT NOT NULL, chunk_id TEXT NOT NULL
         );
         DELETE FROM main.retrieval_rebuild_nodes;
         DELETE FROM main.retrieval_rebuild_edges;",
    )
    .context("creating the retrieval-mode staging tables")?;
    Ok(())
}

/// Name of the sealed staging table of an embedding reindex.
const EMBEDDING_REBUILD_TABLE: &str = "chunk_embeddings_rebuild";

/// Drop the staged embedding table of a reindex that did not finish. It holds a
/// sealed copy of every chunk vector, including chunks of Spaces deleted later,
/// so it must not outlive the run. The scrub is marked owed only when a table
/// was actually there.
fn drop_embedding_reindex_staging(conn: &Connection) -> Result<()> {
    let present: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![EMBEDDING_REBUILD_TABLE],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !present {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(&format!("DROP TABLE IF EXISTS {EMBEDDING_REBUILD_TABLE};"))
        .context("dropping the staged embedding table")?;
    mark_scrub_owed(&tx)?;
    tx.commit()?;
    Ok(())
}

fn cleanup_retrieval_staging(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS main.retrieval_rebuild_nodes;
         DROP TABLE IF EXISTS main.retrieval_rebuild_edges;",
    )?;
    Ok(())
}

fn build_graph_for_chunks_with_control(
    tx: &rusqlite::Transaction<'_>,
    space_id: &str,
    chunks: &[(&str, &str)],
    should_cancel: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(usize, usize, usize),
) -> Result<GraphCounts> {
    // Prepared ONCE for the whole pass, not once per row. `Transaction::execute`
    // (what this used to call) parses + plans its SQL string on every invocation
    // and drops the statement afterwards, so a 4.7M-row rebuild paid 4.7M parses.
    let mut node_stmt = tx
        .prepare(
            "INSERT OR IGNORE INTO graph_nodes (id, space_id, entity, chunk_id)
             VALUES (?1, ?2, ?3, ?4)",
        )
        .context("preparing graph node insert")?;
    let mut edge_stmt = tx
        .prepare(
            "INSERT OR IGNORE INTO graph_edges
             (id, space_id, src_entity, dst_entity, chunk_id)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .context("preparing graph edge insert")?;

    let mut nodes = 0usize;
    let mut edges = 0usize;
    for (chunk_index, (chunk_id, chunk_content)) in chunks.iter().enumerate() {
        if should_cancel() {
            return Err(RetrievalModeCancelled.into());
        }
        let entities = entity_tokens(tx, &extract_entities(chunk_content))?;
        for entity in &entities {
            let node_id = graph_row_id();
            nodes += node_stmt
                .execute(params![node_id, space_id, entity, chunk_id])
                .context("inserting graph node")?;
        }
        for i in 0..entities.len() {
            for j in 0..entities.len() {
                if i == j {
                    continue;
                }
                let edge_id = graph_row_id();
                edges += edge_stmt
                    .execute(params![
                        edge_id,
                        space_id,
                        &entities[i],
                        &entities[j],
                        chunk_id
                    ])
                    .context("inserting graph edge")?;
            }
        }
        anyhow::ensure!(
            nodes.saturating_add(edges) <= MAX_GRAPH_ROWS_PER_SPACE,
            "graph row budget exceeded; a Space supports at most {MAX_GRAPH_ROWS_PER_SPACE} term and co-occurrence rows"
        );
        progress(chunk_index + 1, nodes, edges);
        if should_cancel() {
            return Err(RetrievalModeCancelled.into());
        }
    }
    Ok((nodes, edges))
}

/// Serialize an `f32` vector to little-endian bytes for the `vec0` BLOB binding.
// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn transient_text_embeddings_use_one_active_model_snapshot() {
        let store = SpaceStore::open_in_memory().expect("in-memory store");
        let batch = store
            .embed_texts(&["oak tree".to_owned(), "river stone".to_owned()])
            .await
            .expect("transient embedding batch");

        assert_eq!(batch.model_id, "local-hashing");
        assert_eq!(batch.dims, DEFAULT_EMBED_DIMS);
        assert_eq!(batch.embeddings.len(), 2);
        assert_eq!(batch.embeddings[0].index, 0);
        assert_eq!(batch.embeddings[1].index, 1);
        assert!(batch
            .embeddings
            .iter()
            .all(|item| item.embedding.len() == batch.dims));

        let conn = store.conn.lock().await;
        let document_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0))
            .expect("read transient store");
        assert_eq!(document_count, 0, "transient embeddings are not persisted");
    }

    #[tokio::test]
    async fn index_unindexed_documents_in_space_embeds_only_that_space() {
        let store = SpaceStore::open_in_memory().expect("in-memory store");
        let owner = DocOwner::unattributed();
        let seeded = store
            .create_space("Seeded", None, &owner)
            .await
            .expect("seeded space");
        let other = store
            .create_space("Other", None, &owner)
            .await
            .expect("other space");
        let page = store
            .import_document(
                &seeded,
                "Profile",
                "Builds things in Singapore.",
                "page",
                None,
                &owner,
            )
            .await
            .expect("import seeded page");
        let untouched = store
            .import_document(
                &other,
                "Notes",
                "Pending until reindex.",
                "page",
                None,
                &owner,
            )
            .await
            .expect("import other page");

        let indexed = store
            .index_unindexed_documents_in_space(&seeded)
            .await
            .expect("index seeded space");
        assert_eq!(indexed, 1);
        let chunk_count = |doc_id: String| {
            let store = store.clone();
            async move {
                let conn = store.conn.lock().await;
                conn.query_row(
                    "SELECT COUNT(*) FROM chunks WHERE document_id = ?1",
                    params![doc_id],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count chunks")
            }
        };
        assert!(chunk_count(page).await > 0);
        assert_eq!(chunk_count(untouched).await, 0);
        assert_eq!(
            store
                .index_unindexed_documents_in_space(&seeded)
                .await
                .expect("second pass"),
            0,
            "an indexed document is not embedded again"
        );
    }

    #[test]
    fn file_quota_is_atomic_and_replacement_excludes_current_row() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE documents (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                owner_user_id TEXT,
                org_id TEXT,
                byte_size INTEGER
            )",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO documents (id, kind, owner_user_id, org_id, byte_size)
             VALUES ('owner-file', 'file', 'alice', 'org1', ?1)",
            rusqlite::params![MAX_FILE_BYTES_PER_OWNER],
        )
        .unwrap();
        assert!(ensure_file_quota(&conn, 1, &owned("alice"), None).is_err());
        assert!(ensure_file_quota(&conn, 1, &owned("alice"), Some("owner-file")).is_ok());

        conn.execute(
            "UPDATE documents SET byte_size = ?1 WHERE id = 'owner-file'",
            rusqlite::params![MAX_FILE_BYTES_PER_NODE],
        )
        .unwrap();
        assert!(ensure_file_quota(&conn, 1, &owned("alice"), Some("owner-file")).is_ok());
        assert!(ensure_file_quota(&conn, 1, &owned("bob"), None).is_err());
    }

    fn owned(uid: &str) -> DocOwner {
        DocOwner {
            user_id: Some(uid.to_owned()),
            org_id: Some("org1".to_owned()),
        }
    }

    #[tokio::test]
    async fn import_history_persists_lifecycle_and_results() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space_id = store
            .create_space("Imports", None, &owned("alice"))
            .await
            .unwrap();
        let import = store
            .create_import_record(&space_id, "file", "people.csv", "csv", "database", 128)
            .await
            .unwrap();
        store.start_import(&import.id).await.unwrap();
        assert!(store.start_import(&import.id).await.is_err());
        let result = SpaceImportResultDocument {
            id: "doc_1".to_owned(),
            kind: "database".to_owned(),
            title: "People".to_owned(),
        };
        store
            .complete_import(&import.id, "database", &[result.clone()], 3, None)
            .await
            .unwrap();
        assert!(store
            .complete_import(&import.id, "database", &[result.clone()], 3, None)
            .await
            .is_err());
        assert!(store.fail_import(&import.id, "late failure").await.is_err());

        let history = store.list_imports(&space_id, 10).await.unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].status, "completed");
        assert_eq!(history[0].item_count, 3);
        assert_eq!(history[0].result_documents, vec![result]);
    }

    /// **ResourceKey regression (task C2, deliverable #1): behavior-preserving.**
    ///
    /// `DocOwner::from_resource_key` must produce the same `(owner_user_id, org_id)`
    /// pair the choke points write today, for every shape — including the collapse
    /// (an org-only or unattributed key yields `(None, None)`, the row an UNBOUND
    /// node stamps, so no lockout regresses). The compound address composes above
    /// the collapse and never alters the emitted pair.
    #[test]
    fn doc_owner_from_resource_key_is_behavior_preserving() {
        for (user, org) in [
            (Some("u1"), Some("acme")),
            (Some("u1"), None),
            (None, None),
            (None, Some("acme")),
        ] {
            let via_key = DocOwner::from_resource_key(&ResourceKey::owned(user, org));
            let direct = DocOwner::owned(user, org);
            assert_eq!(
                via_key.parts(),
                direct.parts(),
                "ResourceKey lowering must match DocOwner::owned for ({user:?}, {org:?})"
            );
        }

        // The UNBOUND-node row: an unattributed key is byte-identical to
        // `DocOwner::unattributed()` and writes `(None, None)`.
        let unbound = DocOwner::from_resource_key(&ResourceKey::unattributed());
        assert_eq!(unbound, DocOwner::unattributed());
        assert_eq!(unbound.parts(), (None, None));

        // Compound address composes but never changes the stamped pair.
        let compound = ResourceKey::owned(Some("u1"), Some("acme"))
            .with_session(Some("conv-9"))
            .with_project(Some("/proj"));
        assert_eq!(
            DocOwner::from_resource_key(&compound).parts(),
            DocOwner::owned(Some("u1"), Some("acme")).parts()
        );

        // Round-trip through the shared key is stable.
        let o = DocOwner::owned(Some("u1"), Some("acme"));
        assert_eq!(DocOwner::from_resource_key(&o.to_resource_key()), o);
    }

    /// Per-caller tenancy for documents (the `DOC_TENANCY_VISIBLE_PREDICATE`): on a
    /// bound node a private document is visible only to its owner in `list_documents`
    /// and in RAG `search`, while its owner keeps full access (no lockout). Driven
    /// with `DocFilter::for_caller(node_bound = true)` so no org registration is
    /// needed — the caller tenancy is passed IN.
    #[tokio::test]
    async fn documents_are_filtered_per_owner_on_bound_node() {
        let store = SpaceStore::open_in_memory().unwrap();
        // Alice owns the space + one document; Bob owns another document in it.
        let space = store
            .create_space("Team", None, &owned("alice"))
            .await
            .unwrap();
        let alice_doc = store
            .ingest_document(
                &space,
                "Alice secret",
                "the launch code is 42",
                &owned("alice"),
            )
            .await
            .unwrap();
        let bob_doc = store
            .ingest_document(&space, "Bob secret", "the launch code is 42", &owned("bob"))
            .await
            .unwrap();

        // list_documents: Bob sees only his own doc; Alice only hers.
        let bob_view = store
            .list_documents(
                &space,
                DocFilter::for_caller(Some("bob"), Some("org1"), true),
            )
            .await
            .unwrap();
        let bob_ids: Vec<&str> = bob_view.iter().map(|d| d.id.as_str()).collect();
        assert!(bob_ids.contains(&bob_doc.as_str()));
        assert!(
            !bob_ids.contains(&alice_doc.as_str()),
            "Bob must not see Alice's private document"
        );

        let alice_view = store
            .list_documents(
                &space,
                DocFilter::for_caller(Some("alice"), Some("org1"), true),
            )
            .await
            .unwrap();
        let alice_ids: Vec<&str> = alice_view.iter().map(|d| d.id.as_str()).collect();
        assert!(
            alice_ids.contains(&alice_doc.as_str()),
            "no lockout: Alice reaches her own document"
        );
        assert!(!alice_ids.contains(&bob_doc.as_str()));

        // Spaces RAG search: a chunk from Alice's doc never surfaces for Bob.
        let bob_hits = store
            .search_ext(
                &space,
                "launch code",
                10,
                Some(false),
                DocFilter::for_caller(Some("bob"), Some("org1"), true),
            )
            .await
            .unwrap();
        assert!(
            bob_hits.iter().all(|c| c.document_id != alice_doc),
            "RAG search must not leak Alice's document chunk to Bob"
        );
        // Unrestricted (unbound / in-process): both documents visible.
        let all = store
            .list_documents(&space, DocFilter::unrestricted())
            .await
            .unwrap();
        assert_eq!(
            all.len(),
            2,
            "unbound/in-process listing sees every document"
        );
    }

    /// By-id ACL link: the document choke point STAMPS the owner, and
    /// `get_access_meta` (what `require_resource_read`/`_write` read) reads it back —
    /// so the pre-tested `resource_access` matrix (mod.rs `resource_acl_tests`)
    /// actually bites on a real document. A system space's document is still owned by
    /// its creator (only the SPACE is shared), and an unattributed create leaves the
    /// row NULL (which the by-id ACL denies on a bound node until backfill).
    #[tokio::test]
    async fn create_stamps_owner_for_the_by_id_acl() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("S", None, &owned("alice"))
            .await
            .unwrap();

        let alice_doc = store
            .create_page(&space, "Owned", &owned("alice"))
            .await
            .unwrap();
        let meta = store.get_access_meta(&alice_doc).await.unwrap().unwrap();
        assert_eq!(meta.owner_user_id.as_deref(), Some("alice"));
        assert_eq!(meta.org_id.as_deref(), Some("org1"));
        assert_eq!(meta.visibility, "private");

        // An unattributed create (unbound / system path) leaves the row NULL-owner —
        // exactly what `resource_access` grants on an unbound node and denies (until
        // backfill) on a bound one.
        let anon_doc = store
            .create_page(&space, "Legacy", &DocOwner::unattributed())
            .await
            .unwrap();
        let anon_meta = store.get_access_meta(&anon_doc).await.unwrap().unwrap();
        assert!(anon_meta.owner_user_id.is_none());
        assert!(anon_meta.org_id.is_none());
    }

    #[tokio::test]
    async fn document_access_updates_visibility_and_team() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("S", None, &owned("alice"))
            .await
            .unwrap();
        let doc = store
            .create_page(&space, "Shared", &owned("alice"))
            .await
            .unwrap();

        assert!(store
            .set_document_access(&doc, "team", Some("team-1"))
            .await
            .unwrap());
        let team = store.get_access_meta(&doc).await.unwrap().unwrap();
        assert_eq!(team.visibility, "team");
        assert_eq!(team.team_id.as_deref(), Some("team-1"));

        store.set_document_access(&doc, "org", None).await.unwrap();
        let org = store.get_access_meta(&doc).await.unwrap().unwrap();
        assert_eq!(org.visibility, "org");
        assert!(org.team_id.is_none());

        assert!(store.set_document_access(&doc, "team", None).await.is_err());
        assert!(store
            .set_document_access(&doc, "unknown", None)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn team_visibility_filters_list_and_search_to_the_team() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("S", None, &owned("alice"))
            .await
            .unwrap();
        let doc = store
            .create_page(&space, "Team note", &owned("alice"))
            .await
            .unwrap();
        store
            .set_document_access(&doc, "team", Some("team-1"))
            .await
            .unwrap();

        let wrong_team = store
            .list_documents(
                &space,
                DocFilter::for_caller_with_team(Some("bob"), Some("org1"), Some("team-2"), true),
            )
            .await
            .unwrap();
        assert!(wrong_team.is_empty());

        let right_team = store
            .list_documents(
                &space,
                DocFilter::for_caller_with_team(Some("bob"), Some("org1"), Some("team-1"), true),
            )
            .await
            .unwrap();
        assert_eq!(
            right_team.iter().map(|d| &d.id).collect::<Vec<_>>(),
            vec![&doc]
        );

        let both_orders = [vec!["team-2", "team-1"], vec!["team-1", "team-2"]];
        for teams in both_orders {
            let visible = store
                .list_documents(
                    &space,
                    DocFilter::for_caller_with_teams(Some("bob"), Some("org1"), &teams, true),
                )
                .await
                .unwrap();
            assert_eq!(
                visible
                    .iter()
                    .map(|document| &document.id)
                    .collect::<Vec<_>>(),
                vec![&doc],
                "all verified teams must be honored regardless of JWT ordering"
            );
        }
    }

    #[tokio::test]
    async fn graph_search_cannot_bridge_from_a_private_term_to_a_shared_document() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space_with_mode("Private graph", None, RetrievalMode::Graph, &owned("alice"))
            .await
            .unwrap();
        let private_document = store
            .ingest_document(&space, "Private", "Secret Acme", &owned("alice"))
            .await
            .unwrap();
        let shared_document = store
            .ingest_document(&space, "Shared", "Acme public", &owned("alice"))
            .await
            .unwrap();
        store
            .set_document_access(&shared_document, "org", None)
            .await
            .unwrap();

        let bob_filter = DocFilter::for_caller(Some("bob"), Some("org1"), true);
        let hits = store
            .search_ext(&space, "Secret", 10, Some(false), bob_filter)
            .await
            .unwrap();
        assert!(
            hits.is_empty(),
            "a private term must not seed visible graph work"
        );

        let alice_hits = store
            .search_ext(
                &space,
                "Secret",
                10,
                Some(false),
                DocFilter::for_caller(Some("alice"), Some("org1"), true),
            )
            .await
            .unwrap();
        assert!(alice_hits
            .iter()
            .any(|match_| match_.document_id == private_document));
        assert!(alice_hits
            .iter()
            .any(|match_| match_.document_id == shared_document));
    }

    #[tokio::test]
    async fn vector_search_filters_before_the_candidate_limit() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Private vectors", None, &owned("alice"))
            .await
            .unwrap();
        for index in 0..5 {
            store
                .ingest_document(
                    &space,
                    &format!("Private {index}"),
                    "Exact private needle",
                    &owned("alice"),
                )
                .await
                .unwrap();
        }
        let visible_document = store
            .ingest_document(
                &space,
                "Shared",
                "A public note with different wording",
                &owned("alice"),
            )
            .await
            .unwrap();
        store
            .set_document_access(&visible_document, "org", None)
            .await
            .unwrap();

        let hits = store
            .search_ext(
                &space,
                "Exact private needle",
                1,
                Some(false),
                DocFilter::for_caller(Some("bob"), Some("org1"), true),
            )
            .await
            .unwrap();
        assert_eq!(
            hits.iter()
                .map(|match_| &match_.document_id)
                .collect::<Vec<_>>(),
            vec![&visible_document],
            "private nearest neighbours must not consume the visible candidate budget"
        );
    }

    /// list_spaces filters by owner too, but system spaces (`system = 1`) stay
    /// shared to every member (the `OR s.system = 1` predicate branch).
    #[tokio::test]
    async fn list_spaces_filters_owner_but_keeps_system_shared() {
        let store = SpaceStore::open_in_memory().unwrap();
        let alice_space = store
            .create_space("Alice", None, &owned("alice"))
            .await
            .unwrap();
        let _bob_space = store
            .create_space("Bob", None, &owned("bob"))
            .await
            .unwrap();
        let bob_owned_space = store
            .create_space("Bob's private space", None, &owned("bob"))
            .await
            .unwrap();
        store
            .create_page(&bob_owned_space, "Alice's hidden document", &owned("alice"))
            .await
            .unwrap();
        let sys = store.ensure_system_space("Artifacts", None).await.unwrap();

        let bob_view = store
            .list_spaces(DocFilter::for_caller(Some("bob"), Some("org1"), true))
            .await
            .unwrap();
        let ids: Vec<&str> = bob_view.iter().map(|s| s.id.as_str()).collect();
        assert!(
            !ids.contains(&alice_space.as_str()),
            "Bob must not see Alice's private space"
        );
        assert!(
            ids.contains(&sys.as_str()),
            "system space stays shared to every member"
        );
        let bob_private = bob_view
            .iter()
            .find(|space| space.id == bob_owned_space)
            .expect("Bob's private space is visible to Bob");
        assert_eq!(
            bob_private.document_count, 0,
            "a Space summary must count only documents visible to the caller"
        );
    }

    #[tokio::test]
    async fn shared_space_visibility_is_inherited_by_pages_and_space_listing() {
        let store = SpaceStore::open_in_memory().unwrap();
        let shared_space = store
            .create_space_with_mode_and_visibility(
                "Team notes",
                None,
                RetrievalMode::Vector,
                &owned("alice"),
                "org",
                None,
            )
            .await
            .unwrap();
        let private_space = store
            .create_space("Alice only", None, &owned("alice"))
            .await
            .unwrap();
        let shared_page = store
            .create_page(&shared_space, "Roadmap", &owned("alice"))
            .await
            .unwrap();
        let private_page = store
            .create_page(&private_space, "Private plan", &owned("alice"))
            .await
            .unwrap();

        let bob_spaces = store
            .list_spaces(DocFilter::for_caller(Some("bob"), Some("org1"), true))
            .await
            .unwrap();
        assert!(bob_spaces.iter().any(|space| space.id == shared_space));
        assert!(bob_spaces.iter().all(|space| space.id != private_space));
        let shared = bob_spaces
            .iter()
            .find(|space| space.id == shared_space)
            .expect("shared space is visible to the organization");
        assert_eq!(shared.visibility, "org");

        let bob_pages = store
            .list_documents(
                &shared_space,
                DocFilter::for_caller(Some("bob"), Some("org1"), true),
            )
            .await
            .unwrap();
        assert!(bob_pages.iter().any(|page| page.id == shared_page));

        let private_pages = store
            .list_documents(
                &private_space,
                DocFilter::for_caller(Some("bob"), Some("org1"), true),
            )
            .await
            .unwrap();
        assert!(private_pages.iter().all(|page| page.id != private_page));

        let effective = store
            .get_access_meta(&shared_page)
            .await
            .unwrap()
            .expect("shared page has ACL metadata");
        assert_eq!(effective.visibility, "org");

        store
            .set_visibility(&shared_space, "private", None, true)
            .await
            .unwrap();
        let bob_after_private = store
            .list_spaces(DocFilter::for_caller(Some("bob"), Some("org1"), true))
            .await
            .unwrap();
        assert!(bob_after_private
            .iter()
            .all(|space| space.id != shared_space));
        let no_pages = store
            .list_documents(
                &shared_space,
                DocFilter::for_caller(Some("bob"), Some("org1"), true),
            )
            .await
            .unwrap();
        assert!(no_pages.is_empty());
    }

    #[tokio::test]
    async fn space_visibility_validates_team_scope_and_protects_system_spaces() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Team notes", None, &owned("alice"))
            .await
            .unwrap();

        assert!(store
            .set_visibility(&space, "team", None, true)
            .await
            .is_err());
        assert!(store
            .set_visibility(&space, "team", Some("team-1"), true)
            .await
            .unwrap());
        let listed = store
            .list_spaces(DocFilter::for_caller_with_team(
                Some("bob"),
                Some("org1"),
                Some("team-1"),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(listed[0].visibility, "team");
        assert_eq!(listed[0].team_id.as_deref(), Some("team-1"));
        assert!(store
            .list_spaces(DocFilter::for_caller_with_team(
                Some("bob"),
                Some("org1"),
                Some("team-2"),
                true,
            ))
            .await
            .unwrap()
            .iter()
            .all(|listed_space| listed_space.id != space));

        assert!(store
            .set_visibility(&space, "private", None, false)
            .await
            .is_err());
        assert!(store
            .set_visibility(&space, "private", None, true)
            .await
            .unwrap());

        let system = store.ensure_system_space("Artifacts", None).await.unwrap();
        assert!(store
            .set_visibility(&system, "private", None, true)
            .await
            .is_err());
    }

    /// The link graph must not leak another member's private document node, title,
    /// or link topology on a bound node — and must be byte-identical (full graph)
    /// on an unbound / unrestricted call. Twin of
    /// `list_spaces_filters_owner_but_keeps_system_shared` for `build_graph`.
    #[tokio::test]
    async fn graph_filters_private_nodes_and_edges_on_bound_node() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Shared", None, &owned("alice"))
            .await
            .unwrap();
        // Alice's private page links to Bob's private page.
        let alice_doc = store
            .create_page(&space, "AlicePriv", &owned("alice"))
            .await
            .unwrap();
        let bob_doc = store
            .create_page(&space, "BobPriv", &owned("bob"))
            .await
            .unwrap();
        store
            .update_document(&alice_doc, "AlicePriv", "Secret note about [[BobPriv]].")
            .await
            .unwrap();

        // Bound node, viewed as Bob: Alice's node/title and the edge originating
        // from Alice's body must be absent.
        let bob_graph = store
            .space_graph(
                &space,
                DocFilter::for_caller(Some("bob"), Some("org1"), true),
            )
            .await
            .unwrap();
        assert!(
            bob_graph.nodes.iter().all(|n| n.id != alice_doc),
            "Bob must not see Alice's private document node"
        );
        assert!(
            bob_graph.nodes.iter().all(|n| n.title != "AlicePriv"),
            "Bob must not see Alice's private document title"
        );
        assert!(
            bob_graph.edges.iter().all(|e| e.src != alice_doc),
            "no edge may originate from a document Bob cannot read"
        );
        assert!(
            bob_graph.nodes.iter().any(|n| n.id == bob_doc),
            "Bob still sees his own document"
        );

        // Unrestricted (unbound / in-process): the full graph, both nodes + the edge.
        let full = store
            .space_graph(&space, DocFilter::unrestricted())
            .await
            .unwrap();
        assert!(full.nodes.iter().any(|n| n.id == alice_doc));
        assert!(full.nodes.iter().any(|n| n.id == bob_doc));
        assert!(
            full.edges
                .iter()
                .any(|e| e.src == alice_doc && e.dst == bob_doc),
            "unrestricted graph keeps the cross-owner edge"
        );
    }

    /// `ensure_named_space` is the get-or-create a headless writer (a turn hook) needs:
    /// idempotent by name, scoped to the caller's tenancy, and an ORDINARY space —
    /// never a system one, or a plugin's ledger would become undeletable and would
    /// survive the danger-zone clear the user asked for.
    #[tokio::test]
    async fn ensure_named_space_is_idempotent_and_tenancy_scoped() {
        let store = SpaceStore::open_in_memory().unwrap();

        let first = store
            .ensure_named_space("Mistakes", Some("rules"), &owned("alice"))
            .await
            .unwrap();
        let again = store
            .ensure_named_space("Mistakes", None, &owned("alice"))
            .await
            .unwrap();
        assert_eq!(first, again, "the same owner resolves the same space");

        // A second member's Space of the same name is a DIFFERENT space: resolving by
        // name alone would route one member's writes into the other's Space, which the
        // by-id ACL would then refuse to show them.
        let bob = store
            .ensure_named_space("Mistakes", None, &owned("bob"))
            .await
            .unwrap();
        assert_ne!(first, bob);

        let meta = store.space_access_meta(&first).await.unwrap().unwrap();
        assert_eq!(meta.owner_user_id.as_deref(), Some("alice"));
        assert!(!meta.system, "a plugin's ledger must stay deletable");

        // It really is a Space: an app-owned document can be created in it and listed
        // back, which is the whole point of resolving the id.
        let doc = store
            .app_create_doc(
                "@ryu/no-more-mistakes",
                &first,
                "Never run git stash",
                &owned("alice"),
            )
            .await
            .unwrap();
        let docs = store
            .app_list_docs("@ryu/no-more-mistakes", &first)
            .await
            .unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].id, doc);
        assert_eq!(docs[0].title, "Never run git stash");
    }

    /// `space_access_meta` reads back the owner the choke point stamped, and marks a
    /// system space so the `delete_space` gate can fail it closed on a bound node.
    #[tokio::test]
    async fn space_access_meta_reads_owner_and_system_flag() {
        let store = SpaceStore::open_in_memory().unwrap();
        let alice_space = store
            .create_space("Alice", None, &owned("alice"))
            .await
            .unwrap();
        let sys = store.ensure_system_space("Artifacts", None).await.unwrap();

        let meta = store
            .space_access_meta(&alice_space)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(meta.owner_user_id.as_deref(), Some("alice"));
        assert_eq!(meta.org_id.as_deref(), Some("org1"));
        assert!(!meta.system);

        let sys_meta = store.space_access_meta(&sys).await.unwrap().unwrap();
        assert!(sys_meta.system, "system space is flagged");
        assert!(
            sys_meta.owner_user_id.is_none(),
            "system space has no owner"
        );

        assert!(store.space_access_meta("nope").await.unwrap().is_none());
    }

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
        store
            .create_space("Notes", None, &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .create_space("Research", None, &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .create_space(MEETINGS_SPACE_NAME, None, &DocOwner::unattributed())
            .await
            .unwrap();

        // The hidden Meetings space is excluded from the count.
        assert_eq!(store.count_spaces().await.unwrap(), 2);

        // Clear removes only the two user spaces, leaving Meetings intact.
        let removed = store.clear_all_spaces().await.unwrap();
        assert_eq!(removed, 2);
        assert_eq!(store.count_spaces().await.unwrap(), 0);
        let remaining = store.list_spaces(DocFilter::unrestricted()).await.unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].name, MEETINGS_SPACE_NAME);
    }

    #[test]
    fn blob_store_round_trips_and_dedupes() {
        // sha256 is deterministic and content-addressed.
        let root = std::env::temp_dir().join(format!("ryu-spaces-blob-{}", uuid::Uuid::new_v4()));
        let bytes = b"hello artifact";
        let cipher = SpacesKeys::from_root(&[7; 32]).blob_cipher;
        let sha1 = seal::write_blob(&root, &cipher, bytes).unwrap();
        let sha2 = seal::write_blob(&root, &cipher, bytes).unwrap();
        assert_eq!(sha1, sha2, "identical bytes dedupe to one blob");
        assert_eq!(sha1, sha256_hex(bytes), "returned sha matches content hash");
        let read = seal::read_blob(&root, &cipher, &sha1).unwrap();
        assert_eq!(read.as_deref(), Some(&bytes[..]));
        // Unknown sha reads as absent, not error.
        assert!(seal::read_blob(&root, &cipher, "0".repeat(64).as_str())
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn file_document_and_system_space_are_governed() {
        let store = SpaceStore::open_in_memory().unwrap();

        // A system space is created, flagged, and excluded from the user count.
        let artifacts = store
            .ensure_system_space("Artifacts", Some("Generated files"))
            .await
            .unwrap();
        // ensure_* is idempotent: same name reuses the row.
        let again = store.ensure_system_space("Artifacts", None).await.unwrap();
        assert_eq!(artifacts, again);
        store
            .create_space("Notes", None, &DocOwner::unattributed())
            .await
            .unwrap();
        assert_eq!(
            store.count_spaces().await.unwrap(),
            1,
            "system space uncounted"
        );

        // A file document stores its bytes in the blob store and stays retrievable.
        let png = b"\x89PNG\r\n\x1a\n binary artifact bytes";
        let doc = store
            .create_file(
                &artifacts,
                "chart.png",
                png,
                "image/png",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        let meta = store.get_file_meta(&doc).await.unwrap().unwrap();
        assert_eq!(meta.mime, "image/png");
        assert_eq!(meta.byte_size, png.len() as i64);
        assert!(!meta.sha256.is_empty());
        let (mime, bytes) = store.read_file_blob(&doc).await.unwrap().unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, png);

        // A system space cannot be deleted individually.
        assert!(store.delete_space(&artifacts).await.is_err());
        // And bulk-clear leaves it intact.
        store.clear_all_spaces().await.unwrap();
        let remaining = store.list_spaces(DocFilter::unrestricted()).await.unwrap();
        assert!(remaining.iter().any(|s| s.id == artifacts));
    }

    #[tokio::test]
    async fn rejected_file_quota_writes_no_new_blob_bytes() {
        let store = SpaceStore::open_in_memory().unwrap();
        let owner = owned("alice");
        let space = store.create_space("Files", None, &owner).await.unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "INSERT INTO documents
                 (id, space_id, title, created_at, source, updated_at, kind,
                  byte_size, owner_user_id, org_id)
                 VALUES ('quota-fill', ?1, 'existing', 1, '', 1, 'file', ?2, 'alice', 'org1')",
                rusqlite::params![space, MAX_FILE_BYTES_PER_OWNER],
            )
            .unwrap();
        }
        let bytes = b"rejected-new-blob";
        let path = blob_path(&store.blob_root, &sha256_hex(bytes));
        assert!(!path.exists());
        let error = store
            .create_file(&space, "rejected.txt", bytes, "text/plain", &owner)
            .await
            .expect_err("quota-full upload must fail");
        assert!(error.to_string().contains("file quota exceeded"));
        assert!(
            !path.exists(),
            "quota rejection must not persist blob bytes"
        );
    }

    #[tokio::test]
    async fn rejected_file_replacement_keeps_old_blob_and_writes_no_new_bytes() {
        let store = SpaceStore::open_in_memory().unwrap();
        let owner = owned("alice");
        let space = store.create_space("Files", None, &owner).await.unwrap();
        let doc = store
            .create_file(&space, "kept.txt", b"old", "text/plain", &owner)
            .await
            .unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "INSERT INTO documents
                 (id, space_id, title, created_at, source, updated_at, kind,
                  byte_size, owner_user_id, org_id)
                 VALUES ('quota-fill', ?1, 'existing', 1, '', 1, 'file', ?2, 'alice', 'org1')",
                rusqlite::params![space, MAX_FILE_BYTES_PER_OWNER - 1],
            )
            .unwrap();
        }
        let replacement = b"new content exceeding the remaining byte";
        let path = blob_path(&store.blob_root, &sha256_hex(replacement));
        assert!(!path.exists());
        let error = store
            .replace_file_blob(&doc, replacement, "text/plain")
            .await
            .expect_err("quota-full replacement must fail");
        assert!(error.to_string().contains("file quota exceeded"));
        assert!(!path.exists());
        let (_, current_bytes) = store.read_file_blob(&doc).await.unwrap().unwrap();
        assert_eq!(current_bytes, b"old");
    }

    #[tokio::test]
    async fn replacing_a_file_blob_updates_bytes_and_resets_stale_extracted_chunks() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Files", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let doc = store
            .create_file(
                &space,
                "budget.xlsx",
                b"first revision",
                "application/octet-stream",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        store
            .replace_file_chunks(&doc, "stale extracted worksheet prose")
            .await
            .unwrap();

        let replacement = b"second revision";
        let meta = store
            .replace_file_blob(
                &doc,
                replacement,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
            .await
            .unwrap();
        assert_eq!(meta.byte_size, replacement.len() as i64);
        assert_eq!(
            meta.mime,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        let (mime, bytes) = store.read_file_blob(&doc).await.unwrap().unwrap();
        assert_eq!(mime, meta.mime);
        assert_eq!(bytes, replacement);

        let document = store.get_document(&doc).await.unwrap().unwrap();
        assert_eq!(document.source, format!("budget.xlsx\n{}", meta.mime));
        assert_eq!(
            document.chunk_count, 1,
            "saving new bytes must discard chunks extracted from the old revision"
        );
    }

    #[tokio::test]
    async fn replacing_a_blob_refuses_non_file_documents() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Pages", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let page = store
            .create_page(&space, "Notes", &DocOwner::unattributed())
            .await
            .unwrap();
        let error = store
            .replace_file_blob(&page, b"nope", "application/octet-stream")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("file document"));
    }

    #[tokio::test]
    async fn page_create_edit_search_delete() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Notes", None, &DocOwner::unattributed())
            .await
            .unwrap();

        // New empty page.
        let doc = store
            .create_page(&space, "Untitled", &DocOwner::unattributed())
            .await
            .unwrap();
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
    async fn global_lexical_search_matches_metadata_source_and_respects_tenancy() {
        let store = SpaceStore::open_in_memory().unwrap();
        let owner = DocOwner::owned(Some("alice"), Some("org-1"));
        let space = store
            .create_space("Research Notes", Some("Quarterly planning"), &owner)
            .await
            .unwrap();
        let doc = store
            .create_page(&space, "Zephyr roadmap", &owner)
            .await
            .unwrap();
        store
            .update_document(
                &doc,
                "Zephyr roadmap",
                "The launch checklist covers the migration window.",
            )
            .await
            .unwrap();

        let source_hits = store
            .search_documents_lexical(
                "migration window",
                10,
                DocFilter::for_caller(Some("alice"), Some("org-1"), true),
            )
            .await
            .unwrap();
        assert_eq!(source_hits.len(), 1);
        assert_eq!(source_hits[0].document_id, doc);
        assert_eq!(source_hits[0].title, "Zephyr roadmap");
        assert_eq!(source_hits[0].space_name, "Research Notes");
        assert!(source_hits[0].updated_at >= source_hits[0].created_at);

        let metadata_hits = store
            .search_documents_lexical(
                "Quarterly",
                10,
                DocFilter::for_caller(Some("alice"), Some("org-1"), true),
            )
            .await
            .unwrap();
        assert_eq!(metadata_hits.len(), 1);
        assert_eq!(metadata_hits[0].document_id, doc);

        let hidden_hits = store
            .search_documents_lexical(
                "migration",
                10,
                DocFilter::for_caller(Some("bob"), Some("org-1"), true),
            )
            .await
            .unwrap();
        assert!(hidden_hits.is_empty());
    }

    // ── Wiki page-links: extraction, backlinks, graph, link-expansion ───────────

    #[test]
    fn performance_doc_link_patterns_are_reused() {
        let source = "[[Design]] [[Design|Alias]] [[@Ada]] [Doc](<wikilink:Two%20Words>)";
        let expected = extract_doc_links(source);
        let start = std::time::Instant::now();
        for _ in 0..100 {
            // Original path compiled these same two patterns on every save.
            std::hint::black_box(
                regex::Regex::new(r"\[\[\s*(@)?\s*([^\[\]|]+?)\s*(?:\|[^\[\]]*)?\]\]").unwrap(),
            );
            std::hint::black_box(
                regex::Regex::new(r"\]\(\s*<?\s*(wikilink|mention):([^)>]+?)\s*>?\s*\)").unwrap(),
            );
        }
        let compilation = start.elapsed();
        let start = std::time::Instant::now();
        for _ in 0..100 {
            assert_eq!(extract_doc_links(source), expected);
        }
        let reused_extraction = start.elapsed();
        eprintln!("100 saves: removed regex compilation={compilation:?}, warm full extraction={reused_extraction:?}");
    }

    #[test]
    fn extract_doc_links_parses_wiki_and_mention() {
        let src = "Intro. See [[Design Doc]] and [[Roadmap|our plan]].\n\
                   Ping [[@Alice]] about it. Repeat [[Design Doc]] again.";
        let links = extract_doc_links(src);
        // Dedup by (title, kind): Design Doc appears twice → one entry.
        assert_eq!(links.len(), 3);
        assert!(links
            .iter()
            .any(|l| l.title == "Design Doc" && l.kind == "wiki"));
        assert!(links
            .iter()
            .any(|l| l.title == "Roadmap" && l.kind == "wiki"));
        assert!(links
            .iter()
            .any(|l| l.title == "Alice" && l.kind == "mention"));
    }

    #[test]
    fn extract_doc_links_parses_editor_link_forms() {
        // The editor's canonical serialization: markdown links with a scheme.
        let src = "See [Design Doc](<wikilink:Design Doc>) and \
                   [@Bob](mention:Bob) plus [Encoded](<wikilink:Two%20Words>).";
        let links = extract_doc_links(src);
        assert!(links
            .iter()
            .any(|l| l.title == "Design Doc" && l.kind == "wiki"));
        assert!(links
            .iter()
            .any(|l| l.title == "Bob" && l.kind == "mention"));
        // Percent-encoding is decoded back to the real title.
        assert!(links
            .iter()
            .any(|l| l.title == "Two Words" && l.kind == "wiki"));
    }

    #[tokio::test]
    async fn wiki_links_resolve_and_backlinks_round_trip() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Wiki", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let a = store
            .create_page(&space, "Alpha", &DocOwner::unattributed())
            .await
            .unwrap();
        let b = store
            .create_page(&space, "Bravo", &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .update_document(&a, "Alpha", "Alpha links to [[Bravo]] here.")
            .await
            .unwrap();

        // Outgoing link from A resolves to B.
        let out = store.get_outgoing_links(&a).await.unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].dst_doc_id.as_deref(), Some(b.as_str()));
        assert_eq!(out[0].dst_title, "Bravo");

        // Backlink on B points to A with a snippet.
        let back = store
            .get_backlinks(&b, DocFilter::unrestricted())
            .await
            .unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].src_doc_id, a);
        assert_eq!(back[0].src_title.as_deref(), Some("Alpha"));
        assert!(back[0].snippet.as_deref().unwrap_or("").contains("Bravo"));
    }

    #[tokio::test]
    async fn backlinks_hide_private_source_documents_from_other_callers() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Shared target", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let private_source = store
            .create_page(
                &space,
                "Alice secret",
                &DocOwner::owned(Some("alice"), Some("org1")),
            )
            .await
            .unwrap();
        let target = store
            .create_page(
                &space,
                "Team page",
                &DocOwner::owned(Some("bob"), Some("org1")),
            )
            .await
            .unwrap();
        store
            .update_document(
                &private_source,
                "Alice secret",
                "private launch detail links to [[Team page]]",
            )
            .await
            .unwrap();

        let alice = store
            .get_backlinks(
                &target,
                DocFilter::for_caller(Some("alice"), Some("org1"), true),
            )
            .await
            .unwrap();
        assert_eq!(alice.len(), 1);
        assert_eq!(alice[0].src_doc_id, private_source);

        let bob = store
            .get_backlinks(
                &target,
                DocFilter::for_caller(Some("bob"), Some("org1"), true),
            )
            .await
            .unwrap();
        assert!(
            bob.is_empty(),
            "private source metadata must not leak through backlinks"
        );
    }

    #[tokio::test]
    async fn pending_link_resolves_when_target_created() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Wiki", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let a = store
            .create_page(&space, "Alpha", &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .update_document(&a, "Alpha", "Refers to [[Ghost]] which is missing.")
            .await
            .unwrap();

        // Unresolved → pending link + a pending node in the graph.
        let out = store.get_outgoing_links(&a).await.unwrap();
        assert_eq!(out.len(), 1);
        assert!(out[0].dst_doc_id.is_none());
        let graph = store
            .space_graph(&space, DocFilter::unrestricted())
            .await
            .unwrap();
        assert!(graph.nodes.iter().any(|n| n.pending && n.title == "Ghost"));

        // Creating the target page back-fills the pending link.
        let ghost = store
            .create_page(&space, "Ghost", &DocOwner::unattributed())
            .await
            .unwrap();
        let out = store.get_outgoing_links(&a).await.unwrap();
        assert_eq!(out[0].dst_doc_id.as_deref(), Some(ghost.as_str()));
        let graph = store
            .space_graph(&space, DocFilter::unrestricted())
            .await
            .unwrap();
        assert!(!graph.nodes.iter().any(|n| n.pending));
    }

    #[tokio::test]
    async fn rename_target_unresolves_then_reresolves() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Wiki", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let a = store
            .create_page(&space, "Alpha", &DocOwner::unattributed())
            .await
            .unwrap();
        let b = store
            .create_page(&space, "Bravo", &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .update_document(&a, "Alpha", "Points at [[Bravo]].")
            .await
            .unwrap();
        assert_eq!(
            store
                .get_backlinks(&b, DocFilter::unrestricted())
                .await
                .unwrap()
                .len(),
            1
        );

        // Rename B → its inbound link (matched by old title) unresolves to pending.
        store.update_document(&b, "Charlie", "").await.unwrap();
        assert!(store
            .get_backlinks(&b, DocFilter::unrestricted())
            .await
            .unwrap()
            .is_empty());
        assert!(store.get_outgoing_links(&a).await.unwrap()[0]
            .dst_doc_id
            .is_none());

        // Point A at the new title → re-resolves.
        store
            .update_document(&a, "Alpha", "Points at [[Charlie]].")
            .await
            .unwrap();
        assert_eq!(
            store
                .get_backlinks(&b, DocFilter::unrestricted())
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn expand_by_links_reaches_linked_document_chunks() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Wiki", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let a = store
            .create_page(&space, "Alpha", &DocOwner::unattributed())
            .await
            .unwrap();
        let b = store
            .create_page(&space, "Bravo", &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .update_document(&a, "Alpha", "Alpha content links [[Bravo]].")
            .await
            .unwrap();
        store
            .update_document(&b, "Bravo", "Bravo has unique zephyr content.")
            .await
            .unwrap();

        // Seeded at A, expansion reaches B's chunks.
        let reached = store
            .expand_by_links(
                &space,
                &[a.clone()],
                2,
                3,
                16,
                32,
                &DocFilter::unrestricted(),
            )
            .await
            .unwrap();
        assert!(reached.iter().any(|c| c.document_id == b));

        // A document with no outgoing links reaches nothing.
        let none = store
            .expand_by_links(&space, &[b], 2, 3, 16, 32, &DocFilter::unrestricted())
            .await
            .unwrap();
        assert!(none.is_empty());
    }

    #[tokio::test]
    async fn delete_document_turns_inbound_links_pending() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Wiki", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let a = store
            .create_page(&space, "Alpha", &DocOwner::unattributed())
            .await
            .unwrap();
        let b = store
            .create_page(&space, "Bravo", &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .update_document(&a, "Alpha", "See [[Bravo]].")
            .await
            .unwrap();
        assert!(store.delete_document(&b).await.unwrap());

        // A's link survives but is now pending (target gone).
        let out = store.get_outgoing_links(&a).await.unwrap();
        assert_eq!(out.len(), 1);
        assert!(out[0].dst_doc_id.is_none());
        let graph = store
            .space_graph(&space, DocFilter::unrestricted())
            .await
            .unwrap();
        assert!(graph.nodes.iter().any(|n| n.pending && n.title == "Bravo"));
    }

    #[tokio::test]
    async fn reindex_clears_pending_and_restamps_model() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("R", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let doc = store
            .create_page(&space, "T", &DocOwner::unattributed())
            .await
            .unwrap();
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
        let space = store
            .create_space("D", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let doc = store
            .create_page(&space, "T", &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .update_document(&doc, "T", "vectors of a different width")
            .await
            .unwrap();

        // Swap to a Local embedder with a different dimensionality, then reindex.
        let new_dims = DEFAULT_EMBED_DIMS / 2;
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
    async fn search_does_not_query_old_vectors_after_dimension_swap() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("D", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let doc = store
            .create_page(&space, "T", &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .update_document(&doc, "T", "old width vectors must not be queried")
            .await
            .unwrap();

        store
            .set_embedder(Embedder::Local {
                dims: DEFAULT_EMBED_DIMS / 2,
            })
            .await;

        assert!(
            store
                .search(&space, "old width", 5)
                .await
                .unwrap()
                .is_empty(),
            "a dimension-swapped embedder must not query the old vec0 table"
        );
    }

    #[tokio::test]
    async fn failed_remote_reindex_preserves_the_active_index() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Safe", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let doc = store
            .create_page(&space, "T", &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .update_document(&doc, "T", "the active index remains searchable")
            .await
            .unwrap();

        let target = Embedder::remote(
            "http://127.0.0.1:1",
            "cloud/embed",
            DEFAULT_EMBED_DIMS,
            None,
        );
        assert!(store.run_reindex(target).await.is_err());
        assert!(!store
            .search(&space, "active index searchable", 5)
            .await
            .unwrap()
            .is_empty());
        assert!(store.reindex_status().await.unwrap().errored.is_some());
        let staged: i64 = store
            .conn
            .lock()
            .await
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                params![EMBEDDING_REBUILD_TABLE],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(staged, 0, "a failed reindex must drop its staged vectors");
    }

    #[test]
    fn a_leftover_embedding_staging_table_is_dropped_and_marks_the_scrub_owed() {
        let store = SpaceStore::open_in_memory().unwrap();
        let conn = store.conn.blocking_lock();
        drop_embedding_reindex_staging(&conn).unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE {EMBEDDING_REBUILD_TABLE} (chunk_id TEXT PRIMARY KEY);"
        ))
        .unwrap();
        drop_embedding_reindex_staging(&conn).unwrap();
        let left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                params![EMBEDDING_REBUILD_TABLE],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
    }

    #[tokio::test]
    async fn create_ingest_list_and_search() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space_id = store
            .create_space("Docs", Some("test space"), &DocOwner::unattributed())
            .await
            .unwrap();

        let spaces = store.list_spaces(DocFilter::unrestricted()).await.unwrap();
        assert_eq!(spaces.len(), 1);
        assert_eq!(spaces[0].name, "Docs");
        assert_eq!(spaces[0].document_count, 0);

        store
            .ingest_document(
                &space_id,
                "Cats",
                "Cats are small carnivorous mammals.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        store
            .ingest_document(
                &space_id,
                "Rust",
                "Rust is a systems programming language.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();

        let docs = store
            .list_documents(&space_id, DocFilter::unrestricted())
            .await
            .unwrap();
        assert_eq!(docs.len(), 2);
        assert!(docs.iter().all(|d| d.chunk_count >= 1));

        let spaces = store.list_spaces(DocFilter::unrestricted()).await.unwrap();
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
            .ingest_document("nope", "t", "body", &DocOwner::unattributed())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[tokio::test]
    async fn delete_space_removes_documents() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space_id = store
            .create_space("Temp", None, &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .ingest_document(
                &space_id,
                "Doc",
                "some content here",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        assert!(store.delete_space(&space_id).await.unwrap());
        assert!(store
            .list_spaces(DocFilter::unrestricted())
            .await
            .unwrap()
            .is_empty());
        assert!(!store.delete_space(&space_id).await.unwrap());
    }

    #[test]
    fn chunk_text_splits_large_input() {
        let big = "word ".repeat(500);
        let chunks = chunk_text(&big);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.chars().count() <= CHUNK_CHAR_SIZE));
    }

    #[test]
    fn flatten_app_source_extracts_nested_strings() {
        let src = r#"{
            "title": "hello",
            "nested": { "deep": "world", "count": 42, "flag": true },
            "items": ["one", "two", null, ["three"]]
        }"#;
        let flat = flatten_app_source(src);
        for want in ["hello", "world", "one", "two", "three"] {
            assert!(
                flat.contains(want),
                "flattened text missing {want:?}: {flat:?}"
            );
        }
        // Non-string scalars (numbers/booleans/null) are not searchable text.
        assert!(!flat.contains("42"));
        assert!(!flat.contains("true"));
        // Non-JSON falls back to the raw source so it stays searchable.
        assert_eq!(flatten_app_source("just plain text"), "just plain text");
    }

    #[test]
    fn flatten_app_source_caps_output() {
        // A huge JSON array of strings is capped at APP_FLATTEN_CAP bytes.
        let big: Vec<String> = (0..20_000).map(|i| format!("token{i}")).collect();
        let src = serde_json::to_string(&big).unwrap();
        let flat = flatten_app_source(&src);
        assert!(flat.len() <= APP_FLATTEN_CAP);
    }

    #[tokio::test]
    async fn app_docs_are_kind_isolated_and_embed() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("AppSpace", None, &DocOwner::unattributed())
            .await
            .unwrap();

        // App A creates and can read its own doc.
        let doc = store
            .app_create_doc("app.a", &space, "Doc A", &DocOwner::unattributed())
            .await
            .unwrap();
        let got = store.app_get_doc("app.a", &doc).await.unwrap();
        assert!(got.is_some());
        assert_eq!(got.unwrap().kind, "app:app.a");

        // App B cannot read app A's doc (foreign kind → None, not an error).
        assert!(store.app_get_doc("app.b", &doc).await.unwrap().is_none());

        // A built-in page is invisible to any app.
        let page = store
            .create_page(&space, "Builtin Page", &DocOwner::unattributed())
            .await
            .unwrap();
        assert!(store.app_get_doc("app.a", &page).await.unwrap().is_none());

        // App B cannot mutate app A's doc (kind-checked FIRST → error).
        assert!(store
            .app_update_doc("app.b", &doc, None, "x")
            .await
            .is_err());
        assert!(store.app_delete_doc("app.b", &doc).await.is_err());

        // App A can update its own doc — this runs the flatten + embed path, so the
        // doc gains chunks and becomes searchable.
        store
            .app_update_doc(
                "app.a",
                &doc,
                Some("Renamed"),
                r#"{"note":"searchable app content here"}"#,
            )
            .await
            .unwrap();

        // Listing is scoped per app: A sees exactly its one doc (not the page); B none.
        let list_a = store.app_list_docs("app.a", &space).await.unwrap();
        assert_eq!(list_a.len(), 1);
        assert_eq!(list_a[0].id, doc);
        assert_eq!(list_a[0].title, "Renamed");
        assert!(store
            .app_list_docs("app.b", &space)
            .await
            .unwrap()
            .is_empty());

        // The flattened app content is embedded and retrievable.
        let hits = store
            .search(&space, "searchable app content", 5)
            .await
            .unwrap();
        assert!(hits
            .iter()
            .any(|c| c.content.contains("searchable app content")));

        // Usage is scoped to the owning app and reports the updated source size.
        let usage = store
            .app_space_usage("app.a", DocFilter::unrestricted())
            .await
            .unwrap();
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].id, space);
        assert_eq!(usage[0].document_count, 1);
        assert!(usage[0].storage_bytes > 0);

        let foreign_doc = store
            .app_create_doc("app.b", &space, "Doc B", &DocOwner::unattributed())
            .await
            .unwrap();

        // Bulk deletion removes only the requested app's docs and preserves the
        // shared Space plus documents owned by other apps.
        assert_eq!(
            store
                .delete_app_data("app.a", DocFilter::unrestricted())
                .await
                .unwrap(),
            1
        );
        assert!(store.app_get_doc("app.a", &doc).await.unwrap().is_none());
        assert!(store
            .app_get_doc("app.b", &foreign_doc)
            .await
            .unwrap()
            .is_some());
        assert!(store
            .app_list_docs("app.a", &space)
            .await
            .unwrap()
            .is_empty());
    }

    // ── AC1: existing vector-mode Spaces are unchanged ─────────────────────────

    #[tokio::test]
    async fn default_space_uses_vector_mode() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space_id = store
            .create_space("VectorSpace", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let spaces = store.list_spaces(DocFilter::unrestricted()).await.unwrap();
        assert_eq!(spaces[0].retrieval_mode, RetrievalMode::Vector);
        // Confirm vector search works normally.
        store
            .ingest_document(
                &space_id,
                "Doc",
                "Cats are small carnivorous mammals.",
                &DocOwner::unattributed(),
            )
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
            .create_space_with_mode(
                "GraphSpace",
                None,
                RetrievalMode::Graph,
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();

        // Ingest three-chunk fixture.
        store
            .ingest_document(
                &graph_space,
                "ChunkA",
                "Alice works at Acme.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        store
            .ingest_document(
                &graph_space,
                "ChunkB",
                "Acme is based in Paris.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        store
            .ingest_document(
                &graph_space,
                "ChunkC",
                "Paris has the Eiffel Tower.",
                &DocOwner::unattributed(),
            )
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
            .create_space_with_mode(
                "VectorSpace",
                None,
                RetrievalMode::Vector,
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        store
            .ingest_document(
                &vector_space,
                "ChunkA",
                "Alice works at Acme.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        store
            .ingest_document(
                &vector_space,
                "ChunkB",
                "Acme is based in Paris.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        store
            .ingest_document(
                &vector_space,
                "ChunkC",
                "Paris has the Eiffel Tower.",
                &DocOwner::unattributed(),
            )
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

    /// **A file uploaded to a Graph Space must be as retrievable as the same file
    /// uploaded to a Vector Space that is later flipped to Graph.**
    ///
    /// `create_file` used to hardcode `RetrievalMode::Vector`, so it never reached
    /// [`build_graph_for_chunks`] — while [`SpaceStore::set_retrieval_mode`]'s
    /// rebuild scans `SELECT id, content FROM chunks`, which *does* include the file's
    /// descriptor chunk. The result was that the same file in the same Space was
    /// findable or not depending on the order the user did things, and the natural
    /// order (create a Graph Space → upload → ask) was the broken one.
    ///
    /// The assertion is deliberately an **equality against the rebuild**, not "some
    /// rows exist": the rebuild is the only other definition of what a Space's graph
    /// should contain, so pinning ingest to it is what stops the two drifting again.
    #[tokio::test]
    async fn a_file_added_to_a_graph_space_gets_the_same_graph_rows_as_a_rebuild() {
        const TITLE: &str = "quarterly revenue report.csv";
        const MIME: &str = "text/csv";
        let bytes = b"period,revenue\nQ1,10\n";
        let store = SpaceStore::open_in_memory().unwrap();

        // Path 1 — the natural flow: Graph Space first, then upload.
        let graph_space = store
            .create_space_with_mode(
                "GraphSpace",
                None,
                RetrievalMode::Graph,
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        store
            .create_file(&graph_space, TITLE, bytes, MIME, &DocOwner::unattributed())
            .await
            .unwrap();
        let ingested = graph_row_counts(&store, &graph_space).await;
        assert!(
            ingested.0 > 0 && ingested.1 > 0,
            "a file uploaded to a graph-mode Space must carry graph rows; got {ingested:?}"
        );

        // Path 2 — the flow that always worked: upload to a Vector Space, flip after.
        let flipped = store
            .create_space_with_mode(
                "FlippedSpace",
                None,
                RetrievalMode::Vector,
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        store
            .create_file(&flipped, TITLE, bytes, MIME, &DocOwner::unattributed())
            .await
            .unwrap();
        assert_eq!(
            graph_row_counts(&store, &flipped).await,
            (0, 0),
            "a vector-mode Space must still write no graph rows"
        );
        store
            .set_retrieval_mode(&flipped, RetrievalMode::Graph)
            .await
            .unwrap()
            .expect("space exists");
        assert_eq!(
            ingested,
            graph_row_counts(&store, &flipped).await,
            "upload-into-graph and upload-then-flip must produce the SAME graph"
        );

        // And the point of all of it: the file answers a graph query. (Only the
        // descriptor — title + mime — is ever chunked for a file, in either mode; the
        // bytes are not extracted here. That is `document.parse`'s job, and its
        // output reaches a Space through `ingest_document`.)
        let hits = store
            .graph_search(&graph_space, "revenue", 5, &DocFilter::unrestricted())
            .await
            .unwrap();
        assert!(
            hits.iter().any(|c| c.content.contains(TITLE)),
            "graph traversal must reach the uploaded file's descriptor chunk; got {hits:?}"
        );
    }

    /// **The graph seed floor ([`SEED_MAX_CHUNK_FRACTION`]): a Space-wide-common word
    /// must not crowd out the rare word the user actually asked about.**
    ///
    /// Without the floor this fails outright, and not marginally: `graph_search`
    /// stops collecting the moment `limit` chunks are visited, so seeding on
    /// `platform` (in 12 of 13 chunks, and first in [`extract_entities`] order) fills
    /// the budget with chunks that merely share a common word and the traversal never
    /// reaches `kryptonite` at all. The answer chunk is not ranked low — it is never
    /// visited. That list's head is then merged at rank parity with the best cosine
    /// hit on every chat turn (see `ryu_rag::fuse_ranked_lists`), which is why this is
    /// a retrieval defect rather than a nicety.
    ///
    /// The second half pins the escape hatch: when **every** query entity floods, no
    /// floor is applied, because "weakly grounded" beats "nothing". The third case —
    /// a Space too small for the statistic — is pinned by
    /// `graphrag_multi_hop_finds_connected_chunk_that_vector_misses` (3 chunks, below
    /// [`SEED_FLOOR_MIN_CHUNKS`]), which must keep passing unchanged.
    #[tokio::test]
    async fn graph_seed_floor_keeps_a_common_word_from_crowding_out_a_rare_one() {
        const COMMON_DOCS: usize = 12;
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space_with_mode(
                "Flood",
                None,
                RetrievalMode::Graph,
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        // 12 chunks sharing `platform` + `ledger`, and one that shares nothing with
        // them. 13 ≥ SEED_FLOOR_MIN_CHUNKS, so the floor is in force.
        for i in 0..COMMON_DOCS {
            store
                .ingest_document(
                    &space,
                    &format!("D{i}"),
                    &format!("platform ledger entry number{i} routing"),
                    &DocOwner::unattributed(),
                )
                .await
                .unwrap();
        }
        store
            .ingest_document(
                &space,
                "Answer",
                "kryptonite quarantine vault",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();

        // `platform` sorts first in the query, and appears in 12/13 chunks; the floor
        // is what stops it seeding while `kryptonite` (1/13) can.
        let hits = store
            .graph_search(&space, "platform kryptonite", 3, &DocFilter::unrestricted())
            .await
            .unwrap();
        assert!(
            hits.iter().any(|c| c.content.contains("kryptonite")),
            "the rare query entity must seed the traversal; got {hits:?}"
        );
        assert!(
            hits.iter().all(|c| c.content.contains("kryptonite")),
            "chunks that share only a Space-wide-common word must not fill the \
             result; got {hits:?}"
        );

        // Escape hatch: a query whose every entity floods the Space seeds exactly as
        // it did before the floor existed, rather than returning nothing.
        let all_common = store
            .graph_search(&space, "platform ledger", 3, &DocFilter::unrestricted())
            .await
            .unwrap();
        assert_eq!(
            all_common.len(),
            3,
            "when every query entity floods, the floor must not apply; got {all_common:?}"
        );
    }

    // ── Changing an existing Space's retrieval mode ────────────────────────────

    /// Count this space's graph rows — the thing that decides whether `graph_search`
    /// can answer anything at all.
    async fn graph_row_counts(store: &SpaceStore, space_id: &str) -> (i64, i64) {
        let conn = store.conn.lock().await;
        let nodes = conn
            .query_row(
                "SELECT COUNT(*) FROM graph_nodes WHERE space_id = ?1",
                params![space_id],
                |r| r.get(0),
            )
            .unwrap();
        let edges = conn
            .query_row(
                "SELECT COUNT(*) FROM graph_edges WHERE space_id = ?1",
                params![space_id],
                |r| r.get(0),
            )
            .unwrap();
        (nodes, edges)
    }

    /// **The defect this method exists to prevent.**
    ///
    /// A Space ingested in vector mode has no entity graph. If switching to graph
    /// only flipped the column, `search_ext` would dispatch to `graph_search`, whose
    /// BFS seeds from `graph_nodes` — and would return nothing. This asserts the
    /// switch rebuilds the graph from the chunks already on disk, and that the
    /// multi-hop traversal then works on content ingested *before* the switch.
    #[tokio::test]
    async fn switching_to_graph_rebuilds_the_graph_so_search_actually_works() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Later", None, &DocOwner::unattributed())
            .await
            .unwrap();
        for (title, body) in [
            ("ChunkA", "Alice works at Acme."),
            ("ChunkB", "Acme is based in Paris."),
            ("ChunkC", "Paris has the Eiffel Tower."),
        ] {
            store
                .ingest_document(&space, title, body, &DocOwner::unattributed())
                .await
                .unwrap();
        }
        // Ingested in vector mode ⇒ no graph exists yet.
        assert_eq!(graph_row_counts(&store, &space).await, (0, 0));

        let change = store
            .set_retrieval_mode(&space, RetrievalMode::Graph)
            .await
            .unwrap()
            .expect("space exists");
        assert_eq!(change.previous, RetrievalMode::Vector);
        assert_eq!(change.mode, RetrievalMode::Graph);
        assert!(change.changed);
        assert!(change.graph_rebuilt);
        assert_eq!(change.chunks_scanned, 3);
        assert!(change.graph_nodes > 0, "rebuild must write entity nodes");
        assert!(change.graph_edges > 0, "rebuild must write co-occurrences");

        let (nodes, edges) = graph_row_counts(&store, &space).await;
        assert_eq!(nodes as usize, change.graph_nodes);
        assert_eq!(edges as usize, change.graph_edges);

        // The column moved AND retrieval follows it.
        assert_eq!(
            store.space_mode(&space).await.unwrap(),
            RetrievalMode::Graph
        );
        let hits = store.search(&space, "Alice", 10).await.unwrap();
        assert!(
            hits.iter().any(|c| c.content.contains("Eiffel")),
            "after the switch, Alice→Acme→Paris multi-hop must reach ChunkC \
             (this is what an empty graph would silently fail to do); got: {:?}",
            hits.iter().map(|c| &c.content).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn background_rebuild_reports_progress_and_commits_staged_graph_atomically() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Chunked", None, &DocOwner::unattributed())
            .await
            .unwrap();
        for (title, body) in [
            ("A", "Alice works at Acme."),
            ("B", "Acme is based in Paris."),
            ("C", "Paris has the Eiffel Tower."),
        ] {
            store
                .ingest_document(&space, title, body, &DocOwner::unattributed())
                .await
                .unwrap();
        }

        let job = store
            .start_retrieval_mode_rebuild(&space, RetrievalMode::Graph)
            .await
            .unwrap()
            .unwrap();
        let status = loop {
            let status = store.retrieval_mode_status(&space, &job.job_id).unwrap();
            if status.state != "running" {
                break status;
            }
            tokio::task::yield_now().await;
        };
        assert_eq!(status.job_id, job.job_id);
        assert_eq!(status.state, "completed");
        assert_eq!(status.total_chunks, 3);
        assert_eq!(status.processed_chunks, 3);
        assert!(status.graph_nodes > 0);
        assert!(status.graph_edges > 0);
        assert_eq!(
            store.space_mode(&space).await.unwrap(),
            RetrievalMode::Graph
        );
        assert_eq!(
            graph_row_counts(&store, &space).await,
            (status.graph_nodes as i64, status.graph_edges as i64)
        );
    }

    #[tokio::test]
    async fn retrieval_mode_status_is_job_scoped_and_bounded() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Status history", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let mut job_ids = Vec::new();

        for index in 0..=MAX_RETRIEVAL_MODE_TERMINAL_STATUSES {
            let mode = if index % 2 == 0 {
                RetrievalMode::Graph
            } else {
                RetrievalMode::Vector
            };
            let job = store
                .start_retrieval_mode_rebuild(&space, mode)
                .await
                .unwrap()
                .unwrap();
            let status = loop {
                let status = store.retrieval_mode_status(&space, &job.job_id).unwrap();
                if status.state != "running" && status.state != "cancelling" {
                    break status;
                }
                tokio::task::yield_now().await;
            };
            assert_eq!(status.job_id, job.job_id);
            assert!(matches!(status.state.as_str(), "completed" | "cancelled"));
            job_ids.push(job.job_id);
        }

        assert!(store.retrieval_mode_status(&space, &job_ids[0]).is_none());
        assert!(store
            .retrieval_mode_status(&space, job_ids.last().expect("at least one completed job"))
            .is_some());
        assert!(store
            .retrieval_mode_status("another-space", job_ids.last().unwrap())
            .is_none());
        assert!(!store.cancel_retrieval_mode_rebuild(&space, &job_ids[0]));
        assert!(!store.cancel_retrieval_mode_rebuild(&space, job_ids.last().unwrap()));
    }

    #[tokio::test]
    async fn cancelling_during_final_graph_copy_rolls_back_the_swap() -> Result<()> {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space_with_mode(
                "Already graph",
                None,
                RetrievalMode::Graph,
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        store
            .ingest_document(
                &space,
                "Existing",
                "Alice works at Acme and Acme is based in Paris.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        let before = graph_row_counts(&store, &space).await;

        let calls = std::sync::atomic::AtomicUsize::new(0);
        let mut conn = store.conn.lock().await;
        create_retrieval_staging(&conn)?;
        for index in 0..(RETRIEVAL_REBUILD_BATCH_SIZE + 1) {
            conn.execute(
                "INSERT INTO retrieval_rebuild_nodes
                 (id, space_id, entity, chunk_id) VALUES (?1, ?2, ?3, ?4)",
                params![
                    format!("staged-node-{index}"),
                    &space,
                    format!("entity-{index}"),
                    "staged-chunk"
                ],
            )?;
            conn.execute(
                "INSERT INTO retrieval_rebuild_edges
                 (id, space_id, src_entity, dst_entity, chunk_id)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    format!("staged-edge-{index}"),
                    &space,
                    format!("src-{index}"),
                    format!("dst-{index}"),
                    "staged-chunk"
                ],
            )?;
        }

        let mut fingerprint = Sha256::new();
        let mut stmt = conn.prepare(
            "SELECT rowid, id, COALESCE(ryu_open_soft('chunks.content', id, content), '')
                 FROM chunks WHERE space_id = ?1 ORDER BY rowid",
        )?;
        let rows = stmt.query_map(params![&space], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut total_chunks = 0usize;
        for row in rows {
            let (rowid, id, content) = row?;
            update_rebuild_fingerprint(&mut fingerprint, rowid, &id, &content);
            total_chunks += 1;
        }
        drop(stmt);
        let expected_fingerprint = format!("{:x}", fingerprint.finalize());
        let result = finalize_chunked_retrieval_mode(
            &mut conn,
            &space,
            RetrievalMode::Graph,
            total_chunks,
            total_chunks,
            RETRIEVAL_REBUILD_BATCH_SIZE + 1,
            RETRIEVAL_REBUILD_BATCH_SIZE + 1,
            &expected_fingerprint,
            &|| calls.fetch_add(1, Ordering::SeqCst) >= 7,
        );
        assert!(result.is_err(), "cancellation must abort finalization");
        cleanup_retrieval_staging(&conn)?;
        drop(conn);

        assert_eq!(
            store.space_mode(&space).await.unwrap(),
            RetrievalMode::Graph
        );
        assert_eq!(graph_row_counts(&store, &space).await, before);
        Ok(())
    }

    #[tokio::test]
    async fn cancelling_background_rebuild_preserves_the_previous_mode_and_graph() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Cancelled", None, &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .ingest_document(
                &space,
                "Doc",
                "Alice works at Acme and Acme is based in Paris.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        let job = store
            .start_retrieval_mode_rebuild(&space, RetrievalMode::Graph)
            .await
            .unwrap()
            .unwrap();
        assert!(store.cancel_retrieval_mode_rebuild(&space, &job.job_id));
        let status = loop {
            let status = store.retrieval_mode_status(&space, &job.job_id).unwrap();
            if status.state != "running" && status.state != "cancelling" {
                break status;
            }
            tokio::task::yield_now().await;
        };
        assert_eq!(status.state, "cancelled");
        assert_eq!(
            store.space_mode(&space).await.unwrap(),
            RetrievalMode::Vector
        );
        assert_eq!(graph_row_counts(&store, &space).await, (0, 0));
    }

    #[tokio::test]
    async fn vector_rebuild_arbitrates_cancellation_before_commit() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Vector", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let job_id = "vector-finalization".to_owned();
        {
            let mut state = store.retrieval_mode.lock().unwrap();
            state.statuses.insert(
                job_id.clone(),
                RetrievalModeJobStatus {
                    job_id: job_id.clone(),
                    space_id: space.clone(),
                    requested_mode: RetrievalMode::Vector,
                    previous_mode: Some(RetrievalMode::Graph),
                    state: "running".to_owned(),
                    total_chunks: 0,
                    processed_chunks: 0,
                    graph_nodes: 0,
                    graph_edges: 0,
                    change: None,
                    error: None,
                },
            );
            state.cancel = Some(Arc::new(AtomicBool::new(false)));
        }

        let worker_store = store.clone();
        let worker_space = space.clone();
        let result = tokio::task::spawn_blocking(move || {
            let result = SpaceStore::set_retrieval_mode_chunked_with_control(
                &worker_store,
                &worker_space,
                RetrievalMode::Vector,
                &|| false,
                &|| {
                    assert!(worker_store.begin_retrieval_mode_finalization(&job_id));
                    assert!(!worker_store.cancel_retrieval_mode_rebuild(&worker_space, &job_id));
                    true
                },
                &mut |_processed, _nodes, _edges, _total| {},
            );
            result
        })
        .await
        .unwrap()
        .unwrap();

        assert_eq!(result.unwrap().mode, RetrievalMode::Vector);
        assert_eq!(
            store.space_mode(&space).await.unwrap(),
            RetrievalMode::Vector
        );
    }

    #[tokio::test]
    async fn active_retrieval_job_does_not_leak_metadata_or_allow_conflicting_requests() {
        let store = SpaceStore::open_in_memory().unwrap();
        let first_space = store
            .create_space("First", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let other_space = store
            .create_space("Other", None, &DocOwner::unattributed())
            .await
            .unwrap();

        for state_name in ["running", "cancelling"] {
            let job_id = format!("job-{state_name}");
            let cancel = Arc::new(AtomicBool::new(state_name == "cancelling"));
            {
                let mut state = store.retrieval_mode.lock().unwrap();
                state.statuses.insert(
                    job_id.clone(),
                    RetrievalModeJobStatus {
                        job_id: job_id.clone(),
                        space_id: first_space.clone(),
                        requested_mode: RetrievalMode::Graph,
                        previous_mode: Some(RetrievalMode::Vector),
                        state: state_name.to_owned(),
                        total_chunks: 0,
                        processed_chunks: 0,
                        graph_nodes: 0,
                        graph_edges: 0,
                        change: None,
                        error: None,
                    },
                );
                state.cancel = Some(cancel);
            }

            assert!(store
                .start_retrieval_mode_rebuild(&first_space, RetrievalMode::Vector)
                .await
                .is_err());
            assert!(store
                .start_retrieval_mode_rebuild(&other_space, RetrievalMode::Graph)
                .await
                .is_err());
            let status = store.retrieval_mode_status(&first_space, &job_id).unwrap();
            assert_eq!(status.job_id, job_id);
            assert_eq!(status.space_id, first_space);
            assert_eq!(status.state, state_name);
        }
    }

    #[tokio::test]
    async fn retrieval_job_terminal_state_uses_the_worker_outcome_not_the_cancel_flag() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Jobs", None, &DocOwner::unattributed())
            .await
            .unwrap();

        for (job_id, error, expected_state) in [
            ("failed-job", anyhow::anyhow!("disk full"), "failed"),
            (
                "cancelled-job",
                anyhow::Error::new(RetrievalModeCancelled),
                "cancelled",
            ),
        ] {
            {
                let mut state = store.retrieval_mode.lock().unwrap();
                state.statuses.insert(
                    job_id.to_owned(),
                    RetrievalModeJobStatus {
                        job_id: job_id.to_owned(),
                        space_id: space.clone(),
                        requested_mode: RetrievalMode::Graph,
                        previous_mode: Some(RetrievalMode::Vector),
                        state: "cancelling".to_owned(),
                        total_chunks: 1,
                        processed_chunks: 0,
                        graph_nodes: 0,
                        graph_edges: 0,
                        change: None,
                        error: None,
                    },
                );
                state.cancel = Some(Arc::new(AtomicBool::new(true)));
            }

            assert!(store.cancel_retrieval_mode_rebuild(&space, job_id));
            assert!(store.cancel_retrieval_mode_rebuild(&space, job_id));
            store.finish_retrieval_mode_job(job_id, Err(error));
            let status = store.retrieval_mode_status(&space, job_id).unwrap();
            assert_eq!(status.state, expected_state);
            if expected_state == "failed" {
                assert_eq!(status.error.as_deref(), Some("disk full"));
            } else {
                assert!(status.error.is_none());
            }
        }
    }

    #[tokio::test]
    async fn vector_rebuild_progress_never_reports_unscanned_chunks() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Vector progress", None, &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .ingest_document(
                &space,
                "Document",
                "A chunk that vector mode does not scan",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        let totals = Arc::new(StdMutex::new(Vec::new()));
        let worker_totals = totals.clone();
        let worker_store = store.clone();
        let worker_space = space.clone();
        tokio::task::spawn_blocking(move || {
            SpaceStore::set_retrieval_mode_chunked_with_control(
                &worker_store,
                &worker_space,
                RetrievalMode::Vector,
                &|| false,
                &|| true,
                &mut |_processed, _nodes, _edges, total| {
                    worker_totals.lock().unwrap().push(total);
                },
            )
        })
        .await
        .unwrap()
        .unwrap();
        assert!(!totals.lock().unwrap().is_empty());
        assert!(totals.lock().unwrap().iter().all(|total| *total == 0));
    }

    #[tokio::test]
    async fn missing_space_is_not_confused_with_an_active_rebuild() {
        let store = SpaceStore::open_in_memory().unwrap();
        let missing = "missing-space";

        assert!(store
            .start_retrieval_mode_rebuild(missing, RetrievalMode::Graph)
            .await
            .unwrap()
            .is_none());
    }

    /// Re-asserting `graph` on a Space that is already `graph` must not duplicate
    /// rows. The tables carry no UNIQUE constraint (their `INSERT OR IGNORE` is
    /// inert), so this is only true because the method clears before rebuilding.
    /// It doubles as the graph *repair* path.
    #[tokio::test]
    async fn re_asserting_graph_mode_rebuilds_idempotently() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space_with_mode("G", None, RetrievalMode::Graph, &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .ingest_document(
                &space,
                "Doc",
                "Alice works at Acme.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        let before = graph_row_counts(&store, &space).await;
        assert!(before.0 > 0);

        let change = store
            .set_retrieval_mode(&space, RetrievalMode::Graph)
            .await
            .unwrap()
            .unwrap();
        assert!(!change.changed, "same mode ⇒ changed = false");
        assert!(change.graph_rebuilt, "…but the graph is still repaired");
        assert_eq!(
            graph_row_counts(&store, &space).await,
            before,
            "a second rebuild must not double the rows"
        );

        // And a third pass is still stable.
        store
            .set_retrieval_mode(&space, RetrievalMode::Graph)
            .await
            .unwrap();
        assert_eq!(graph_row_counts(&store, &space).await, before);
    }

    /// Ingest and rebuild must produce the SAME graph — they share
    /// [`build_graph_for_chunks`] precisely so they cannot drift. This pins that:
    /// a Space born in graph mode and a Space converted into graph mode, over
    /// identical content, end up with identical row counts and identical answers.
    #[tokio::test]
    async fn rebuilt_graph_matches_an_ingest_built_graph() {
        let store = SpaceStore::open_in_memory().unwrap();
        let docs = [
            ("ChunkA", "Alice works at Acme."),
            ("ChunkB", "Acme is based in Paris."),
            ("ChunkC", "Paris has the Eiffel Tower."),
        ];

        let born = store
            .create_space_with_mode(
                "Born",
                None,
                RetrievalMode::Graph,
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        let converted = store
            .create_space("Converted", None, &DocOwner::unattributed())
            .await
            .unwrap();
        for (title, body) in docs {
            for space in [&born, &converted] {
                store
                    .ingest_document(space, title, body, &DocOwner::unattributed())
                    .await
                    .unwrap();
            }
        }
        store
            .set_retrieval_mode(&converted, RetrievalMode::Graph)
            .await
            .unwrap();

        assert_eq!(
            graph_row_counts(&store, &born).await,
            graph_row_counts(&store, &converted).await,
            "a rebuilt graph must be shaped exactly like an ingested one"
        );
        let born_hits = store.search(&born, "Alice", 10).await.unwrap().len();
        let converted_hits = store.search(&converted, "Alice", 10).await.unwrap().len();
        assert_eq!(born_hits, converted_hits);
    }

    /// Switching back to vector drops the graph (nothing maintains it in vector
    /// mode), restores KNN retrieval, and leaves chunk vectors intact — so the
    /// round trip is lossless and never re-embeds.
    #[tokio::test]
    async fn switching_to_vector_drops_the_graph_and_keeps_vectors() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space_with_mode(
                "RoundTrip",
                None,
                RetrievalMode::Graph,
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        store
            .ingest_document(
                &space,
                "Doc",
                "Cats are small carnivorous mammals.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        assert!(graph_row_counts(&store, &space).await.0 > 0);

        let change = store
            .set_retrieval_mode(&space, RetrievalMode::Vector)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(change.previous, RetrievalMode::Graph);
        assert!(change.changed);
        assert!(!change.graph_rebuilt);
        assert_eq!(change.chunks_scanned, 0);
        assert_eq!(graph_row_counts(&store, &space).await, (0, 0));

        // Vector retrieval works without a re-index: the chunk vectors were never
        // touched, so a semantic (non-token-overlapping) query still hits.
        assert_eq!(
            store.space_mode(&space).await.unwrap(),
            RetrievalMode::Vector
        );
        assert!(!store
            .search(&space, "small mammals", 5)
            .await
            .unwrap()
            .is_empty());

        // …and switching back rebuilds from those same chunks.
        let back = store
            .set_retrieval_mode(&space, RetrievalMode::Graph)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(back.chunks_scanned, 1);
        assert!(graph_row_counts(&store, &space).await.0 > 0);
    }

    /// A missing Space is `Ok(None)`, not an error and not a silent success — the
    /// HTTP layer turns it into a 404.
    #[tokio::test]
    async fn setting_mode_on_a_missing_space_reports_not_found() {
        let store = SpaceStore::open_in_memory().unwrap();
        assert!(store
            .set_retrieval_mode("nope", RetrievalMode::Graph)
            .await
            .unwrap()
            .is_none());
    }

    /// Documents ingested *after* a switch to graph must join the same graph — the
    /// ingest path reads the (now updated) column, so the two writers stay coherent.
    #[tokio::test]
    async fn documents_ingested_after_the_switch_extend_the_graph() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Growing", None, &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .ingest_document(
                &space,
                "ChunkA",
                "Alice works at Acme.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        store
            .set_retrieval_mode(&space, RetrievalMode::Graph)
            .await
            .unwrap();
        let after_rebuild = graph_row_counts(&store, &space).await;

        store
            .ingest_document(
                &space,
                "ChunkB",
                "Acme is based in Paris.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        let after_ingest = graph_row_counts(&store, &space).await;
        assert!(
            after_ingest.0 > after_rebuild.0,
            "post-switch ingest must keep extending the graph"
        );
        let hits = store.search(&space, "Alice", 10).await.unwrap();
        assert!(hits.iter().any(|c| c.content.contains("Paris")));
    }

    /// The strict parse used at every caller boundary. Distinct from the lenient
    /// `from_str` used on DB reads — conflating them is how a typo becomes a
    /// silently-vector Space.
    #[test]
    fn retrieval_mode_parse_is_strict() {
        assert_eq!(RetrievalMode::parse("vector"), Some(RetrievalMode::Vector));
        assert_eq!(RetrievalMode::parse("graph"), Some(RetrievalMode::Graph));
        for bad in ["graphrag", "Graph", "GRAPH", "vec", "", " graph"] {
            assert!(
                RetrievalMode::parse(bad).is_none(),
                "{bad:?} must not parse"
            );
        }
        // The wire form round-trips through both directions and matches what serde
        // emits, so the column, the JSON body, and the API response agree.
        for mode in [RetrievalMode::Vector, RetrievalMode::Graph] {
            assert_eq!(RetrievalMode::parse(mode.as_str()), Some(mode));
            assert_eq!(
                serde_json::to_string(&mode).unwrap(),
                format!("\"{}\"", mode.as_str())
            );
        }
        // The DB-read path stays lenient by design: an unknown column value
        // degrades to vector rather than failing every search on that Space.
        assert_eq!(RetrievalMode::from_str("graphrag"), RetrievalMode::Vector);
    }

    // ── AC3: retrieval mode + extraction model are registry-configurable ────────
    // (The `ModelRegistry`-level tests for this live Core-side in the `spaces`
    // shim's test module, since `ModelRegistry` is a Core type.)

    #[test]
    fn space_store_reports_graph_extraction_model() {
        let store = SpaceStore::open_in_memory().unwrap();
        assert_eq!(store.graph_extraction_model_id(), "local-cooccurrence");
    }

    #[test]
    fn graph_extraction_model_accepts_only_the_shipped_implementation() {
        assert_eq!(
            GraphExtractionModel::parse("  local-cooccurrence  ").unwrap(),
            GraphExtractionModel::LocalCooccurrence
        );
        for unsupported in [
            "",
            "   ",
            "Local-Cooccurrence",
            "acme/extract",
            "https://example.test",
        ] {
            assert!(GraphExtractionModel::parse(unsupported).is_err());
        }
    }

    #[test]
    fn open_at_rejects_an_unsupported_graph_extractor_before_creating_the_database() {
        let root = std::env::temp_dir().join(format!(
            "ryu-spaces-unsupported-extractor-{}",
            uuid::Uuid::new_v4()
        ));
        let database = root.join("spaces.db");
        let result = SpaceStore::open_at(
            database.clone(),
            Embedder::Local {
                dims: DEFAULT_EMBED_DIMS,
            },
            DEFAULT_EMBED_DIMS,
            "acme/entity-extractor".to_owned(),
            Reranker::Local,
            root.join("blobs"),
            None,
        );
        let error = result.err().expect("unsupported extractor must fail");
        assert!(error
            .to_string()
            .contains("unsupported graph extraction model"));
        assert!(
            !database.exists(),
            "validation must precede filesystem mutation"
        );
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
    fn extract_entities_uses_character_lengths_and_caps_quadratic_fanout() {
        assert!(extract_entities("Ab 東京").is_empty());
        assert!(extract_entities("東京大学校").contains(&"東京大学校".to_owned()));

        let text = (0..(MAX_EXTRACTED_GRAPH_TERMS + 20))
            .map(|index| format!("Entity{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        let entities = extract_entities(&text);
        assert_eq!(entities.len(), MAX_EXTRACTED_GRAPH_TERMS);
        assert_eq!(entities.first().map(String::as_str), Some("entity0"));
        assert_eq!(
            entities.last().map(String::as_str),
            Some("entity63"),
            "the cap must preserve deterministic source order"
        );
    }

    #[tokio::test]
    async fn direct_and_background_mode_changes_share_one_arbitration_domain() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Arbitrated", None, &DocOwner::unattributed())
            .await
            .unwrap();
        {
            let mut state = store.retrieval_mode.lock().unwrap();
            state.statuses.insert(
                "background".to_owned(),
                RetrievalModeJobStatus {
                    job_id: "background".to_owned(),
                    space_id: space.clone(),
                    requested_mode: RetrievalMode::Graph,
                    previous_mode: Some(RetrievalMode::Vector),
                    state: "running".to_owned(),
                    total_chunks: 0,
                    processed_chunks: 0,
                    graph_nodes: 0,
                    graph_edges: 0,
                    change: None,
                    error: None,
                },
            );
        }
        assert!(store
            .set_retrieval_mode(&space, RetrievalMode::Vector)
            .await
            .is_err());

        {
            let mut state = store.retrieval_mode.lock().unwrap();
            state.statuses.clear();
            state.direct_active = true;
        }
        assert!(store
            .start_retrieval_mode_rebuild(&space, RetrievalMode::Graph)
            .await
            .is_err());
        store.retrieval_mode.lock().unwrap().direct_active = false;
    }

    #[tokio::test]
    async fn finalization_fails_if_an_empty_space_was_deleted_after_snapshot() -> Result<()> {
        let store = SpaceStore::open_in_memory()?;
        let space = store
            .create_space("Deleted", None, &DocOwner::unattributed())
            .await?;
        let mut conn = store.conn.lock().await;
        create_retrieval_staging(&conn)?;
        conn.execute("DELETE FROM spaces WHERE id = ?1", params![&space])?;
        let empty_fingerprint = format!("{:x}", Sha256::new().finalize());
        let result = finalize_chunked_retrieval_mode(
            &mut conn,
            &space,
            RetrievalMode::Vector,
            0,
            0,
            0,
            0,
            &empty_fingerprint,
            &|| false,
        );
        assert!(
            result.is_err(),
            "a deleted Space must never report completion"
        );
        cleanup_retrieval_staging(&conn)?;
        Ok(())
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

    // ── Graph cost / bound regressions (H3) ───────────────────────────────────
    //
    // These exist because the rebuild's cost was *documented* rather than measured,
    // and the documented figure ("pure SQL + string work", "affordable enough to
    // run inline") was wrong by two orders of magnitude on a real Space. The two
    // tests below pin the two things the corrected docs assert: what the graph
    // CONTAINS (so a later speed-up cannot quietly shrink it) and that a query over
    // a dense graph is bounded and deterministic.
    //
    // Ordinary English prose on purpose — `extract_entities` keeps every token ≥ 3
    // chars that is capitalised or longer than 4, so a synthetic fixture of short
    // repeated words would understate the fan-out that makes this expensive.
    const PROSE: &str = "The quarterly revenue report from Acme Corporation shows that \
        European operations delivered stronger margins than the North American division, \
        largely because logistics costs in Rotterdam and Hamburg fell after the shipping \
        contract renegotiation completed in March. Analysts covering the industrial sector \
        expect similar improvements at competing firms, although currency exposure remains \
        a meaningful risk for companies without hedging programs. Management reiterated \
        guidance for the full year and announced additional investment in automation across \
        three manufacturing facilities. ";

    /// Prose that `chunk_text` splits into roughly `target_chunks` chunks near
    /// [`CHUNK_CHAR_SIZE`]. The `marker{i}` tokens keep chunks textually distinct so
    /// nothing collapses into one document-level entity set.
    fn prose_corpus(target_chunks: usize) -> String {
        let reps = (target_chunks * CHUNK_CHAR_SIZE / PROSE.len()).max(1);
        let mut out = String::new();
        for i in 0..reps {
            out.push_str(PROSE);
            out.push_str(&format!("marker{i} "));
        }
        out
    }

    /// **Pins what the graph CONTAINS: `n` entities per chunk ⇒ `n` nodes and
    /// `n·(n−1)` directed edges, exactly.**
    ///
    /// The cost documented on [`build_graph_for_chunks`] is `O(chunks × entities²)`,
    /// and the prepared statements preserve this identity for the bounded term set.
    /// [`extract_entities`] deliberately caps `n`; within that cap, changing the
    /// extractor or emitting one direction instead of two still changes which chunks
    /// a graph query can reach and must update this assertion explicitly.
    ///
    /// **Both properties of [`graph_row_id`] at once: strictly ascending (the
    /// performance property) and all-distinct (the correctness property).**
    ///
    /// They are asserted together because each alone is satisfiable by a broken
    /// generator — a constant is "ascending" if you only check `>=`, and a v4 UUID is
    /// distinct while being the random-scatter insert this replaced. Ascending is
    /// what turns the `TEXT PRIMARY KEY` insert into an append at the right edge of
    /// its b-tree; distinct is what keeps the `INSERT OR IGNORE` on `graph_nodes` /
    /// `graph_edges` inert, and an inert conflict clause is the only reason a
    /// collision cannot silently *drop an edge*.
    ///
    /// String comparison, not numeric, because that is what SQLite's index orders by:
    /// the ids are `TEXT`, so the fixed-width zero-padded hex encoding is doing real
    /// work and a formatting change that dropped the padding would show up here.
    ///
    /// The second, independent guard on the same property is
    /// `graph_edge_count_matches_the_quadratic_fan_out`: it compares reported counts
    /// (accumulated from each `execute`'s rows-affected) against the `n·(n−1)`
    /// formula, so any collision that made the conflict clause fire would under-count
    /// and fail it. This test says the ids are sound; that one says the graph a real
    /// ingest wrote is still the graph it was.
    #[test]
    fn graph_row_ids_are_unique_and_monotonic() {
        const N: usize = 100_000;
        let ids: Vec<String> = (0..N).map(|_| graph_row_id()).collect();
        assert!(
            ids.windows(2).all(|w| w[0] < w[1]),
            "graph row ids must sort strictly ascending as TEXT — that is the whole \
             point of not using a v4 UUID here"
        );
        let distinct: std::collections::HashSet<&String> = ids.iter().collect();
        assert_eq!(
            distinct.len(),
            N,
            "a duplicate id makes INSERT OR IGNORE fire and silently drops a graph row"
        );
        // Fixed width: a variable-length id would sort lexicographically wrong the
        // moment the counter gained a digit, which is exactly how a "monotonic" id
        // scheme regresses into a random one without anything failing.
        assert!(
            ids.iter().all(|id| id.len() == 32),
            "ids must be 32 hex chars"
        );
    }

    /// Asserted on the *rebuild* path (`set_retrieval_mode`) so the reported counts,
    /// the stored rows, and the formula are checked against each other at once.
    #[tokio::test]
    async fn graph_edge_count_matches_the_quadratic_fan_out() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Dense", None, &DocOwner::unattributed())
            .await
            .unwrap();
        let corpus = prose_corpus(6);
        let per_chunk: Vec<usize> = chunk_text(&corpus)
            .iter()
            .map(|c| extract_entities(c).len())
            .collect();
        // Guard the guard: if the fixture ever degenerated into a couple of tiny
        // chunks this test would pass while proving nothing about fan-out.
        assert!(
            per_chunk.len() >= 4,
            "fixture must span several chunks, got {}",
            per_chunk.len()
        );
        assert!(
            per_chunk.iter().all(|n| *n >= 20),
            "fixture chunks must be entity-dense (this is what makes the graph \
             expensive); got {per_chunk:?}"
        );
        let expected_nodes: usize = per_chunk.iter().sum();
        let expected_edges: usize = per_chunk.iter().map(|n| n * n.saturating_sub(1)).sum();

        store
            .ingest_document(&space, "Dense", &corpus, &DocOwner::unattributed())
            .await
            .unwrap();
        let change = store
            .set_retrieval_mode(&space, RetrievalMode::Graph)
            .await
            .unwrap()
            .expect("space exists");

        assert_eq!(change.chunks_scanned, per_chunk.len());
        assert_eq!(
            change.graph_nodes, expected_nodes,
            "one node per entity occurrence"
        );
        assert_eq!(
            change.graph_edges, expected_edges,
            "n·(n−1) directed edges per chunk — if you meant to change this, change \
             the cost docs on build_graph_for_chunks in the same commit"
        );
        // Reported counts must equal what is actually stored.
        let (nodes, edges) = graph_row_counts(&store, &space).await;
        assert_eq!(nodes as usize, expected_nodes);
        assert_eq!(edges as usize, expected_edges);
    }

    /// **A query over a dense co-occurrence graph must terminate in bounded work and
    /// return the same chunks every time.**
    ///
    /// With ≈57 entities per chunk every entity has ≈56 neighbours, so an
    /// unbounded 3-hop BFS reaches essentially the whole Space. `graph_search` now
    /// stops the moment `limit` chunks are collected (previously it only checked
    /// between hops) and carries at most [`MAX_FRONTIER_ENTITIES`] into the next
    /// hop.
    ///
    /// The determinism half is a real defect, not a nicety: the frontier used to be
    /// a `HashSet`, so on any Space with more reachable chunks than `limit` the
    /// answer to an identical query changed between runs.
    #[tokio::test]
    async fn graph_search_is_bounded_and_deterministic_on_a_dense_space() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space_with_mode(
                "Dense",
                None,
                RetrievalMode::Graph,
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        let corpus = prose_corpus(12);
        let total_chunks = chunk_text(&corpus).len();
        store
            .ingest_document(&space, "Dense", &corpus, &DocOwner::unattributed())
            .await
            .unwrap();
        assert!(
            total_chunks > 5,
            "fixture must hold more chunks than the limit under test"
        );

        // Bounded: never more than asked for, even though the traversal could reach
        // every chunk in the Space.
        let first = store
            .graph_search(&space, "logistics", 5, &DocFilter::unrestricted())
            .await
            .unwrap();
        assert!(
            first.len() <= 5,
            "graph_search returned {} chunks for limit=5",
            first.len()
        );
        assert!(
            !first.is_empty(),
            "a query entity present in the corpus must hit"
        );

        // Deterministic: identical query ⇒ identical chunks in identical order.
        for _ in 0..3 {
            let again = store
                .graph_search(&space, "logistics", 5, &DocFilter::unrestricted())
                .await
                .unwrap();
            assert_eq!(
                again.iter().map(|c| &c.chunk_id).collect::<Vec<_>>(),
                first.iter().map(|c| &c.chunk_id).collect::<Vec<_>>(),
                "graph_search must be stable across runs"
            );
        }

        // A limit larger than the Space cannot invent chunks, and the public
        // `search` entry point honours the limit through reranking too.
        let wide = store
            .graph_search(&space, "logistics", 10_000, &DocFilter::unrestricted())
            .await
            .unwrap();
        assert!(wide.len() <= total_chunks);
        let via_search = store.search(&space, "logistics", 3).await.unwrap();
        assert!(via_search.len() <= 3);
    }

    /// `limit = 0` must not walk the graph at all. Cheap, but it is the boundary the
    /// new "check the budget inside the loop" logic is built on.
    #[tokio::test]
    async fn graph_search_with_zero_limit_returns_nothing() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space_with_mode("G", None, RetrievalMode::Graph, &DocOwner::unattributed())
            .await
            .unwrap();
        store
            .ingest_document(
                &space,
                "A",
                "Alice works at Acme.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        assert!(store
            .graph_search(&space, "Alice", 0, &DocFilter::unrestricted())
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn public_search_caps_oversized_limits_without_panicking() {
        let store = SpaceStore::open_in_memory().unwrap();
        for mode in [RetrievalMode::Vector, RetrievalMode::Graph] {
            let space = store
                .create_space_with_mode(mode.as_str(), None, mode, &DocOwner::unattributed())
                .await
                .unwrap();
            store
                .ingest_document(
                    &space,
                    "Doc",
                    "Alice works at Acme in Paris.",
                    &DocOwner::unattributed(),
                )
                .await
                .unwrap();
            let hits = store.search(&space, "Alice", usize::MAX).await.unwrap();
            assert!(hits.len() <= 50);
        }
    }

    #[tokio::test]
    async fn graph_search_reaches_a_chunk_three_edges_from_the_query_seed() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space_with_mode(
                "Three hops",
                None,
                RetrievalMode::Graph,
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        for (title, content) in [
            ("Seed", "Alpha Bridgeone"),
            ("Hop one", "Bridgeone Bridgetwo"),
            ("Hop two", "Bridgetwo Bridgethree"),
            ("Answer", "Bridgethree Finalanswer"),
        ] {
            store
                .ingest_document(&space, title, content, &DocOwner::unattributed())
                .await
                .unwrap();
        }

        let hits = store
            .graph_search(&space, "Alpha", 20, &DocFilter::unrestricted())
            .await
            .unwrap();
        assert!(
            hits.iter().any(|hit| hit.content.contains("Finalanswer")),
            "the documented three-edge traversal must load the distance-three chunk"
        );
    }

    /// **Exercises [`MAX_FRONTIER_ENTITIES`].** A bound whose truncation branch no
    /// test ever executes is a bound that might not take effect — the same defect
    /// family as the mode flag that could not take effect.
    ///
    /// `prose_corpus` cannot reach the cap: it repeats one paragraph, so the whole
    /// corpus has ≈57 shared entities plus one `marker{i}` per chunk, and a frontier
    /// tops out in the dozens. This fixture instead gives every chunk its own 30
    /// unique tokens around one shared hub, so the hub's out-degree is `30 ×
    /// chunks` — asserted below to exceed the cap, so the truncation is provably
    /// reached rather than assumed.
    ///
    /// Be precise about what this does and does not establish, because a bound test
    /// that overstates itself is the same species of defect as the bound it guards:
    ///
    /// - **Does:** prove the truncation branch executes over real stored data (the
    ///   hub's degree is read back from `graph_edges` and asserted to exceed the
    ///   cap), and that a search whose frontier is truncated still terminates,
    ///   obeys `limit`, and returns the same chunks in the same order every run.
    /// - **Does not:** prove the cap is what determines the *result*. Every chunk
    ///   here contains the hub, so hop 1 already collects all of them and this test
    ///   would pass with the cap set to 5 or to 5,000.
    ///
    /// That second half is no longer a gap in the file, only in this test:
    /// `graph_search_frontier_truncation_can_drop_a_reachable_chunk` closes it by
    /// putting a chunk behind a bridge entity that the cap drops, and it fails the
    /// moment the cap is lifted. It stays sized from the constant rather than from
    /// the literal 512, so retuning the cap re-scales the fixture instead of
    /// silently un-testing the bound.
    #[tokio::test]
    async fn graph_search_truncates_an_oversized_frontier() {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space_with_mode("Hub", None, RetrievalMode::Graph, &DocOwner::unattributed())
            .await
            .unwrap();
        const DOCS: usize = 24;
        const UNIQUE_PER_DOC: usize = 30;
        for doc in 0..DOCS {
            let mut text = String::from("hubentity ");
            for tok in 0..UNIQUE_PER_DOC {
                text.push_str(&format!("satellite{doc}x{tok} "));
            }
            store
                .ingest_document(&space, &format!("D{doc}"), &text, &DocOwner::unattributed())
                .await
                .unwrap();
        }

        // The truncation branch is only reached if the hub really does have more
        // neighbours than the cap. Assert that from the data, not from arithmetic.
        let hub_degree: i64 = {
            let conn = store.conn.lock().await;
            conn.query_row(
                "SELECT COUNT(DISTINCT dst_entity) FROM graph_edges
                 WHERE space_id = ?1 AND src_entity = ?2",
                params![space, store.seal.keys.entity_token("hubentity")],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert!(
            hub_degree as usize > MAX_FRONTIER_ENTITIES,
            "fixture must overflow the frontier cap to exercise it; hub degree was \
             {hub_degree}, cap is {MAX_FRONTIER_ENTITIES}"
        );

        // A limit far above the Space's size means the traversal never short-circuits
        // on `limit`, so the cap is the only thing bounding hop 2.
        let wide = store
            .graph_search(&space, "hubentity", 10_000, &DocFilter::unrestricted())
            .await
            .unwrap();
        assert!(
            wide.len() <= DOCS,
            "traversal returned {} chunks for a {DOCS}-chunk Space",
            wide.len()
        );
        assert!(!wide.is_empty(), "the hub entity must hit its own chunks");
        for _ in 0..3 {
            let again = store
                .graph_search(&space, "hubentity", 10_000, &DocFilter::unrestricted())
                .await
                .unwrap();
            assert_eq!(
                again.iter().map(|c| &c.chunk_id).collect::<Vec<_>>(),
                wide.iter().map(|c| &c.chunk_id).collect::<Vec<_>>(),
                "a truncated frontier must truncate the SAME way every run"
            );
        }
    }

    /// Builds a Space whose hub entity provably overflows [`MAX_FRONTIER_ENTITIES`],
    /// plus a two-hop path off it: `hubentity → <bridge> → <answer chunk>`.
    ///
    /// Shared by the two traversal-bound tests so they differ in exactly ONE
    /// variable — where the bridge sorts relative to the satellites — which is the
    /// variable the cap keys on (`ORDER BY e.dst_entity`, so truncation keeps the
    /// lexicographically smallest neighbours). Everything else is identical, so a
    /// difference in outcome can only be the cap.
    ///
    /// Layout, all lowercase because [`extract_entities`] normalizes:
    /// - `docs` hub chunks, each `hubentity` + `{satellite_prefix}{d}x{t}`. Sized
    ///   from the constant, never from a literal, so retuning the cap cannot make
    ///   the fixture vacuous.
    /// - one **bridge** chunk: `hubentity {bridge}` — and nothing else, so the
    ///   bridge co-occurs with the hub and with the answer, and with no satellite.
    ///   That is what makes the negative case genuinely unreachable: a dense fixture
    ///   would rediscover a truncated entity one hop later through a shared chunk.
    /// - one **answer** chunk: `{bridge} zzzanswerfact` — no `hubentity`, so it can
    ///   only be reached by traversal, never as a direct hit.
    ///
    /// Returns `(store, space_id, answer_chunk_content)`.
    async fn hub_fixture(
        satellite_prefix: &str,
        bridge_sorts_first: bool,
    ) -> (SpaceStore, String, &'static str, String) {
        const UNIQUE_PER_DOC: usize = 30;
        // Comfortably past the cap whatever the cap is, so the truncation branch is
        // reached and enough entities are left over to be dropped.
        let docs = (MAX_FRONTIER_ENTITIES + 64).div_ceil(UNIQUE_PER_DOC);

        let store = SpaceStore::open_in_memory().unwrap();
        // The traversal orders neighbours by their blind token (entities are
        // stored only as tokens), so pick a bridge name whose token sorts before
        // (or after) every satellite's.
        let satellite_tokens: Vec<String> = (0..docs)
            .flat_map(|doc| {
                (0..UNIQUE_PER_DOC).map(move |tok| format!("{satellite_prefix}{doc}x{tok}"))
            })
            .map(|name| store.seal.keys.entity_token(&name))
            .collect();
        let lowest = satellite_tokens.iter().min().cloned().unwrap();
        let highest = satellite_tokens.iter().max().cloned().unwrap();
        let bridge = (0..1_000_000)
            .map(|n| format!("bridge{n}"))
            .find(|name| {
                let token = store.seal.keys.entity_token(name);
                if bridge_sorts_first {
                    token < lowest
                } else {
                    token > highest
                }
            })
            .expect("a bridge name with the wanted token order");
        let bridge = bridge.as_str();
        let space = store
            .create_space_with_mode("Hub", None, RetrievalMode::Graph, &DocOwner::unattributed())
            .await
            .unwrap();
        for doc in 0..docs {
            let mut text = String::from("hubentity");
            for tok in 0..UNIQUE_PER_DOC {
                text.push_str(&format!(" {satellite_prefix}{doc}x{tok}"));
            }
            store
                .ingest_document(&space, &format!("D{doc}"), &text, &DocOwner::unattributed())
                .await
                .unwrap();
        }
        store
            .ingest_document(
                &space,
                "Bridge",
                &format!("hubentity {bridge}"),
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        const ANSWER: &str = "zzzanswerfact";
        store
            .ingest_document(
                &space,
                "Answer",
                &format!("{bridge} {ANSWER}"),
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();

        // Non-vacuity, read from the stored graph rather than assumed from
        // arithmetic: if the hub's out-degree did not exceed the cap, neither test
        // below would be exercising the truncation branch at all.
        let hub_degree: i64 = {
            let conn = store.conn.lock().await;
            conn.query_row(
                "SELECT COUNT(DISTINCT dst_entity) FROM graph_edges
                 WHERE space_id = ?1 AND src_entity = ?2",
                params![space, store.seal.keys.entity_token("hubentity")],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert!(
            hub_degree as usize > MAX_FRONTIER_ENTITIES,
            "fixture must overflow the frontier cap; hub degree was {hub_degree}, \
             cap is {MAX_FRONTIER_ENTITIES}"
        );
        (store, space, ANSWER, bridge.to_owned())
    }

    /// **The cap truncates, and the grounded chunk still comes back.**
    ///
    /// The bridge is named so its token sorts *before* every satellite's, so it survives the
    /// truncation and the two-hop path `hubentity → bridge → answer chunk`
    /// resolves. This is the half that proves the cap bounds the traversal without
    /// breaking it: the search terminates and returns the chunk that a full
    /// traversal would have returned — even though hop 1 threw away every neighbour
    /// past the cap.
    ///
    /// Stated plainly, because a test that overstates itself is the defect it
    /// guards: this one would also pass with the cap lifted. Its job is that
    /// truncation (asserted from the hub's stored out-degree in [`hub_fixture`])
    /// does **not** cost the answer. The test whose *outcome* depends on the cap is
    /// the lossiness one below.
    #[tokio::test]
    async fn graph_search_reaches_a_two_hop_chunk_through_a_truncated_frontier() {
        let (store, space, answer, _bridge) = hub_fixture("sat", true).await;
        let hits = store
            .graph_search(&space, "hubentity", 10_000, &DocFilter::unrestricted())
            .await
            .unwrap();
        assert!(
            hits.iter().any(|c| c.content.contains(answer)),
            "the two-hop answer chunk must survive frontier truncation when its \
             bridge entity sorts inside the cap"
        );
        // The answer chunk contains no query entity, so a direct hit cannot explain
        // the result — it is genuinely two hops away.
        assert!(
            !hits
                .iter()
                .any(|c| c.content.contains(answer) && c.content.contains("hubentity")),
            "fixture broken: the answer chunk must not contain the query entity"
        );
    }

    /// **The cap is LOSSY, and that is a retrieval claim, not a performance one.**
    ///
    /// Identical fixture to the test above with one change: the bridge token sorts *after*
    /// every satellite, so hop 1 fills its [`MAX_FRONTIER_ENTITIES`] budget with
    /// satellites and the bridge is dropped. The chunk behind it then becomes
    /// unreachable — permanently, not just later: the bridge shares a chunk with the
    /// hub and the answer only, so no hop-2 or hop-3 frontier can rediscover it
    /// (in a *dense* Space a truncated entity usually does come back a hop later
    /// through a shared chunk, which is why the fixture is deliberately sparse here).
    ///
    /// This is asserted rather than left as a doc sentence because a silently lossy
    /// bound is exactly the defect class this file has been shedding: a knob whose
    /// stated effect (speed) is not its real effect (which chunks exist, as far as
    /// retrieval is concerned). Retuning `MAX_FRONTIER_ENTITIES` therefore changes
    /// answers, and the fixture is sized from the constant so this stays true at any
    /// value.
    #[tokio::test]
    async fn graph_search_frontier_truncation_can_drop_a_reachable_chunk() {
        let (store, space, answer, bridge) = hub_fixture("aaa", false).await;

        // Reachable in principle: seeded directly at the bridge, the traversal finds
        // the answer chunk in one hop. So the fixture is connected, and the miss
        // below is the cap's doing.
        let direct = store
            .graph_search(&space, &bridge, 10_000, &DocFilter::unrestricted())
            .await
            .unwrap();
        assert!(
            direct.iter().any(|c| c.content.contains(answer)),
            "fixture broken: the answer chunk must be reachable from its bridge"
        );

        let hits = store
            .graph_search(&space, "hubentity", 10_000, &DocFilter::unrestricted())
            .await
            .unwrap();
        assert!(
            hits.iter().any(|c| c.content.contains(bridge.as_str())),
            "the bridge's own chunk is a direct hop-1 hit and must still be returned"
        );
        assert!(
            !hits.iter().any(|c| c.content.contains(answer)),
            "the cap is lossy by construction: a chunk whose only path runs through \
             a truncated frontier entity is NOT returned. If this now passes, the \
             traversal's reachability changed — update the docs on graph_search and \
             MAX_FRONTIER_ENTITIES in the same commit"
        );
    }

    /// **The regression guard for "document ingest no longer occupies a runtime
    /// worker."**
    ///
    /// `#[tokio::test]` builds a **current-thread** runtime: exactly one worker. So
    /// a spawned ticker task can only advance while the test's own task is parked at
    /// an await point — which makes "did the ingest yield the worker?" directly
    /// observable as a tick count, with no timing assertion.
    ///
    /// Both halves were run against the pre-fix (inline) shape and both counted
    /// **exactly 0** ticks: the embed loop's awaits are all immediately-ready and an
    /// uncontended `tokio::Mutex::lock().await` does not yield, so nothing between
    /// the call and its return ever returned `Pending`. After the fix, one observed
    /// run on a laptop counted 35,301 (ingest) and 56,473 (update). Those two
    /// figures are a *spin rate* — they say nothing beyond "the worker was free" and
    /// will differ per machine — so the threshold asserted below is 8, chosen to sit
    /// far above the pre-fix 0 and far below any real run, pinning the shape rather
    /// than the scheduler.
    #[tokio::test]
    async fn graph_ingest_does_not_occupy_the_async_worker() {
        use std::sync::atomic::{AtomicBool, AtomicUsize};

        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space_with_mode(
                "Dense",
                None,
                RetrievalMode::Graph,
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        // Dense enough that the blocking phase is the dominant cost of the call:
        // ≈57 entities/chunk ⇒ ≈3,200 edge rows per chunk (see
        // [`build_graph_for_chunks`]).
        let corpus = prose_corpus(24);

        let stop = Arc::new(AtomicBool::new(false));
        let ticks = Arc::new(AtomicUsize::new(0));
        let ticker = tokio::spawn({
            let stop = Arc::clone(&stop);
            let ticks = Arc::clone(&ticks);
            async move {
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    ticks.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    tokio::task::yield_now().await;
                }
            }
        });
        // Let the ticker reach its loop before the measurement window opens.
        tokio::task::yield_now().await;
        let before = ticks.load(std::sync::atomic::Ordering::Relaxed);

        let doc = store
            .ingest_document(&space, "Dense", &corpus, &DocOwner::unattributed())
            .await
            .unwrap();

        let during_ingest = ticks.load(std::sync::atomic::Ordering::Relaxed) - before;

        // `update_document` (the editor's embed-on-save path) re-runs the same
        // quadratic graph build over the whole document, so it was moved off the
        // worker in the same change and is measured in the same window.
        let before_update = ticks.load(std::sync::atomic::Ordering::Relaxed);
        let updated_corpus = format!("{corpus}\nAdditional updated evidence.");
        store
            .update_document(&doc, "Dense", &updated_corpus)
            .await
            .unwrap();
        let during_update = ticks.load(std::sync::atomic::Ordering::Relaxed) - before_update;

        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = ticker.await;

        assert!(
            during_ingest >= 8,
            "the ingest never parked the single runtime worker ({during_ingest} \
             ticks) — the graph build is back on the async worker"
        );
        assert!(
            during_update >= 8,
            "the document update never parked the single runtime worker \
             ({during_update} ticks) — the graph rebuild is back on the async worker"
        );
        // The work must still have happened: an off-worker ingest that wrote no
        // graph is a green test over a broken path. (`update_document` deletes the
        // document's graph rows before re-inserting, so a non-zero count here also
        // says the update's own rebuild ran.)
        let (nodes, edges) = graph_row_counts(&store, &space).await;
        assert!(
            nodes > 0 && edges > 0,
            "graph-mode ingest wrote no graph rows (nodes={nodes}, edges={edges})"
        );
    }

    /// **The reproduction harness for the cost table on [`build_graph_for_chunks`].**
    ///
    /// `#[ignore]`d, not deleted: it takes 1–2 minutes, so it must not run in CI, but
    /// a documented measurement nobody can re-derive decays into folklore — which is
    /// precisely how the "affordable enough to run inline" claim it replaced
    /// survived. It prints; it asserts nothing about wall clock (timings on a shared
    /// machine are not a pass/fail signal), so it cannot rot into a false red or a
    /// false green. Run it with:
    ///
    /// ```text
    /// cargo test --release -p ryu-spaces measure_graph_rebuild_cost -- --ignored --nocapture --test-threads=1
    /// ```
    ///
    /// Both storage shapes are measured because they differ by ~1.6×, and the
    /// production one is the slow one: `open_in_memory` is what every other test in
    /// this file uses, and quoting only that number understates a real Space by
    /// seconds. The row/edge counts it prints are exact and reproduce byte for byte
    /// (they did so across the [`graph_row_id`] change, which is how that change was
    /// shown to cost no graph rows); the seconds are a range and should be read as
    /// one.
    ///
    /// How wide a range depends on which shape you are measuring, and that is itself
    /// the finding: under v4-UUID ids the 1,566-chunk on-disk case came out at 87 s
    /// and 46 s on two runs of the same laptop, because the cost of a
    /// randomly-addressed index is whatever of it happens to be resident. Since
    /// [`graph_row_id`] made the inserts ordered, runs sit within ~10 % of each
    /// other. Free disk space also moves the absolute numbers noticeably — treat
    /// figures from different sessions as ratios, not as differences.
    #[tokio::test]
    #[ignore = "measurement harness: ~35 s, run manually (see doc comment)"]
    async fn measure_graph_rebuild_cost() {
        let dir = std::env::temp_dir().join(format!("ryu-spaces-measure-{}", uuid::Uuid::new_v4()));
        // Stay within the public graph quotas; the quota rejection itself is
        // covered by fast deterministic tests rather than this timing harness.
        for target in [96usize, 383] {
            let corpus = prose_corpus(target);
            let chunks = chunk_text(&corpus);
            let per: Vec<usize> = chunks.iter().map(|c| extract_entities(c).len()).collect();
            let avg_chars = chunks.iter().map(|c| c.chars().count()).sum::<usize>() / chunks.len();
            let avg_entities = per.iter().sum::<usize>() / per.len();

            for on_disk in [false, true] {
                let store = if on_disk {
                    SpaceStore::open_at(
                        dir.join(format!("{target}/spaces.db")),
                        Embedder::Local { dims: 8 },
                        8,
                        DEFAULT_GRAPH_EXTRACTION_MODEL.to_owned(),
                        Reranker::Local,
                        dir.join(format!("{target}/blobs")),
                        None,
                    )
                    .unwrap()
                } else {
                    SpaceStore::open_in_memory().unwrap()
                };
                let space = store
                    .create_space("Measure", None, &DocOwner::unattributed())
                    .await
                    .unwrap();
                store
                    .ingest_document(&space, "Measure", &corpus, &DocOwner::unattributed())
                    .await
                    .unwrap();
                // Ingest happened in vector mode, so this is a cold, full rebuild —
                // the exact work one click on the retrieval-mode switch performs.
                let started = std::time::Instant::now();
                let change = store
                    .set_retrieval_mode(&space, RetrievalMode::Graph)
                    .await
                    .unwrap()
                    .expect("space exists");
                let wall = started.elapsed();
                println!(
                    "storage={:9} chunks={:5} chars/chunk={:4} entities/chunk={:3} (min {:3} max {:3}) nodes={:7} edges={:9} wall={:>12?} per-chunk={:?}",
                    if on_disk { "on-disk" } else { "in-memory" },
                    change.chunks_scanned,
                    avg_chars,
                    avg_entities,
                    per.iter().min().unwrap(),
                    per.iter().max().unwrap(),
                    change.graph_nodes,
                    change.graph_edges,
                    wall,
                    wall / (change.chunks_scanned.max(1) as u32),
                );
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The reproduction harness for the chat-attachment stall (X2).**
    ///
    /// Measures the thing the defect is actually about, which is *not* how long the
    /// upload takes. `SpaceStore` holds ONE `Connection` behind ONE
    /// `tokio::Mutex`, so the number that matters is the **worst latency a cheap,
    /// unrelated Space operation sees while an attachment is being indexed** — a
    /// sidebar refresh, another Space's search, a second upload. A slow upload is a
    /// slow upload; a slow upload that freezes every Space on the node is the bug.
    ///
    /// Shape of the measurement:
    /// - on-disk store (WAL, the production storage shape — `open_in_memory` is
    ///   2–5× faster and would understate this), graph-mode Space;
    /// - `create_file` then [`SpaceStore::replace_file_chunks`], i.e. exactly the
    ///   path `space_file_index::record_parse_result` takes for a floor-readable
    ///   `.md`/`.csv`/`.txt` attachment;
    /// - a concurrent probe task looping `count_spaces()` (one indexed `COUNT`,
    ///   microseconds uncontended) and recording its **maximum** observed latency.
    ///
    /// Prints; asserts nothing about wall clock, for the same reason
    /// [`measure_graph_rebuild_cost`] does not — timings on a shared machine are a
    /// diagnostic, not a pass/fail signal.
    ///
    /// ```text
    /// cargo test --release -p ryu-spaces measure_attachment_stall -- --ignored --nocapture --test-threads=1
    /// ```
    ///
    /// Current-thread runtime, and that is fine rather than a compromise: the
    /// transaction runs on `spawn_blocking` (a separate pool), the test's own task
    /// is parked awaiting its `JoinHandle`, so the probe is freely schedulable
    /// throughout. What it waits on is therefore the connection **mutex**, not the
    /// executor — which is exactly the quantity under measurement. (This crate's
    /// `tokio` dev-dependency does not enable `rt-multi-thread`, and Cargo.toml is
    /// not this change's to edit.)
    #[tokio::test]
    #[ignore = "measurement harness: minutes, run manually (see doc comment)"]
    async fn measure_attachment_stall() {
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

        let dir = std::env::temp_dir().join(format!("ryu-spaces-stall-{}", uuid::Uuid::new_v4()));
        // Sizes chosen to bracket "a file someone drags into a chat": a note, a
        // README, a spec, a long report. The largest case stays below the
        // 256-chunk Graph document limit.
        for target in [8usize, 32, 100, 240] {
            let corpus = prose_corpus(target);
            let case = dir.join(target.to_string());
            let store = SpaceStore::open_at(
                case.join("spaces.db"),
                Embedder::Local { dims: 8 },
                8,
                DEFAULT_GRAPH_EXTRACTION_MODEL.to_owned(),
                Reranker::Local,
                case.join("blobs"),
                None,
            )
            .unwrap();
            let space = store
                .create_space_with_mode(
                    "Attach",
                    None,
                    RetrievalMode::Graph,
                    &DocOwner::unattributed(),
                )
                .await
                .unwrap();
            let doc = store
                .create_file(
                    &space,
                    "attachment.md",
                    corpus.as_bytes(),
                    "text/markdown",
                    &DocOwner::unattributed(),
                )
                .await
                .unwrap();

            let stop = Arc::new(AtomicBool::new(false));
            let worst_us = Arc::new(AtomicU64::new(0));
            let probe = tokio::spawn({
                let store = store.clone();
                let stop = Arc::clone(&stop);
                let worst_us = Arc::clone(&worst_us);
                async move {
                    let mut samples = 0u64;
                    while !stop.load(Ordering::Relaxed) {
                        let t = std::time::Instant::now();
                        let _ = store.count_spaces().await;
                        let us = t.elapsed().as_micros() as u64;
                        worst_us.fetch_max(us, Ordering::Relaxed);
                        samples += 1;
                        tokio::task::yield_now().await;
                    }
                    samples
                }
            });
            tokio::task::yield_now().await;

            let started = std::time::Instant::now();
            let chunks = store.replace_file_chunks(&doc, &corpus).await.unwrap();
            let wall = started.elapsed();

            stop.store(true, Ordering::Relaxed);
            let samples = probe.await.unwrap();
            let (nodes, edges) = graph_row_counts(&store, &space).await;
            println!(
                "bytes={:7} chunks={:4} nodes={:6} edges={:8} call={:>10.3?} \
                 worst-concurrent-op={:>10.3?} probes={}",
                corpus.len(),
                chunks,
                nodes,
                edges,
                wall,
                std::time::Duration::from_micros(worst_us.load(Ordering::Relaxed)),
                samples,
            );
            // Per-case cleanup, not just at the end: the largest graph is hundreds
            // of thousands of edge rows across two indexes, and
            // keeping every case alive would make the harness's peak footprint the
            // sum rather than the max.
            drop(store);
            let _ = std::fs::remove_dir_all(&case);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
