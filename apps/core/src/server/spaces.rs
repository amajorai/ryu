//! Core's kernel side of the extracted [`ryu_spaces`] seam.
//!
//! The `ryu-spaces` crate owns the Spaces primitive — the `SpaceStore` (sqlite-vec
//! `vec0` vector store + content-addressed blob store), documents/chunks schema,
//! the per-space embedder, and the GraphRAG (entity/relation) retrieval strategy —
//! all built from plain config, with ZERO dependency on `apps/core`. What it
//! deliberately cannot own — because they are kernel couplings — are the four reads
//! that decide *which* embedder/reranker/graph-model is active, *where* the db and
//! blobs live, *who* owns a row, and how a row's access metadata maps back to the
//! shared ACL type:
//!
//!   - the model registry ([`crate::registry::ModelRegistry`]) + the single RAG
//!     resolver ([`crate::rag_host`]) that mint the embedder/reranker (so a
//!     per-space embedder still follows an embed-provider swap — the per-space
//!     gotcha stays a `RagProvider`/`Embedder` INSTANCE the store holds);
//!   - the default `~/.ryu` db + blob paths ([`crate::paths::ryu_dir`]);
//!   - the org/account lookup for the pre-tenancy backfill + background writers
//!     ([`crate::sidecar::control_plane`] + [`crate::auth`]);
//!   - the [`Tenancy`] → [`DocOwner`] lowering and the [`DocAccessMeta`] →
//!     [`ResourceTenancy`] mapping, so the shared `resource_access` row-gate keeps
//!     receiving ONE type from both the conversation and the Spaces stores.
//!
//! This is a re-export shim (the crate types stay reachable at the historical
//! `crate::server::spaces::*` path used across ~60 sites) plus the Core-side wiring
//! above. It holds NO Spaces business logic — that all moved to the crate.
//!
//! Mirrors the `search_host`/`rag_host` precedent (kernel wiring the extracted
//! crate can't own), by *constructor injection* like `ryu-storage`.

use anyhow::Result;

pub use ryu_spaces::*;

use crate::identity_verify::ResourceTenancy;
use crate::registry::ModelRegistry;
use crate::server::conversations::Tenancy;
use crate::server::preferences::PreferencesStore;
use ryu_rag::Embedder;

/// Lower a Core [`Tenancy`] into the crate's plain [`DocOwner`] at the boundary.
/// Lossless: `Tenancy::Unattributed` → `(None, None)`, `Tenancy::Owned` → the same
/// `(user, org)` pair `Tenancy::parts` produces.
pub fn owner_of(tenancy: &Tenancy) -> DocOwner {
    let (user_id, org_id) = tenancy.parts();
    DocOwner::owned(user_id, org_id)
}

/// The owner attribution for the pre-tenancy one-shot backfill:
/// `Some((owner_user_id, owner_org_id))` on an org-bound node with a signed-in
/// account, else `None` (unbound node, or bound node with no account → skip, fail
/// closed). Warns on the bound-but-no-account case exactly as the in-store backfill
/// used to before this coupling was hoisted Core-side.
fn backfill_owner() -> Option<(String, String)> {
    let org = crate::sidecar::control_plane::registered_org()?;
    match crate::auth::load_accounts().active().map(|a| a.user_id.clone()) {
        Some(owner) => Some((owner, org.id)),
        None => {
            tracing::warn!(
                "spaces tenancy backfill: org-bound node with no signed-in local account — \
                 leaving pre-ACL spaces/documents untenanted (fail closed). Sign in and restart \
                 to claim them."
            );
            None
        }
    }
}

/// The owner a BACKGROUND writer stamps — a path that creates a space/document with
/// no HTTP caller (clips/meetings auto-file, the plugin bridge, canvas migration).
/// Resolves EXACTLY as the open-time backfill does: on an org-bound node the local
/// vault owner, on an unbound personal node [`DocOwner::unattributed`]
/// (byte-identical to pre-ACL). This is what stops a runtime-created background row
/// on a bound node from being stranded (NULL tenancy → denied to everyone).
pub fn background_owner() -> DocOwner {
    match crate::sidecar::control_plane::registered_org() {
        Some(org) => match crate::auth::load_accounts().active() {
            Some(acct) => DocOwner {
                user_id: Some(acct.user_id.clone()),
                org_id: Some(org.id),
            },
            None => DocOwner::unattributed(),
        },
        None => DocOwner::unattributed(),
    }
}

