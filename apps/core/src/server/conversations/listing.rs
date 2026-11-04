//! Conversation and run listings, visibility-scoped id sets and summaries.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// List conversations, most-recently-updated first. **Unfiltered** — every row
    /// on the node. Kept for the in-process callers that legitimately need the full
    /// set (sync replay, the learning pass, the MCP `threads` tool). Any HTTP
    /// handler serving a remote caller must use [`Self::list_conversations_visible`].
    pub async fn list_conversations(&self) -> Result<Vec<ConversationSummary>> {
        self.list_summaries("", TenancyFilter::unrestricted()).await
    }

    /// List conversations this caller may READ, filtered in SQL.
    ///
    /// Replaces the handler-side N+1 (`get_access_meta` per row, each taking the
    /// store mutex) with one query whose `WHERE` mirrors `resource_access`
    /// (`server/mod.rs`) exactly. On an org-bound node an anonymous caller gets an
    /// empty list rather than every user's chat titles.
    pub async fn list_conversations_visible(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
    ) -> Result<Vec<ConversationSummary>> {
        self.list_conversations_visible_for_teams(owner_user_id, org_id, node_bound, None)
            .await
    }

    /// Team-aware variant used by authenticated HTTP callers. `team_ids_json`
    /// must contain only signature-verified team ids narrowed to the node org.
    pub async fn list_conversations_visible_for_teams(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
        team_ids_json: Option<&str>,
    ) -> Result<Vec<ConversationSummary>> {
        self.list_summaries(
            "",
            TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, team_ids_json),
        )
        .await
    }

    /// [`Self::list_conversations_visible`] with the newest message of each row
    /// attached (`last_message` / `last_message_role` / `last_message_at`). Serves
    /// `GET /api/conversations?preview=1`, which the desktop calls only while the
    /// messaging-style sidebar is switched on.
    pub async fn list_conversations_visible_with_preview(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
    ) -> Result<Vec<ConversationSummary>> {
        self.list_conversations_visible_with_preview_for_teams(
            owner_user_id,
            org_id,
            node_bound,
            None,
        )
        .await
    }

    /// Preview variant with the same verified team-membership boundary as the
    /// summary list. The SQL gate runs before any newest-message content is opened.
    pub async fn list_conversations_visible_with_preview_for_teams(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
        team_ids_json: Option<&str>,
    ) -> Result<Vec<ConversationSummary>> {
        self.list_summaries_inner(
            "",
            TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, team_ids_json),
            true,
            None,
        )
        .await
    }

    /// List conversations that have an active or recently-finished run (i.e.
    /// run_status is not NULL), ordered most-recently-updated first.  Used by
    /// the background-runs view (issue #128) and the sidebar runs section.
    /// **Unfiltered** — see [`Self::list_runs_visible`] for the caller-scoped form.
    pub async fn list_runs(&self) -> Result<Vec<ConversationSummary>> {
        self.list_summaries(
            "AND c.run_status IS NOT NULL",
            TenancyFilter::unrestricted(),
        )
        .await
    }

    /// The tenancy-filtered twin of [`Self::list_runs`] — used by `GET /api/runs`
    /// and the `/api/runs/stream` opening snapshot, which otherwise fan out every
    /// run on the node to every holder of the node token.
    pub async fn list_runs_visible(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
    ) -> Result<Vec<ConversationSummary>> {
        self.list_runs_visible_for_teams(owner_user_id, org_id, node_bound, None)
            .await
    }

    /// Team-aware variant of [`Self::list_runs_visible`].
    pub async fn list_runs_visible_for_teams(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
        team_ids_json: Option<&str>,
    ) -> Result<Vec<ConversationSummary>> {
        self.list_summaries(
            "AND c.run_status IS NOT NULL",
            TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, team_ids_json),
        )
        .await
    }

    /// The ids of every conversation this caller may READ. Feeds the
    /// `conversation_ids` filter that [`Self::search_messages`] /
    /// [`Self::fts_search_messages`] already accept, so semantic search can never
    /// return a snippet from someone else's chat.
    pub async fn visible_conversation_ids(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
    ) -> Result<Vec<String>> {
        self.visible_conversation_ids_for_teams(owner_user_id, org_id, node_bound, None)
            .await
    }

    /// Team-aware variant used before semantic search builds its conversation id
    /// intersection. Without this boundary, search could expose a team preview
    /// even when the sidebar list was correctly filtered.
    pub async fn visible_conversation_ids_for_teams(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
        team_ids_json: Option<&str>,
    ) -> Result<Vec<String>> {
        let filter =
            TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, team_ids_json);
        // Newest first, so a caller that must bound the set (the ext-proxy's
        // caller resource scope) keeps the most recently active conversations.
        let sql = format!(
            "SELECT c.id FROM conversations c WHERE {TENANCY_VISIBLE_PREDICATE}
             ORDER BY c.updated_at DESC, c.id ASC"
        );
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json,
            },
            |row| row.get::<_, String>(0),
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// The conversations this caller may READ, each paired with its source
    /// version: a short digest of the row's immutable identity (id, creation
    /// time, owner, org). Feeds the ext-proxy's `caller_resource_scope`, so a
    /// derived index can tell a conversation from a later one RE-CREATED under
    /// the same id (after the original was deleted) and never serve the old
    /// conversation's derived data to the new one's readers. Newest first, like
    /// [`Self::visible_conversation_ids_for_teams`].
    pub async fn visible_conversation_versions_for_teams(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
        team_ids_json: Option<&str>,
    ) -> Result<Vec<(String, String)>> {
        let filter =
            TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, team_ids_json);
        let sql = format!(
            "SELECT c.id, c.created_at, c.owner_user_id, c.org_id
             FROM conversations c WHERE {TENANCY_VISIBLE_PREDICATE}
             ORDER BY c.updated_at DESC, c.id ASC"
        );
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json,
            },
            |row| {
                let id: String = row.get(0)?;
                let created_at: i64 = row.get(1)?;
                let owner: Option<String> = row.get(2)?;
                let org: Option<String> = row.get(3)?;
                let version =
                    conversation_source_version(&id, created_at, owner.as_deref(), org.as_deref());
                Ok((id, version))
            },
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Shared body of the conversation-summary listings. `extra` is an additional
    /// `AND …` clause appended to the tenancy predicate.
    pub(super) async fn list_summaries(
        &self,
        extra: &str,
        filter: TenancyFilter<'_>,
    ) -> Result<Vec<ConversationSummary>> {
        self.list_summaries_inner(extra, filter, false, None).await
    }

    /// One visible conversation's summary, read with the same query and access
    /// predicate as [`Self::list_conversations_visible`] but for a single id, so
    /// a caller that needs one row does not list (and decrypt) every chat.
    pub async fn get_summary_visible(
        &self,
        conversation_id: &str,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
    ) -> Result<Option<ConversationSummary>> {
        let filter = TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, None);
        Ok(self
            .list_summaries_inner("", filter, false, Some(conversation_id))
            .await?
            .into_iter()
            .next())
    }

    /// Every conversation's sync revision (see the `sync_rev` migration). A
    /// revision changes whenever anything a cloud sync payload carries changes,
    /// and never repeats for an id, so equal values mean nothing to push.
    pub async fn sync_revisions(&self) -> Result<std::collections::HashMap<String, i64>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT id, sync_rev FROM conversations")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let mut out = std::collections::HashMap::new();
        for row in rows {
            let (id, rev) = row?;
            out.insert(id, rev);
        }
        Ok(out)
    }

    /// One conversation's summary, **unfiltered** like [`Self::list_conversations`].
    /// For in-process callers that already checked access and need a single row,
    /// so they do not list (and decrypt) every chat on the node to find it.
    pub async fn get_summary(&self, conversation_id: &str) -> Result<Option<ConversationSummary>> {
        Ok(self
            .list_summaries_inner(
                "",
                TenancyFilter::unrestricted(),
                false,
                Some(conversation_id),
            )
            .await?
            .into_iter()
            .next())
    }

    /// [`Self::list_summaries`] plus the newest message of each row. Separate
    /// entry point rather than a default argument because the preview costs two
    /// correlated subqueries and one decrypt per row, and only the messaging-style
    /// sidebar wants it — `list_runs`, sync replay and the learning pass must not
    /// start paying for it.
    pub(super) async fn list_summaries_inner(
        &self,
        extra: &str,
        filter: TenancyFilter<'_>,
        with_preview: bool,
        // Restrict to one conversation; bound as a parameter, never spliced.
        only_id: Option<&str>,
    ) -> Result<Vec<ConversationSummary>> {
        // Both subqueries ride `idx_messages_conversation (conversation_id,
        // created_at)`, so each is an index seek to the tail of one conversation.
        // Only conversational turns preview. In-process writes are user/assistant
        // only, but sync replay and thread import copy a peer's `role` verbatim, and
        // a tool/system row surfacing as an agent's "last message" reads as a bug.
        let preview_cols = if with_preview {
            ",
                    (SELECT m.content FROM messages m WHERE m.conversation_id = c.id
                      AND m.role IN ('user', 'assistant')
                      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1),
                    (SELECT m.role FROM messages m WHERE m.conversation_id = c.id
                      AND m.role IN ('user', 'assistant')
                      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1),
                    (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id
                      AND m.role IN ('user', 'assistant')
                      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1)"
        } else {
            ""
        };
        let sql = format!(
            "SELECT c.id, c.title, c.agent_id, c.created_at, c.updated_at,
                    c.message_count,
                    c.folder_path, c.branch, c.worktree_path, c.run_status,
                    c.participants, c.pinned, c.archived, c.icon, c.visibility,
                    {HIERARCHY_SELECT}, c.linked_pull_requests{preview_cols},
                    c.continued_on
             FROM conversations c
             WHERE {TENANCY_VISIBLE_PREDICATE} AND (:only_id IS NULL OR c.id = :only_id) {extra}
             ORDER BY c.updated_at DESC"
        );
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json,
                ":only_id": only_id,
            },
            |row| {
                let participants_json: Option<String> = row.get(10)?;
                let participants = parse_participants_json(participants_json.as_deref());
                let icon_raw: Option<String> = row.get(13)?;
                // Still sealed here — decrypted below, once the db lock is out of
                // the way, exactly like `title`.
                let linked_at = 15 + HIERARCHY_COLUMN_COUNT;
                let linked_pull_requests =
                    parse_participants_json(row.get::<_, Option<String>>(linked_at)?.as_deref());
                let preview_at = linked_at + 1;
                let (last_message, last_message_role, last_message_at) = if with_preview {
                    (
                        row.get(preview_at)?,
                        row.get(preview_at + 1)?,
                        row.get(preview_at + 2)?,
                    )
                } else {
                    (None, None, None)
                };
                Ok(ConversationSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    agent_id: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    message_count: row.get(5)?,
                    folder_path: row.get(6)?,
                    branch: row.get(7)?,
                    worktree_path: row.get(8)?,
                    run_status: row.get(9)?,
                    participants,
                    pinned: row.get::<_, i64>(11)? != 0,
                    archived: row.get::<_, i64>(12)? != 0,
                    linked_pull_requests,
                    icon: icon_raw.and_then(|s| serde_json::from_str(&s).ok()),
                    visibility: row.get(14)?,
                    last_message,
                    last_message_role,
                    last_message_at,
                    hierarchy: hierarchy_from_row(row, 15)?,
                    continued_on: row
                        .get::<_, Option<String>>(preview_at + if with_preview { 3 } else { 0 })?
                        .and_then(|raw| serde_json::from_str(&raw).ok()),
                })
            },
        )?;
        let mut out = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        drop(conn);
        for summary in &mut out {
            summary.title = self.open_opt(summary.title.take());
            summary.last_message = summary
                .last_message
                .take()
                .map(|sealed| preview_line(&self.open_content(sealed)));
        }
        Ok(out)
    }
}
