//! Legacy sessions and the versioned harness session projection.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    // ── Session methods ──────────────────────────────────────────────────────

    /// Create a new Session bound to a Runnable, reusing the existing
    /// conversation create path. The conversation is upserted via
    /// [`Self::ensure_conversation`] so no message data is duplicated.
    pub async fn create_session(
        &self,
        runnable_id: &str,
        runnable_kind: RunnableKind,
        agent_id: Option<&str>,
        title: Option<&str>,
        tenancy: Tenancy,
    ) -> Result<Session> {
        let session_id = format!("sess_{}", uuid::Uuid::new_v4().simple());
        let conversation_id = format!("conv_{}", uuid::Uuid::new_v4().simple());
        let now = now_millis();

        // Reuse the existing conversation create path — no duplicate message store.
        let title = self.seal_opt(title)?;
        {
            let conn = self.conn.lock().await;
            upsert_conversation_row(
                &conn,
                &conversation_id,
                now,
                &tenancy,
                &ConvRow {
                    title: title.as_deref(),
                    agent_id,
                    ..ConvRow::default()
                },
                Touch::Keep,
            )
            .context("creating conversation for session")?;

            conn.execute(
                "INSERT INTO sessions (id, conversation_id, runnable_id, runnable_kind, status,
                 execution_profile, parent_session_id, native_session_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?7)",
                params![
                    session_id,
                    conversation_id,
                    runnable_id,
                    runnable_kind.as_str(),
                    SessionStatus::Idle.as_str(),
                    serde_json::to_string(&ExecutionProfile::default())?,
                    now,
                ],
            )
            .context("inserting session")?;
        }

        Ok(Session {
            id: session_id,
            conversation_id,
            runnable_id: runnable_id.to_string(),
            runnable_kind,
            status: SessionStatus::Idle,
            execution_profile: ExecutionProfile::default(),
            parent_session_id: None,
            native_session_id: None,
            created_at: now,
            updated_at: now,
        })
    }

    /// Load a session by id.
    pub async fn get_session(&self, session_id: &str) -> Result<Option<Session>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, runnable_id, runnable_kind, status,
                    execution_profile, parent_session_id, native_session_id,
                    created_at, updated_at
             FROM sessions WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
            ))
        })?;
        match rows.next() {
            None => Ok(None),
            Some(row) => {
                let (
                    id,
                    conversation_id,
                    runnable_id,
                    runnable_kind_str,
                    status_str,
                    execution_profile_json,
                    parent_session_id,
                    native_session_id,
                    created_at,
                    updated_at,
                ) = row?;
                let runnable_kind = parse_runnable_kind(&runnable_kind_str);
                Ok(Some(Session {
                    id,
                    conversation_id,
                    runnable_id,
                    runnable_kind,
                    status: SessionStatus::from_str(&status_str),
                    execution_profile: parse_execution_profile(&execution_profile_json),
                    parent_session_id,
                    native_session_id,
                    created_at,
                    updated_at,
                }))
            }
        }
    }

    /// Update the status of a session.
    pub async fn update_session_status(
        &self,
        session_id: &str,
        status: SessionStatus,
    ) -> Result<bool> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE sessions SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status.as_str(), now, session_id],
        )?;
        Ok(updated > 0)
    }

    /// List sessions for a conversation, most-recently-updated first.
    pub async fn list_sessions_for_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<Session>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, runnable_id, runnable_kind, status,
                    execution_profile, parent_session_id, native_session_id,
                    created_at, updated_at
             FROM sessions WHERE conversation_id = ?1
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([conversation_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (
                id,
                conversation_id,
                runnable_id,
                runnable_kind_str,
                status_str,
                execution_profile_json,
                parent_session_id,
                native_session_id,
                created_at,
                updated_at,
            ) = row?;
            let runnable_kind = parse_runnable_kind(&runnable_kind_str);
            out.push(Session {
                id,
                conversation_id,
                runnable_id,
                runnable_kind,
                status: SessionStatus::from_str(&status_str),
                execution_profile: parse_execution_profile(&execution_profile_json),
                parent_session_id,
                native_session_id,
                created_at,
                updated_at,
            });
        }
        Ok(out)
    }

    /// List active Runnable sessions visible to this caller, newest activity
    /// first. The cap bounds the model-facing session roster.
    pub async fn list_running_sessions_visible(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
        limit: usize,
    ) -> Result<Vec<Session>> {
        let filter = TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, None);
        let limit = limit.clamp(1, 100);
        let sql = format!(
            "SELECT s.id, s.conversation_id, s.runnable_id, s.runnable_kind, s.status,
                    s.execution_profile, s.parent_session_id, s.native_session_id,
                    s.created_at, s.updated_at
             FROM sessions s
             JOIN conversations c ON c.id = s.conversation_id
             WHERE s.status = 'running' AND {TENANCY_VISIBLE_PREDICATE}
             ORDER BY s.updated_at DESC
             LIMIT :limit"
        );
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json,
                ":limit": limit as i64,
            },
            |row| {
                let runnable_kind = parse_runnable_kind(&row.get::<_, String>(3)?);
                let status = SessionStatus::from_str(&row.get::<_, String>(4)?);
                let execution_profile = parse_execution_profile(&row.get::<_, String>(5)?);
                Ok(Session {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    runnable_id: row.get(2)?,
                    runnable_kind,
                    status,
                    execution_profile,
                    parent_session_id: row.get(6)?,
                    native_session_id: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing visible active sessions")
    }

    // ── Versioned agent harness ─────────────────────────────────────────────

    /// Store the portable execution profile attached to a session. The profile
    /// is intentionally separate from the node's secrets and from Gateway's
    /// effective policy; it records what the caller requested so every host can
    /// render the same run provenance.
    pub async fn set_session_execution_profile(
        &self,
        session_id: &str,
        profile: &ExecutionProfile,
        parent_session_id: Option<&str>,
    ) -> Result<bool> {
        let probe = StartRunRequest {
            input: serde_json::json!({}),
            idempotency_key: None,
            execution_profile: Some(profile.clone()),
            resume_run_id: None,
            multitask_strategy: None,
        };
        validate_start_request(&probe).map_err(anyhow::Error::msg)?;
        let profile_json = serde_json::to_string(profile)?;
        let now = now_millis();
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE sessions
             SET execution_profile = ?1, parent_session_id = ?2, updated_at = ?3
             WHERE id = ?4",
            params![profile_json, parent_session_id, now, session_id],
        )?;
        Ok(updated > 0)
    }

    /// Record the native session id supplied by an external runtime such as
    /// ACP/Codex. This is a projection binding only; the native runtime remains
    /// responsible for the native transcript and its own resume semantics.
    pub async fn set_session_native_id(
        &self,
        session_id: &str,
        native_session_id: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE sessions SET native_session_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![native_session_id, now_millis(), session_id],
        )?;
        Ok(updated > 0)
    }

    /// Convert the legacy session row into the versioned harness projection.
    /// The newest harness run supplies the richer lifecycle when one exists;
    /// otherwise the legacy idle/running/completed/failed state is preserved.
    pub async fn get_harness_session(&self, session_id: &str) -> Result<Option<HarnessSession>> {
        let Some(session) = self.get_session(session_id).await? else {
            return Ok(None);
        };
        // A queued run is newer than the run it waits behind, so the live run
        // (if any) describes the session; otherwise the newest run does.
        let runs = self.list_harness_runs(session_id).await?;
        let status = runs
            .iter()
            .find(|run| {
                matches!(
                    run.status,
                    HarnessRunStatus::Running | HarnessRunStatus::AwaitingApproval
                )
            })
            .or_else(|| runs.first())
            .map(|run| run.status)
            .unwrap_or_else(|| harness_status_from_legacy(&session.status));
        Ok(Some(HarnessSession {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            id: session.id,
            conversation_id: session.conversation_id,
            runnable_id: session.runnable_id,
            runnable_kind: session.runnable_kind.as_str().to_owned(),
            status,
            parent_session_id: session.parent_session_id,
            execution_profile: session.execution_profile,
            native_session_id: session.native_session_id,
            created_at: millis_to_rfc3339(session.created_at),
            updated_at: millis_to_rfc3339(session.updated_at),
        }))
    }

    /// List durable child sessions spawned from a parent session. Child rows
    /// stay independently addressable so they can be resumed or inspected
    /// without copying the parent's transcript.
    pub async fn list_child_harness_sessions(
        &self,
        parent_session_id: &str,
    ) -> Result<Vec<HarnessSession>> {
        let ids = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id FROM sessions WHERE parent_session_id = ?1
                 ORDER BY updated_at DESC",
            )?;
            let rows = stmt.query_map(params![parent_session_id], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut children = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(session) = self.get_harness_session(&id).await? {
                children.push(session);
            }
        }
        Ok(children)
    }
}
