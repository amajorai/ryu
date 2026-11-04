//! Sync and resume writes: metadata merges and id-preserving appends that
//! link synced or resumed rows into the version tree.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Update conversation metadata only when `incoming_updated_at` is strictly
    /// newer than the stored `updated_at` value (last-writer-wins).
    /// Used by the cross-device sync client (`server/sync.rs`).
    pub async fn update_metadata_if_newer(
        &self,
        conversation_id: &str,
        title: Option<&str>,
        agent_id: Option<&str>,
        folder_path: Option<&str>,
        branch: Option<&str>,
        worktree_path: Option<&str>,
        run_status: Option<&str>,
        incoming_updated_at: i64,
    ) -> Result<()> {
        let title = self.seal_opt(title)?;
        let conn = self.conn.lock().await;
        // Only overwrite when the incoming timestamp is >= the stored one (LWW).
        conn.execute(
            "UPDATE conversations
             SET title         = COALESCE(?2, title),
                 agent_id      = COALESCE(?3, agent_id),
                 folder_path   = COALESCE(?4, folder_path),
                 branch        = COALESCE(?5, branch),
                 worktree_path = COALESCE(?6, worktree_path),
                 run_status    = COALESCE(?7, run_status),
                 updated_at    = ?8
             WHERE id = ?1 AND updated_at <= ?8",
            params![
                conversation_id,
                title,
                agent_id,
                folder_path,
                branch,
                worktree_path,
                run_status,
                incoming_updated_at,
            ],
        )
        .context("update_metadata_if_newer")?;
        Ok(())
    }

    /// Append a message with an explicit stable id (used by the sync client to
    /// replay messages from a remote payload without generating new ids).
    /// Skips the insert silently when a message with the given id already
    /// exists (idempotent — union-merge semantics for cross-device sync).
    pub async fn append_message_with_id(
        &self,
        conversation_id: &str,
        message_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        created_at_ms: i64,
        tenancy: Tenancy,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        // Upsert the conversation row so the message FK is satisfied — through the
        // choke point, so a replayed conversation is born owned rather than
        // NULL-tenanted (and therefore invisible) on an org-bound node.
        upsert_conversation_row(
            &conn,
            conversation_id,
            created_at_ms,
            &tenancy,
            &ConvRow {
                agent_id,
                ..ConvRow::default()
            },
            Touch::Max,
        )?;

        // INSERT OR IGNORE: skip when the message id already exists (idempotent).
        let sealed = self.cipher.seal(content)?;
        conn.execute(
            "INSERT OR IGNORE INTO messages (id, conversation_id, role, content, agent_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![message_id, conversation_id, role, sealed, agent_id, created_at_ms],
        )
        .context("inserting message with explicit id")?;
        Ok(())
    }

    /// Insert one replayed message after `ensure_sync_conversation` established
    /// the row and tenancy. Unlike `append_message_with_id`, this does not touch
    /// conversation metadata, so replay order cannot replace a newer active agent
    /// or timestamp before LWW metadata resolution runs.
    pub async fn append_sync_message_with_id(
        &self,
        conversation_id: &str,
        message_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        created_at_ms: i64,
    ) -> Result<bool> {
        let sealed = self.cipher.seal(content)?;
        let conn = self.conn.lock().await;
        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO messages
                    (id, conversation_id, role, content, agent_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    message_id,
                    conversation_id,
                    role,
                    sealed,
                    agent_id,
                    created_at_ms
                ],
            )
            .context("inserting sync message with explicit id")?;
        Ok(inserted == 1)
    }

    /// Chain the rows an RNP resume just imported into the version tree.
    ///
    /// Sync inserts carry no parent, so once a conversation has a tree (non-NULL
    /// leaf) they are unreachable from the active thread that the chat view and
    /// the next turn's context read. `transcript_ids` is the resumed bundle's
    /// transcript in thread order (one linear active-thread export),
    /// `context_ids` its imported context items, and `inserted` the subset of both
    /// that this resume added. Each inserted row is parented on its predecessor.
    ///
    /// The leaf moves only when the import continues the active thread: the
    /// inserted transcript rows are the bundle's tail and either follow the leaf
    /// itself or share no row with the target (a `Recent` export past the
    /// target's history), in which case they start beneath the leaf. When the
    /// target has its own turns after the shared row, the imported transcript
    /// stays an alternate branch beneath that row (reachable through the version
    /// pager) and its context items follow it, so the target's newer local turns
    /// remain selected. Context items imported without new transcript rows join
    /// the active thread beneath the leaf. A never-branched conversation is left
    /// flat, where reads already follow creation order.
    pub async fn link_resumed_messages(
        &self,
        conversation_id: &str,
        transcript_ids: &[String],
        context_ids: &[String],
        inserted: &std::collections::HashSet<String>,
    ) -> Result<()> {
        if !transcript_ids
            .iter()
            .chain(context_ids)
            .any(|id| inserted.contains(id))
        {
            return Ok(());
        }
        let mut conn = self.conn.lock().await;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("starting resume link transaction")?;
        let Some(leaf) = Self::active_leaf_locked(&tx, conversation_id)? else {
            return Ok(());
        };
        let link = |parent: Option<&str>, id: &str| -> Result<()> {
            tx.execute(
                "UPDATE messages SET parent_message_id = ?1
                 WHERE id = ?2 AND conversation_id = ?3",
                params![parent, id, conversation_id],
            )
            .context("linking resumed message")?;
            Ok(())
        };
        // Where the active thread ends, and whether the context items follow it.
        let mut active_tail = leaf.clone();
        let mut previous: Option<String> = Some(leaf.clone());
        let mut context_on_active_thread = true;
        if let Some(first_new) = transcript_ids.iter().position(|id| inserted.contains(id)) {
            let anchor = first_new
                .checked_sub(1)
                .map(|index| transcript_ids[index].clone());
            let new_tail = transcript_ids[first_new..]
                .iter()
                .all(|id| inserted.contains(id));
            let appends = new_tail && anchor.as_deref().is_none_or(|anchor| anchor == leaf);
            let mut transcript_previous = if appends { Some(leaf.clone()) } else { anchor };
            for id in &transcript_ids[first_new..] {
                if inserted.contains(id) {
                    link(transcript_previous.as_deref(), id.as_str())?;
                }
                transcript_previous = Some(id.clone());
            }
            if appends {
                active_tail = transcript_previous.clone().unwrap_or_else(|| leaf.clone());
                previous = transcript_previous;
            } else if new_tail {
                // An alternate branch: keep its context items with it.
                context_on_active_thread = false;
                previous = transcript_previous;
            }
        }
        for id in context_ids {
            if inserted.contains(id) {
                link(previous.as_deref(), id.as_str())?;
                if context_on_active_thread {
                    active_tail = id.clone();
                }
                previous = Some(id.clone());
            }
        }
        if active_tail != leaf {
            tx.execute(
                "UPDATE conversations SET active_leaf_message_id = ?1 WHERE id = ?2",
                params![active_tail, conversation_id],
            )
            .context("advancing leaf to resumed thread")?;
        }
        tx.commit().context("committing resume link")?;
        Ok(())
    }

    /// Place the rows a cloud-sync pull or git-checkpoint import just inserted
    /// into the receiver's version tree.
    ///
    /// Replayed rows are inserted with a NULL parent, so in a branched receiver
    /// (non-NULL leaf) they would be unreachable from the active thread that the
    /// chat view and the next turn's context read. `rows` is the replayed batch
    /// in payload order with each row's source tree position; `inserted` is the
    /// subset this replay added. Rows that already existed are never re-parented.
    ///
    /// In a branched receiver, each inserted row keeps its source parent when the
    /// receiver holds that parent and linking it keeps the tree acyclic. A
    /// [`SyncParent::Root`] row stays a root. A row with no parent, a parent the
    /// receiver does not hold, or a parent that would close a loop (a payload
    /// naming rows as each other's parents) continues the thread: it is parented
    /// on the current tail, and later such rows chain beneath it. The leaf moves
    /// only down onto inserted rows that descend from it, so it never leaves newer
    /// local turns: a row whose parent is an earlier message becomes an alternate
    /// version reachable through the pager. A never-branched receiver is left
    /// untouched: its leaf stays NULL, its reads stay flat, and its rows keep NULL
    /// parents (branching later rebuilds every parent chronologically).
    pub async fn link_synced_messages(
        &self,
        conversation_id: &str,
        rows: &[SyncLink],
        inserted: &std::collections::HashSet<String>,
    ) -> Result<()> {
        if inserted.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().await;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("starting sync link transaction")?;
        let Some(leaf) = Self::active_leaf_locked(&tx, conversation_id)? else {
            // Flat receiver: the pre-tree behaviour, no writes.
            return Ok(());
        };
        // The end of the thread this replay continues, and (once it is an
        // inserted row) its parent, so a later sibling version replaces it.
        let mut tail = leaf.clone();
        let mut tail_parent: Option<String> = None;
        // Inserted children of each parent, in payload order.
        let mut children: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        {
            let mut exists =
                tx.prepare_cached("SELECT 1 FROM messages WHERE id = ?1 AND conversation_id = ?2")?;
            let mut parent_of = tx.prepare_cached(
                "SELECT parent_message_id FROM messages WHERE id = ?1 AND conversation_id = ?2",
            )?;
            let mut link = tx.prepare_cached(
                "UPDATE messages SET parent_message_id = ?1
                 WHERE id = ?2 AND conversation_id = ?3",
            )?;
            let mut ancestry = VersionAncestry::default();
            let mut placed = std::collections::HashSet::new();
            for row in rows.iter().filter(|row| inserted.contains(&row.id)) {
                // A payload may repeat an id; place each row once.
                if !placed.insert(row.id.as_str()) {
                    continue;
                }
                let mut parent = None;
                if let SyncParent::Message(source) = &row.parent {
                    let held = exists
                        .query_row(params![source, conversation_id], |_| Ok(()))
                        .optional()
                        .context("checking synced parent")?
                        .is_some();
                    if held
                        && ancestry.extends_tree(
                            &mut parent_of,
                            conversation_id,
                            source,
                            &row.id,
                        )?
                    {
                        parent = Some(source.clone());
                    }
                }
                if parent.is_none()
                    && row.parent != SyncParent::Root
                    && ancestry.extends_tree(&mut parent_of, conversation_id, &tail, &row.id)?
                {
                    // No usable source position: continue the receiver's thread.
                    parent = Some(tail.clone());
                }
                let Some(parent) = parent else {
                    continue;
                };
                link.execute(params![parent, row.id, conversation_id])
                    .context("linking synced message")?;
                ancestry.link(&row.id, &parent);
                if tail == parent || tail_parent.as_deref() == Some(parent.as_str()) {
                    tail_parent = Some(parent.clone());
                    tail = row.id.clone();
                }
                children.entry(parent).or_default().push(row.id.clone());
            }
        }
        // Follow inserted descendants of the tail, whatever order they arrived
        // in; the newest version wins where the source branched below it.
        let mut visited = std::collections::HashSet::from([tail.clone()]);
        while let Some(next) = children
            .get(&tail)
            .and_then(|ids| ids.last())
            .filter(|id| visited.insert((*id).clone()))
        {
            tail = next.clone();
        }
        if tail != leaf {
            tx.execute(
                "UPDATE conversations SET active_leaf_message_id = ?1 WHERE id = ?2",
                params![tail, conversation_id],
            )
            .context("advancing leaf to synced thread")?;
        }
        tx.commit().context("committing sync link")?;
        Ok(())
    }
}
