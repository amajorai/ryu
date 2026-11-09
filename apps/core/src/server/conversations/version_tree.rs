//! Reading the active thread of a branched conversation.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// The conversation's active leaf, or `None` for a never-branched (flat)
    /// conversation or a missing row.
    pub(super) fn active_leaf_locked(
        conn: &Connection,
        conversation_id: &str,
    ) -> Result<Option<String>> {
        Ok(conn
            .query_row(
                "SELECT active_leaf_message_id FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .context("reading active leaf")?
            .flatten())
    }

    /// Up to `limit` message ids on the parent chain walked up from `leaf`,
    /// newest (the leaf) first. Reads ids only — no payloads, no decryption.
    pub(super) fn active_ancestor_ids_locked(
        conn: &Connection,
        conversation_id: &str,
        leaf: &str,
        limit: usize,
    ) -> Result<Vec<String>> {
        let mut parent_query = conn.prepare_cached(
            "SELECT parent_message_id FROM messages WHERE id = ?1 AND conversation_id = ?2",
        )?;
        let mut ids = Vec::new();
        let mut cursor = Some(leaf.to_owned());
        let mut visited = std::collections::HashSet::new();
        while let Some(id) = cursor {
            if ids.len() == limit || !visited.insert(id.clone()) {
                break;
            }
            let parent: Option<Option<String>> = parent_query
                .query_row(params![id, conversation_id], |row| row.get(0))
                .optional()?;
            let Some(parent) = parent else {
                break;
            };
            ids.push(id);
            cursor = parent;
        }
        Ok(ids)
    }

    /// Read only the selected ancestry and returned page's payloads. Sibling
    /// decoration uses the parent index and never reads alternate message bodies.
    pub(super) fn active_message_page_locked(
        &self,
        conn: &Connection,
        conversation_id: &str,
        leaf: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<StoredMessage>, bool)> {
        let mut parent_query = conn.prepare_cached(
            "SELECT parent_message_id FROM messages WHERE id = ?1 AND conversation_id = ?2",
        )?;
        // Invalid/off-branch cursors retain the old behavior: return the latest
        // page. Verify ancestry using IDs only before fetching any payload.
        let mut start = Some(leaf.to_owned());
        if let Some(before) = before {
            let mut cursor = start.clone();
            let mut visited = std::collections::HashSet::new();
            while let Some(id) = cursor {
                if !visited.insert(id.clone()) {
                    break;
                }
                let parent: Option<Option<String>> = parent_query
                    .query_row(params![id, conversation_id], |row| row.get(0))
                    .optional()?;
                let Some(parent) = parent else {
                    break;
                };
                if id == before {
                    start = parent;
                    break;
                }
                cursor = parent;
            }
        }
        let mut selected = Vec::new();
        let mut cursor = start;
        let mut visited = std::collections::HashSet::new();
        let mut has_older = false;
        while let Some(id) = cursor {
            if !visited.insert(id.clone()) {
                break;
            }
            let parent: Option<Option<String>> = parent_query
                .query_row(params![id, conversation_id], |row| row.get(0))
                .optional()?;
            let Some(parent) = parent else {
                break;
            };
            if selected.len() == limit {
                has_older = true;
                break;
            }
            selected.push(id);
            cursor = parent;
        }
        selected.reverse();
        let messages = self.load_thread_messages_locked(conn, conversation_id, &selected)?;
        Ok((messages, has_older))
    }

    /// Decrypt the payloads of `ids` (in the given order) and decorate each with
    /// its version-pager siblings. Reads alternate versions' ids, never their
    /// bodies.
    pub(super) fn load_thread_messages_locked(
        &self,
        conn: &Connection,
        conversation_id: &str,
        ids: &[String],
    ) -> Result<Vec<StoredMessage>> {
        let mut message_query = conn.prepare_cached(
            "SELECT id, role, content, agent_id, created_at, author_user_id, author_name,
                    source, widget_instance_id, origin_server, parts, parent_message_id, interrupted, metadata
             FROM messages WHERE id = ?1 AND conversation_id = ?2",
        )?;
        let mut sibling_query = conn.prepare_cached(
            "SELECT id FROM messages WHERE conversation_id = ?1 AND parent_message_id IS ?2
             ORDER BY created_at ASC, rowid ASC",
        )?;
        let mut messages = Vec::with_capacity(ids.len());
        for id in ids {
            let (mut message, parts, metadata) =
                message_query.query_row(params![id, conversation_id], |row| {
                    Ok((
                        StoredMessage {
                            id: row.get(0)?,
                            role: row.get(1)?,
                            content: row.get(2)?,
                            agent_id: row.get(3)?,
                            created_at: row.get(4)?,
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
                        },
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<String>>(13)?,
                    ))
                })?;
            message.content = self.open_content(std::mem::take(&mut message.content));
            message.parts = self.open_parts(parts);
            message.metadata = self.open_parts(metadata);
            let siblings = sibling_query
                .query_map(params![conversation_id, message.parent_message_id], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            message.sibling_count = siblings.len();
            message.sibling_index = siblings
                .iter()
                .position(|id| *id == message.id)
                .unwrap_or(0);
            if siblings.len() > 1 {
                message.sibling_ids = siblings;
            }
            messages.push(message);
        }
        Ok(messages)
    }

    /// The active thread of a conversation: the parent chain walked up from the
    /// selected leaf, in chronological (root-first) order, each message annotated
    /// with its `sibling_index`/`sibling_count` for the version pager. Falls back
    /// to flat chronological order for conversations that have never been branched
    /// (NULL leaf) — byte-identical to `get_messages` there.
    pub async fn get_active_messages(&self, conversation_id: &str) -> Result<Vec<StoredMessage>> {
        let conn = self.conn.lock().await;
        let leaf: Option<String> = conn
            .query_row(
                "SELECT active_leaf_message_id FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .context("reading active leaf")?
            .flatten();
        drop(conn);
        let Some(leaf) = leaf else {
            // Never branched: flat history.
            return self.get_messages(conversation_id).await;
        };

        let conn = self.conn.lock().await;
        Ok(self
            .active_message_page_locked(&conn, conversation_id, &leaf, None, usize::MAX)?
            .0)
    }

    /// How many versions share `parent` in `conversation_id` — the fan-out at a
    /// branch point, read for the `session_tree` hook payload.
    ///
    /// `IS` rather than `=`: the branch point of the very first user turn is the
    /// root bucket, where `parent_message_id` is NULL, and SQL `=` never matches
    /// NULL — a naive `=` would report a first-turn edit as having no siblings at
    /// all, which is exactly the case a version pager cares about.
    ///
    /// Fails open to `1` (a lone version): this count only decorates an
    /// observation hook, so a read error here must never turn an edit into a 500.
    pub(super) fn sibling_count_locked(
        conn: &Connection,
        conversation_id: &str,
        parent: Option<&str>,
    ) -> i64 {
        match conn.query_row(
            "SELECT COUNT(*) FROM messages
             WHERE conversation_id = ?1 AND parent_message_id IS ?2",
            params![conversation_id, parent],
            |r| r.get::<_, i64>(0),
        ) {
            Ok(count) => count,
            Err(e) => {
                tracing::warn!(
                    "session_tree: sibling count failed for '{conversation_id}': {e}; reporting 1"
                );
                1
            }
        }
    }

    /// Fire `session_tree` plugin hooks DETACHED after the message tree branched.
    ///
    /// Observation-only, in both directions: no directive can move a leaf, so the
    /// branch is already committed before the sandbox is even spawned, and every
    /// returned directive is dropped. Detached rather than awaited because an
    /// edit/regenerate is a user-facing click on the UI's critical path — waiting
    /// on a sandbox run there would cost latency for a signal nobody can act on in
    /// time. The global dispatcher's own DB-free `any_manifest_declares` gate makes
    /// the no-plugin case free, so a node without a `session_tree` plugin pays only
    /// this spawn.
    ///
    /// Takes owned scalars — never `&self` and never the connection — because the
    /// caller MUST have dropped the store mutex first. A hook is free to reach back
    /// into Core over HTTP; if the spawn happened under the lock, that call would
    /// block on a mutex the still-running caller holds.
    pub(super) fn fire_session_tree_hooks(
        conversation_id: String,
        source_message_id: String,
        parent_message_id: Option<String>,
        new_message_id: Option<String>,
        active_leaf_message_id: String,
        sibling_count: i64,
        reason: &'static str,
    ) {
        tokio::spawn(async move {
            let ctx = crate::plugin_host::HookContext {
                conversation_id: Some(conversation_id.clone()),
                event: Some(serde_json::json!({
                    "conversation_id": conversation_id,
                    "source_message_id": source_message_id,
                    "parent_message_id": parent_message_id,
                    "new_message_id": new_message_id,
                    "active_leaf_message_id": active_leaf_message_id,
                    "sibling_count": sibling_count,
                    "reason": reason,
                })),
                ..Default::default()
            };
            let _ =
                crate::plugin_host::dispatch_global(crate::plugin_host::ON_SESSION_TREE, ctx).await;
        });
    }
}
