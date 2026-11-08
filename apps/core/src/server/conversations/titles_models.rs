//! Titles and their history, model selection history and context handoffs.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Set (or replace) the title of a conversation. The title is sealed at rest
    /// like every other title write. Used by the coordinator `set_thread_title`
    /// tool so an orchestrator can label its worker threads, and by the desktop
    /// manual-rename endpoint.
    ///
    /// This is an explicit, human-driven rename, so it marks the title
    /// `title_custom = 1` — the background auto-namer ([`auto_set_title`]) checks
    /// that flag and never overwrites a title a user (or coordinator) chose.
    pub async fn set_title(&self, conversation_id: &str, title: &str) -> Result<()> {
        let now = now_millis();
        let sealed = self.seal_opt(Some(title))?;
        let mut conn = self.conn.lock().await;
        let transaction = conn.transaction()?;
        transaction.execute(
            "UPDATE conversations SET title = ?1, title_custom = 1, updated_at = ?2 WHERE id = ?3",
            params![sealed, now, conversation_id],
        )
        .context("setting conversation title")?;
        Self::push_title_history_locked(
            &transaction,
            &self.cipher,
            conversation_id,
            title,
            "user",
            now,
        )?;
        transaction
            .commit()
            .context("committing conversation title and history")?;
        Ok(())
    }

    /// Apply an auto-generated title (from the chat-title plugin / background
    /// auto-namer) to a conversation, but **only** when the user hasn't chosen
    /// one themselves (`title_custom = 0`). The guard makes the write a no-op if
    /// a manual rename raced ahead, so an LLM title can never clobber a deliberate
    /// one.
    ///
    /// Unlike [`set_title`] this does NOT set `title_custom` — an auto title stays
    /// replaceable, and a later manual rename still locks it. Returns whether a
    /// row was actually updated.
    pub async fn auto_set_title(&self, conversation_id: &str, title: &str) -> Result<bool> {
        let now = now_millis();
        let sealed = self.seal_opt(Some(title))?;
        let mut conn = self.conn.lock().await;
        let transaction = conn.transaction()?;
        let changed = transaction
            .execute(
                "UPDATE conversations SET title = ?1, updated_at = ?2
                 WHERE id = ?3 AND title_custom = 0",
                params![sealed, now, conversation_id],
            )
            .context("auto-setting conversation title")?;
        if changed > 0 {
            Self::push_title_history_locked(
                &transaction,
                &self.cipher,
                conversation_id,
                title,
                "auto",
                now,
            )?;
        }
        transaction
            .commit()
            .context("committing automatic title and history")?;
        Ok(changed > 0)
    }

    /// Explicitly requested machine rename: unlock the title and record history atomically.
    pub async fn force_set_title(&self, conversation_id: &str, title: &str) -> Result<()> {
        let now = now_millis();
        let sealed = self.seal_opt(Some(title))?;
        let mut conn = self.conn.lock().await;
        let transaction = conn.transaction()?;
        let changed = transaction.execute(
            "UPDATE conversations SET title = ?1, title_custom = 0, updated_at = ?2 WHERE id = ?3",
            params![sealed, now, conversation_id],
        ).context("force-setting conversation title")?;
        anyhow::ensure!(changed > 0, "conversation not found");
        Self::push_title_history_locked(
            &transaction,
            &self.cipher,
            conversation_id,
            title,
            "auto",
            now,
        )?;
        transaction
            .commit()
            .context("committing requested automatic title and history")?;
        Ok(())
    }

    /// Append one title-history row. Titles are sealed at rest like conversation
    /// titles. `source` is a short tag (`"auto"` | `"user"` | `"derived"`).
    pub(super) fn push_title_history_locked(
        conn: &Connection,
        cipher: &ryu_crypto::FieldCipher,
        conversation_id: &str,
        title: &str,
        source: &str,
        created_at: i64,
    ) -> Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        let sealed = cipher.seal(title)?;
        conn.execute(
            "INSERT INTO conversation_title_history
                (id, conversation_id, title, source, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, conversation_id, sealed, source, created_at],
        )
        .context("inserting title history")?;
        Ok(())
    }

    /// Title history for a conversation, oldest → newest (decrypted).
    pub async fn list_title_history(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<TitleHistoryEntry>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT id, title, source, created_at
                 FROM conversation_title_history
                 WHERE conversation_id = ?1
                 ORDER BY created_at ASC, rowid ASC",
            )
            .context("preparing title history query")?;
        let rows = stmt
            .query_map(params![conversation_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .context("querying title history")?;
        let mut out = Vec::new();
        for row in rows {
            let (id, sealed, source, created_at) = row.context("reading title history row")?;
            let title = self
                .cipher
                .open(&sealed)
                .unwrap_or_else(|_| "[unable to decrypt]".to_owned());
            out.push(TitleHistoryEntry {
                id,
                title,
                source,
                created_at,
            });
        }
        Ok(out)
    }

    /// Current decrypted titles for `conversation_ids`, used to label message
    /// search hits. Ids that do not resolve or have no title yet are absent.
    /// This applies no tenancy filter: callers pass only ids they already
    /// limited to conversations the caller may read.
    pub async fn conversation_titles(
        &self,
        conversation_ids: &[String],
    ) -> Result<std::collections::HashMap<String, String>> {
        let mut out = std::collections::HashMap::new();
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare_cached("SELECT title FROM conversations WHERE id = ?1")
            .context("preparing conversation title lookup")?;
        for id in conversation_ids {
            let sealed: Option<Option<String>> = stmt
                .query_row(params![id], |row| row.get(0))
                .optional()
                .context("reading conversation title")?;
            if let Some(title) = self.open_opt(sealed.flatten()) {
                out.insert(id.clone(), title);
            }
        }
        Ok(out)
    }

    /// Provider/model changes are append-only conversation events. The newest
    /// event is also the conversation's current selection, so collaborators
    /// share one durable value without relying on their per-user preferences.
    pub async fn list_model_changes(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<ConversationModelChange>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT sequence, id, selection_kind, provider_id, provider_label, model_id,
                        model_label, changed_by, created_at
                 FROM conversation_model_changes
                 WHERE conversation_id = ?1
                 ORDER BY sequence ASC",
            )
            .context("preparing conversation model history query")?;
        let rows = stmt
            .query_map(params![conversation_id], read_conversation_model_change)
            .context("querying conversation model history")?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("reading conversation model history")
    }

    /// Store a model/provider selection atomically and fan it out to active
    /// conversation collaborators. Replaying the same `id` is idempotent.
    pub async fn record_model_selection(
        &self,
        conversation_id: &str,
        input: ConversationModelSelectionInput,
    ) -> Result<(ConversationModelChange, bool)> {
        let mut conn = self.conn.lock().await;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("starting conversation model-selection transaction")?;

        let existing = tx
            .query_row(
                "SELECT sequence, id, selection_kind, provider_id, provider_label, model_id,
                        model_label, changed_by, created_at
                 FROM conversation_model_changes WHERE id = ?1",
                params![input.id],
                read_conversation_model_change,
            )
            .optional()
            .context("checking idempotent model-selection write")?;
        if let Some(existing) = existing {
            anyhow::ensure!(
                existing.kind == input.kind
                    && existing.provider_id == input.provider_id
                    && existing.provider_label == input.provider_label
                    && existing.model_id == input.model_id
                    && existing.model_label == input.model_label
                    && existing.changed_by == input.changed_by,
                "conversation model-selection id was reused with different data"
            );
            tx.commit()
                .context("committing idempotent model-selection write")?;
            return Ok((existing, false));
        }

        let current = tx
            .query_row(
                "SELECT sequence, id, selection_kind, provider_id, provider_label, model_id,
                        model_label, changed_by, created_at
                 FROM conversation_model_changes
                 WHERE conversation_id = ?1
                 ORDER BY sequence DESC LIMIT 1",
                params![conversation_id],
                read_conversation_model_change,
            )
            .optional()
            .context("reading current conversation model selection")?;
        if let Some(current) = current {
            if current.provider_id == input.provider_id && current.model_id == input.model_id {
                tx.commit()
                    .context("committing unchanged model-selection write")?;
                return Ok((current, false));
            }
        }

        let created_at = now_millis();
        tx.execute(
            "INSERT INTO conversation_model_changes
                (id, conversation_id, selection_kind, provider_id, provider_label, model_id,
                 model_label, changed_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                input.id,
                conversation_id,
                input.kind.as_db_value(),
                input.provider_id,
                input.provider_label,
                input.model_id,
                input.model_label,
                input.changed_by,
                created_at,
            ],
        )
        .context("recording conversation model selection")?;
        let change = ConversationModelChange {
            sequence: tx.last_insert_rowid(),
            id: input.id,
            kind: input.kind,
            provider_id: input.provider_id,
            provider_label: input.provider_label,
            model_id: input.model_id,
            model_label: input.model_label,
            changed_by: input.changed_by,
            created_at,
        };
        tx.commit()
            .context("committing conversation model selection")?;
        drop(conn);

        if let Some(realtime) = &self.realtime {
            realtime.broadcast_event(
                conversation_id,
                "conversation.model-selection",
                serde_json::json!({
                    "type": "modelSelection",
                    "conversationId": conversation_id,
                    "change": change,
                }),
            );
        }
        Ok((change, true))
    }

    /// Every context handoff recorded for a conversation, oldest first.
    pub async fn list_context_handoffs(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<ConversationContextHandoff>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {CONTEXT_HANDOFF_COLUMNS} FROM conversation_context_handoffs
                 WHERE conversation_id = ?1
                 ORDER BY created_at ASC, rowid ASC"
            ))
            .context("preparing context handoff query")?;
        let rows = stmt
            .query_map(params![conversation_id], read_context_handoff_row)
            .context("querying context handoffs")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("reading context handoffs")?;
        drop(stmt);
        drop(conn);
        Ok(rows
            .into_iter()
            .map(|row| self.open_context_handoff(row))
            .collect())
    }

    /// The handoff recorded for one model change on the branch whose history
    /// before it ends at `covered_head_id`, if it was evaluated already.
    pub async fn get_context_handoff(
        &self,
        model_change_id: &str,
        covered_head_id: &str,
    ) -> Result<Option<ConversationContextHandoff>> {
        let conn = self.conn.lock().await;
        let row = conn
            .query_row(
                &format!(
                    "SELECT {CONTEXT_HANDOFF_COLUMNS} FROM conversation_context_handoffs
                     WHERE model_change_id = ?1 AND covered_head_id = ?2"
                ),
                params![model_change_id, covered_head_id],
                read_context_handoff_row,
            )
            .optional()
            .context("reading context handoff")?;
        drop(conn);
        Ok(row.map(|row| self.open_context_handoff(row)))
    }

    /// Record the handoff for a model change on one branch. The summary is sealed
    /// at rest like message content. A second write for the same change and
    /// branch keeps the first (two racing turns must replay one summary) and
    /// returns it.
    pub async fn record_context_handoff(
        &self,
        conversation_id: &str,
        handoff: ConversationContextHandoff,
    ) -> Result<ConversationContextHandoff> {
        let sealed_summary = self.seal_opt(handoff.summary.as_deref())?;
        let conn = self.conn.lock().await;
        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO conversation_context_handoffs
                    (id, conversation_id, model_change_id, outcome, reason, from_model,
                     to_model, from_context, to_context, summarized_count, boundary_at,
                     summary, created_at, covered_head_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    handoff.id,
                    conversation_id,
                    handoff.model_change_id,
                    handoff.outcome.as_db_value(),
                    handoff.reason,
                    handoff.from_model,
                    handoff.to_model,
                    handoff.from_context,
                    handoff.to_context,
                    handoff.summarized_count,
                    handoff.boundary_at,
                    sealed_summary,
                    handoff.created_at,
                    handoff.covered_head_id,
                ],
            )
            .context("recording context handoff")?;
        drop(conn);
        if inserted == 0 {
            return self
                .get_context_handoff(&handoff.model_change_id, &handoff.covered_head_id)
                .await?
                .context("context handoff vanished after a conflicting insert");
        }
        if handoff.outcome == ContextHandoffOutcome::Applied {
            if let Some(realtime) = &self.realtime {
                realtime.broadcast_event(
                    conversation_id,
                    "conversation.context-handoff",
                    serde_json::json!({
                        "type": "contextHandoff",
                        "conversationId": conversation_id,
                        "handoff": handoff,
                    }),
                );
            }
        }
        Ok(handoff)
    }

    pub(super) fn open_context_handoff(
        &self,
        mut row: ConversationContextHandoff,
    ) -> ConversationContextHandoff {
        row.summary = self.open_opt(row.summary);
        row
    }
}
