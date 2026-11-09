//! Keyword index over past chat messages: the lexical complement to the
//! semantic index in `message_index.rs`.
//!
//! ## Blind term index (encryption at rest)
//!
//! Conversation message bodies are sealed in `conversations.db`. This index
//! lives in its own `message-fts.db` and holds **no message words**: each
//! message is tokenized with the shared term tokenizer
//! ([`ryu_crypto::tokenize_terms`]: NFKC + lowercase, split on anything that is
//! not a letter, mark or number, terms of 2-64 code points, stopwords dropped,
//! de-duplicated and sorted) and every term is replaced by a keyed token
//! (`HMAC-SHA256(K_bi, term)[..16]`, key `message-fts.db`/`terms`, derived from
//! the master key). The FTS5 table `message_terms(terms, detail=none,
//! tokenize='ascii', content='fts_messages')` indexes those tokens; its
//! external content is `fts_messages.terms`, the row's de-duplicated tokens
//! sorted by their own value (never the words' order), which holds nothing the
//! inverted index does not already map. A query is tokenized and hashed the
//! same way. `fts_messages` also holds `message_id`, `conversation_id`, `role`
//! and `created_at`; the caller re-reads and decrypts each hit's snippet from
//! `conversations.db`.
//!
//! What still leaks to someone holding the file: tokens are deterministic per
//! install, so which messages share a word, how many distinct words a message
//! has, and global term frequencies (frequency analysis with outside knowledge
//! can guess common words). **No phrase, prefix or NEAR queries**: search is
//! whole-word only, and a stopword-only query returns nothing.
//!
//! A file written by an older build (a plaintext `message_fts` FTS5 table) is
//! deleted on open and rebuilt lazily from the sealed messages. So is an index
//! whose tokens were made under a different key (its key check token differs).
//!
//! ## Rows, deletes, network-free
//!
//! Inserts are idempotent on `message_id`. Rows are removed when their
//! conversation is deleted ([`MessageFtsIndex::delete_conversation`]) and the
//! whole index is emptied when chat memory is turned off
//! ([`MessageFtsIndex::clear`]). FTS5 secure-delete is on, so a delete removes
//! the row's postings rather than leaving a tombstone, and `clear` (and a key
//! change) drops every segment with `delete-all`; the WAL is truncated after. FTS needs no embedder, so indexing and lazy
//! backfill are network-free.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::Connection;
use ryu_crypto::blind_index::TERMS_FIELD;
use ryu_crypto::BlindIndex;
use tokio::sync::Mutex;

use schema::{is_legacy_plaintext_index, remove_db_files};

mod schema;
mod search;
mod write;

#[cfg(test)]
mod schema_tests;
#[cfg(test)]
mod search_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod write_tests;

/// Store name of the keyword index (its blind-index key derives from it).
pub const MESSAGE_FTS_STORE: &str = "message-fts.db";
/// Plaintext input the key check token is made from (never a real term: it
/// contains characters the tokenizer splits on).
const KEY_CHECK_INPUT: &str = "ryu-message-fts:key-check";
/// Row format of `message_terms`: external content in `fts_messages.terms`
/// with FTS5 secure-delete, tokens sorted by their hex value (never by the
/// underlying words). An index without this marker is rebuilt.
const DOC_FORMAT: &str = "external-sorted-tokens-v2";

/// A keyword hit from the message index: the `message_id` + metadata + a bounded
/// relevance score. The snippet is intentionally NOT stored here; the caller
/// re-reads and decrypts it from `conversations.db`.
#[derive(Debug, Clone)]
pub struct MessageFtsHit {
    pub message_id: String,
    pub conversation_id: String,
    pub role: String,
    pub created_at: i64,
    /// Relevance score in `(0, 1]` (higher is more relevant), derived from the
    /// FTS5 `bm25()` rank.
    pub score: f32,
}

/// Blind-term keyword index of chat-message bodies. Cheap to clone (`Arc`
/// inside). Stores keyed term tokens + metadata; never message words.
#[derive(Clone)]
pub struct MessageFtsIndex {
    conn: Arc<Mutex<Connection>>,
    terms: Arc<BlindIndex>,
}

impl MessageFtsIndex {
    /// Open (or create) the index at `path`, with the term key derived from the
    /// process master key (fails closed without one). The default path is
    /// resolved Core-side by the `search_host` shim.
    pub fn open(path: PathBuf) -> Result<Self> {
        let terms = ryu_crypto::blind_index(MESSAGE_FTS_STORE, TERMS_FIELD)
            .context("resolving the message keyword index key")?;
        Self::open_with_blind_index(path, terms)
    }

    /// [`Self::open`] with an explicit term key (tests).
    pub fn open_with_blind_index(path: PathBuf, terms: BlindIndex) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating message-fts db dir {}", parent.display()))?;
        }
        if path.exists() && is_legacy_plaintext_index(&path)? {
            tracing::info!(
                "message keyword index: removing the plaintext index written by an older \
                 build; it is rebuilt from the sealed messages on the next search"
            );
            remove_db_files(&path)?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening message-fts db {}", path.display()))?;
        Self::init(conn, terms)
    }

    /// Open an in-memory index with the process term key. Used by tests (this
    /// crate's and Core's).
    pub fn open_in_memory() -> Result<Self> {
        let terms = ryu_crypto::blind_index(MESSAGE_FTS_STORE, TERMS_FIELD)
            .context("resolving the message keyword index key")?;
        Self::open_in_memory_with_blind_index(terms)
    }

    /// [`Self::open_in_memory`] with an explicit term key (tests).
    pub fn open_in_memory_with_blind_index(terms: BlindIndex) -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory message-fts db")?;
        Self::init(conn, terms)
    }

    fn init(conn: Connection, terms: BlindIndex) -> Result<Self> {
        Self::init_schema(&conn)?;
        Self::check_key(&conn, &terms)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            terms: Arc::new(terms),
        })
    }
}

/// The FTS5 document for `text`: its blind term tokens sorted by token value and
/// de-duplicated, so their order says nothing about the underlying words (the
/// tokenizer returns them in the words' alphabetical order).
fn blind_document(terms: &BlindIndex, text: &str) -> String {
    let mut tokens = terms.term_tokens(text);
    tokens.sort_unstable();
    tokens.dedup();
    tokens.join(" ")
}

/// The FTS5 `MATCH` expression for `query`: its blind term tokens OR-joined (any
/// term surfaces a message; bm25 ranks messages matching more terms higher), or
/// `None` when the query has no indexable term. Tokens are bare hex, so they can
/// never be FTS5 operators or carry meta-characters.
fn blind_match_expression(terms: &BlindIndex, query: &str) -> Option<String> {
    let tokens = terms.term_tokens(query);
    if tokens.is_empty() {
        return None;
    }
    Some(tokens.join(" OR "))
}

/// Map an FTS5 `bm25()` rank (unbounded, more-negative-is-better) to a bounded
/// relevance hint in `(0, 1]` (higher is more relevant). Monotonic, so ranking is
/// preserved; it is a relevance indicator, not an exact probability.
fn bm25_to_relevance(bm25: f32) -> f32 {
    let strength = (-bm25).max(0.0);
    strength / (1.0 + strength)
}
