//! Conversation search primitive: the sqlite-vec (`vec0`) semantic KNN index
//! ([`MessageIndex`]) and the contentless FTS5 lexical index
//! ([`MessageFtsIndex`]) over past chat messages. Both stores hold vectors /
//! inverted-index + metadata only — never message text; the caller re-reads and
//! decrypts each hit's snippet from `conversations.db`.
//!
//! ## The embedder seam ([`SearchEmbedder`])
//!
//! The semantic index needs to turn text into vectors, but *which* embedder
//! (local hashing vs. a registry-configured remote `/v1/embeddings` endpoint) is
//! a per-consumer RAG concern that must stay out of this crate. So the embedder
//! is injected as a narrow [`SearchEmbedder`] trait object at construction; Core
//! wraps its `retrieval::Embedder` behind this in `apps/core/src/search_host.rs`.
//! The crate never sees `ModelRegistry` and has ZERO dependency on `apps/core`.
//!
//! The default db paths (`~/.ryu/message-embeddings.db`, `~/.ryu/message-fts.db`)
//! and the registry-driven embedder choice likewise stay Core-side (the host
//! shim), mirroring the `ryu-storage` `open(path)` precedent.

mod message_fts;
mod message_index;

pub use message_fts::{MessageFtsHit, MessageFtsIndex};
pub use message_index::{MessageHit, MessageIndex};

use anyhow::Result;
use async_trait::async_trait;

/// Narrow embedding seam for the semantic message index. Core wraps its
/// registry-configured `retrieval::Embedder` behind this trait so the crate never
/// depends on the model registry (per-consumer embedder config is a RAG concern,
/// a later decomposition wave).
#[async_trait]
pub trait SearchEmbedder: Send + Sync {
    /// The dimensionality this embedder produces (fixes the vec0 table width).
    fn dims(&self) -> usize;

    /// A stable identifier for the embedding model. Rows are tagged with it so a
    /// query embedded by a different model never matches an incomparable vector
    /// space.
    fn model_id(&self) -> &str;

    /// `true` for a deterministic local (network-free) embedder. Callers use this
    /// to decide whether embedding work can run inline or must be spawned off the
    /// request path.
    fn is_local(&self) -> bool;

    /// Embed a single piece of text into a normalized vector of length
    /// [`dims`](Self::dims).
    async fn embed(&self, text: &str) -> Result<Vec<f32>>;
}

use std::path::Path;

use anyhow::Context;
use rusqlite::Connection;

/// Register the sqlite-vec extension exactly once for the whole process, then open
/// a `vec0`-capable connection. Installed as a SQLite *auto-extension* so every
/// connection opened afterwards gains the `vec0` virtual table.
///
/// A sibling copy of this registration lives in `apps/core/src/server/spaces.rs`;
/// both pass the identical `sqlite_vec::sqlite3_vec_init` pointer (one unified
/// crate) to `sqlite3_auto_extension`, which deduplicates identical registrations
/// — so the two coexist harmlessly.
pub(crate) fn open_vec_connection(path: &Path) -> Result<Connection> {
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
    let conn = if path == Path::new(":memory:") {
        Connection::open_in_memory().context("opening in-memory search db")?
    } else {
        Connection::open(path).with_context(|| format!("opening search db {}", path.display()))?
    };
    Ok(conn)
}

/// Encode an f32 vector as a little-endian byte BLOB (sqlite-vec wire format).
pub(crate) fn encode_embedding(vec: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vec.len() * 4);
    for v in vec {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    bytes
}

/// Deterministic local (network-free) embedder used by the crate's own unit
/// tests. Copied verbatim from `apps/core/src/server/retrieval.rs`
/// (`local_embed`/`tokenize`/`fnv1a`/`l2_normalize`) so the moved KNN tests keep
/// byte-identical ranking semantics. Core's own in-memory test constructors wrap
/// the *real* `Embedder::Local` via `search_host`, not this copy.
#[cfg(test)]
mod test_embedder {
    use super::{Result, SearchEmbedder};
    use async_trait::async_trait;

    /// A normalized bag-of-token-hashes embedder. Model id `"local-hashing"`.
    pub struct LocalHashingEmbedder {
        dims: usize,
    }

    impl LocalHashingEmbedder {
        pub fn new(dims: usize) -> Self {
            Self { dims }
        }
    }

    #[async_trait]
    impl SearchEmbedder for LocalHashingEmbedder {
        fn dims(&self) -> usize {
            self.dims
        }

        fn model_id(&self) -> &str {
            "local-hashing"
        }

        fn is_local(&self) -> bool {
            true
        }

        async fn embed(&self, text: &str) -> Result<Vec<f32>> {
            Ok(local_embed(text, self.dims))
        }
    }

    fn local_embed(text: &str, dims: usize) -> Vec<f32> {
        let mut vec = vec![0.0f32; dims];
        for token in tokenize(text) {
            let bucket = (fnv1a(&token) as usize) % dims;
            vec[bucket] += 1.0;
        }
        l2_normalize(&mut vec);
        vec
    }

    fn tokenize(text: &str) -> Vec<String> {
        text.split(|c: char| !c.is_alphanumeric())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_lowercase())
            .collect()
    }

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
}
