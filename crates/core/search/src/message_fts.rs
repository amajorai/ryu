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

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::blind_index::TERMS_FIELD;
use ryu_crypto::BlindIndex;
use tokio::sync::Mutex;

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

    fn init_schema(conn: &Connection) -> Result<()> {
        // Deleted rows are zeroed, not left in free pages.
        ryu_crypto::content_sqlite::enable_secure_delete(conn)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS fts_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .context("initializing fts_meta")?;
        // An index written in an earlier row format is dropped and rebuilt
        // lazily: the first stored token lists followed the alphabetical order
        // of the underlying words (a vocabulary ordering), and the contentless
        // one that followed could only tombstone a deleted row, leaving its
        // postings in the segment b-tree.
        let format: Option<String> = conn
            .query_row(
                "SELECT value FROM fts_meta WHERE key = 'doc_format'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let rebuilt = format.as_deref() != Some(DOC_FORMAT);
        let had_table = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE name = 'message_terms'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if rebuilt {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(
                "DROP TABLE IF EXISTS message_terms;
                 DROP TABLE IF EXISTS fts_messages;",
            )
            .context("dropping the message_terms table of an older row format")?;
            tx.execute(
                "INSERT INTO fts_meta (key, value) VALUES ('doc_format', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![DOC_FORMAT],
            )?;
            tx.commit()?;
        }
        // `message_id` is a plain TEXT column, NOT a foreign key: `messages` lives
        // in a separate database file (`conversations.db`). Rows are removed with
        // their conversation (`delete_conversation`). `terms` is the row's
        // de-duplicated token list sorted by token value: exactly what the
        // inverted index already maps (token -> rowids), kept so a delete can
        // remove the row's postings.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS fts_messages (
                 rowid           INTEGER PRIMARY KEY,
                 message_id      TEXT UNIQUE NOT NULL,
                 conversation_id TEXT NOT NULL,
                 role            TEXT NOT NULL,
                 created_at      INTEGER NOT NULL,
                 terms           TEXT NOT NULL DEFAULT ''
             );
             CREATE INDEX IF NOT EXISTS idx_fts_messages_conversation
                 ON fts_messages(conversation_id);",
        )
        .context("initializing fts_messages schema")?;
        // Keyed term tokens are 32 lowercase hex characters, so the `ascii`
        // tokenizer keeps each one whole; `detail=none` stores no positions
        // (phrase and NEAR queries are meaningless over sorted tokens anyway).
        // External content (`fts_messages.terms`) lets FTS5 secure-delete read a
        // deleted row's tokens and remove its postings at delete time, instead
        // of a contentless tombstone that leaves them until a merge.
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS message_terms
                 USING fts5(terms, content='fts_messages', content_rowid='rowid',
                            detail=none, tokenize='ascii');",
        )
        .context("initializing message_terms FTS5 table (is FTS5 compiled in?)")?;
        if rebuilt || !had_table {
            conn.execute(
                "INSERT INTO message_terms (message_terms, rank) VALUES ('secure-delete', 1)",
                [],
            )
            .context("enabling FTS5 secure-delete on message_terms")?;
        }
        if had_table && rebuilt {
            tracing::info!(
                "message keyword index: rebuilt in the current row format; it is refilled \
                 from the sealed messages on the next search"
            );
            // secure_delete zeroed the dropped pages; fold the WAL back so the
            // old rows do not linger in it.
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        Ok(())
    }

    /// Record the key check token on first use; when the recorded one differs
    /// (the master key changed), the tokens are useless: empty the index so it
    /// is rebuilt lazily under the current key.
    fn check_key(conn: &Connection, terms: &BlindIndex) -> Result<()> {
        let current = terms.term_token(KEY_CHECK_INPUT);
        let recorded: Option<String> = conn
            .query_row(
                "SELECT value FROM fts_meta WHERE key = 'key_check'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if recorded.as_deref() == Some(current.as_str()) {
            return Ok(());
        }
        if recorded.is_some() {
            tracing::warn!(
                "message keyword index was built under a different key; clearing it for a \
                 rebuild"
            );
        }
        let tx = conn.unchecked_transaction()?;
        // `delete-all` drops every segment (a row DELETE would leave the old
        // key's postings behind in a contentless index).
        tx.execute(
            "INSERT INTO message_terms (message_terms) VALUES ('delete-all')",
            [],
        )?;
        tx.execute("DELETE FROM fts_messages", [])?;
        tx.execute(
            "INSERT INTO fts_meta (key, value) VALUES ('key_check', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![current],
        )?;
        tx.commit()?;
        if recorded.is_some() {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        Ok(())
    }

    /// Index a single message's body. Idempotent on `message_id`: re-indexing
    /// the same content is a no-op, and a changed body (a streamed reply that
    /// grew, an edited message) replaces the row so tokens of the old text do not
    /// survive. Empty/whitespace bodies are skipped (the caller removes the row
    /// of a message edited to empty with [`Self::delete_messages`]). A body with
    /// no indexable term (stopwords only) is recorded with no tokens, so it is
    /// not retried.
    pub async fn index_message(
        &self,
        message_id: &str,
        conversation_id: &str,
        role: &str,
        text: &str,
        created_at: i64,
    ) -> Result<()> {
        if text.trim().is_empty() {
            return Ok(());
        }
        let document = blind_document(&self.terms, text);
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let existing: Option<(i64, String, String, i64, String)> = tx
            .query_row(
                "SELECT rowid, conversation_id, role, created_at, terms
                 FROM fts_messages WHERE message_id = ?1",
                params![message_id],
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
            .context("reading the existing fts_messages row")?;
        let replaced =
            if let Some((rowid, old_conversation, old_role, old_created, old_terms)) = existing {
                if old_conversation == conversation_id
                    && old_role == role
                    && old_created == created_at
                    && old_terms == document
                {
                    return Ok(());
                }
                // External-content delete: `fts_messages.terms` must still hold the
                // old document so secure-delete can remove its postings.
                tx.execute("DELETE FROM message_terms WHERE rowid = ?1", params![rowid])
                    .context("removing the old message_terms postings")?;
                tx.execute(
                    "UPDATE fts_messages
                 SET conversation_id = ?1, role = ?2, created_at = ?3, terms = ?4
                 WHERE rowid = ?5",
                    params![conversation_id, role, created_at, document, rowid],
                )
                .context("updating fts_messages metadata row")?;
                tx.execute(
                    "INSERT INTO message_terms (rowid, terms) VALUES (?1, ?2)",
                    params![rowid, document],
                )
                .context("inserting message_terms row")?;
                true
            } else {
                tx.execute(
                    "INSERT INTO fts_messages
                     (message_id, conversation_id, role, created_at, terms)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![message_id, conversation_id, role, created_at, document],
                )
                .context("inserting fts_messages metadata row")?;
                let rowid = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO message_terms (rowid, terms) VALUES (?1, ?2)",
                    params![rowid, document],
                )
                .context("inserting message_terms row")?;
                false
            };
        tx.commit()?;
        if replaced {
            // Fold the WAL back so the replaced postings do not linger in it.
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        Ok(())
    }

    /// The set of message ids already indexed (used to compute the backfill set).
    pub async fn indexed_ids(&self) -> Result<HashSet<String>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT message_id FROM fts_messages")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut set = HashSet::new();
        for row in rows {
            set.insert(row?);
        }
        Ok(set)
    }

    /// Remove every row of one conversation (called when it is deleted).
    /// Returns the number of messages removed.
    pub async fn delete_conversation(&self, conversation_id: &str) -> Result<usize> {
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM message_terms WHERE rowid IN
                 (SELECT rowid FROM fts_messages WHERE conversation_id = ?1)",
            params![conversation_id],
        )
        .context("deleting message_terms rows")?;
        let removed = tx
            .execute(
                "DELETE FROM fts_messages WHERE conversation_id = ?1",
                params![conversation_id],
            )
            .context("deleting fts_messages rows")?;
        tx.commit()?;
        if removed > 0 {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        Ok(removed)
    }

    /// Remove the rows of these messages (orphans whose source message no longer
    /// exists). Returns the number removed.
    pub async fn delete_messages(&self, message_ids: &[String]) -> Result<usize> {
        if message_ids.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let mut removed = 0;
        {
            let mut terms = tx.prepare_cached(
                "DELETE FROM message_terms WHERE rowid =
                     (SELECT rowid FROM fts_messages WHERE message_id = ?1)",
            )?;
            let mut meta = tx.prepare_cached("DELETE FROM fts_messages WHERE message_id = ?1")?;
            for id in message_ids {
                terms.execute([id])?;
                removed += meta.execute([id])?;
            }
        }
        tx.commit()?;
        if removed > 0 {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        Ok(removed)
    }

    /// Remove every row (chat memory turned off). Enabling it again rebuilds the
    /// index from the sealed messages.
    pub async fn clear(&self) -> Result<()> {
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO message_terms (message_terms) VALUES ('delete-all')",
            [],
        )
        .context("clearing message_terms")?;
        tx.execute("DELETE FROM fts_messages", [])
            .context("clearing fts_messages")?;
        tx.commit()?;
        // Hand freed pages back so the file shrinks; secure_delete already
        // zeroed the deleted cells.
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        Ok(())
    }

    /// Keyword search over indexed messages: the query is tokenized and hashed
    /// like the bodies, any matching term surfaces a message, ranked by
    /// `bm25()`, optionally post-filtered to a set of conversation ids. Returns
    /// hits most-relevant-first. A query with no indexable term (empty, or
    /// stopwords only) yields no hits (never an error). Whole words only: no
    /// phrase or prefix matching.
    pub async fn search(
        &self,
        query: &str,
        limit: usize,
        conversation_ids: Option<&[String]>,
    ) -> Result<Vec<MessageFtsHit>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let Some(match_expr) = blind_match_expression(&self.terms, query) else {
            return Ok(Vec::new());
        };
        let conn = self.conn.lock().await;
        // Over-fetch when post-filtering by conversation so the metadata filter
        // does not starve the capped result set.
        let fetch = match conversation_ids {
            Some(ids) if !ids.is_empty() => limit.saturating_mul(8).max(64),
            _ => limit,
        };
        // Do NOT alias the FTS table: `bm25()` and `MATCH` need the real table
        // reference. `bm25()` is more-negative-is-better.
        let mut stmt = conn.prepare(
            "SELECT m.message_id, m.conversation_id, m.role, m.created_at, bm25(message_terms)
             FROM message_terms
             JOIN fts_messages m ON m.rowid = message_terms.rowid
             WHERE message_terms MATCH ?1
             ORDER BY bm25(message_terms)
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![match_expr, fetch as i64], |row| {
            let bm25 = row.get::<_, f64>(4)? as f32;
            Ok(MessageFtsHit {
                message_id: row.get(0)?,
                conversation_id: row.get(1)?,
                role: row.get(2)?,
                created_at: row.get(3)?,
                score: bm25_to_relevance(bm25),
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            let hit = row?;
            if let Some(ids) = conversation_ids {
                if !ids.is_empty() && !ids.iter().any(|c| c == &hit.conversation_id) {
                    continue;
                }
            }
            out.push(hit);
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }
}

/// Whether the file at `path` holds the plaintext `message_fts` table an older
/// build wrote.
fn is_legacy_plaintext_index(path: &Path) -> Result<bool> {
    let conn = Connection::open(path)
        .with_context(|| format!("inspecting message-fts db {}", path.display()))?;
    let legacy: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE name = 'message_fts'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(legacy.is_some())
}

/// Delete a database file and its WAL/SHM side files.
fn remove_db_files(path: &Path) -> Result<()> {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        let candidate = PathBuf::from(name);
        match std::fs::remove_file(&candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("removing {}", candidate.display()));
            }
        }
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u8) -> BlindIndex {
        BlindIndex::from_root(&[n; 32], MESSAGE_FTS_STORE, TERMS_FIELD)
    }

    fn index() -> MessageFtsIndex {
        MessageFtsIndex::open_in_memory_with_blind_index(key(7)).expect("open index")
    }

    /// THE required round-trip: index three messages with distinct terms in
    /// distinct conversations, search a query term, and assert the right past
    /// session row surfaces first. Network-free (no embedder).
    #[tokio::test]
    async fn fts_round_trip_surfaces_matching_session() {
        let index = index();
        let docs = [
            ("m1", "c1", "assistant", "rust borrow checker lifetimes"),
            ("m2", "c1", "user", "favourite pizza toppings pepperoni"),
            ("m3", "c2", "user", "singapore travel itinerary"),
        ];
        for (id, conv, role, text) in docs {
            index
                .index_message(id, conv, role, text, 0)
                .await
                .expect("index");
        }

        let hits = index.search("Pizza!", 5, None).await.expect("search");
        assert!(!hits.is_empty(), "expected at least one hit");
        assert_eq!(hits[0].message_id, "m2", "pizza query must surface m2");
        assert_eq!(hits[0].conversation_id, "c1");
        // Messages that share more query terms rank higher.
        let hits = index
            .search("pizza pepperoni singapore", 5, None)
            .await
            .expect("search");
        assert_eq!(hits[0].message_id, "m2");
        assert_eq!(hits.len(), 2);
    }

    /// Conversation-scoped search returns only hits from the requested conversation.
    #[tokio::test]
    async fn search_scopes_to_conversation_ids() {
        let index = index();
        for (id, conv) in [("m1", "c1"), ("m2", "c2")] {
            index
                .index_message(id, conv, "user", "alpha beta gamma", 0)
                .await
                .expect("index");
        }
        let hits = index
            .search("alpha beta", 5, Some(&["c2".to_owned()]))
            .await
            .expect("search");
        assert!(!hits.is_empty());
        assert!(
            hits.iter().all(|h| h.conversation_id == "c2"),
            "all hits must be scoped to c2"
        );
    }

    /// Re-indexing the same message id is idempotent (no duplicate rows).
    #[tokio::test]
    async fn reindex_is_idempotent() {
        let index = index();
        index
            .index_message("m1", "c1", "user", "hello world", 0)
            .await
            .expect("index");
        index
            .index_message("m1", "c1", "user", "hello world", 1)
            .await
            .expect("reindex");
        let ids = index.indexed_ids().await.expect("ids");
        assert_eq!(ids.len(), 1, "re-index must not duplicate the row");
        let hits = index.search("hello", 5, None).await.expect("search");
        assert_eq!(hits.len(), 1);
    }

    /// Queries are tokenized like bodies: FTS5 meta-characters never reach
    /// MATCH, and stopword-only or prefix queries find nothing (whole words only).
    #[tokio::test]
    async fn queries_are_whole_word_and_meta_char_safe() {
        let index = index();
        index
            .index_message("m1", "c1", "user", "the foo and the bar baz", 0)
            .await
            .expect("index");
        let hits = index
            .search("foo:bar* \"baz AND", 5, None)
            .await
            .expect("search must not error on meta-chars");
        assert_eq!(hits[0].message_id, "m1");
        assert!(index.search("the and", 5, None).await.unwrap().is_empty());
        assert!(index.search("ba", 5, None).await.unwrap().is_empty());
        assert!(index.search("   ", 5, None).await.unwrap().is_empty());
        assert!(index.search("!!! @@@", 5, None).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_conversation_and_clear_remove_rows() {
        let index = index();
        for (id, conv) in [("m1", "c1"), ("m2", "c1"), ("m3", "c2")] {
            index
                .index_message(id, conv, "user", "orchid greenhouse", 0)
                .await
                .unwrap();
        }
        assert_eq!(index.delete_conversation("c1").await.unwrap(), 2);
        let hits = index.search("orchid", 5, None).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, "m3");
        index
            .index_message("m4", "c3", "user", "orchid", 0)
            .await
            .unwrap();
        assert_eq!(index.delete_messages(&["m4".to_owned()]).await.unwrap(), 1);
        assert_eq!(index.search("orchid", 5, None).await.unwrap().len(), 1);
        index.clear().await.unwrap();
        assert!(index.indexed_ids().await.unwrap().is_empty());
        assert!(index.search("orchid", 5, None).await.unwrap().is_empty());
    }

    fn file_bytes(path: &Path) -> Vec<u8> {
        let mut bytes = std::fs::read(path).unwrap_or_default();
        let mut wal = path.as_os_str().to_owned();
        wal.push("-wal");
        bytes.extend(std::fs::read(PathBuf::from(wal)).unwrap_or_default());
        bytes
    }

    fn contains(haystack: &[u8], needle: &str) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle.as_bytes())
    }

    /// The file and its WAL hold blind tokens, never the words, and the token
    /// of an indexed word is present (the blind index still finds the row).
    #[tokio::test]
    async fn words_never_reach_the_file_or_wal() {
        let dir = crate::test_dir::TestDir::new();
        let path = dir.path().join("message-fts.db");
        let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(3)).unwrap();
        index
            .index_message("m1", "c1", "user", "quetzalcoatl xylophonist", 0)
            .await
            .unwrap();
        let bytes = file_bytes(&path);
        assert!(!contains(&bytes, "quetzalcoatl"));
        assert!(!contains(&bytes, "xylophonist"));
        assert!(contains(&bytes, &key(3).term_token("quetzalcoatl")));
        assert_eq!(
            index.search("Quetzalcoatl", 5, None).await.unwrap()[0].message_id,
            "m1"
        );
    }

    /// Postings of a token stored in an FTS5 leaf: the first term of a page is
    /// whole, later ones are prefix-compressed, so probe the token's tail.
    fn holds_token(bytes: &[u8], token: &str) -> bool {
        contains(bytes, &token[token.len() - 24..])
    }

    /// Deletes remove the postings themselves (FTS5 secure-delete), not just a
    /// tombstone: a deleted message's blind tokens are absent from the file and
    /// the WAL after a conversation delete, an orphan delete and a clear.
    #[tokio::test]
    async fn deleted_tokens_leave_the_file_and_wal() {
        let dir = crate::test_dir::TestDir::new();
        let path = dir.path().join("message-fts.db");
        let terms = key(6);
        let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(6)).unwrap();
        let docs = [
            ("m1", "c1", "aardvarkone"),
            ("m2", "c1", "bandicoottwo"),
            ("m3", "c2", "capybarathree"),
            ("m4", "c3", "dugongfour"),
        ];
        for (id, conversation, word) in docs {
            index
                .index_message(id, conversation, "user", word, 0)
                .await
                .unwrap();
        }
        let token = |word: &str| terms.term_token(word);
        let bytes = file_bytes(&path);
        for (_, _, word) in docs {
            assert!(holds_token(&bytes, &token(word)), "{word} indexed");
        }
        index.delete_conversation("c1").await.unwrap();
        index.delete_messages(&["m3".to_owned()]).await.unwrap();
        let bytes = file_bytes(&path);
        for word in ["aardvarkone", "bandicoottwo", "capybarathree"] {
            assert!(!holds_token(&bytes, &token(word)), "{word} must be purged");
        }
        assert!(holds_token(&bytes, &token("dugongfour")));
        assert_eq!(
            index.search("dugongfour", 5, None).await.unwrap()[0].message_id,
            "m4"
        );
        index.clear().await.unwrap();
        assert!(!holds_token(&file_bytes(&path), &token("dugongfour")));
        drop(index);

        // A key change empties the index the same way.
        let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(6)).unwrap();
        index
            .index_message("m5", "c5", "user", "echidnafive", 0)
            .await
            .unwrap();
        drop(index);
        assert!(holds_token(&file_bytes(&path), &token("echidnafive")));
        let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(8)).unwrap();
        assert!(index.indexed_ids().await.unwrap().is_empty());
        assert!(!holds_token(&file_bytes(&path), &token("echidnafive")));
    }

    /// A message whose content changes (a streamed reply checkpointed, then
    /// completed) is re-indexed: the new text matches, the old does not, and the
    /// old token is gone from the file and WAL.
    #[tokio::test]
    async fn reindexing_changed_content_replaces_the_old_tokens() {
        let dir = crate::test_dir::TestDir::new();
        let path = dir.path().join("message-fts.db");
        let terms = key(5);
        let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(5)).unwrap();
        index
            .index_message("m1", "c1", "assistant", "alphabravo", 1)
            .await
            .unwrap();
        index
            .index_message("m2", "c1", "assistant", "otherword", 2)
            .await
            .unwrap();
        assert!(holds_token(
            &file_bytes(&path),
            &terms.term_token("alphabravo")
        ));
        // Re-indexing the same content changes nothing.
        index
            .index_message("m1", "c1", "assistant", "alphabravo", 1)
            .await
            .unwrap();
        assert_eq!(index.search("alphabravo", 5, None).await.unwrap().len(), 1);
        index
            .index_message("m1", "c1", "assistant", "betacharlie", 1)
            .await
            .unwrap();
        assert!(index
            .search("alphabravo", 5, None)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            index.search("betacharlie", 5, None).await.unwrap()[0].message_id,
            "m1"
        );
        assert_eq!(index.indexed_ids().await.unwrap().len(), 2);
        let bytes = file_bytes(&path);
        assert!(!holds_token(&bytes, &terms.term_token("alphabravo")));
        assert!(holds_token(&bytes, &terms.term_token("betacharlie")));
        assert!(holds_token(&bytes, &terms.term_token("otherword")));
    }

    /// A plaintext index written by an older build is deleted on open (it is
    /// rebuilt from the sealed messages), and a key change empties the index.
    #[tokio::test]
    async fn legacy_plaintext_files_and_foreign_keys_are_discarded() {
        let dir = crate::test_dir::TestDir::new();
        let path = dir.path().join("message-fts.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE fts_messages (rowid INTEGER PRIMARY KEY, message_id TEXT UNIQUE NOT NULL,
                     conversation_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
                 CREATE VIRTUAL TABLE message_fts USING fts5(body, content='');
                 INSERT INTO fts_messages VALUES (1, 'm1', 'c1', 'user', 0);
                 INSERT INTO message_fts (rowid, body) VALUES (1, 'zanzibar legacyword');",
            )
            .unwrap();
        }
        assert!(contains(&file_bytes(&path), "zanzibar"));
        let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(3)).unwrap();
        assert!(index.indexed_ids().await.unwrap().is_empty());
        assert!(!contains(&file_bytes(&path), "zanzibar"));
        index
            .index_message("m2", "c1", "user", "lantern", 0)
            .await
            .unwrap();
        drop(index);
        // Same key: rows survive a reopen.
        let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(3)).unwrap();
        assert_eq!(index.indexed_ids().await.unwrap().len(), 1);
        drop(index);
        // Different key: tokens are useless, so the index is emptied for a rebuild.
        let index = MessageFtsIndex::open_with_blind_index(path, key(4)).unwrap();
        assert!(index.indexed_ids().await.unwrap().is_empty());
    }

    /// A row's tokens are sorted by token value (not by the words), so no
    /// word-ordered token list reaches the file.
    #[tokio::test]
    async fn rows_store_no_word_ordered_token_list() {
        let terms = key(5);
        let text = "apple banana cherry damson elderberry";
        let document = blind_document(&terms, text);
        let tokens: Vec<&str> = document.split(' ').collect();
        let mut sorted = tokens.clone();
        sorted.sort_unstable();
        assert_eq!(tokens, sorted, "tokens must be in sorted hex order");
        assert_eq!(tokens.len(), 5);

        let dir = crate::test_dir::TestDir::new();
        let path = dir.path().join("message-fts.db");
        let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(5)).unwrap();
        index
            .index_message("m1", "c1", "user", text, 0)
            .await
            .unwrap();
        let bytes = file_bytes(&path);
        // The word-ordered list an older build stored is absent; the row keeps
        // only the token-sorted list (what the inverted index maps anyway).
        assert!(!contains(&bytes, &terms.fts_document(text)));
        assert!(contains(&bytes, &document));
        assert_eq!(
            index.search("cherry", 5, None).await.unwrap()[0].message_id,
            "m1"
        );
        index.delete_messages(&["m1".to_owned()]).await.unwrap();
        assert!(index.search("cherry", 5, None).await.unwrap().is_empty());
    }

    /// An index in the older row format (a regular FTS5 table storing each
    /// row's word-ordered token list) is dropped and rebuilt on open.
    #[tokio::test]
    async fn older_row_format_is_dropped_and_scrubbed() {
        let terms = key(6);
        let text = "falcon gazelle heron";
        let old_document = terms.fts_document(text);
        let dir = crate::test_dir::TestDir::new();
        let path = dir.path().join("message-fts.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE fts_messages (rowid INTEGER PRIMARY KEY, message_id TEXT UNIQUE NOT NULL,
                     conversation_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
                 CREATE TABLE fts_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE VIRTUAL TABLE message_terms USING fts5(terms, detail=none, tokenize='ascii');
                 INSERT INTO fts_messages VALUES (1, 'm1', 'c1', 'user', 0);",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO fts_meta VALUES ('key_check', ?1)",
                params![terms.term_token(KEY_CHECK_INPUT)],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO message_terms (rowid, terms) VALUES (1, ?1)",
                params![old_document],
            )
            .unwrap();
        }
        assert!(contains(&file_bytes(&path), &old_document));
        let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(6)).unwrap();
        assert!(index.indexed_ids().await.unwrap().is_empty());
        assert!(!contains(&file_bytes(&path), &old_document));
        index
            .index_message("m1", "c1", "user", text, 0)
            .await
            .unwrap();
        drop(index);
        // The marker is recorded: a reopen keeps the rebuilt rows.
        let index = MessageFtsIndex::open_with_blind_index(path, key(6)).unwrap();
        assert_eq!(index.indexed_ids().await.unwrap().len(), 1);
    }

    /// The contentless format (v1) could only tombstone deletes, so its file
    /// may still hold the postings of deleted messages: it is dropped and
    /// rebuilt on open, and those tokens leave the file and the WAL.
    #[tokio::test]
    async fn contentless_format_with_tombstoned_postings_is_rebuilt() {
        let terms = key(9);
        let dir = crate::test_dir::TestDir::new();
        let path = dir.path().join("message-fts.db");
        let gone = terms.term_token("gerenuksix");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE fts_messages (rowid INTEGER PRIMARY KEY, message_id TEXT UNIQUE NOT NULL,
                     conversation_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
                 CREATE TABLE fts_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO fts_meta VALUES ('doc_format', 'contentless-sorted-tokens-v1');
                 CREATE VIRTUAL TABLE message_terms USING fts5(terms, content='',
                     contentless_delete=1, detail=none, tokenize='ascii');
                 INSERT INTO fts_messages VALUES (1, 'm1', 'c1', 'user', 0);",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO fts_meta VALUES ('key_check', ?1)",
                params![terms.term_token(KEY_CHECK_INPUT)],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO message_terms (rowid, terms) VALUES (1, ?1)",
                params![gone],
            )
            .unwrap();
            conn.execute_batch(
                "DELETE FROM message_terms WHERE rowid = 1;
                 DELETE FROM fts_messages WHERE rowid = 1;",
            )
            .unwrap();
        }
        assert!(
            holds_token(&file_bytes(&path), &gone),
            "a contentless delete leaves the postings"
        );
        let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(9)).unwrap();
        assert!(!holds_token(&file_bytes(&path), &gone));
        index
            .index_message("m2", "c2", "user", "hyraxseven", 0)
            .await
            .unwrap();
        index.delete_conversation("c2").await.unwrap();
        assert!(!holds_token(
            &file_bytes(&path),
            &terms.term_token("hyraxseven")
        ));
    }

    /// bm25 relevance mapping is bounded and monotonic (better rank → higher score).
    #[test]
    fn bm25_relevance_is_bounded_and_monotonic() {
        let strong = bm25_to_relevance(-5.0);
        let weak = bm25_to_relevance(-0.5);
        assert!(strong > weak);
        assert!((0.0..=1.0).contains(&strong));
        assert!((0.0..=1.0).contains(&weak));
        assert_eq!(bm25_to_relevance(1.0), 0.0);
    }

    /// Stopword-only and empty queries have no match expression.
    #[test]
    fn match_expression_uses_blind_tokens() {
        let terms = key(1);
        assert_eq!(blind_match_expression(&terms, "the and of"), None);
        assert_eq!(blind_match_expression(&terms, ""), None);
        let expr = blind_match_expression(&terms, "Solo duo").unwrap();
        assert!(!expr.contains("solo"));
        assert_eq!(
            expr,
            format!(
                "{} OR {}",
                terms.term_token("duo"),
                terms.term_token("solo")
            )
        );
    }
}
