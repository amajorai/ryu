//! Editing a user turn, regenerating a reply and selecting a version.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Edit a user message: create a new sibling version carrying `new_content`
    /// (same parent as the edited message) and point the active leaf at it, so a
    /// subsequent generation turn attaches its reply beneath the edit. Returns the
    /// new sibling's id, or `None` if the message is absent / not a user turn.
    ///
    /// Fires `session_tree` hooks (detached) once the branch is committed — this is
    /// the primary site where the tree actually gains a fork.
    pub async fn edit_user_message(
        &self,
        conversation_id: &str,
        message_id: &str,
        new_content: &str,
    ) -> Result<Option<String>> {
        let now = now_millis();
        let new_id = uuid::Uuid::new_v4().to_string();
        let sealed = self.cipher.seal(new_content)?;
        let conn = self.conn.lock().await;
        Self::linearize_locked(&conn, conversation_id)?;
        // Resolve the edited message's role, parent, and agent.
        let row: Option<(String, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT role, parent_message_id, agent_id FROM messages
                 WHERE id = ?1 AND conversation_id = ?2",
                params![message_id, conversation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .context("loading message to edit")?;
        let Some((role, parent, agent_id)) = row else {
            return Ok(None);
        };
        if role != "user" {
            return Ok(None);
        }
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, agent_id, parent_message_id, created_at)
             VALUES (?1, ?2, 'user', ?3, ?4, ?5, ?6)",
            params![new_id, conversation_id, sealed, agent_id, parent, now],
        )
        .context("inserting edited user sibling")?;
        conn.execute(
            "UPDATE conversations SET active_leaf_message_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_id, now, conversation_id],
        )
        .context("pointing leaf at edit")?;
        // Read the fan-out under the SAME lock that just inserted the sibling
        // (cheap, indexed, no decryption), so the hook payload can never disagree
        // with the branch it is reporting. Then release the lock BEFORE spawning.
        let sibling_count = Self::sibling_count_locked(&conn, conversation_id, parent.as_deref());
        drop(conn);
        Self::fire_session_tree_hooks(
            conversation_id.to_owned(),
            message_id.to_owned(),
            parent,
            Some(new_id.clone()),
            new_id.clone(),
            sibling_count,
            "edit",
        );
        Ok(Some(new_id))
    }

    /// Prepare to regenerate an assistant message: point the active leaf at the
    /// user turn *above* it (its parent) so the next generation appends a fresh
    /// assistant sibling. Returns the parent id, or `None` if the message is
    /// absent or has no parent (a regenerate needs a preceding user turn).
    ///
    /// Fires `session_tree` hooks (detached) alongside `edit_user_message`: the
    /// phase means "the tree changed", not "the edit button was pressed", and a
    /// regenerate moves the active leaf to a fork point just as an edit does.
    pub async fn prepare_regenerate(
        &self,
        conversation_id: &str,
        message_id: &str,
    ) -> Result<Option<String>> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        Self::linearize_locked(&conn, conversation_id)?;
        let parent: Option<Option<String>> = conn
            .query_row(
                "SELECT parent_message_id FROM messages
                 WHERE id = ?1 AND conversation_id = ?2",
                params![message_id, conversation_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()
            .context("loading message to regenerate")?;
        let Some(Some(parent_id)) = parent else {
            return Ok(None);
        };
        conn.execute(
            "UPDATE conversations SET active_leaf_message_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![parent_id, now, conversation_id],
        )
        .context("pointing leaf at regenerate parent")?;
        let sibling_count = Self::sibling_count_locked(&conn, conversation_id, Some(&parent_id));
        drop(conn);
        // `new_message_id` is null on purpose. A regenerate only repoints the leaf;
        // the fresh assistant sibling is born later, when the streamed turn reaches
        // `append_message` and chains beneath this parent. Reporting an id here
        // would mean inventing one. For the same reason `sibling_count` is the
        // count BEFORE the regeneration lands, i.e. how many versions the user is
        // branching away from.
        Self::fire_session_tree_hooks(
            conversation_id.to_owned(),
            message_id.to_owned(),
            Some(parent_id.clone()),
            None,
            parent_id.clone(),
            sibling_count,
            "regenerate",
        );
        Ok(Some(parent_id))
    }

    /// Switch the active version at a branch point: make `version_id` the chosen
    /// sibling, then descend to a leaf (following the newest child at each step)
    /// and set that as the conversation's active leaf. Returns the resolved leaf
    /// id, or `None` if `version_id` is absent. The client then re-reads the
    /// active path to re-render the thread along the newly-selected branch.
    ///
    /// Deliberately does NOT fire `session_tree`, unlike `edit_user_message` and
    /// `prepare_regenerate`: paging between versions inserts no message and rewires
    /// no parent edge, it only moves the cursor over a tree that already exists.
    /// Firing here would turn a branch signal into a navigation feed, so a plugin
    /// counting forks would over-count every time the user clicked "<".
    pub async fn select_version(
        &self,
        conversation_id: &str,
        version_id: &str,
    ) -> Result<Option<String>> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        Self::linearize_locked(&conn, conversation_id)?;
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM messages WHERE id = ?1 AND conversation_id = ?2",
                params![version_id, conversation_id],
                |_| Ok(()),
            )
            .optional()
            .context("checking version exists")?
            .is_some();
        if !exists {
            return Ok(None);
        }
        // Descend from the chosen version to a leaf, always following the
        // most-recently-created child (the latest continuation of that branch).
        let mut leaf = version_id.to_owned();
        // A stored parent loop (relayed or legacy data) must not spin forever
        // while the store lock is held: stop at the first revisited row.
        let mut visited = std::collections::HashSet::from([leaf.clone()]);
        loop {
            let child: Option<String> = conn
                .query_row(
                    "SELECT id FROM messages
                     WHERE conversation_id = ?1 AND parent_message_id = ?2
                     ORDER BY created_at DESC, rowid DESC LIMIT 1",
                    params![conversation_id, leaf],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .context("descending to leaf")?;
            match child {
                Some(c) if visited.insert(c.clone()) => leaf = c,
                _ => break,
            }
        }
        conn.execute(
            "UPDATE conversations SET active_leaf_message_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![leaf, now, conversation_id],
        )
        .context("setting selected leaf")?;
        Ok(Some(leaf))
    }
}
