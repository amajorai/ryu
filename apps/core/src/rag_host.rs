//! Core's kernel side of the extracted [`ryu_rag`] seam — the **single resolver**
//! through which every embedder/reranker/retrieval-store in the process is
//! constructed.
//!
//! `ryu-rag` owns the RAG *primitive* (the `Embedder`/`Reranker` enums, the
//! sqlite-backed `RetrievalStore`, the `RagProvider` trait) built from plain
//! config. What it deliberately cannot own — because they are kernel couplings —
//! are the three reads that decide *which* provider/model is active and *who*
//! owns pre-tenancy chunks: the model registry ([`crate::registry::ModelRegistry`],
//! env > registry.json > local default), the default `~/.ryu` db path
//! ([`crate::paths::ryu_dir`]), and the org/account lookup for the memory-owner
//! backfill ([`crate::sidecar::control_plane`] + [`crate::auth`]).
//!
//! Every RAG construction site in Core funnels through this module (grep-invariant:
//! no `Embedder::`/`Reranker::`/`RetrievalStore::open*` construction lives outside
//! `rag_host` + `#[cfg(test)]`), so a provider swap is a change at exactly one
//! origin — memory, spaces, search, tool-routing and chat retrieval move together,
//! never a silent half-swap. The provider is keyed by `RYU_RAG_PROVIDER` (default
//! `"vector"`) and resolved by [`provider_binding`]: the in-process `"vector"` provider (sqlite-vec,
//! the default) alone, or the in-process provider plus a configured external
//! vector store ([`vector_store`]: Qdrant, Chroma, Pinecone, Weaviate, Milvus,
//! pgvector, or a local sqlite-vec collection). Any other id is an **explicit
//! error** ([`open_retrieval_store`]), never a silent fallthrough to vector. A real
//! GraphRAG *sidecar* provider (broker-routed) is the deferred W8 follow-on.
//!
//! Mirrors the `search_host`/`crypto_host` precedent (kernel wiring the extracted
//! crate can't own), by *constructor injection* like `ryu-storage`.

use std::sync::Arc;

use anyhow::Result;

use ryu_rag::{
    ChunkSource, Embedder, Reranker, RetrievalOptions, RetrievalStore, ScoredChunk, SpaceRecall,
};
use ryu_spaces::{DocFilter, SpaceSearchOptions, SpaceStore};

use crate::registry::ModelRegistry;

pub mod vector_store;

use ryu_vector_stores::VectorStoreProvider;

/// `true` when the active provider is the built-in in-process vector RAG.
fn is_in_process(id: &str) -> bool {
    matches!(id, "vector" | "in-process" | "builtin" | "ryu-rag")
}

/// What the configured RAG provider resolves to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderBinding {
    /// The built-in in-process stores only (`retrieval.db` + sqlite-vec Spaces).
    BuiltIn,
    /// The built-in stores plus an external vector-store collection, answered as
    /// the [`vector_store::SOURCE_ID`] retrieval source.
    VectorStore(VectorStoreProvider),
}

/// Resolve the provider binding from `RYU_RAG_PROVIDER` and
/// `RYU_RAG_VECTOR_STORE_PROVIDER` (node-config `settings.rag.provider` /
/// `settings.rag.vectorStore.provider`) through `lookup`.
///
/// - `RYU_RAG_VECTOR_STORE_PROVIDER` names the vector store explicitly;
/// - `RYU_RAG_PROVIDER` may name one as shorthand (`RYU_RAG_PROVIDER=qdrant`);
/// - both set to different stores is an error rather than a silent pick;
/// - `sqlite-vec` via `RYU_RAG_PROVIDER` is the built-in default itself, while
///   `RYU_RAG_VECTOR_STORE_PROVIDER=sqlite-vec` opts into a separate local
///   knowledge collection (`db/vector-store.db`).
pub fn provider_binding(lookup: impl Fn(&str) -> Option<String>) -> Result<ProviderBinding> {
    let read = |name: &str| {
        lookup(name)
            .map(|value| value.trim().to_lowercase())
            .filter(|value| !value.is_empty())
    };
    let rag = read("RYU_RAG_PROVIDER").unwrap_or_else(|| "vector".to_owned());
    let explicit = read("RYU_RAG_VECTOR_STORE_PROVIDER")
        .map(|id| id.parse::<VectorStoreProvider>())
        .transpose()?;
    let shorthand =
        if is_in_process(&rag) {
            None
        } else {
            match rag.parse::<VectorStoreProvider>() {
                Ok(VectorStoreProvider::SqliteVec) => None,
                Ok(provider) => Some(provider),
                Err(_) => anyhow::bail!(
                "RAG provider '{rag}' is not supported; use 'vector' (the default) or a vector \
                 store id ({}).",
                VectorStoreProvider::ALL.map(VectorStoreProvider::as_str).join(", ")
            ),
            }
        };
    match (explicit, shorthand) {
        (Some(a), Some(b)) if a != b => anyhow::bail!(
            "RYU_RAG_PROVIDER selects '{b}' but RYU_RAG_VECTOR_STORE_PROVIDER selects '{a}'; \
             set one of them."
        ),
        (Some(provider), _) | (None, Some(provider)) => Ok(ProviderBinding::VectorStore(provider)),
        (None, None) => Ok(ProviderBinding::BuiltIn),
    }
}

