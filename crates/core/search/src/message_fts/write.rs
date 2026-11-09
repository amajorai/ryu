//! Writes to the keyword index: idempotent indexing, conversation and orphan
//! deletes, and the whole-index clear.

use std::collections::HashSet;

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};

use super::{blind_document, MessageFtsIndex};

impl MessageFtsIndex {
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
}
