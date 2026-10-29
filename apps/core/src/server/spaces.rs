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
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use ryu_rag::Embedder;
use serde::Deserialize;
use serde_json::Value;

pub use ryu_spaces::*;

use crate::identity_verify::ResourceTenancy;
use crate::server::conversations::Tenancy;

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct QueryDatabaseBody {
    query: String,
    #[serde(default)]
    parameters: Vec<Value>,
}

/// Run a bounded, read-only SQL query against a Space database document.
pub async fn query_database(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((space_id, document_id)): Path<(String, String)>,
    Json(body): Json<QueryDatabaseBody>,
) -> axum::response::Response {
    if crate::server::enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
        crate::acl::KIND_SPACE,
        &space_id,
    )
    .await
    .is_err()
    {
        return crate::server::json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: space.read".to_owned(),
        );
    }
    if let Err(response) = crate::server::require_resource_read(
        space_access_meta(&state.spaces, &space_id).await,
        caller.as_ref(),
        "space not found",
    ) {
        return response;
    }
    if let Err(response) = crate::server::require_resource_read(
        doc_access_meta(&state.spaces, &document_id).await,
        caller.as_ref(),
        "database not found",
    ) {
        return response;
    }
    match state
        .spaces
        .query_database(&space_id, &document_id, &body.query, &body.parameters)
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(error) => crate::server::json_error(
            StatusCode::BAD_REQUEST,
            format!("database query failed: {error}"),
        ),
    }
}

/// Resolve a per-Spaces embedding preference through Core's single RAG resolver.
pub fn embedder_for_pref(pref: &EmbeddingModelPref) -> Embedder {
    if pref.provider.as_deref() == Some("gateway") {
        return crate::rag_host::gateway_embedder(
            &pref.model_id,
            pref.dims
                .unwrap_or_else(|| crate::rag_host::retrieval_registry().embedder.dims),
        );
    }
    crate::rag_host::embedder_from_config(
        pref.base_url.as_deref().unwrap_or_default(),
        &pref.model_id,
        pref.dims
            .unwrap_or_else(|| crate::rag_host::retrieval_registry().embedder.dims),
    )
}

/// Apply the persisted Spaces embedding preference at boot, including reindexing
/// when its model or dimensionality differs from the store's current embedder.
pub async fn apply_saved_embedding_pref(
    store: &SpaceStore,
    preferences: &crate::server::preferences::PreferencesStore,
) {
    let Ok(Some(raw)) = preferences.get(EMBEDDING_MODEL_PREF_KEY).await else {
        return;
    };
    let Ok(pref) = serde_json::from_str::<EmbeddingModelPref>(&raw) else {
        tracing::warn!("ignoring invalid saved embedding model preference");
        return;
    };
    store.apply_embedder_change(embedder_for_pref(&pref)).await;
}

