//! Bulk clearing: every conversation, or only those a user owns.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

/// What a bulk chat clear removed: the conversation count, and per removed
/// conversation the residue it leaves outside the store, so the caller can
/// release it as a single delete does.
#[derive(Debug, Default)]
pub struct ClearedConversations {
    pub removed: u64,
    pub residue: Vec<ClearedConversationResidue>,
}

/// One cleared conversation's id (its agent transcripts are kept under it) and
/// the folders whose checkpoint stores pin snapshots for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClearedConversationResidue {
    pub conversation_id: String,
    pub checkpoint_workspaces: Vec<PathBuf>,
}

/// The residue a bulk clear is about to remove: every conversation (`owner` is
/// `None`) or only the ones `owner` owns (strict owner match), plus any
/// checkpoint rows those clears delete. Callers hold the connection lock across
/// this read and the deletes.
pub(super) fn cleared_conversation_residue(
    conn: &Connection,
    owner: Option<&str>,
) -> Result<Vec<ClearedConversationResidue>> {
    const OWNED: &str = "SELECT id FROM conversations WHERE owner_user_id = ?1";
    let mut by_id: std::collections::BTreeMap<String, Vec<PathBuf>> =
        std::collections::BTreeMap::new();
    let (ids_sql, folders_sql) = match owner {
        None => (
            "SELECT id FROM conversations".to_owned(),
            "SELECT DISTINCT conversation_id, workspace FROM chat_checkpoints
             WHERE commit_id IS NOT NULL AND workspace IS NOT NULL
             ORDER BY conversation_id, workspace"
                .to_owned(),
        ),
        Some(_) => (
            OWNED.to_owned(),
            format!(
                "SELECT DISTINCT conversation_id, workspace FROM chat_checkpoints
                 WHERE commit_id IS NOT NULL AND workspace IS NOT NULL
                   AND conversation_id IN ({OWNED})
                 ORDER BY conversation_id, workspace"
            ),
        ),
    };
    let params: Vec<&dyn rusqlite::ToSql> = match &owner {
        None => Vec::new(),
        Some(owner) => vec![owner],
    };
    {
        let mut stmt = conn.prepare(&ids_sql)?;
        let rows = stmt.query_map(params.as_slice(), |row| row.get::<_, String>(0))?;
        for id in rows {
            by_id.entry(id?).or_default();
        }
    }
    {
        let mut stmt = conn.prepare(&folders_sql)?;
        let rows = stmt.query_map(params.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, workspace) = row?;
            by_id.entry(id).or_default().push(PathBuf::from(workspace));
        }
    }
    Ok(by_id
        .into_iter()
        .map(
            |(conversation_id, checkpoint_workspaces)| ClearedConversationResidue {
                conversation_id,
                checkpoint_workspaces,
            },
        )
        .collect())
}

impl ConversationStore {
    /// Delete **every** conversation and all chat-scoped state: messages and
    /// sessions (both keyed by `conversation_id`) plus the conversation rows
    /// themselves (which carry the goal columns). Returns the number of
    /// conversations removed. This goes further than [`Self::delete_conversation`],
    /// which leaves sessions orphaned — a full wipe should not.
    ///
    /// The returned [`ClearedConversations::residue`] is read under the same
    /// lock as the deletes, so it names exactly the conversations removed (one
    /// created concurrently either is cleared and listed, or survives).
    pub async fn clear_all_conversations(&self) -> Result<ClearedConversations> {
        // One transaction, so a failure part-way cannot leave reactions or other
        // side tables behind to resurface under a reused conversation id.
        let mut conn = self.conn.lock().await;
        let residue = cleared_conversation_residue(&conn, None)?;
        // Scoped so the transaction (which borrows the connection, so is not
        // `Send`) is gone before the awaits below.
        let removed = {
            let transaction = conn.transaction()?;
            transaction.execute("DELETE FROM messages", [])?;
            transaction.execute("DELETE FROM message_read_receipts", [])?;
            transaction.execute(
                "DELETE FROM harness_run_events WHERE run_id IN (SELECT id FROM harness_runs)",
                [],
            )?;
            transaction.execute("DELETE FROM harness_runs", [])?;
            transaction.execute("DELETE FROM sessions", [])?;
            transaction.execute("DELETE FROM btw_entries", [])?;
            // No FK on either table (see `delete_conversation`): without these the
            // reactions and the saved widget/page state (whatever the user typed into
            // a generative-UI widget) would outlive the wipe as unreachable orphans.
            transaction.execute("DELETE FROM message_reactions", [])?;
            transaction.execute("DELETE FROM agent_ui_state", [])?;
            transaction.execute("DELETE FROM chat_checkpoints", [])?;
            transaction.execute("DELETE FROM proactive_openings", [])?;
            transaction.execute("DELETE FROM channel_turn_idempotency", [])?;
            transaction.execute("DELETE FROM conversation_collaborators", [])?;
            for table in CONVERSATION_SCOPED_HISTORY_TABLES {
                transaction.execute(&format!("DELETE FROM {table}"), [])?;
            }
            let removed = transaction.execute("DELETE FROM conversations", [])?;
            transaction.commit()?;
            removed
        };
        drop(conn);
        // Every message is gone, so the derived indexes (blind terms, sealed
        // vectors, the in-memory partition) are emptied with them; the backfill
        // flags reset. Best-effort: the orphan sweep retries on a later search.
        if let Err(error) = self.clear_message_embeddings().await {
            tracing::warn!("search index cleanup after clearing all chats failed: {error:#}");
        }
        Ok(ClearedConversations {
            removed: removed as u64,
            residue,
        })
    }