fn env_lookup(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// The registry the two retrieval-store openers build from — the single seam where
/// "does `registry.json` reach retrieval?" is decided.
///
/// [`ModelRegistry::load`], not `from_env`. `from_env` is `from_file_path(None)`
/// and `None.and_then(RegistryFile::load)` is `None`: it opens no file, ever. The
/// file-backed reranker settings and `graph_extraction_model` must reach the Spaces
/// constructor. The latter is validated there; unsupported ids stop startup instead
/// of silently producing graph rows with the local implementation.
///
/// Embedding fields are different: the vector space of `spaces.db`, `retrieval.db`
/// and `message-embeddings.db` hangs off them and `SpaceStore::open_at` does not
/// reconcile a changed vec0 width. They therefore have no `registry.json` key. See
/// `registry`'s module header.
///
/// Exists as a named function rather than an inline `load()` in each opener so the
/// conversion has one testable point: the openers themselves touch `~/.ryu` and
/// cannot be exercised in a unit test, but this can (see
/// `retrieval_registry_reads_the_registry_file`).
///
/// Deliberately NOT used by `search_host::CoreSearchEmbedder::from_env`, which reads
/// only the embed trio: for those fields the two constructors return identical
/// values, so `load()` there would be a redundant file read implying a file layer
/// that does not exist for them.
pub fn retrieval_registry() -> ModelRegistry {
    ModelRegistry::load()
}

/// Build an embedder from the model registry — the resolver for the default chat
/// embedder. Reads `embed_base_url`, `RYU_EMBED_API_KEY`/`OPENAI_API_KEY`, and the
/// registry embedder id/dims. A blank base URL falls back to the dependency-free
/// local hashing embedder.
///
/// **The embed fields are `env > literal`, whichever constructor built `registry`.**
/// This used to document `env > registry.json > local default`, and used to be a
/// per-caller answer: true for the `load()`-built callers (`tool_registry_host`,
/// `agent_routing::auto`), false for [`open_retrieval_store`] and
/// `server::spaces::open_default`, which passed a `from_env()` registry. That split
/// ran through one field and was the dangerous kind — set `embed_model` and the tool
/// ranker embedded with the new model while `spaces.db` kept being written by the
/// old one.
///
/// It is now settled the other way: `embed_model`, `embed_dims` and `embed_base_url`
/// have no `registry.json` key at all, so both constructors agree and this function
/// behaves identically for every caller. Swap them with `RYU_EMBED_MODEL` /
/// `RYU_EMBED_DIMS` / `RYU_EMBED_BASE_URL`.
///
/// # What a swap costs, per store — the three do NOT recover alike
///
/// Every store tags each row with the `embed_model` that produced it and filters
/// search to the current one, so a swap never mixes vector spaces. What differs is
/// whether the old content comes back:
///
/// - `spaces.db` — recoverable. `POST /api/embeddings/reindex` runs
///   `SpaceStore::reindex_all`, which re-embeds every stale chunk (and drops +
///   recreates the `chunk_vectors` vec0 table first when the dims changed);
///   `GET /api/embeddings/reindex/status` reports progress. Note this is a *manual*
///   trigger for an env-driven swap: `apply_embedder_change` fires only from the
///   separate embedding-model **preference** path (`set_embedding_model`), so
///   nothing re-indexes on its own at boot.
/// - `message-embeddings.db` — self-healing on a **dims** change only.
///   `MessageIndex::open` clears its sealed vectors so the next search
///   re-backfills. A same-dims model change leaves old rows filtered out
///   until they are re-indexed by the normal backfill.
/// - `retrieval.db` — no re-embed path. `RetrievalStore` filters on
///   `embedding_model`, so chunks written under the previous model stay invisible.
///
/// Naming a remedy that only covers one of the three would be the same defect as the
/// half-live knob this comment replaced.
pub fn embedder_from_registry(registry: &ModelRegistry) -> Embedder {
    embedder_from_config(
        registry.embed_base_url.trim(),
        &registry.embedder.id,
        registry.embedder.dims,
    )
}

/// Build an embedder from an explicitly chosen model config (a per-space embedding
/// preference, or the agent-auto-routing embedder). Routes through the same origin
/// as [`embedder_from_registry`] so a provider swap reaches these consumers too.
pub fn embedder_from_config(base_url: &str, model: &str, dims: usize) -> Embedder {
    if std::env::var("RYU_EMBED_PROVIDER")
        .ok()
        .is_some_and(|provider| provider.eq_ignore_ascii_case("gateway"))
    {
        return gateway_embedder(model, dims);
    }
    let api_key = embed_api_key();
    Embedder::remote(base_url, model, dims, api_key)
}

/// Build a cloud-safe embedder through the local/managed Gateway. The Gateway
/// owns upstream provider selection and credentials; Core never sends a cloud
/// API key directly to a provider when this path is selected.
pub fn gateway_embedder(model: &str, dims: usize) -> Embedder {
    let base_url = crate::sidecar::gateway::gateway_url();
    let token = crate::sidecar::gateway::required_gateway_inference_token().ok();
    // Keep provider identity in the stored vector tag. Gateway removes this
    // namespace before model routing, so a local `model-x` and cloud
    // `gateway/model-x` can never silently share vectors.
    Embedder::remote(&base_url, &format!("gateway/{model}"), dims, token)
}

/// Bearer key for the embeddings endpoint (`RYU_EMBED_API_KEY`, then `OPENAI_API_KEY`).
fn embed_api_key() -> Option<String> {
    std::env::var("RYU_EMBED_API_KEY")
        .ok()
        .or_else(|| std::env::var("OPENAI_API_KEY").ok())
        .filter(|s| !s.is_empty())
}

/// Build a reranker from environment + the model registry (the default chat
/// reranker): remote when `RYU_RERANKER_BASE_URL` is set, else the local
/// term-overlap reranker.
///
/// # This one deliberately does NOT read `registry.reranker_base_url`
///
/// The env var is the whole switch: unset ⇒ `Reranker::Local`, and no
/// `registry.json` key can flip that. Routing this through the field would give it
/// the built-in `http://127.0.0.1:8082` default and silently turn `retrieval.db`
/// reranking from local term-overlap into always-remote against the
/// `llamacpp-rerank` sidecar — which is off by default and only lazily started by
/// the *Spaces* search path. `registry.reranker.id` (the `reranker_model` key) IS
/// read, in the remote branch and as the store's reported id.
///
/// [`reranker_local_server`] is the reader of `reranker_base_url`; keep the
/// asymmetry documented at both ends, because "reranker endpoint is configurable in
/// registry.json" is true of exactly one of these two.
///
/// # `RYU_PROFILE` turns the opt-in on for you
///
/// "Off by default" is a *release-profile* statement.
/// [`crate::profile::apply_env_defaults`] seeds `RYU_RERANKER_BASE_URL` on every
/// non-release profile, so on `dev` (what `bun dev` runs) this function always takes
/// the remote branch, pointed at the profile's `llamacpp-rerank` port. Two
/// consequences worth knowing before debugging retrieval on a dev stack:
///
/// - `registry.reranker.id` (the `reranker_model` key) is *observed* there — the
///   remote branch is the one place that key changes behaviour, so dev is where a
///   file-set `reranker_model` actually reaches the wire.
/// - `RetrievalStore::retrieve` propagates a reranker error rather than falling back
///   to cosine order (`self.reranker.rerank(..).await?`, `crates/core/rag/src/store/retrieve.rs`),
///   and `Reranker::Remote` errors when the endpoint is unreachable. The Spaces path
///   falls open to vector order; this one does not. Its main consumer, chat
///   auto-recall (`sidecar::adapters`), catches the error, logs a warning and
///   contributes no chunks — so an un-started rerank sidecar on a dev profile shows
///   up as memory recall silently returning nothing, not as a visible failure.
///
/// The remote branch reached by an operator's own export behaves identically; the
/// profile just makes it the default nobody chose.
pub fn reranker_from_registry(registry: &ModelRegistry) -> Reranker {
    if std::env::var("RYU_RERANKER_PROVIDER")
        .ok()
        .is_some_and(|provider| provider.eq_ignore_ascii_case("gateway"))
    {
        let base_url = format!("{}/v1", crate::sidecar::gateway::gateway_url());
        return Reranker::remote(
            &base_url,
            &format!("gateway/{}", registry.reranker.id),
            crate::sidecar::gateway::required_gateway_inference_token().ok(),
        );
    }
    match std::env::var("RYU_RERANKER_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
    {
        Some(base_url) => Reranker::remote(&base_url, &registry.reranker.id, reranker_api_key()),
        None => Reranker::Local,
    }
}

/// Build a reranker that targets the local `llamacpp-rerank` server (the bge
/// cross-encoder) — used by Spaces RAG. **The one reader of
/// `registry.reranker_base_url`**, and therefore the only place the `registry.json`
/// `reranker_base_url` key takes effect (its sibling [`reranker_from_registry`] is
/// env-opt-in and ignores the field). Always server-backed at
/// `registry.reranker_base_url` (or the `RYU_RERANKER_BASE_URL` override); the
/// Spaces search path lazily starts that server and falls open to vector order when
/// it is unreachable, so this is safe to construct before the server exists.
///
/// # The env preference below is not dormant off release
///
/// `RYU_RERANKER_BASE_URL` is not merely an override an operator might set: it is
/// seeded by [`crate::profile::apply_env_defaults`] on every non-release profile, so
/// the `unwrap_or_else` fallback to `registry.reranker_base_url` — the only thing
/// that makes the `registry.json` key live at all — runs **only** under
/// `RYU_PROFILE=release` (or when the seeding is bypassed, as in the unit tests
/// below, which clear the variable). Keep [`crate::registry::ProviderRegistry::reranker_base_url`]
/// in sync when this precedence changes; that doc is where an operator looks.
///
/// The model id is [`crate::registry::ProviderRegistry::local_reranker_model`]`.id`,
/// deliberately **not** the `reranker_model` key — this is the GGUF the sidecar
/// serves, and naming it from the other field would ask the server for a model it
/// does not have.
pub fn reranker_local_server(registry: &ModelRegistry) -> Reranker {
    let base_url = std::env::var("RYU_RERANKER_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| registry.reranker_base_url.clone());
    Reranker::remote(
        &base_url,
        &registry.local_reranker_model.id,
        reranker_api_key(),
    )
}

/// Bearer key for the reranker endpoint (`RYU_RERANKER_API_KEY`).
fn reranker_api_key() -> Option<String> {
    std::env::var("RYU_RERANKER_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
}

/// Owner attribution for the one-shot pre-tenancy memory-owner backfill:
/// `Some((owner_user_id, owner_org_id))` on an org-bound node with a signed-in
/// account, else `None` (unbound node, or bound node with no account → skip).
fn backfill_owner() -> Option<(String, String)> {
    let org = crate::sidecar::control_plane::registered_org()?;
    match crate::auth::load_accounts()
        .active()
        .map(|a| a.user_id.clone())
    {
        Some(owner) => Some((owner, org.id)),
        None => {
            tracing::warn!(
                "retrieval memory-owner backfill: org-bound node with no signed-in local account \
                 — leaving pre-tenancy memory chunks unattributed (fail closed)."
            );
            None
        }
    }
}

/// Recall diagnostics (counts only, never content): how much of each sealed
/// vector index is searchable from memory right now (`vector_coverage`:
/// `hydrated`, `total`, `evicted_partitions` under the shared
/// `RYU_VECTOR_CACHE_MB` budget) and how many rows were skipped because a sealed
/// value did not open. Degraded semantic recall is visible here, never silent.
pub fn recall_diagnostics(
    retrieval: &RetrievalStore,
    conversations: &crate::server::conversations::ConversationStore,
) -> serde_json::Value {
    serde_json::json!({
        "retrieval": {
            "vector_coverage": retrieval.vector_coverage(),
            "unreadable_rows": retrieval.unreadable_rows(),
        },
        "conversations": conversations.search_index_diagnostics(),
    })
}

/// Open (or create) the process retrieval store at the default `~/.ryu/retrieval.db`
/// path using the node's model registry ([`retrieval_registry`]: env >
/// `registry.json` > literal) — the ServerState field origin. Resolves the embedder
/// + reranker + default reranker id through this module and runs the tenancy
/// backfill with the Core-resolved owner.
///
/// This is the single fallible origin where the bound provider id is enforced
/// ([`provider_binding`]): an unknown id, a conflicting pair, or an invalid
/// vector-store setting is an explicit boot error rather than a silent
/// fallthrough to vector. A configured vector store is validated here and opened
/// lazily on first recall ([`vector_store::ExternalCollection`]); a future GraphRAG
/// sidecar provider is wired here (broker-routed), not faked.
///
/// `spaces` is **required**, not optional, and that is the point: it is what makes
/// `RetrievalOptions::space_ids` reach a real Space at all (see [`SpacesRecall`]).
/// An optional wiring is a wiring somebody forgets, and the symptom of forgetting
/// it is silent — an agent's Space allowlist that retrieves nothing, which is the
/// exact defect this delegate closes.
pub fn open_retrieval_store(spaces: &SpaceStore) -> Result<RetrievalStore> {
    let binding = provider_binding(env_lookup)?;
    // `retrieval_registry()` (= `load()`), not `from_env()`: this store's
    // `reranker_model` comes from `registry.json` when the operator set it there.
    let registry = retrieval_registry();
    let embedder = embedder_from_registry(&registry);
    let reranker = reranker_from_registry(&registry);
    let recall: Arc<dyn SpaceRecall> = match binding {
        ProviderBinding::BuiltIn => Arc::new(SpacesRecall::new(spaces.clone())),
        ProviderBinding::VectorStore(provider) => {
            let settings = vector_store::VectorStoreSettings::from_lookup(provider, env_lookup)?;
            tracing::info!(
                "retrieval: {provider} vector store collection '{}' is available as source '{}'",
                settings.collection,
                vector_store::SOURCE_ID
            );
            Arc::new(vector_store::VectorStoreRecall::new(
                SpacesRecall::new(spaces.clone()),
                vector_store::ExternalCollection::new(settings, embedder.clone()),
            ))
        }
    };
    Ok(RetrievalStore::open(
        crate::paths::db_path("retrieval.db"),
        embedder,
        reranker,
        registry.reranker.id.clone(),
        backfill_owner(),
    )?
    .with_space_recall(recall))
}

/// The Core-side [`SpaceRecall`] delegate: answers `RetrievalOptions::space_ids`
/// out of the **Spaces** store, so a Space's `retrieval_mode` governs the chat
/// path (`run_auto_recall` → `RetrievalStore::retrieve`) and
/// `POST /api/retrieval/search`, not only the Spaces search box.
///
/// # Why this lowering lives here and is this thin
///
/// `ryu-rag` cannot depend on `ryu-spaces` (the dependency runs the other way —
/// `ryu-spaces` uses `ryu_rag::Embedder`), so the trait is declared in `ryu-rag`
/// and implemented here, in the module that already owns every RAG construction
/// site. All it does is lower tenancy into a [`DocFilter`] and call
/// [`SpaceStore::search_with`] — the SAME pipeline the Spaces search box and the
/// `ryu_search_space` MCP tool use, which is what keeps `retrieval_mode` and the
/// entity graph single-sourced in `spaces.db`. Nothing here re-reads a Space's
/// mode; `search_with` branches on it internally. The request's `hybrid` and
/// `filter` knobs are forwarded so they apply inside each Space.
pub struct SpacesRecall {
    spaces: SpaceStore,
}

impl SpacesRecall {
    /// Wrap the process `SpaceStore` (cheap `Arc` clone) as a retrieval delegate.
    pub fn new(spaces: SpaceStore) -> Self {
        Self { spaces }
    }

    /// The Spaces `DocFilter` for the retrieval caller. Lossless lowering of the
    /// three tenancy fields `RetrievalOptions` already carries, so a delegated
    /// search is gated by exactly the filter `POST /api/spaces/:id/search` applies:
    /// an unbound node collapses to unrestricted (byte-identical to the personal
    /// local-first path), a bound node restricts to documents the caller may READ.
    fn filter(opts: &RetrievalOptions) -> DocFilter<'_> {
        DocFilter::for_caller(
            opts.caller_user_id.as_deref(),
            opts.caller_org_id.as_deref(),
            opts.node_bound,
        )
    }
}

#[async_trait::async_trait]
impl SpaceRecall for SpacesRecall {
    async fn recall(
        &self,
        query: &str,
        opts: &RetrievalOptions,
        per_space_limit: usize,
    ) -> Result<Vec<Vec<ScoredChunk>>> {
        let filter = Self::filter(opts);
        // `None` = "all Spaces": enumerate under the same tenancy filter the search
        // itself applies, so "all" never means "all, including other members'".
        // Resolving it here rather than treating `None` as "no Spaces" is what keeps
        // the documented meaning of the field true on the delegated path too.
        let space_ids: Vec<String> = match &opts.space_ids {
            Some(ids) => ids.clone(),
            None => self
                .spaces
                .list_spaces(filter.clone())
                .await?
                .into_iter()
                .map(|s| s.id)
                .collect(),
        };

        // The caller's hybrid and metadata-filter knobs apply inside each Space.
        let search_options = SpaceSearchOptions {
            limit: per_space_limit,
            hybrid: opts.hybrid,
            filter: opts.filter.clone(),
            ..SpaceSearchOptions::default()
        };
        let mut lists = Vec::new();
        for space_id in space_ids {
            // Per-Space fail-open: one unreadable/missing Space must not cost the
            // caller the other Spaces (or the memory half). An id that is not a
            // Space at all — e.g. an OKF bundle id, which is what this store's own
            // `space_id` column holds — simply yields nothing here and is still
            // matched by the `retrieval.db` half.
            match self
                .spaces
                .search_with(&space_id, query, &search_options, filter.clone())
                .await
            {
                Ok(matches) if matches.is_empty() => {}
                Ok(matches) => lists.push(
                    matches
                        .into_iter()
                        .map(|m| ScoredChunk {
                            id: m.chunk_id,
                            source: ChunkSource::Space,
                            space_id: Some(space_id.clone()),
                            content: m.content,
                            // Deliberately NOT derived from `ChunkMatch::distance`:
                            // that is a real `vec0` distance in vector mode and a
                            // constant 0.0 in graph mode, so any mapping of it would
                            // rank every graph hit above every vector hit. The list's
                            // ORDER is the signal; `fuse_ranked_lists` assigns the
                            // score that actually gets used.
                            score: 0.0,
                        })
                        .collect(),
                ),
                Err(e) => tracing::warn!("retrieval: space {space_id} search skipped ({e:#})"),
            }
        }
        Ok(lists)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{
        lock_registry_env, RegistryEnvGuard, DEFAULT_EMBED_MODEL, DEFAULT_LOCAL_CHAT_MODEL_ID,
        DEFAULT_LOCAL_RERANKER_MODEL_ID,
    };

    /// The conversion this seam exists for: `retrieval_registry()` must open
    /// `registry.json`, because `server::spaces::open_default` reads and validates
    /// `graph_extraction_model`, while the RAG constructors read the reranker fields.
    ///
    /// Asserted here rather than at the two openers because those touch `~/.ryu`
    /// (they create `spaces.db` / `retrieval.db`) and cannot run in a unit test. This
    /// function is the whole difference between the old `from_env()` and the new
    /// wiring, so pinning it pins the conversion — the openers have no other
    /// registry source.
    ///
    /// Uses `RYU_REGISTRY_PATH` + the crate-wide registry env lock, exactly like
    /// `registry::tests::rag_strategy_reads_registry_file_via_load`. A test that
    /// proved this with `ProviderRegistry::from_file` would prove nothing: no
    /// production caller uses that constructor.
    #[test]
    fn retrieval_registry_reads_the_registry_file() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(
            &path,
            r#"{"graph_extraction_model":"acme/extract","reranker_model":"acme/rerank","reranker_base_url":"http://127.0.0.1:9998"}"#,
        )
        .unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);

        let reg = retrieval_registry();
        assert_eq!(reg.graph_extraction_model, "acme/extract");
        assert_eq!(reg.reranker.id, "acme/rerank");
        assert_eq!(reg.reranker_base_url, "http://127.0.0.1:9998");
    }

    /// …and must NOT resurrect a file layer for the fields that deliberately have no
    /// `registry.json` key. Paired with the test above so "make it read the file" can
    /// never be over-applied: the embed trio fixes the vector space of three on-disk
    /// indexes, and `local_chat_model` names a GGUF a different moment downloaded.
    #[test]
    fn retrieval_registry_does_not_give_the_env_only_fields_a_file_layer() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(
            &path,
            r#"{"embed_model":"file/embed","embed_dims":1024,"embed_base_url":"http://127.0.0.1:9990","local_chat_model_id":"file-chat","reranker_model":"acme/rerank"}"#,
        )
        .unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);

        let reg = retrieval_registry();
        assert_eq!(
            reg.reranker.id, "acme/rerank",
            "precondition: the file was read"
        );
        assert_eq!(reg.embedder.id, DEFAULT_EMBED_MODEL);
        assert_eq!(reg.embedder.dims, crate::registry::DEFAULT_EMBED_DIMS);
        assert_eq!(reg.embed_base_url, crate::registry::DEFAULT_EMBED_BASE_URL);
        assert_eq!(reg.local_chat_model.id, DEFAULT_LOCAL_CHAT_MODEL_ID);
    }

    /// `reranker_from_registry` (the `retrieval.db` reranker) is opt-in remote via
    /// `RYU_RERANKER_BASE_URL` and must stay local when only the file sets
    /// `reranker_base_url` — the asymmetry documented on both it and
    /// [`reranker_local_server`].
    ///
    /// Without this, "reranker_base_url is now file-backed" reads as a blanket claim,
    /// and a future edit routing this function through the field would silently flip
    /// retrieval reranking to always-remote against a sidecar that is off by default.
    #[test]
    fn file_reranker_base_url_does_not_make_the_retrieval_reranker_remote() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(&path, r#"{"reranker_base_url":"http://127.0.0.1:9998"}"#).unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);

        let reg = retrieval_registry();
        assert_eq!(reg.reranker_base_url, "http://127.0.0.1:9998");
        assert!(
            matches!(reranker_from_registry(&reg), Reranker::Local),
            "the retrieval.db reranker keys on RYU_RERANKER_BASE_URL only"
        );
        // The Spaces reranker DOES honour it — that is the one reader.
        let local = reranker_local_server(&reg);
        assert!(
            !matches!(local, Reranker::Local),
            "reranker_local_server is always server-backed"
        );
    }

    /// Where the `reranker_model` key is actually *observed*, and where it is not.
    ///
    /// The field doc used to say `open_retrieval_store` hands the id to
    /// `RetrievalStore` "as the reported/remote reranker id", which reads as two
    /// live readers. Only the remote one is: `RetrievalStore::reranker_model_id()`
    /// has no caller outside `ryu-rag`'s own unit test, so the "reported" half is an
    /// unread field. This pins the half that IS observable — the model name in the
    /// outbound `/rerank` request — so the corrected doc has a test behind it.
    ///
    /// The env var is set explicitly here because that is exactly what
    /// `profile::apply_env_defaults` does for every non-release profile: this is the
    /// `bun dev` configuration, in which the "opt-in remote" branch is always taken.
    /// The `Reranker::Local` twin above is the release-profile configuration. Between
    /// them they cover both sides of the profile split described on
    /// [`crate::registry::ProviderRegistry::reranker`].
    #[test]
    fn reranker_model_is_observed_only_in_the_remote_branch() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(&path, r#"{"reranker_model":"acme/rerank"}"#).unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);
        // Stand in for the profile seed (`apply_env_defaults` → dev's :9082).
        std::env::set_var("RYU_RERANKER_BASE_URL", "http://127.0.0.1:9082");

        let reg = retrieval_registry();
        assert_eq!(
            reg.reranker.id, "acme/rerank",
            "precondition: file was read"
        );

        // 1. The retrieval reranker: remote, and the file-set id is what goes on the
        //    wire as `"model"`. `model_id`'s argument is the Local fallback, so a
        //    value that is not the registry id proves the Remote arm answered.
        let retrieval = reranker_from_registry(&reg);
        assert!(matches!(retrieval, Reranker::Remote { .. }));
        assert_eq!(retrieval.model_id("<local-fallback>"), "acme/rerank");

        // 2. The Spaces reranker ignores `reranker_model` entirely — it names the
        //    GGUF `llamacpp-rerank` actually serves. Setting `reranker_model` and
        //    expecting Space search to change is the documented mistake.
        assert_eq!(
            reranker_local_server(&reg).model_id("<local-fallback>"),
            DEFAULT_LOCAL_RERANKER_MODEL_ID,
        );
    }
}

