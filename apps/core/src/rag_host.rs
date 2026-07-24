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
//! never a silent half-swap. The provider is keyed by [`active_provider_id`]; today
//! only the in-process `"vector"` provider exists and a bound out-of-process id is
//! an **explicit error** ([`open_retrieval_store`]), never a silent fallthrough to
//! vector. A real GraphRAG *sidecar* provider (broker-routed) is the deferred W8
//! follow-on.
//!
//! Mirrors the `search_host`/`crypto_host` precedent (kernel wiring the extracted
//! crate can't own), by *constructor injection* like `ryu-storage`.

use anyhow::Result;

use ryu_rag::{Embedder, Reranker, RetrievalStore};

use crate::registry::ModelRegistry;

/// The bound RAG provider id. Today only the in-process vector provider exists;
/// the seam reads `RYU_RAG_PROVIDER` (default `"vector"`) so a future binding layer
/// can select an out-of-process provider without touching consumers. An unknown id
/// is rejected at the store-creation origin ([`open_retrieval_store`]).
pub fn active_provider_id() -> String {
    std::env::var("RYU_RAG_PROVIDER")
        .ok()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "vector".to_string())
}

/// `true` when the active provider is the built-in in-process vector RAG.
fn is_in_process(id: &str) -> bool {
    matches!(id, "vector" | "in-process" | "builtin" | "ryu-rag")
}

/// Build an embedder from the model registry — the resolver for the default chat
/// embedder. Reads `embed_base_url` (env > registry.json > local default),
/// `RYU_EMBED_API_KEY`/`OPENAI_API_KEY`, and the registry embedder id/dims. A blank
/// base URL falls back to the dependency-free local hashing embedder.
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
    let api_key = embed_api_key();
    Embedder::remote(base_url, model, dims, api_key)
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
pub fn reranker_from_registry(registry: &ModelRegistry) -> Reranker {
    match std::env::var("RYU_RERANKER_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
    {
        Some(base_url) => Reranker::remote(&base_url, &registry.reranker.id, reranker_api_key()),
        None => Reranker::Local,
    }
}

/// Build a reranker that targets the local `llamacpp-rerank` server (the bge
/// cross-encoder) — used by Spaces RAG. Always server-backed at
/// `registry.reranker_base_url` (or the `RYU_RERANKER_BASE_URL` override); the
/// Spaces search path lazily starts that server and falls open to vector order when
/// it is unreachable, so this is safe to construct before the server exists.
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

/// Open (or create) the process retrieval store at the default `~/.ryu/retrieval.db`
/// path using the environment-configured model registry — the ServerState field
/// origin. Resolves the embedder + reranker + default reranker id through this
/// module and runs the tenancy backfill with the Core-resolved owner.
///
/// This is the single fallible origin where the bound provider id is enforced: an
/// out-of-process provider id (anything other than the in-process vector provider)
/// is an explicit error rather than a silent fallthrough to vector — a future
/// GraphRAG sidecar provider is wired here (broker-routed), not faked.
pub fn open_retrieval_store() -> Result<RetrievalStore> {
    let provider = active_provider_id();
    if !is_in_process(&provider) {
        anyhow::bail!(
            "RAG provider '{provider}' selects an out-of-process provider that is not wired yet; \
             only the in-process 'vector' provider is supported (unset RYU_RAG_PROVIDER)."
        );
    }
    let registry = ModelRegistry::from_env();
    let embedder = embedder_from_registry(&registry);
    let reranker = reranker_from_registry(&registry);
    RetrievalStore::open(
        crate::paths::ryu_dir().join("retrieval.db"),
        embedder,
        reranker,
        registry.reranker.id.clone(),
        backfill_owner(),
    )
}
