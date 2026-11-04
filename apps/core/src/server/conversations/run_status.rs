//! Run status reads and writes, including the terminal-run retry claim.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Update the run_status column of a conversation.
    pub async fn set_run_status(&self, conversation_id: &str, status: &str) -> Result<()> {
        let now = now_millis();
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE conversations SET run_status = ?1, updated_at = ?2 WHERE id = ?3",
                params![status, now, conversation_id],
            )
            .context("setting run status")?;
        }
        // Fan out the lifecycle change to live `/api/runs/stream` subscribers so
        // the desktop can replace its 3s poll. A publish with no listeners is a
        // harmless no-op, and a summary-load failure must never fail the caller —
        // the status write already succeeded.
        if let Ok(Some(run)) = self.run_summary(conversation_id).await {
            let _ = run_events_sender().send(RunStatusEvent { run });
        }
        Ok(())
    }

    /// Whether a turn is running in this conversation, whatever its provider:
    /// the conversation's own `run_status` is `running`, or one of its
    /// sessions is. Same rule as [`Self::get_run_status_visible`], without the
    /// tenancy filter, for callers that already passed an access check.
    pub async fn is_run_running(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT EXISTS (
                 SELECT 1 FROM conversations c
                 WHERE c.id = ?1 AND c.run_status = 'running'
             ) OR EXISTS (
                 SELECT 1 FROM sessions s
                 WHERE s.conversation_id = ?1 AND s.status = 'running'
             )",
            params![conversation_id],
            |row| row.get::<_, bool>(0),
        )
        .context("reading conversation run status")
    }

    /// Return a visible conversation's run status without loading its transcript.
    /// `None` means the conversation is missing or not visible; `Some(None)` means
    /// it exists and is visible, but no run status is recorded.
    pub async fn get_run_status_visible(
        &self,
        conversation_id: &str,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
    ) -> Result<Option<Option<String>>> {
        let filter = TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, None);
        let sql = format!(
            "SELECT CASE
                 WHEN EXISTS (
                     SELECT 1 FROM sessions s
                     WHERE s.conversation_id = c.id AND s.status = 'running'
                 ) THEN 'running'
                 ELSE c.run_status
             END
             FROM conversations c
             WHERE c.id = :id AND {TENANCY_VISIBLE_PREDICATE}"
        );
        let conn = self.conn.lock().await;
        conn.query_row(
            &sql,
            named_params! {
                ":id": conversation_id,
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json,
            },
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .context("reading visible conversation run status")
    }

    /// Return a session's status only when its conversation is visible to the
    /// caller. The access predicate and status read share one SQL statement.
    pub async fn get_session_status_visible(
        &self,
        session_id: &str,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
    ) -> Result<Option<String>> {
        let filter = TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, None);
        let sql = format!(
            "SELECT s.status FROM sessions s
             JOIN conversations c ON c.id = s.conversation_id
             WHERE s.id = :id AND {TENANCY_VISIBLE_PREDICATE}"
        );
        let conn = self.conn.lock().await;
        conn.query_row(
            &sql,
            named_params! {
                ":id": session_id,
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json,
            },
            |row| row.get::<_, String>(0),
        )
        .optional()
        .context("reading visible session status")
    }

    /// Interrupt active chat records at the same time Core cancels their agents.
    /// Keep the message flags, run state and durable harness events on the same
    /// SQLite transaction path as boot recovery, then publish each live summary.
    pub async fn interrupt_running_conversations(&self) -> Result<usize> {
        let mut conn = self.conn.lock().await;
        let conversation_ids = {
            let mut statement =
                conn.prepare("SELECT id FROM conversations WHERE run_status = 'running'")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let (interrupted, _) = Self::reconcile_interrupted_runs(&mut conn, &self.cipher)?;
        drop(conn);

        for conversation_id in &conversation_ids {
            if let Ok(Some(run)) = self.run_summary(conversation_id).await {
                let _ = run_events_sender().send(RunStatusEvent { run });
            }
        }
        Ok(interrupted)
    }

    /// Load one run summary for a caller that has already passed the conversation
    /// ACL. This keeps retry and other lifecycle endpoints from having to scan the
    /// entire run list just to inspect one conversation.
    pub async fn get_run_summary(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ConversationSummary>> {
        self.run_summary(conversation_id).await
    }

    /// Atomically claim a terminal run for one bounded reconnect retry.
    ///
    /// The caller must perform the conversation ACL before invoking this method.
    /// The conditional update is the duplicate-work guard: two desktop windows
    /// reconnecting at the same time can race, but only the first one changes the
    /// terminal status to `running` and receives `true`.
    pub async fn claim_terminal_run_for_retry(&self, conversation_id: &str) -> Result<bool> {
        let now = now_millis();
        let claimed = {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE conversations
                 SET run_status = 'running', updated_at = ?1
                 WHERE id = ?2 AND run_status IN ('failed', 'interrupted')",
                params![now, conversation_id],
            )? == 1
        };
        if claimed {
            // A publish with no listeners is harmless; the status write remains the
            // source of truth if a client subscribes after this point.
            if let Ok(Some(run)) = self.run_summary(conversation_id).await {
                let _ = run_events_sender().send(RunStatusEvent { run });
            }
        }
        Ok(claimed)
    }

    /// Load a single conversation's run summary by id. Used to publish a complete
    /// [`RunStatusEvent`] on every status change. Returns `None` if the row is gone.
    pub(super) async fn run_summary(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ConversationSummary>> {
        let summary = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT c.id, c.title, c.agent_id, c.created_at, c.updated_at,
                        c.message_count,
                        c.folder_path, c.branch, c.worktree_path, c.run_status,
                        c.participants, c.pinned, c.archived, c.icon, c.visibility,
                        c.project_id, c.thread_role, c.owner_kind, c.owner_id,
                        c.coordination, c.spawned_by_conversation_id, c.spawned_by_message_id,
                        c.linked_pull_requests
                 FROM conversations c
                 WHERE c.id = ?1",
            )?;
            stmt.query_row(params![conversation_id], |row| {
                let participants_json: Option<String> = row.get(10)?;
                let participants = parse_participants_json(participants_json.as_deref());
                let icon_raw: Option<String> = row.get(13)?;
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
                    linked_pull_requests: parse_participants_json(
                        row.get::<_, Option<String>>(15 + HIERARCHY_COLUMN_COUNT)?
                            .as_deref(),
                    ),
                    icon: icon_raw.and_then(|s| serde_json::from_str(&s).ok()),
                    visibility: row.get(14)?,
                    last_message: None,
                    last_message_role: None,
                    last_message_at: None,
                    hierarchy: hierarchy_from_row(row, 15)?,
                    continued_on: None,
                })
            })
            .optional()?
        };
        // Decrypt the title after the connection lock is released (uses the cipher,
        // not the db), matching the pattern in `list_runs`.
        Ok(summary.map(|mut s| {
            s.title = self.open_opt(s.title);
            s
        }))
    }
}