#[cfg(test)]
mod space_recall_tests {
    use super::*;
    use ryu_rag::DEFAULT_TOP_K;
    use ryu_spaces::{DocOwner, RetrievalMode};

    /// Two documents joined by the bridge entity "Acme", so a graph traversal from
    /// one reaches the other. Ordinary prose because `extract_entities` keeps tokens
    /// that are capitalised or longer than 4 chars.
    const DOC_A: &str = "Alice works at Acme and signs the quarterly ledger.";
    const DOC_B: &str = "Acme is based in Rotterdam where logistics costs fell.";

    /// A retrieval store with the real Spaces delegate over an in-memory
    /// `SpaceStore`. Deliberately built from the crate constructors rather than
    /// `open_retrieval_store`, which would touch the user's real `~/.ryu`.
    fn wired(spaces: &SpaceStore) -> RetrievalStore {
        RetrievalStore::open_in_memory(768, "test/reranker".to_owned())
            .unwrap()
            .with_space_recall(Arc::new(SpacesRecall::new(spaces.clone())))
    }

    async fn seed_space(spaces: &SpaceStore, name: &str, mode: RetrievalMode) -> String {
        let owner = DocOwner::unattributed();
        let id = spaces
            .create_space_with_mode(name, None, mode, &owner)
            .await
            .unwrap();
        for (title, body) in [("a", DOC_A), ("b", DOC_B)] {
            spaces
                .ingest_document(&id, title, body, &owner)
                .await
                .unwrap();
        }
        id
    }

