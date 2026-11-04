//! Recent messages, conversation details and paged message reads.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Fetch the most recent `limit` messages of a conversation, returned in
    /// chronological order (oldest first). Used by short-term memory (spec unit
    /// U11) to assemble recent session context for each request without
    /// replaying the entire history.
    ///
    /// Once a conversation has a version tree (non-NULL leaf), this follows the
    /// active thread like [`Self::get_active_messages`]: rewound, edited-away and
    /// regenerated-over rows stay in the table as alternate versions and must
    /// not be replayed to the model as if they were still the conversation.
    pub async fn get_recent_messages(
        &self,
        conversation_id: &str,
        limit: usize,
    ) -> Result<Vec<StoredMessage>> {
        // Short-term-memory context assembly feeds the model plain text, so the
        // structured parts, metadata and the render-side interruption marker are
        // intentionally not read here — only the reload paths decode them.
        fn recent_message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredMessage> {
            Ok(StoredMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                agent_id: row.get(3)?,
                parts: None,
                metadata: None,
                parent_message_id: None,
                interrupted: false,
                sibling_index: 0,
                sibling_count: 1,
                sibling_ids: Vec::new(),
                created_at: row.get(4)?,
                author_user_id: row.get(5)?,
                author_name: row.get(6)?,
                source: row.get(7)?,
                widget_instance_id: row.get(8)?,
                origin_server: row.get(9)?,
            })
        }
        const RECENT_COLUMNS: &str = "id, role, content, agent_id, created_at, author_user_id, author_name, source, widget_instance_id, origin_server";

        let conn = self.conn.lock().await;
        // Newest first in both branches; reversed to chronological order below.
        let mut out = match Self::active_leaf_locked(&conn, conversation_id)? {
            Some(leaf) => {
                let ids = Self::active_ancestor_ids_locked(&conn, conversation_id, &leaf, limit)?;
                let mut stmt = conn.prepare_cached(&format!(
                    "SELECT {RECENT_COLUMNS} FROM messages WHERE id = ?1 AND conversation_id = ?2"
                ))?;
                let mut out = Vec::with_capacity(ids.len());
                for id in &ids {
                    out.push(
                        stmt.query_row(params![id, conversation_id], recent_message_from_row)?,
                    );
                }
                out
            }
            None => {
                // Never branched: the newest `limit` rows are the thread.
                let mut stmt = conn.prepare(&format!(
                    "SELECT {RECENT_COLUMNS}
                     FROM messages
                     WHERE conversation_id = ?1
                     ORDER BY created_at DESC, rowid DESC
                     LIMIT ?2"
                ))?;
                let rows = stmt.query_map(
                    params![conversation_id, limit as i64],
                    recent_message_from_row,
                )?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
        };
        // Runs on every chat turn: decrypt after releasing the store mutex.
        drop(conn);
        for msg in &mut out {
            msg.content = self.open_content(std::mem::take(&mut msg.content));
        }
        out.reverse();
        Ok(out)
    }

    /// The conversation's selected leaf, or `None` while it has never been
    /// branched (its rows are flat and carry no meaningful parents).
    pub async fn active_leaf(&self, conversation_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        Self::active_leaf_locked(&conn, conversation_id)
    }

    /// Fetch full conversation detail including messages and participants.
    pub async fn get_conversation_detail(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ConversationDetail>> {
        // Serve the *active* thread (the currently-selected branch) so a reloaded
        // conversation renders the version the user last chose, with sibling
        // counts for the pager. Flat (never-branched) conversations fall back to
        // full chronological order inside `get_active_messages`.
        let messages = self.get_active_messages(conversation_id).await?;
        let conn = self.conn.lock().await;
        let row: Option<(Option<String>, Option<String>, i64, i64, Option<String>)> = conn
            .query_row(
                "SELECT title, agent_id, created_at, updated_at, participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        match row {
            None => Ok(None),
            Some((title, agent_id, created_at, updated_at, participants_json)) => {
                let participants = parse_participants_json(participants_json.as_deref());
                Ok(Some(ConversationDetail {
                    id: conversation_id.to_owned(),
                    title: self.open_opt(title),
                    agent_id,
                    created_at,
                    updated_at,
                    messages,
                    participants,
                    has_older_messages: false,
                    older_messages_cursor: None,
                }))
            }
        }
    }

    /// Fetch one chronological page from a never-branched conversation without
    /// loading or decrypting the rest of the transcript. The extra row is the
    /// existence check for the next older page.
    pub(super) async fn get_flat_message_page(
        &self,
        conversation_id: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<StoredMessage>, bool)> {
        let page_limit = limit.max(1);
        let cursor_position = if let Some(cursor) = before {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT created_at, rowid FROM messages
                 WHERE id = ?1 AND conversation_id = ?2",
                params![cursor, conversation_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?
        } else {
            None
        };
        let fetch_limit = page_limit.saturating_add(1) as i64;
        let conn = self.conn.lock().await;
        let mut raw = Vec::new();
        if let Some((cursor_created_at, cursor_rowid)) = cursor_position {
            let mut stmt = conn.prepare(
                "SELECT id, role, content, agent_id, created_at, author_user_id, author_name, source, widget_instance_id, origin_server, parts, parent_message_id, interrupted, metadata
                 FROM messages
                 WHERE conversation_id = ?1
                   AND (created_at < ?2 OR (created_at = ?2 AND rowid < ?3))
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?4",
            )?;
            let rows = stmt.query_map(
                params![
                    conversation_id,
                    cursor_created_at,
                    cursor_rowid,
                    fetch_limit
                ],
                |row| {
                    let sealed_parts: Option<String> = row.get(10)?;
                    let sealed_metadata: Option<String> = row.get(13)?;
                    Ok((
                        StoredMessage {
                            id: row.get(0)?,
                            role: row.get(1)?,
                            content: row.get(2)?,
                            agent_id: row.get(3)?,
                            author_user_id: row.get(5)?,
                            author_name: row.get(6)?,
                            source: row.get(7)?,
                            widget_instance_id: row.get(8)?,
                            origin_server: row.get(9)?,
                            parts: None,
                            metadata: None,
                            parent_message_id: row.get(11)?,
                            interrupted: row.get::<_, i64>(12)? != 0,
                            sibling_index: 0,
                            sibling_count: 1,
                            sibling_ids: Vec::new(),
                            created_at: row.get(4)?,
                        },
                        sealed_parts,
                        sealed_metadata,
                    ))
                },
            )?;
            for row in rows {
                raw.push(row?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, role, content, agent_id, created_at, author_user_id, author_name, source, widget_instance_id, origin_server, parts, parent_message_id, interrupted, metadata
                 FROM messages
                 WHERE conversation_id = ?1
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![conversation_id, fetch_limit], |row| {
                let sealed_parts: Option<String> = row.get(10)?;
                let sealed_metadata: Option<String> = row.get(13)?;
                Ok((
                    StoredMessage {
                        id: row.get(0)?,
                        role: row.get(1)?,
                        content: row.get(2)?,
                        agent_id: row.get(3)?,
                        author_user_id: row.get(5)?,
                        author_name: row.get(6)?,
                        source: row.get(7)?,
                        widget_instance_id: row.get(8)?,
                        origin_server: row.get(9)?,
                        parts: None,
                        metadata: None,
                        parent_message_id: row.get(11)?,
                        interrupted: row.get::<_, i64>(12)? != 0,
                        sibling_index: 0,
                        sibling_count: 1,
                        sibling_ids: Vec::new(),
                        created_at: row.get(4)?,
                    },
                    sealed_parts,
                    sealed_metadata,
                ))
            })?;
            for row in rows {
                raw.push(row?);
            }
        }
        // Decrypt after releasing the store mutex so a page load never holds
        // up other chats' reads and streaming checkpoints.
        drop(conn);
        let mut out: Vec<StoredMessage> = raw
            .into_iter()
            .map(|(mut message, sealed_parts, sealed_metadata)| {
                message.content = self.open_content(std::mem::take(&mut message.content));
                message.parts = self.open_parts(sealed_parts);
                message.metadata = self.open_parts(sealed_metadata);
                message
            })
            .collect();
        let has_older = out.len() > page_limit;
        out.truncate(page_limit);
        out.reverse();
        Ok((out, has_older))
    }

    /// Fetch the newest message page, or the page immediately before a stable
    /// message cursor. The desktop uses this for reverse scrolling so opening a
    /// long chat only decrypts/renders the latest slice at first.
    pub async fn get_conversation_message_page(
        &self,
        conversation_id: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Option<ConversationDetail>> {
        let active_leaf = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT active_leaf_message_id FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
        };
        let (messages, has_older_messages, older_messages_cursor) = if active_leaf.is_none() {
            let (messages, has_older_messages) = self
                .get_flat_message_page(conversation_id, before, limit)
                .await?;
            let older_messages_cursor = if has_older_messages {
                messages.first().map(|message| message.id.clone())
            } else {
                None
            };
            (messages, has_older_messages, older_messages_cursor)
        } else {
            let conn = self.conn.lock().await;
            let (messages, has_older_messages) = self.active_message_page_locked(
                &conn,
                conversation_id,
                active_leaf.as_deref().expect("branched"),
                before,
                limit.max(1),
            )?;
            let older_messages_cursor = if has_older_messages {
                messages.first().map(|message| message.id.clone())
            } else {
                None
            };
            (messages, has_older_messages, older_messages_cursor)
        };

        let conn = self.conn.lock().await;
        let row: Option<(Option<String>, Option<String>, i64, i64, Option<String>)> = conn
            .query_row(
                "SELECT title, agent_id, created_at, updated_at, participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        match row {
            None => Ok(None),
            Some((title, agent_id, created_at, updated_at, participants_json)) => {
                let participants = parse_participants_json(participants_json.as_deref());
                Ok(Some(ConversationDetail {
                    id: conversation_id.to_owned(),
                    title: self.open_opt(title),
                    agent_id,
                    created_at,
                    updated_at,
                    older_messages_cursor,
                    has_older_messages,
                    messages,
                    participants,
                }))
            }
        }
    }
}
