//! Deleting one conversation and counting stored rows.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Delete a conversation and its messages. Returns true if a row was removed.
    pub async fn delete_conversation(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        // FK enforcement is off (deletes are manual), so drop side chats here too.
        conn.execute(
            "DELETE FROM btw_entries WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        conn.execute(
            "DELETE FROM chat_checkpoints WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        // Same reason: `message_reactions` has no FK either, so its rows would
        // outlive both the messages and the conversation forever.
        conn.execute(
            "DELETE FROM message_reactions WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        // Generative-UI widget state is keyed by tool call, not message, and has
        // no FK either.
        conn.execute(
            "DELETE FROM agent_ui_state WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        conn.execute(
            "DELETE FROM message_read_receipts WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        // Proactive openings deliberately have no FK (their key survives a
        // failed message write), so delete the idempotency tombstone with the
        // conversation. Otherwise deleting and recreating the same conversation
        // id can suppress its first greeting forever.
        conn.execute(
            "DELETE FROM proactive_openings WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        conn.execute(
            "DELETE FROM channel_turn_idempotency WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        // Legacy databases do not rely on SQLite foreign-key enforcement for
        // manual deletes, so clear the durable harness children explicitly.
        conn.execute(
            "DELETE FROM harness_run_events WHERE run_id IN (
                 SELECT id FROM harness_runs WHERE session_id IN (
                     SELECT id FROM sessions WHERE conversation_id = ?1
                 )
             )",
            params![conversation_id],
        )?;
        conn.execute(
            "DELETE FROM harness_runs WHERE session_id IN (
                 SELECT id FROM sessions WHERE conversation_id = ?1
             )",
            params![conversation_id],
        )?;
        conn.execute(
            "DELETE FROM sessions WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        conn.execute(
            "DELETE FROM conversation_collaborators WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        // Their `ON DELETE CASCADE` never fires with FK enforcement off. Left
        // behind, the sealed LLM handoff summaries and every past title outlive
        // the chat, and a recreated id would inherit them (and the auto-resume
        // attempt ledger and pending agent control).
        for table in CONVERSATION_SCOPED_HISTORY_TABLES {
            conn.execute(
                &format!("DELETE FROM {table} WHERE conversation_id = ?1"),
                params![conversation_id],
            )?;
        }
        let removed = conn.execute(
            "DELETE FROM conversations WHERE id = ?1",
            params![conversation_id],
        )?;
        drop(conn);
        self.remove_conversation_from_indexes(conversation_id).await;
        Ok(removed > 0)
    }

    /// The derived search indexes hold a conversation's vectors and blind terms:
    /// remove them with it. Best-effort (the source rows are already gone,
    /// search drops hits that no longer resolve, and the backfill's orphan sweep
    /// retries).
    pub(super) async fn remove_conversation_from_indexes(&self, conversation_id: &str) {
        if let Some(index) = self.message_fts.as_ref() {
            if let Err(error) = index.delete_conversation(conversation_id).await {
                tracing::warn!(
                    "keyword index cleanup for a deleted conversation failed: {error:#}"
                );
            }
        }
        if let Some(index) = self.message_index.as_ref() {
            if let Err(error) = index.delete_conversation(conversation_id).await {
                tracing::warn!(
                    "semantic index cleanup for a deleted conversation failed: {error:#}"
                );
            }
        }
    }

    /// Total number of conversations (for the danger-zone "Delete all 42 chats?"
    /// preview). Cheap `COUNT(*)`, no row materialization.
    pub async fn count_conversations(&self) -> Result<u64> {
        let conn = self.conn.lock().await;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0))?;
        Ok(n.max(0) as u64)
    }

    /// `(sealed, total)` chat-content rows, for the encryption-status surface.
    ///
    /// Measured, not assumed: sealed rows carry the `enc:v1:` envelope prefix, so
    /// a row written before encryption landed counts toward `total` but not
    /// `sealed`. Reporting a flat "encrypted ✓" would hide exactly that legacy
    /// plaintext.
    ///
    /// Counts ROWS, not fields, keyed on the field that every row has: a message is
    /// sealed when its `content` envelope is present, a conversation when its
    /// `title` is. `parts` needs no term of its own — it is sealed through the same
    /// [`FieldCipher`] in [`Self::update_message_parts`], and it only ever exists on
    /// a row already counted here, so adding it would double-count the same message.
    /// If a future field is sealed on a path of its own, it needs a term on BOTH
    /// sides — one added to `total` alone would peg every node at partial coverage.
    pub async fn count_sealed_content(&self) -> Result<(u64, u64)> {
        let conn = self.conn.lock().await;
        let (sealed, total): (i64, i64) = conn.query_row(
            "SELECT
                 (SELECT COUNT(*) FROM messages WHERE content LIKE 'enc:v1:%')
                 + (SELECT COUNT(*) FROM conversations WHERE title LIKE 'enc:v1:%'),
                 (SELECT COUNT(*) FROM messages)
                 + (SELECT COUNT(*) FROM conversations WHERE title IS NOT NULL AND title <> '')",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok((sealed.max(0) as u64, total.max(0) as u64))
    }
}