    fn opts_for(space_ids: Vec<String>) -> RetrievalOptions {
        RetrievalOptions {
            top_k: DEFAULT_TOP_K,
            space_ids: Some(space_ids),
            ..RetrievalOptions::default()
        }
    }

    /// **W3, end to end.** A Space's `retrieval_mode` now governs the path an agent
    /// actually uses: `RetrievalStore::retrieve` — the call `run_auto_recall` makes
    /// on every chat turn, and the one behind `POST /api/retrieval/search`.
    ///
    /// The discriminator is deliberate rather than incidental. Graph mode answers
    /// by entity traversal, so a query with NO extractable entity (every token under
    /// three characters) can seed no BFS and returns nothing; vector mode is a KNN
    /// and always returns its nearest chunks. Identical content, identical query,
    /// opposite results ⇒ the mode is what decided, not the corpus. The same query
    /// shape is then shown to reach BOTH Spaces once it carries an entity, so the
    /// graph Space is not simply broken.
    #[tokio::test]
    async fn space_retrieval_mode_governs_the_chat_retrieval_path() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let graph_id = seed_space(&spaces, "Graph", RetrievalMode::Graph).await;
        let vector_id = seed_space(&spaces, "Vector", RetrievalMode::Vector).await;
        let store = wired(&spaces);

