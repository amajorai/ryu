//! Keyword search over the blind term index.

use anyhow::Result;
use rusqlite::{params, Connection, Row};

use super::{blind_match_expression, bm25_to_relevance, MessageFtsHit, MessageFtsIndex};

// Do NOT alias the FTS table: `bm25()` and `MATCH` need the real table
// reference. `bm25()` is more-negative-is-better, and its corpus statistics
// cover the whole index, so a scope filter does not change any hit's score.
const UNSCOPED_SQL: &str =
    "SELECT m.message_id, m.conversation_id, m.role, m.created_at, bm25(message_terms)
     FROM message_terms
     JOIN fts_messages m ON m.rowid = message_terms.rowid
     WHERE message_terms MATCH ?1
     ORDER BY bm25(message_terms)
     LIMIT ?2";

// The conversation scope travels as one JSON array bound to `?3` and expanded
// by `json_each`, so any number of ids costs a single SQL variable (no
// `SQLITE_MAX_VARIABLE_NUMBER` limit, no chunking that would break the global
// ordering) and the LIMIT applies after the scope filter.
const SCOPED_SQL: &str =
    "SELECT m.message_id, m.conversation_id, m.role, m.created_at, bm25(message_terms)
     FROM message_terms
     JOIN fts_messages m ON m.rowid = message_terms.rowid
     WHERE message_terms MATCH ?1
       AND m.conversation_id IN (SELECT value FROM json_each(?3))
     ORDER BY bm25(message_terms)
     LIMIT ?2";

impl MessageFtsIndex {
    /// Keyword search over indexed messages: the query is tokenized and hashed
    /// like the bodies, any matching term surfaces a message, ranked by
    /// `bm25()`, optionally restricted to a set of conversation ids (`None` or
    /// an empty set searches every conversation). The scope is applied in SQL
    /// before the limit, so matches in other conversations never crowd the
    /// caller's hits out of the result. Returns hits most-relevant-first. A
    /// query with no indexable term (empty, or stopwords only) yields no hits
    /// (never an error). Whole words only: no phrase or prefix matching.
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
        let scope = match conversation_ids {
            Some(ids) if !ids.is_empty() => Some(serde_json::to_string(ids)?),
            _ => None,
        };
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let conn = self.conn.lock().await;
        query_hits(&conn, &match_expr, limit, scope.as_deref())
    }
}

fn query_hits(
    conn: &Connection,
    match_expr: &str,
    limit: i64,
    scope_json: Option<&str>,
) -> Result<Vec<MessageFtsHit>> {
    let hits = if let Some(scope_json) = scope_json {
        let mut stmt = conn.prepare_cached(SCOPED_SQL)?;
        let rows = stmt.query_map(params![match_expr, limit, scope_json], hit_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        let mut stmt = conn.prepare_cached(UNSCOPED_SQL)?;
        let rows = stmt.query_map(params![match_expr, limit], hit_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(hits)
}

fn hit_from_row(row: &Row<'_>) -> rusqlite::Result<MessageFtsHit> {
    let bm25 = row.get::<_, f64>(4)? as f32;
    Ok(MessageFtsHit {
        message_id: row.get(0)?,
        conversation_id: row.get(1)?,
        role: row.get(2)?,
        created_at: row.get(3)?,
        score: bm25_to_relevance(bm25),
    })
}
