//! Full-text (FTS5) index over past chat messages — the keyword/lexical
//! complement to the semantic KNN index in `message_index.rs`.
//!
//! ## Why a separate FTS store (and the encryption-at-rest tradeoff)
//!
//! Conversation message bodies are encrypted at rest in `conversations.db`
//! (`ConversationStore` / [`crate::crypto::FieldCipher`], the `enc:v1:` envelope).
//! Like [`super::message_index`], this index lives in its own
//! `~/.ryu/message-fts.db` and stores **no retrievable message text** — it uses a
//! CONTENTLESS FTS5 table (`content=''`), which keeps only the tokenized inverted
//! index plus a parallel metadata table (`message_id`, `conversation_id`, `role`,
//! `created_at`). On match the search returns `message_id`s; the caller re-reads
//! and decrypts the snippet from `conversations.db`.
//!
//! HONEST TRADEOFF: a tokenized inverted index is inherently more word-recoverable
//! than a vector — an attacker with `message-fts.db` can recover the SET of terms
//! per message even though the message body in `conversations.db` stays encrypted.
//! Contentless FTS5 is the best available mitigation (no retrievable column text),
//! but the term index itself is word-recoverable. This is a deliberate, accepted
//! tradeoff because the feature explicitly requests FTS5 (the in-memory
//! inverted-index alternative has the identical property). Exposure is limited by
//! keeping the feature default-OFF: the index is only ever populated for users who
//! opt in (population happens lazily on search, which only runs when the FTS recall
//! pref is enabled).
//!
//! ## Append-only, network-free
//!
//! Messages are immutable and append-only, so no FTS DELETE/UPDATE is ever needed
//! (contentless FTS5 does not support them without `contentless_delete=1`, which we
//! do not set). Inserts are idempotent on `message_id`. Unlike the semantic index,
//! FTS needs NO embedder, so indexing and lazy backfill are network-free and can
//! never be blocked by a down embed sidecar.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use tokio::sync::Mutex;

/// A full-text hit from the message FTS index: the `message_id` + metadata + a
/// bounded relevance score. The snippet/content is intentionally NOT stored here —
/// the caller re-reads and decrypts it from `conversations.db`.
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

/// FTS5-backed full-text index of chat-message bodies. Cheap to clone (`Arc`
/// inside). Stores only the tokenized inverted index + metadata; never retrievable
/// message text.
#[derive(Clone)]
pub struct MessageFtsIndex {
    conn: Arc<Mutex<Connection>>,
}

fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("message-fts.db")
}

impl MessageFtsIndex {
    /// Open (or create) the FTS index at the default path
    /// (`~/.ryu/message-fts.db`). A plain `rusqlite` connection — FTS5 ships with
    /// the `bundled` SQLite amalgamation, so no extension load is needed (unlike
    /// sqlite-vec's `open_vec_connection`).
    pub fn open_default() -> Result<Self> {
        Self::open_inner(default_db_path())
    }

    fn open_inner(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating message-fts db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening message-fts db {}", path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Open an in-memory FTS index. Used by tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory message-fts db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        // Metadata table. NOTE: `message_id` is a plain TEXT column, NOT a foreign
        // key — `messages` lives in a *separate* database file (`conversations.db`),
        // so a cross-db FK is impossible. Deleting a conversation therefore orphans
        // its FTS rows; search skips message ids that no longer resolve, and a
        // dedicated cleanup sweep is a known follow-up.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS fts_messages (
                 rowid           INTEGER PRIMARY KEY,
                 message_id      TEXT UNIQUE NOT NULL,
                 conversation_id TEXT NOT NULL,
                 role            TEXT NOT NULL,
                 created_at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_fts_messages_conversation
                 ON fts_messages(conversation_id);",
        )
        .context("initializing fts_messages schema")?;