        // No entity in the query: only the vector-mode Space can answer.
        let hits = store
            .retrieve(
                "an by of",
                &opts_for(vec![graph_id.clone(), vector_id.clone()]),
            )
            .await
            .unwrap();
        assert!(
            hits.iter()
                .any(|c| c.space_id.as_deref() == Some(&vector_id)),
            "vector-mode Space must still answer an entity-less query: {hits:?}"
        );
        assert!(
            !hits
                .iter()
                .any(|c| c.space_id.as_deref() == Some(&graph_id)),
            "graph-mode Space answered by traversal cannot seed on an entity-less \
             query — a hit here means the chat path fell back to vector: {hits:?}"
        );

        // With an entity, both Spaces contribute — the graph Space via traversal.
        let hits = store
            .retrieve(
                "Alice",
                &opts_for(vec![graph_id.clone(), vector_id.clone()]),
            )
            .await
            .unwrap();
        for space in [&graph_id, &vector_id] {
            assert!(
                hits.iter()
                    .any(|c| c.space_id.as_deref() == Some(space.as_str())),
                "space {space} missing from {hits:?}"
            );
        }
    }

    /// Traversal really is traversal: seeded on "Alice" (which appears only in
    /// DOC_A) the graph Space also returns the DOC_B chunk, reached over the shared
    /// "acme" entity. This is the GraphRAG behaviour that previously stopped at the
    /// Spaces search box.
    #[tokio::test]
    async fn graph_mode_reaches_a_bridged_chunk_on_the_retrieval_path() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let graph_id = seed_space(&spaces, "Graph", RetrievalMode::Graph).await;
        let hits = wired(&spaces)
            .retrieve("Alice", &opts_for(vec![graph_id]))
            .await
            .unwrap();
        assert!(
            hits.iter().any(|c| c.content.contains("Rotterdam")),
            "expected the bridged chunk via the shared entity: {hits:?}"
        );
    }

    /// The delegated path is a NEW way for document text to leave the Spaces store,
    /// so it must carry the same per-caller tenancy as `POST /api/spaces/:id/search`.
    /// On a bound node a member retrieving through chat gets their own Space and not
    /// a colleague's; an unbound node keeps the local-first path unfiltered.
    #[tokio::test]
    async fn delegated_space_hits_respect_bound_node_tenancy() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let alice = DocOwner::owned(Some("alice"), Some("org1"));
        let space = spaces
            .create_space_with_mode("Alice private", None, RetrievalMode::Vector, &alice)
            .await
            .unwrap();
        spaces
            .ingest_document(&space, "a", DOC_A, &alice)
            .await
            .unwrap();
        let store = wired(&spaces);

        let bound_as = |user: &str| RetrievalOptions {
            top_k: DEFAULT_TOP_K,
            space_ids: Some(vec![space.clone()]),
            node_bound: true,
            caller_user_id: Some(user.to_owned()),
            caller_org_id: Some("org1".to_owned()),
            ..RetrievalOptions::default()
        };

        let as_bob = store
            .retrieve("Alice ledger", &bound_as("bob"))
            .await
            .unwrap();
        assert!(
            as_bob.is_empty(),
            "another member must not receive Alice's Space text: {as_bob:?}"
        );
        let as_alice = store
            .retrieve("Alice ledger", &bound_as("alice"))
            .await
            .unwrap();
        assert!(
            !as_alice.is_empty(),
            "the owner must still get her own Space"
        );

        // Unbound node (the personal local-first default): unfiltered.
        let unbound = store
            .retrieve("Alice ledger", &opts_for(vec![space.clone()]))
            .await
            .unwrap();
        assert!(!unbound.is_empty());
    }

    /// `space_ids: None` means "every Space" on the delegated path too, and the
    /// enumeration runs under the caller's tenancy filter — so "all" never means
    /// "all, including Spaces this caller may not read".
    #[tokio::test]
    async fn no_space_filter_enumerates_every_readable_space() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let mine = seed_space(&spaces, "Mine", RetrievalMode::Vector).await;
        let alice = DocOwner::owned(Some("alice"), Some("org1"));
        let hers = spaces
            .create_space_with_mode("Hers", None, RetrievalMode::Vector, &alice)
            .await
            .unwrap();
        spaces
            .ingest_document(&hers, "b", DOC_B, &alice)
            .await
            .unwrap();
        let store = wired(&spaces);

        let all = store
            .retrieve(
                "Acme",
                &RetrievalOptions {
                    top_k: 10,
                    space_ids: None,
                    ..RetrievalOptions::default()
                },
            )
            .await
            .unwrap();
        assert!(all.iter().any(|c| c.space_id.as_deref() == Some(&mine)));

        let as_bob = store
            .retrieve(
                "Acme",
                &RetrievalOptions {
                    top_k: 10,
                    space_ids: None,
                    node_bound: true,
                    caller_user_id: Some("bob".to_owned()),
                    caller_org_id: Some("org1".to_owned()),
                    ..RetrievalOptions::default()
                },
            )
            .await
            .unwrap();
        assert!(
            !as_bob.iter().any(|c| c.space_id.as_deref() == Some(&hers)),
            "the all-Spaces enumeration must not reach a colleague's Space: {as_bob:?}"
        );
    }

    /// The recall diagnostics report vector coverage and unreadable-row counts
    /// for both recall stores, and never content.
    #[tokio::test]
    async fn recall_diagnostics_report_coverage_without_content() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let store = wired(&spaces);
        store
            .index_chunk(
                "diag-1",
                ChunkSource::Memory,
                None,
                "Diagnostics must never echo this sentence.",
                ryu_rag::RetrievalOwner::shared(),
            )
            .await
            .unwrap();
        store
            .retrieve(
                "diagnostics sentence",
                &RetrievalOptions {
                    include_sensitive: true,
                    ..RetrievalOptions::default()
                },
            )
            .await
            .unwrap();
        let conversations =
            crate::server::conversations::ConversationStore::open_in_memory().unwrap();
        let report = recall_diagnostics(&store, &conversations);
        assert_eq!(report["retrieval"]["vector_coverage"]["hydrated"], 1);
        assert_eq!(report["retrieval"]["unreadable_rows"], 0);
        assert!(report["conversations"]["unreadable"].is_object());
        assert!(!report.to_string().contains("echo this sentence"));
    }

    /// An id that is not a Space at all — this store's own `space_id` column holds
    /// OKF **bundle** ids — is skipped by the delegate without failing the recall,
    /// and the bundle's chunks still come back from `retrieval.db`. Guards the one
    /// pre-existing meaning of `space_ids` against the new one.
    #[tokio::test]
    async fn an_okf_bundle_id_still_resolves_against_this_store() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let store = wired(&spaces);
        store
            .index_chunk(
                "okf:bundle-1:concept#0",
                ChunkSource::Space,
                Some("bundle-1"),
                "Rotterdam logistics costs fell after the contract renegotiation.",
                ryu_rag::RetrievalOwner::shared(),
            )
            .await
            .unwrap();
        let hits = store
            .retrieve(
                "Rotterdam logistics",
                &opts_for(vec!["bundle-1".to_owned()]),
            )
            .await
            .unwrap();
        assert!(hits
            .iter()
            .any(|c| c.space_id.as_deref() == Some("bundle-1")));
    }
}