/// Open (or create) the Spaces store at the default `~/.ryu/spaces.db` path using
/// the environment-configured model registry — the ServerState field origin.
/// Resolves the embedder + dims + graph-extraction model + reranker through the
/// single RAG resolver, uses the default blob root, and runs the tenancy backfill
/// with the Core-resolved owner.
pub fn open_default() -> Result<SpaceStore> {
    let registry = ModelRegistry::from_env();
    let embedder = crate::rag_host::embedder_from_registry(&registry);
    let dims = embedder.dims();
    let extraction_model = registry.graph_extraction_model.clone();
    let reranker = crate::rag_host::reranker_local_server(&registry);
    SpaceStore::open_at(
        crate::paths::ryu_dir().join("spaces.db"),
        embedder,
        dims,
        extraction_model,
        reranker,
        crate::paths::ryu_dir().join("blobs"),
        backfill_owner(),
    )
}

/// Build a concrete embedder from a saved [`EmbeddingModelPref`] (the per-space
/// embedder gotcha — a Space picks its own model). A non-empty `base_url` yields a
/// Remote (OpenAI-compatible) embedder; otherwise the offline Local hashing
/// embedder. Funnelled through the single RAG resolver so a per-space embedder
/// still follows an embed-provider swap; dims fall back to the registry default
/// only when the pref omits them.
pub fn embedder_for_pref(pref: &EmbeddingModelPref) -> Embedder {
    let dims = pref.dims.unwrap_or(crate::registry::DEFAULT_EMBED_DIMS);
    let base_url = pref.base_url.as_deref().unwrap_or("");
    crate::rag_host::embedder_from_config(base_url, &pref.model_id, dims)
}

/// On startup, apply the user's saved default embedding model (if any). Reads the
/// pref Core-side, resolves it into an embedder through the single RAG resolver,
/// then hands it to the store which detects a change and kicks a background
/// re-index if needed.
pub async fn apply_saved_embedding_pref(store: &SpaceStore, prefs: &PreferencesStore) {
    let Ok(Some(raw)) = prefs.get(EMBEDDING_MODEL_PREF_KEY).await else {
        return;
    };
    let Ok(pref) = serde_json::from_str::<EmbeddingModelPref>(&raw) else {
        return;
    };
    store.apply_embedder_change(embedder_for_pref(&pref)).await;
}

/// Read a document's access metadata and map it into the shared
/// [`ResourceTenancy`] the `resource_access` row-gate expects from BOTH the
/// conversation and the Spaces stores.
pub async fn doc_access_meta(store: &SpaceStore, doc_id: &str) -> Result<Option<ResourceTenancy>> {
    Ok(store.get_access_meta(doc_id).await?.map(|m| ResourceTenancy {
        owner_user_id: m.owner_user_id,
        org_id: m.org_id,
        visibility: m.visibility,
        team_id: m.team_id,
    }))
}

#[cfg(test)]
mod tests {
    // The `ModelRegistry`-level "retrieval mode + extraction model are
    // registry-configurable" tests live here Core-side (they moved out of the
    // `ryu-spaces` crate with the extraction, since `ModelRegistry` is a Core type).
    use crate::registry::ModelRegistry;

    #[test]
    fn registry_graph_extraction_model_defaults_to_local() {
        let registry = ModelRegistry::default();
        assert_eq!(registry.graph_extraction_model_id(), "local-cooccurrence");
    }

    #[test]
    fn registry_rag_strategy_defaults_to_vector() {
        let registry = ModelRegistry::default();
        assert_eq!(registry.resolve_rag_strategy(None), "vector");
    }

    #[test]
    fn registry_resolves_per_space_mode_over_default() {
        let registry = ModelRegistry::default();
        assert_eq!(registry.resolve_rag_strategy(Some("graph")), "graph");
    }
}
