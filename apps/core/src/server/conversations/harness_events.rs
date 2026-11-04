//! Harness run events, status changes and completion.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Append one ordered event to the durable run journal and wake live
    /// subscribers. Event payloads are bounded and already redacted by the
    /// caller; raw model/tool arguments are never required by this contract.
    pub async fn append_harness_event(
        &self,
        run_id: &str,
        event: RunEvent,
    ) -> Result<RunEventEnvelope> {
        let (envelope, _) = {
            let mut conn = self.conn.lock().await;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (session_id, current_seq): (String, i64) = tx
                .query_row(
                    "SELECT session_id, event_seq FROM harness_runs WHERE id = ?1",
                    params![run_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .context("loading harness run for event")?;
            let seq = u64::try_from(current_seq.max(0) + 1).unwrap_or(u64::MAX);
            let now = now_millis();
            let envelope = build_harness_event(run_id, &session_id, seq, now, event);
            insert_harness_event(&tx, &self.cipher, &envelope)?;
            tx.execute(
                "UPDATE harness_runs SET event_seq = ?1 WHERE id = ?2",
                params![i64::try_from(seq).unwrap_or(i64::MAX), run_id],
            )?;
            tx.commit()?;
            (envelope, seq)
        };
        let _ = harness_events_sender().send(envelope.clone());
        Ok(envelope)
    }

    /// Read a bounded event page after an exclusive sequence cursor.
    pub async fn list_harness_events(
        &self,
        run_id: &str,
        after_seq: u64,
        limit: usize,
    ) -> Result<Vec<RunEventEnvelope>> {
        let after = i64::try_from(after_seq).unwrap_or(i64::MAX);
        let limit = i64::try_from(limit.clamp(1, 500)).unwrap_or(500);
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT event_json FROM harness_run_events
             WHERE run_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![run_id, after, limit], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            let sealed = row?;
            let json = self.cipher.open(&sealed).context("opening harness event")?;
            serde_json::from_str(&json).context("decoding harness event")
        })
        .collect()
    }

    /// Move a non-terminal run between `running` and `awaiting_approval`
    /// without creating an extra synthetic event. The approval event itself is
    /// the durable explanation for the transition; this method only updates the
    /// indexed state used by `GET /api/harness/runs/:id`.
    pub async fn set_harness_run_status(
        &self,
        run_id: &str,
        status: HarnessRunStatus,
    ) -> Result<bool> {
        if status.is_terminal() {
            anyhow::bail!("set_harness_run_status accepts non-terminal states only");
        }
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE harness_runs SET status = ?1 WHERE id = ?2
             AND status NOT IN ('completed', 'failed', 'canceled', 'interrupted')",
            params![status.as_str(), run_id],
        )?;
        Ok(updated > 0)
    }

    /// Complete, fail, cancel, or interrupt a run. Terminal calls are
    /// idempotent: a late duplicate completion cannot append a second terminal
    /// event or move a run back out of its terminal state.
    pub async fn finish_harness_run(
        &self,
        run_id: &str,
        status: HarnessRunStatus,
        error: Option<&str>,
        output: Option<&serde_json::Value>,
    ) -> Result<Option<HarnessRun>> {
        if !status.is_terminal() {
            anyhow::bail!("harness finish status must be terminal");
        }
        let mut published = None;
        let mut already_terminal = false;
        {
            let mut conn = self.conn.lock().await;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let row: Option<(String, i64, String)> = tx
                .query_row(
                    "SELECT session_id, event_seq, status FROM harness_runs WHERE id = ?1",
                    params![run_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((session_id, current_seq, current_status)) = row else {
                drop(tx);
                drop(conn);
                // Keep the decision outside this transaction scope so a caller
                // that is already in a Tokio task never holds a rusqlite
                // transaction across the async reload below.
                return Ok(None);
            };
            if HarnessRunStatus::from_str(&current_status).is_terminal() {
                already_terminal = true;
                drop(tx);
                drop(conn);
            } else {
                let now = now_millis();
                let output_json = output
                    .map(serde_json::to_string)
                    .transpose()?
                    .map(|value| self.cipher.seal(&value))
                    .transpose()?;
                // The error text can echo provider responses (prompt fragments):
                // sealed like the output.
                let sealed_error = error.map(|value| self.cipher.seal(value)).transpose()?;
                tx.execute(
                    "UPDATE harness_runs
                     SET status = ?1, error = ?2, output_json = ?3, finished_at = ?4
                     WHERE id = ?5",
                    params![status.as_str(), sealed_error, output_json, now, run_id],
                )?;
                let session_status = match status {
                    HarnessRunStatus::Completed => "completed",
                    HarnessRunStatus::Canceled
                    | HarnessRunStatus::Failed
                    | HarnessRunStatus::Interrupted => "failed",
                    HarnessRunStatus::Pending
                    | HarnessRunStatus::Running
                    | HarnessRunStatus::AwaitingApproval => "running",
                };
                // Finishing a queued run must not overwrite the status of
                // the run that is still live in the same session.
                tx.execute(
                    "UPDATE sessions SET status = ?1, updated_at = ?2 WHERE id = ?3
                     AND NOT EXISTS (
                         SELECT 1 FROM harness_runs
                         WHERE session_id = ?3 AND id != ?4
                           AND status IN ('running', 'awaiting_approval')
                     )",
                    params![session_status, now, session_id, run_id],
                )?;
                let next_seq = u64::try_from(current_seq.max(0) + 1).unwrap_or(u64::MAX);
                let terminal_event = match status {
                    HarnessRunStatus::Completed => RunEvent::RunCompleted {
                        output: output.cloned(),
                    },
                    HarnessRunStatus::Canceled => RunEvent::RunCanceled,
                    HarnessRunStatus::Interrupted => RunEvent::RunInterrupted,
                    HarnessRunStatus::Failed => RunEvent::RunFailed {
                        code: "run_failed".to_owned(),
                        message: error.unwrap_or("run failed").to_owned(),
                    },
                    HarnessRunStatus::Pending
                    | HarnessRunStatus::Running
                    | HarnessRunStatus::AwaitingApproval => unreachable!(),
                };
                let envelope =
                    build_harness_event(run_id, &session_id, next_seq, now, terminal_event);
                insert_harness_event(&tx, &self.cipher, &envelope)?;
                tx.execute(
                    "UPDATE harness_runs SET event_seq = ?1 WHERE id = ?2",
                    params![i64::try_from(next_seq).unwrap_or(i64::MAX), run_id],
                )?;
                tx.commit()?;
                published = Some(envelope);
            }
        }
        if already_terminal {
            return self.get_harness_run(run_id).await;
        }
        if let Some(envelope) = published {
            let _ = harness_events_sender().send(envelope);
        }
        self.get_harness_run(run_id).await
    }
}