/// Apply the persisted embedding provider to every vector-bearing Core index.
/// Spaces uses its transactional swap; retrieval and encrypted-message search
/// install the same provider before their guarded stale-row passes. This is the
/// boot counterpart of `POST /api/embeddings/model`.
pub async fn apply_saved_embedding_pref_all(
    spaces: &SpaceStore,
    retrieval: &ryu_rag::RetrievalStore,
    conversations: &crate::server::conversations::ConversationStore,
    preferences: &crate::server::preferences::PreferencesStore,
) {
    let Ok(Some(raw)) = preferences.get(EMBEDDING_MODEL_PREF_KEY).await else {
        return;
    };
    let Ok(pref) = serde_json::from_str::<EmbeddingModelPref>(&raw) else {
        tracing::warn!("ignoring invalid saved embedding model preference");
        return;
    };
    let embedder = embedder_for_pref(&pref);
    spaces.apply_embedder_change(embedder.clone()).await;
    retrieval.set_embedder(embedder.clone());
    let search_embedder = std::sync::Arc::new(
        crate::search_host::CoreSearchEmbedder::from_embedder(embedder),
    );
    if let Err(error) = conversations.set_message_embedder(search_embedder).await {
        tracing::warn!("could not apply saved message embedding provider: {error:#}");
    }
    let retrieval = retrieval.clone();
    let conversations = conversations.clone();
    tokio::spawn(async move {
        if let Err(error) = retrieval.reindex_stale_embeddings().await {
            tracing::warn!("saved retrieval embedding reindex failed: {error:#}");
        }
        if let Err(error) = conversations.reindex_message_embeddings().await {
            tracing::warn!("saved message embedding reindex failed: {error:#}");
        }
    });
}

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
    match crate::auth::load_accounts()
        .active()
        .map(|a| a.user_id.clone())
    {
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
/// the node's model registry — the ServerState field origin. Resolves the embedder +
/// dims + graph-extraction implementation + reranker through the single RAG resolver,
/// uses the default blob root, and runs the tenancy backfill with the Core-resolved
/// owner.
///
/// Built with [`crate::rag_host::retrieval_registry`] (`ProviderRegistry::load`),
/// not `from_env`. `graph_extraction_model` and, via `reranker_local_server`,
/// `reranker_base_url` have live `registry.json` keys. `SpaceStore::open_at`
/// validates the extraction id and rejects anything except the shipped offline
/// implementation. The embedder fields have no file key; see `registry`'s module
/// header for why the vec0 table width makes that the right answer.
pub fn open_default() -> Result<SpaceStore> {
    // `spaces.db` content and the blob files are sealed under keys derived from
    // the master key; the store resolves them through the installed host and
    // starts its background sealing migration (see `ryu_spaces::seal`).
    crate::crypto_host::install();
    // Decrypted parser inputs a crash left behind (no job survives a restart).
    crate::document_parse::sweep_on_start();
    ryu_spaces::set_source_history_root(crate::paths::files_path("source-history"));
    let registry = crate::rag_host::retrieval_registry();
    let embedder = crate::rag_host::embedder_from_registry(&registry);
    let dims = embedder.dims();
    let extraction_model = registry.graph_extraction_model.clone();
    let reranker = crate::rag_host::reranker_local_server(&registry);
    SpaceStore::open_at(
        crate::paths::db_path("spaces.db"),
        embedder,
        dims,
        extraction_model,
        reranker,
        crate::paths::files_path("blobs"),
        backfill_owner(),
    )
}

/// Sealing diagnostics of the Spaces store (counts only, never content): the
/// `spaces.db.unreadable_rows` counter, whether the store accepts writes (a
/// store sealed under a key this process does not hold refuses them), the
/// background migration and blob-sweep progress (`blobs_sealed`/`blobs_total`),
/// and how much of the sealed vector index is searchable from memory
/// (`vector_coverage`). A health or recall surface embeds this object.
pub fn seal_diagnostics(store: &SpaceStore) -> serde_json::Value {
    serde_json::json!({
        "sealing": store.seal_status(),
        "vector_coverage": store.vector_coverage(),
    })
}

/// Read a document's access metadata and map it into the shared
/// [`ResourceTenancy`] the `resource_access` row-gate expects from BOTH the
/// conversation and the Spaces stores.
pub async fn doc_access_meta(store: &SpaceStore, doc_id: &str) -> Result<Option<ResourceTenancy>> {
    Ok(store
        .get_access_meta(doc_id)
        .await?
        .map(|m| ResourceTenancy {
            owner_user_id: m.owner_user_id,
            org_id: m.org_id,
            visibility: m.visibility,
            team_id: m.team_id,
            collaborators: Vec::new(),
        }))
}

/// Read a Space's access metadata and map it into the shared [`ResourceTenancy`]
/// the `resource_access` row-gate expects — the twin of [`doc_access_meta`] for the
/// `delete_space` write gate. A system space (`system = 1`, NULL owner) maps to an
/// owner-less tenancy which `resource_access` denies on a bound node, so a
/// node-singleton system space is not user-deletable over HTTP (the danger-zone
/// in-process bulk clear bypasses this gate and is unaffected).
pub async fn space_access_meta(
    store: &SpaceStore,
    space_id: &str,
) -> Result<Option<ResourceTenancy>> {
    Ok(store
        .space_access_meta(space_id)
        .await?
        .map(|m| ResourceTenancy {
            owner_user_id: m.owner_user_id,
            org_id: m.org_id,
            visibility: m.visibility,
            team_id: m.team_id,
            collaborators: Vec::new(),
        }))
}

#[cfg(test)]
mod tests {
    // The `ModelRegistry`-level retrieval defaults live here Core-side because
    // `ModelRegistry` is a Core type. `ryu-spaces` tests the supported extractor-id
    // boundary itself.
    use crate::registry::ModelRegistry;

    #[tokio::test]
    async fn seal_diagnostics_report_counts_only() {
        let store = ryu_spaces::SpaceStore::open_in_memory().unwrap();
        let report = super::seal_diagnostics(&store);
        assert_eq!(report["sealing"]["unreadable_rows"], 0);
        assert_eq!(report["sealing"]["writable"], true);
        assert!(report["vector_coverage"]["hydrated"].is_u64());
    }

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