#[cfg(test)]
mod provider_binding_tests {
    use super::*;
    use std::collections::HashMap;

    fn binding(pairs: &[(&str, &str)]) -> Result<ProviderBinding> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        provider_binding(|name| map.get(name).cloned())
    }

    #[test]
    fn default_and_in_process_ids_are_built_in() {
        assert_eq!(binding(&[]).unwrap(), ProviderBinding::BuiltIn);
        for id in [
            "vector",
            "In-Process",
            "builtin",
            "ryu-rag",
            "sqlite-vec",
            " ",
        ] {
            assert_eq!(
                binding(&[("RYU_RAG_PROVIDER", id)]).unwrap(),
                ProviderBinding::BuiltIn,
                "{id}"
            );
        }
    }

    #[test]
    fn vector_store_ids_select_a_store() {
        assert_eq!(
            binding(&[("RYU_RAG_PROVIDER", "Qdrant")]).unwrap(),
            ProviderBinding::VectorStore(VectorStoreProvider::Qdrant)
        );
        assert_eq!(
            binding(&[("RYU_RAG_VECTOR_STORE_PROVIDER", "pgvector")]).unwrap(),
            ProviderBinding::VectorStore(VectorStoreProvider::Pgvector)
        );
        // The explicit key may opt into a separate local sqlite-vec collection.
        assert_eq!(
            binding(&[("RYU_RAG_VECTOR_STORE_PROVIDER", "sqlite-vec")]).unwrap(),
            ProviderBinding::VectorStore(VectorStoreProvider::SqliteVec)
        );
        // Agreeing keys are fine.
        assert_eq!(
            binding(&[
                ("RYU_RAG_PROVIDER", "milvus"),
                ("RYU_RAG_VECTOR_STORE_PROVIDER", "milvus"),
            ])
            .unwrap(),
            ProviderBinding::VectorStore(VectorStoreProvider::Milvus)
        );
    }

    #[test]
    fn unknown_or_conflicting_ids_are_explicit_errors() {
        let error = binding(&[("RYU_RAG_PROVIDER", "graphrag-sidecar")]).unwrap_err();
        assert!(error.to_string().contains("not supported"), "{error}");
        assert!(binding(&[("RYU_RAG_VECTOR_STORE_PROVIDER", "faiss")]).is_err());
        let error = binding(&[
            ("RYU_RAG_PROVIDER", "qdrant"),
            ("RYU_RAG_VECTOR_STORE_PROVIDER", "chroma"),
        ])
        .unwrap_err();
        assert!(error.to_string().contains("set one of them"), "{error}");
    }
}