    /// The tenancy-scoped twin of [`Self::clear_all_conversations`]: delete ONLY the
    /// conversations `owner_user_id` owns, plus their messages/sessions/side-chats.
    ///
    /// `POST /api/data/clear` used the unscoped truncate above with no ACL at all, so
    /// on an org-bound node any holder of the node token could destroy EVERY user's
    /// chats. On a bound node the danger-zone clear now routes here instead. Strict
    /// owner-match on purpose: an org-visible chat owned by a colleague is NOT the
    /// caller's to delete.
    ///
    /// Like [`Self::clear_all_conversations`], the residue is read under the
    /// same lock as the deletes.
    pub async fn clear_conversations_owned_by(
        &self,
        owner_user_id: &str,
    ) -> Result<ClearedConversations> {
        // One transaction, so a failure part-way cannot leave this owner's
        // reactions or other side tables behind for a reused conversation id.
        let mut conn = self.conn.lock().await;
        let residue = cleared_conversation_residue(&conn, Some(owner_user_id))?;
        let owned = "SELECT id FROM conversations WHERE owner_user_id = ?1";
        // Collected first: the derived search indexes are cleaned per
        // conversation after the wipe.
        let owned_ids: Vec<String> = {
            let mut stmt = conn.prepare(owned)?;
            let rows = stmt.query_map(params![owner_user_id], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        // Scoped so the transaction (which borrows the connection, so is not
        // `Send`) is gone before the awaits below.
        let removed = {
            let transaction = conn.transaction()?;
            transaction.execute(
                &format!("DELETE FROM messages WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM message_read_receipts WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            // Harness runs hang off sessions (`sess_…` ids), not conversation ids, so
            // resolve the owned conversations' sessions first.
            let owned_sessions =
                format!("SELECT id FROM sessions WHERE conversation_id IN ({owned})");
            transaction.execute(
                &format!(
                    "DELETE FROM harness_run_events WHERE run_id IN (
                     SELECT id FROM harness_runs WHERE session_id IN ({owned_sessions})
                 )"
                ),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM harness_runs WHERE session_id IN ({owned_sessions})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM sessions WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM btw_entries WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM message_reactions WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM agent_ui_state WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM chat_checkpoints WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM proactive_openings WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM channel_turn_idempotency WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!(
                    "DELETE FROM conversation_collaborators WHERE conversation_id IN ({owned})"
                ),
                params![owner_user_id],
            )?;
            // Before the conversations themselves: `owned` reads their ids.
            for table in CONVERSATION_SCOPED_HISTORY_TABLES {
                transaction.execute(
                    &format!("DELETE FROM {table} WHERE conversation_id IN ({owned})"),
                    params![owner_user_id],
                )?;
            }
            let removed_rows = transaction.execute(
                "DELETE FROM conversations WHERE owner_user_id = ?1",
                params![owner_user_id],
            )?;
            transaction.commit()?;
            removed_rows
        };
        drop(conn);
        for conversation_id in &owned_ids {
            self.remove_conversation_from_indexes(conversation_id).await;
        }
        Ok(ClearedConversations {
            removed: removed as u64,
            residue,
        })
    }
}
