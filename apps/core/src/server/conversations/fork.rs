//! Forking a conversation and linearizing a flat history into a version tree.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Fork (branch) a conversation into a brand-new conversation, copying the
    /// thread up to and including `up_to_message_id` (ChatGPT-style "Branch in
    /// new chat"). When `up_to_message_id` is `None` the whole active thread is
    /// copied. Once the source has a version tree, the copy is the cut point's
    /// ancestry only; alternate versions (edits, regenerations, rewound turns)
    /// are never interleaved into the branch.
    ///
    /// The new conversation is fully independent: it gets a fresh id and fresh
    /// per-message ids, so continuing the branch never touches the source. Run
    /// metadata (folder/branch/worktree) and participants are carried over, but
    /// `run_status` and any goal are intentionally left unset on the copy. Saved
    /// generative-UI widget state is carried over only when the fork copies the
    /// whole active thread.
    ///
    /// Returns the new conversation's summary, or `None` when the source does not
    /// exist or `up_to_message_id` is not a message of that conversation.
    ///
    /// Tenancy: the FORKER owns the copy (`owner_user_id` / `org_id` come from the
    /// caller, NOT from the source row). Forking an org-visible chat therefore
    /// produces a private branch owned by whoever forked it, and never silently
    /// hands a copy of someone else's private chat to a new owner — the READ gate on
    /// the source is what decides whether the fork may happen at all. Pass
    /// [`Tenancy::Unattributed`] for the unbound/personal case (rows stay untenanted,
    /// byte-identical to the pre-ACL behaviour).
    pub async fn fork_conversation(
        &self,
        source_id: &str,
        up_to_message_id: Option<&str>,
        tenancy: Tenancy,
    ) -> Result<Option<ConversationSummary>> {
        // Read the source history (chronological) before taking the write lock so
        // the cut-point lookup stays simple. The leaf is read first so it always
        // names a row the history read below includes.
        let leaf = {
            let conn = self.conn.lock().await;
            Self::active_leaf_locked(&conn, source_id)?
        };
        let messages = self.get_messages(source_id).await?;
        // `copies_active_thread`: the slice is the whole active thread, so the
        // latest widget snapshots belong to it (see the widget-state copy below).
        let (slice, copies_active_thread): (Vec<&StoredMessage>, bool) = match leaf.as_deref() {
            // Never branched: the flat chronological history is the thread.
            None => {
                let slice: Vec<&StoredMessage> = match up_to_message_id {
                    Some(mid) => {
                        let Some(idx) = messages.iter().position(|m| m.id == mid) else {
                            return Ok(None);
                        };
                        messages[..=idx].iter().collect()
                    }
                    None => messages.iter().collect(),
                };
                let whole = slice.len() == messages.len();
                (slice, whole)
            }
            // A version tree: copy only the cut point's own ancestry, never the
            // alternate versions (edits, regenerations, rewound turns) beside it.
            Some(leaf) => {
                let by_id: std::collections::HashMap<&str, &StoredMessage> =
                    messages.iter().map(|m| (m.id.as_str(), m)).collect();
                let tip = up_to_message_id.unwrap_or(leaf);
                if up_to_message_id.is_some() && !by_id.contains_key(tip) {
                    return Ok(None);
                }
                let mut slice = Vec::new();
                let mut visited = std::collections::HashSet::new();
                let mut cursor = Some(tip);
                while let Some(id) = cursor {
                    if !visited.insert(id) {
                        break;
                    }
                    let Some(message) = by_id.get(id) else {
                        break;
                    };
                    slice.push(*message);
                    cursor = message.parent_message_id.as_deref();
                }
                slice.reverse();
                (slice, tip == leaf)
            }
        };

        let now = now_millis();
        let new_id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock().await;

        // Carry over the source's metadata; bail if the row is missing.
        type SourceRow = (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let source: Option<SourceRow> = conn
            .query_row(
                "SELECT title, agent_id, folder_path, branch, worktree_path, participants
                 FROM conversations WHERE id = ?1",
                params![source_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((title, agent_id, folder_path, branch, worktree_path, participants_json)) = source
        else {
            return Ok(None);
        };
        // The stored title is sealed; decrypt before deriving the branch title,
        // then re-seal for the new row (and return the plaintext in the summary).
        let forked_title = self
            .open_opt(title)
            .map(|t| format!("{t} (branch)"))
            .or_else(|| Some("Branch".to_owned()));
        let forked_title_sealed = self.seal_opt(forked_title.as_deref())?;
        let participants_json = participants_json.unwrap_or_else(|| "[]".to_owned());

        upsert_conversation_row(
            &conn,
            &new_id,
            now,
            &tenancy,
            &ConvRow {
                title: forked_title_sealed.as_deref(),
                agent_id: agent_id.as_deref(),
                folder_path: folder_path.as_deref(),
                branch: branch.as_deref(),
                worktree_path: worktree_path.as_deref(),
                participants: Some(participants_json.as_str()),
                channel_id: None,
                visibility: None,
                ..ConvRow::default()
            },
            Touch::Keep,
        )
        .context("inserting forked conversation")?;
        // A fork stays in its source's project as an ordinary session; it never
        // inherits a main-thread role (that would collide with the scope's one
        // main thread).
        let project_id_of_source: Option<String> = conn
            .query_row(
                "SELECT project_id FROM conversations WHERE id = ?1",
                params![source_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        if project_id_of_source.is_some() {
            conn.execute(
                "UPDATE conversations SET project_id = ?1 WHERE id = ?2",
                params![project_id_of_source, new_id],
            )
            .context("carrying the project onto the fork")?;
        }

        // Copy each message with a fresh id, preserving role/content/agent/ordering.
        // `m.content` is already decrypted (get_messages opened it), so re-seal it
        // for the new row.
        //
        // Deliberately NOT copied: `feedback`, `interrupted` — and, for the
        // same reason, `message_reactions`. A fork is a new thread whose messages
        // have new ids; per-person reactions belong to the rows people actually
        // reacted to, so the branch starts with none.
        for m in &slice {
            let copy_id = uuid::Uuid::new_v4().to_string();
            let sealed = self.cipher.seal(&m.content)?;
            let sealed_parts = m
                .parts
                .as_ref()
                .map(|value| self.cipher.seal(&value.to_string()))
                .transpose()?;
            let sealed_metadata = m
                .metadata
                .as_ref()
                .map(|value| self.cipher.seal(&value.to_string()))
                .transpose()?;
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, agent_id, created_at, parts, metadata)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![copy_id, new_id, m.role, sealed, m.agent_id, m.created_at, sealed_parts, sealed_metadata],
            )
            .context("copying message into fork")?;
        }

        // Saved generative-UI widget and artifact-page state is keyed by the tool
        // call ids the copied parts keep verbatim, so a fork of the whole history
        // carries it over: ticks stay ticked and a submitted form stays submitted.
        // Each row is one latest snapshot, not a history, so a fork cut before the
        // last message starts its widgets from their specs rather than importing
        // edits (or a submission) made after the cut point. Values are sealed
        // without per-conversation binding and the source is already capped at
        // `MAX_AGENT_UI_STATES`, so the rows copy as they are.
        if copies_active_thread {
            conn.execute(
                "INSERT OR IGNORE INTO agent_ui_state (conversation_id, tool_call_id, state, updated_at)
                 SELECT ?1, tool_call_id, state, updated_at FROM agent_ui_state
                 WHERE conversation_id = ?2
                 ORDER BY updated_at DESC
                 LIMIT ?3",
                params![new_id, source_id, MAX_AGENT_UI_STATES],
            )
            .context("copying widget state into fork")?;
        }

        Ok(Some(ConversationSummary {
            id: new_id,
            title: forked_title,
            agent_id,
            created_at: now,
            updated_at: now,
            message_count: slice.len() as i64,
            folder_path,
            branch,
            worktree_path,
            run_status: None,
            participants: parse_participants_json(Some(&participants_json)),
            pinned: false,
            archived: false,
            linked_pull_requests: Vec::new(),
            icon: None,
            visibility: "private".to_owned(),
            last_message: None,
            last_message_role: None,
            last_message_at: None,
            hierarchy: ThreadHierarchy {
                project_id: project_id_of_source,
                ..ThreadHierarchy::default()
            },
            continued_on: None,
        }))
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Message version tree (ChatGPT/Claude-style edit + regenerate branching)
    //
    // A conversation starts flat: every message has a NULL `parent_message_id`
    // and the conversation's `active_leaf_message_id` is NULL, so reads return
    // chronological order and appends do not link parents. The first edit or
    // regenerate calls `linearize`, which converts that flat history into a spine
    // (each message's parent = its predecessor) and sets the leaf to the last
    // message. From then on the *active thread* is the parent chain walked up
    // from the leaf, alternate versions are siblings (messages sharing a parent),
    // and `append_message` chains new turns beneath the leaf.
    // ─────────────────────────────────────────────────────────────────────────

    /// Convert a never-branched conversation's flat history into a linked spine
    /// so it can host version branches. Idempotent: a no-op once the leaf is set
    /// (i.e. the conversation already has a tree). Returns the id of the message
    /// the caller named, resolved within the now-linearized history, or `None`
    /// if that message does not belong to the conversation.
    ///
    /// Must be called while holding no other reference to the connection.
    pub(super) fn linearize_locked(conn: &Connection, conversation_id: &str) -> Result<()> {
        let already: Option<String> = conn
            .query_row(
                "SELECT active_leaf_message_id FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .context("checking leaf for linearize")?
            .flatten();
        if already.is_some() {
            return Ok(());
        }
        // Chronological ids (the flat order the UI has always shown).
        let ids: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT id FROM messages WHERE conversation_id = ?1
                 ORDER BY created_at ASC, rowid ASC",
            )?;
            let rows = stmt.query_map(params![conversation_id], |row| row.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        if ids.is_empty() {
            return Ok(());
        }
        // Link each message to its predecessor; the first becomes a root (NULL
        // parent). Clearing it matters: a flat row may still carry a parent (a
        // relayed or legacy value), and keeping one that names a later row would
        // turn the rebuilt chain into a ring.
        conn.execute(
            "UPDATE messages SET parent_message_id = NULL WHERE id = ?1",
            params![ids[0]],
        )
        .context("clearing first message parent on linearize")?;
        for pair in ids.windows(2) {
            conn.execute(
                "UPDATE messages SET parent_message_id = ?1 WHERE id = ?2",
                params![pair[0], pair[1]],
            )
            .context("linearizing message parent")?;
        }
        let leaf = ids.last().expect("non-empty");
        conn.execute(
            "UPDATE conversations SET active_leaf_message_id = ?1 WHERE id = ?2",
            params![leaf, conversation_id],
        )
        .context("setting leaf on linearize")?;
        Ok(())
    }
}
