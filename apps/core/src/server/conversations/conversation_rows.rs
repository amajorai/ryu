//! Creating conversation rows and recording run metadata, agent control and
//! import provenance on them.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Ensure a conversation row exists, creating it on first use. Optionally
    /// records the agent and a title (only set when not already present).
    ///
    /// `tenancy` stamps the row's owner **on creation** (see [`Tenancy`] and the
    /// [`upsert_conversation_row`] choke point). Pass [`Tenancy::Unattributed`] on
    /// an unbound personal node or when the row is already known to exist — the
    /// choke point preserves any owner already stamped.
    pub async fn ensure_conversation(
        &self,
        conversation_id: &str,
        agent_id: Option<&str>,
        title: Option<&str>,
        tenancy: Tenancy,
    ) -> Result<()> {
        self.ensure_conversation_with_generation(conversation_id, agent_id, title, tenancy)
            .await
            .map(|_| ())
    }

    pub async fn ensure_conversation_with_generation(
        &self,
        conversation_id: &str,
        agent_id: Option<&str>,
        title: Option<&str>,
        tenancy: Tenancy,
    ) -> Result<String> {
        let now = now_millis();
        let title = self.seal_opt(title)?;
        let conn = self.conn.lock().await;
        upsert_conversation_row(
            &conn,
            conversation_id,
            now,
            &tenancy,
            &ConvRow {
                title: title.as_deref(),
                agent_id,
                ..ConvRow::default()
            },
            Touch::Keep,
        )?;
        crate::server::conversation_lifecycle::generation(&conn, conversation_id)?
            .context("conversation generation missing")
    }

    /// Insert a conversation received through a continuity/sync boundary without
    /// mutating an existing row. Metadata convergence is handled separately by
    /// `update_metadata_if_newer`; keeping conflict handling insert-only prevents
    /// a stale payload from replacing the active agent before its timestamp is
    /// considered.
    pub async fn ensure_sync_conversation(
        &self,
        conversation_id: &str,
        agent_id: Option<&str>,
        title: Option<&str>,
        created_at: i64,
        updated_at: i64,
        tenancy: Tenancy,
    ) -> Result<()> {
        let title = self.seal_opt(title)?;
        let conn = self.conn.lock().await;
        insert_conversation_row(
            &conn,
            conversation_id,
            updated_at,
            &tenancy,
            &ConvRow {
                title: title.as_deref(),
                agent_id,
                created_at: Some(created_at),
                updated_at: Some(updated_at),
                ..ConvRow::default()
            },
            Touch::Keep,
            ConversationConflict::Ignore,
        )
    }

    /// Ensure a channel-originated conversation exists with stable source
    /// metadata. On an org-bound node the row is shared with the organization
    /// without assigning it to a human owner; on an unbound node it preserves
    /// the local single-user behavior.
    pub async fn ensure_channel_conversation(
        &self,
        conversation_id: &str,
        channel_id: &str,
        agent_id: Option<&str>,
        org_id: Option<&str>,
    ) -> Result<()> {
        let tenancy = org_id
            .map(Tenancy::shared_with_org)
            .unwrap_or(Tenancy::Unattributed);
        let conn = self.conn.lock().await;
        upsert_conversation_row(
            &conn,
            conversation_id,
            now_millis(),
            &tenancy,
            &ConvRow {
                agent_id,
                channel_id: Some(channel_id),
                visibility: org_id.map(|_| "org"),
                ..ConvRow::default()
            },
            Touch::Keep,
        )
    }

    /// Persist the active agent for a conversation after an agent-level handoff.
    /// Participants remain recorded separately so the previous agent is still a
    /// valid caller for conversation-scoped tools during the same thread.
    pub async fn set_active_agent(&self, conversation_id: &str, agent_id: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations SET agent_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![conversation_id, agent_id, now_millis()],
        )
        .context("setting active conversation agent")?;
        Ok(())
    }

    /// Record run metadata (folder_path, branch, worktree_path) on the
    /// conversation row at run start. Call after `ensure_conversation` so the
    /// row is guaranteed to exist.
    pub async fn set_run_metadata(
        &self,
        conversation_id: &str,
        folder_path: Option<&str>,
        branch: Option<&str>,
        worktree_path: Option<&str>,
    ) -> Result<()> {
        // Normalised here because this is the ONE write path for `folder_path`,
        // and its callers are three different producers of the same string: a
        // native run (the desktop's picked folder), a thread import (Claude
        // Code's / Codex's recorded `cwd`), and the threads MCP. Clients group
        // conversations into project folders by this value, so a lone trailing
        // separator from any one of them showed up as a second project folder
        // with the same name.
        let folder_path = folder_path.map(normalize_folder_path);
        let worktree_path = worktree_path.map(normalize_folder_path);
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations
             SET folder_path  = COALESCE(?2, folder_path),
                 branch       = COALESCE(?3, branch),
                 worktree_path = COALESCE(?4, worktree_path)
             WHERE id = ?1",
            params![
                conversation_id,
                folder_path.as_deref(),
                branch,
                worktree_path.as_deref()
            ],
        )
        .context("setting run metadata")?;
        Ok(())
    }

    /// Whether an agent is already participating in a conversation. Agent-plane
    /// tools use this as their conversation boundary: the caller identity comes
    /// from Core's ACP/MCP bridge, never from tool arguments.
    pub async fn is_conversation_agent(
        &self,
        conversation_id: &str,
        agent_id: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let row: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT agent_id, participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .context("checking conversation agent membership")?;
        let Some((primary_agent_id, participants_json)) = row else {
            return Ok(false);
        };
        if primary_agent_id.as_deref() == Some(agent_id) {
            return Ok(true);
        }
        Ok(parse_participants_json(participants_json.as_deref())
            .iter()
            .any(|participant| participant == agent_id))
    }

    /// Store or merge a next-turn agent control. A second partial request in the
    /// same turn fills another field rather than discarding the first request.
    pub async fn set_pending_agent_control(
        &self,
        conversation_id: &str,
        control: &crate::agent_control::PendingAgentControl,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO agent_controls
                 (conversation_id, requested_by, agent_id, model, effort, requested_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(conversation_id) DO UPDATE SET
                 requested_by = excluded.requested_by,
                 agent_id = COALESCE(excluded.agent_id, agent_controls.agent_id),
                 model = COALESCE(excluded.model, agent_controls.model),
                 effort = COALESCE(excluded.effort, agent_controls.effort),
                 requested_at = excluded.requested_at",
            params![
                conversation_id,
                control.requested_by,
                control
                    .patch
                    .clear_agent_id
                    .then_some(crate::agent_control::CLEAR_SENTINEL)
                    .or(control.patch.agent_id.as_deref()),
                control
                    .patch
                    .clear_model
                    .then_some(crate::agent_control::CLEAR_SENTINEL)
                    .or(control.patch.model.as_deref()),
                control
                    .patch
                    .clear_effort
                    .then_some(crate::agent_control::CLEAR_SENTINEL)
                    .or(control.patch.effort.as_deref()),
                control.requested_at,
            ],
        )
        .context("setting pending agent control")?;
        Ok(())
    }

    /// Atomically consume the pending control for the next user turn.
    pub async fn take_pending_agent_control(
        &self,
        conversation_id: &str,
    ) -> Result<Option<crate::agent_control::PendingAgentControl>> {
        let mut conn = self.conn.lock().await;
        let tx = conn
            .transaction()
            .context("starting agent control transaction")?;
        let row: Option<(String, Option<String>, Option<String>, Option<String>, i64)> = tx
            .query_row(
                "SELECT requested_by, agent_id, model, effort, requested_at
                 FROM agent_controls WHERE conversation_id = ?1",
                params![conversation_id],
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
            .context("reading pending agent control")?;
        let Some((requested_by, agent_id, model, effort, requested_at)) = row else {
            tx.commit()
                .context("committing empty agent control transaction")?;
            return Ok(None);
        };
        tx.execute(
            "DELETE FROM agent_controls WHERE conversation_id = ?1",
            params![conversation_id],
        )
        .context("consuming pending agent control")?;
        tx.commit().context("committing consumed agent control")?;
        let decode = |value: Option<String>| {
            if value.as_deref() == Some(crate::agent_control::CLEAR_SENTINEL) {
                (None, true)
            } else {
                (value, false)
            }
        };
        let (agent_id, clear_agent_id) = decode(agent_id);
        let (model, clear_model) = decode(model);
        let (effort, clear_effort) = decode(effort);
        Ok(Some(crate::agent_control::PendingAgentControl {
            patch: crate::agent_control::AgentControlPatch {
                agent_id,
                clear_agent_id,
                model,
                clear_model,
                effort,
                clear_effort,
            },
            requested_by,
            requested_at,
        }))
    }

    /// Record that a conversation was imported from an agent's native history
    /// store: `origin` (e.g. `import:claude`) and the agent-native `session_id`.
    /// Call after the conversation row exists. Callers dedup on
    /// [`find_imported_conversation`] before creating, so a re-import returns the
    /// existing conversation rather than writing a duplicate.
    pub async fn set_import_source(
        &self,
        conversation_id: &str,
        origin: &str,
        native_session_id: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations
             SET origin = ?2, native_session_id = ?3
             WHERE id = ?1",
            params![conversation_id, origin, native_session_id],
        )
        .context("setting import source")?;
        Ok(())
    }

    /// Find an already-imported conversation by its import origin + agent-native
    /// session id, so a repeat import focuses the existing thread instead of
    /// creating a duplicate. Returns `None` when nothing matches (or the source
    /// thread carried no native session id to key on). Candidate rows are limited
    /// to the same owner and organization pair as the requested tenancy, so a
    /// human or sync service cannot reuse another scope.
    pub async fn find_imported_conversation(
        &self,
        origin: &str,
        native_session_id: &str,
        tenancy: &Tenancy,
    ) -> Result<Option<String>> {
        Ok(self
            .find_imported_conversation_with_generation(origin, native_session_id, tenancy)
            .await?
            .map(|(id, _)| id))
    }

    pub async fn find_imported_conversation_with_generation(
        &self,
        origin: &str,
        native_session_id: &str,
        tenancy: &Tenancy,
    ) -> Result<Option<(String, String)>> {
        let (owner_user_id, org_id) = tenancy.parts();
        let conn = self.conn.lock().await;
        let id = conn
            .query_row(
                "SELECT c.id, g.generation FROM conversations c JOIN conversation_generations g ON g.conversation_id = c.id
                 WHERE origin = ?1 AND native_session_id = ?2
                   AND owner_user_id IS ?3 AND org_id IS ?4
                 ORDER BY updated_at DESC LIMIT 1",
                params![origin, native_session_id, owner_user_id, org_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .context("looking up imported conversation")?;
        Ok(id)
    }
}
