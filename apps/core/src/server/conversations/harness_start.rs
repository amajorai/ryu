//! Starting a harness run: validation, idempotency and multitask strategy.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// A newly-created idempotent harness run. `created = false` means the
    /// caller must attach to the existing run and must not dispatch a duplicate.
    ///
    /// The request's [`MultitaskStrategy`] decides what happens while the
    /// session already has an active (or queued) run:
    /// - `reject` fails with an "active run" / "queued run" conflict;
    /// - `enqueue` persists the run as `pending` at the back of the queue;
    /// - `interrupt` / `rollback` persist it as `pending` ahead of enqueued runs
    ///   and name the active run in [`HarnessRunStart::displaced_run_id`] so the
    ///   caller can stop it. A rollback also records which run's turns to remove
    ///   when it is promoted ([`Self::promote_next_harness_run`]).
    ///
    /// A `pending` run's first event is `run_queued`; `run_started` and
    /// `input_accepted` are appended when it is promoted.
    pub async fn start_harness_run(
        &self,
        session_id: &str,
        request: &StartRunRequest,
    ) -> Result<HarnessRunStart> {
        validate_start_request(request).map_err(anyhow::Error::msg)?;
        let Some(session) = self.get_session(session_id).await? else {
            anyhow::bail!("session '{session_id}' not found");
        };
        let profile = request
            .execution_profile
            .clone()
            .unwrap_or_else(|| session.execution_profile.clone());
        let input = serde_json::to_string(&request.input)?;
        let sealed_input = self.cipher.seal(&input)?;
        let idempotency_key = request
            .idempotency_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_owned);
        let input_hash = ryu_tracing::hash_args(&request.input);
        let message_count = harness_message_count(&request.input);
        let strategy = request.multitask_strategy.unwrap_or_default();
        let stored_strategy = request
            .multitask_strategy
            .filter(|value| *value != MultitaskStrategy::Reject);
        let now = now_millis();
        let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
        let profile_json = serde_json::to_string(&profile)?;
        let parent_run_id = request.resume_run_id.clone();
        let created_at = millis_to_rfc3339(now);
        let (new_run, existing_id) = {
            let mut conn = self.conn.lock().await;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            let existing_id: Option<String> = if let Some(key) = idempotency_key.as_deref() {
                let existing: Option<(String, String, String, Option<String>)> = tx
                    .query_row(
                        "SELECT id, input_json, execution_profile, parent_run_id
                     FROM harness_runs
                     WHERE session_id = ?1 AND idempotency_key = ?2",
                        params![session_id, key],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?;
                if let Some((existing_id, existing_input, existing_profile, existing_parent)) =
                    existing
                {
                    let existing_input = self.cipher.open(&existing_input)?;
                    if !same_harness_input(&existing_input, &request.input)
                        || !same_execution_profile(&existing_profile, &profile)
                        || existing_parent != parent_run_id
                    {
                        anyhow::bail!(
                            "idempotency_key '{key}' was already used with a different request"
                        );
                    }
                    Some(existing_id)
                } else {
                    None
                }
            } else {
                None
            };
            if let Some(existing_id) = existing_id {
                drop(tx);
                drop(conn);
                (None, Some(existing_id))
            } else {
                let active: Option<(String, String)> = tx
                    .query_row(
                        "SELECT id, status FROM harness_runs
                         WHERE session_id = ?1
                           AND status IN ('running', 'awaiting_approval')
                         ORDER BY created_at DESC LIMIT 1",
                        params![session_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let queued: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM harness_runs
                     WHERE session_id = ?1 AND status = 'pending'",
                    params![session_id],
                    |row| row.get(0),
                )?;
                if strategy == MultitaskStrategy::Reject {
                    if let Some((active_id, active_status)) = active.as_ref() {
                        anyhow::bail!(
                            "session already has active run '{active_id}' ({active_status})"
                        );
                    }
                    if queued > 0 {
                        anyhow::bail!("session already has {queued} queued run(s)");
                    }
                }
                if let Some(parent_id) = parent_run_id.as_deref() {
                    let parent_session: Option<String> = tx
                        .query_row(
                            "SELECT session_id FROM harness_runs WHERE id = ?1",
                            params![parent_id],
                            |row| row.get(0),
                        )
                        .optional()?;
                    match parent_session {
                        Some(parent_session) if parent_session == session_id => {}
                        Some(_) => anyhow::bail!("resume_run_id belongs to another session"),
                        None => anyhow::bail!("resume_run_id '{parent_id}' not found"),
                    }
                }

                let attempt: i64 = tx.query_row(
                    "SELECT COALESCE(MAX(attempt), 0) + 1 FROM harness_runs WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get(0),
                )?;
                let active_id = active.map(|(id, _)| id);
                let must_wait = active_id.is_some() || queued > 0;
                let (priority, displaced, rollback_of) = if strategy.preempts() {
                    (
                        1_i64,
                        active_id.clone(),
                        active_id
                            .clone()
                            .filter(|_| strategy == MultitaskStrategy::Rollback),
                    )
                } else {
                    (0, None, None)
                };
                if must_wait {
                    // Position among the runs that will start before this one:
                    // preempting runs only queue behind other preempting runs.
                    let ahead: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM harness_runs
                         WHERE session_id = ?1 AND status = 'pending' AND queue_priority >= ?2",
                        params![session_id, priority],
                        |row| row.get(0),
                    )?;
                    tx.execute(
                        "INSERT INTO harness_runs (
                             id, session_id, parent_run_id, status, attempt, idempotency_key,
                             execution_profile, input_json, event_seq, created_at,
                             multitask_strategy, queue_priority, rollback_run_id
                         ) VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, ?11)",
                        params![
                            run_id,
                            session_id,
                            parent_run_id,
                            attempt,
                            idempotency_key,
                            profile_json,
                            sealed_input,
                            now,
                            stored_strategy.map(MultitaskStrategy::as_str),
                            priority,
                            rollback_of,
                        ],
                    )?;
                    let queued_event = build_harness_event(
                        &run_id,
                        session_id,
                        1,
                        now,
                        RunEvent::RunQueued {
                            position: u32::try_from(ahead.max(0) + 1).unwrap_or(u32::MAX),
                            strategy,
                            active_run_id: active_id.clone(),
                        },
                    );
                    insert_harness_event(&tx, &self.cipher, &queued_event)?;
                    tx.commit()?;
                    (
                        Some((
                            vec![queued_event],
                            attempt,
                            HarnessRunStatus::Pending,
                            displaced,
                        )),
                        None,
                    )
                } else {
                    tx.execute(
                        "INSERT INTO harness_runs (
                             id, session_id, parent_run_id, status, attempt, idempotency_key,
                             execution_profile, input_json, event_seq, created_at, started_at,
                             multitask_strategy
                         ) VALUES (?1, ?2, ?3, 'running', ?4, ?5, ?6, ?7, 0, ?8, ?8, ?9)",
                        params![
                            run_id,
                            session_id,
                            parent_run_id,
                            attempt,
                            idempotency_key,
                            profile_json,
                            sealed_input,
                            now,
                            stored_strategy.map(MultitaskStrategy::as_str),
                        ],
                    )?;
                    tx.execute(
                        "UPDATE sessions SET status = 'running', updated_at = ?1 WHERE id = ?2",
                        params![now, session_id],
                    )?;
                    let events = append_run_start_events(
                        &tx,
                        &self.cipher,
                        &run_id,
                        session_id,
                        0,
                        now,
                        profile.clone(),
                        input_hash,
                        message_count,
                    )?;
                    tx.commit()?;
                    (
                        Some((events, attempt, HarnessRunStatus::Running, None)),
                        None,
                    )
                }
            }
        };
        if let Some(existing_id) = existing_id {
            let run = self
                .get_harness_run(&existing_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("idempotent harness run disappeared"))?;
            return Ok(HarnessRunStart {
                run,
                created: false,
                displaced_run_id: None,
            });
        }
        let Some((events, attempt, status, displaced_run_id)) = new_run else {
            anyhow::bail!("harness run creation produced no run");
        };
        let event_cursor = events.last().map_or(0, |event| event.seq);
        for event in events {
            let _ = harness_events_sender().send(event);
        }
        let running = status == HarnessRunStatus::Running;
        Ok(HarnessRunStart {
            run: HarnessRun {
                protocol_version: PROTOCOL_VERSION.to_owned(),
                id: run_id,
                session_id: session_id.to_owned(),
                status,
                attempt: u32::try_from(attempt.max(0)).unwrap_or(u32::MAX),
                idempotency_key,
                parent_run_id,
                execution_profile: profile,
                event_cursor,
                created_at: created_at.clone(),
                started_at: running.then_some(created_at),
                finished_at: None,
                error: None,
                output: None,
                multitask_strategy: stored_strategy,
            },
            created: true,
            displaced_run_id,
        })
    }
}
