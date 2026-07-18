//! Core's kernel side of the extracted [`ryu_search`] seam.
//!
//! The `ryu-search` crate owns the conversation search stores — the sqlite-vec
//! (`vec0`) semantic KNN index and the contentless FTS5 lexical index — plus their
//! schema, KNN/FTS query logic, and dims reconciliation. What it cannot own —
//! because they are kernel/RAG couplings that must stay in Core — are the two
//! wirings the semantic index needs: the registry-configured embedder
//! ([`crate::server::retrieval::Embedder`], whose per-consumer choice is a RAG
//! concern deferred to a later wave) and the default `~/.ryu` db paths
//! ([`crate::paths::ryu_dir`]). This shim implements both: [`CoreSearchEmbedder`]
//! wraps `Embedder` behind the crate's narrow [`ryu_search::SearchEmbedder`] trait,
//! and the `open_default_*` helpers resolve the default paths + build the embedder.
//!
//! Mirrors the `crypto_host`/`recipes_host` precedent (kernel wiring the extracted
//! crate can't own), but by *constructor injection* like `ryu-storage`
//! (`open(path)`), not a process-global host — the embedder is per-instance state,
//! not an ambient singleton.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;

use ryu_search::{MessageFtsIndex, MessageIndex, SearchEmbedder};

use ryu_rag::Embedder;

/// Core's `SearchEmbedder` — wraps the registry-configured [`Embedder`] behind the
/// crate's narrow embedding seam so `ryu-search` never sees the model registry.
pub struct CoreSearchEmbedder {
    inner: Embedder,
}

impl CoreSearchEmbedder {
    /// Build from the environment-configured model registry (the default chat
    /// embedder), resolved through the single RAG resolver. Used by the
    /// process-wide default constructors.
    pub fn from_env() -> Self {
        let registry = crate::registry::ModelRegistry::from_env();
        Self {
            inner: crate::rag_host::embedder_from_registry(&registry),
        }
    }

    /// The deterministic local (network-free) hashing embedder at the default
    /// registry dims. Used by Core's in-memory test constructors so their
    /// semantics stay byte-identical to the pre-extraction `open_in_memory`.
    #[cfg(test)]
    pub fn local_default() -> Self {
        Self {
            inner: Embedder::Local {
                dims: crate::registry::DEFAULT_EMBED_DIMS,
            },
        }
    }
}

#[async_trait]
impl SearchEmbedder for CoreSearchEmbedder {
    fn dims(&self) -> usize {
        self.inner.dims()
    }

    fn model_id(&self) -> &str {
        self.inner.model_id()
    }

    fn is_local(&self) -> bool {
        self.inner.is_local()
    }

    async fn embed(&self, text: &str) -> Result<Vec<f32>> {
        self.inner.embed(text).await
    }
}

fn message_index_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("message-embeddings.db")
}

fn message_fts_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("message-fts.db")
}

/// Open the semantic message index at the default path
/// (`~/.ryu/message-embeddings.db`) with the environment-configured embedder.
pub fn open_default_message_index() -> Result<MessageIndex> {
    MessageIndex::open(
        message_index_db_path(),
        Arc::new(CoreSearchEmbedder::from_env()),
    )
}

/// Open the FTS message index at the default path (`~/.ryu/message-fts.db`).
pub fn open_default_message_fts() -> Result<MessageFtsIndex> {
    MessageFtsIndex::open(message_fts_db_path())
}

/// An in-memory semantic message index wired with the local (network-free)
/// embedder. Test-only — Core's `ConversationStore` unit tests use it to keep the
/// pre-extraction `MessageIndex::open_in_memory()` semantics.
#[cfg(test)]
pub fn in_memory_message_index() -> Result<MessageIndex> {
    MessageIndex::open_in_memory(Arc::new(CoreSearchEmbedder::local_default()))
}