        // Contentless FTS5 virtual table: stores only the tokenized inverted index
        // for `body`, never the retrievable column text (`content=''`). Keyed by the
        // metadata rowid. If this CREATE fails the build shipped SQLite without
        // FTS5 — surface it loudly rather than silently degrading.
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(body, content='');",
        )
        .context("initializing message_fts FTS5 table (is FTS5 compiled in?)")?;
        Ok(())
    }

    /// Index a single message's body for full-text search. Idempotent on
    /// `message_id`: a message already present is a no-op (append-only content is
    /// immutable, so there is nothing to update). Empty/whitespace bodies are
    /// skipped.
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
        let conn = self.conn.lock().await;
        // INSERT OR IGNORE keeps this idempotent on the UNIQUE `message_id`. When
        // the row already existed the insert is ignored and `changes()` is 0 — bail
        // BEFORE touching `last_insert_rowid()`, which would otherwise return a
        // STALE prior rowid and misalign the FTS body row.
        conn.execute(
            "INSERT OR IGNORE INTO fts_messages
                 (message_id, conversation_id, role, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![message_id, conversation_id, role, created_at],
        )
        .context("inserting fts_messages metadata row")?;
        if conn.changes() == 0 {
            // Already indexed — nothing to do.
            return Ok(());
        }
        let rowid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO message_fts (rowid, body) VALUES (?1, ?2)",
            params![rowid, text],
        )
        .context("inserting message_fts body row")?;
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

    /// Full-text search over indexed message bodies. Sanitizes `query` into a safe
    /// FTS5 MATCH expression (arbitrary chat text can otherwise trigger a syntax
    /// error), runs a `bm25()`-ranked search, and optionally post-filters to a set
    /// of conversation ids. Returns hits ordered most-relevant-first. An
    /// empty/unusable query yields no hits (never an error).
    pub async fn search(
        &self,
        query: &str,
        limit: usize,
        conversation_ids: Option<&[String]>,
    ) -> Result<Vec<MessageFtsHit>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let Some(match_expr) = sanitize_fts_query(query) else {
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
        // reference. `bm25()` is more-negative-is-better, so ascending order puts
        // the best hits first.
        let mut stmt = conn.prepare(
            "SELECT m.message_id, m.conversation_id, m.role, m.created_at, bm25(message_fts)
             FROM message_fts
             JOIN fts_messages m ON m.rowid = message_fts.rowid
             WHERE message_fts MATCH ?1
             ORDER BY bm25(message_fts)
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

/// Map an FTS5 `bm25()` rank (unbounded, more-negative-is-better) to a bounded
/// relevance hint in `(0, 1]` (higher is more relevant). Monotonic, so ranking is
/// preserved; it is a relevance indicator, not an exact probability.
fn bm25_to_relevance(bm25: f32) -> f32 {
    let strength = (-bm25).max(0.0);
    strength / (1.0 + strength)
}

/// Turn arbitrary user/chat text into a safe FTS5 `MATCH` expression, or `None`
/// when no usable terms remain. Splitting on any non-alphanumeric char both strips
/// every FTS5 meta-char (`:` column filters, `*` prefixes, quotes, `AND`/`OR`
/// operators embedded in punctuation, etc.) AND aligns the query tokens with how
/// FTS5's default `unicode61` tokenizer split the stored text. Each surviving term
/// is wrapped in double quotes (so it is a literal phrase, never an operator) and
/// the terms are OR-joined so any single term match surfaces the row.
fn sanitize_fts_query(raw: &str) -> Option<String> {
    let terms: Vec<String> = raw
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\""))
        .collect();
    if terms.is_empty() {
        return None;
    }
    Some(terms.join(" OR "))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE required round-trip: index three messages with distinct terms in
    /// distinct conversations, search a query term, and assert the right past
    /// session row surfaces first. Network-free (no embedder).
    #[tokio::test]
    async fn fts_round_trip_surfaces_matching_session() {
        let index = MessageFtsIndex::open_in_memory().expect("open index");
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

        let hits = index.search("pizza", 5, None).await.expect("search");
        assert!(!hits.is_empty(), "expected at least one hit");
        assert_eq!(hits[0].message_id, "m2", "pizza query must surface m2");
        assert_eq!(hits[0].conversation_id, "c1");
    }

    /// Conversation-scoped search returns only hits from the requested conversation.
    #[tokio::test]
    async fn search_scopes_to_conversation_ids() {
        let index = MessageFtsIndex::open_in_memory().expect("open index");
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
        let index = MessageFtsIndex::open_in_memory().expect("open index");
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
        // And the single row is still searchable exactly once.
        let hits = index.search("hello", 5, None).await.expect("search");
        assert_eq!(hits.len(), 1);
    }

    /// A query full of FTS5 meta-chars must not error and still matches on the
    /// surviving term tokens.
    #[tokio::test]
    async fn sanitize_handles_meta_chars() {
        let index = MessageFtsIndex::open_in_memory().expect("open index");
        index
            .index_message("m1", "c1", "user", "the foo and the bar baz", 0)
            .await
            .expect("index");
        // Raw query with column-filter, prefix, unbalanced quote, operator-like text.
        let hits = index
            .search("foo:bar* \"baz AND", 5, None)
            .await
            .expect("search must not error on meta-chars");
        assert!(!hits.is_empty(), "term tokens should still match");
        assert_eq!(hits[0].message_id, "m1");
    }

    /// `sanitize_fts_query` strips meta-chars into quoted OR-joined terms, and
    /// returns `None` when nothing usable remains.
    #[test]
    fn sanitize_fts_query_shapes_terms() {
        assert_eq!(
            sanitize_fts_query("foo:bar* \"baz"),
            Some("\"foo\" OR \"bar\" OR \"baz\"".to_owned())
        );
        assert_eq!(sanitize_fts_query("   "), None);
        assert_eq!(sanitize_fts_query("!!! @@@ ---"), None);
        assert_eq!(sanitize_fts_query("solo"), Some("\"solo\"".to_owned()));
    }

    /// bm25 relevance mapping is bounded and monotonic (better rank → higher score).
    #[test]
    fn bm25_relevance_is_bounded_and_monotonic() {
        let strong = bm25_to_relevance(-5.0);
        let weak = bm25_to_relevance(-0.5);
        assert!(strong > weak);
        assert!((0.0..=1.0).contains(&strong));
        assert!((0.0..=1.0).contains(&weak));
        // A non-negative (degenerate) bm25 maps to 0.
        assert_eq!(bm25_to_relevance(1.0), 0.0);
    }
}
