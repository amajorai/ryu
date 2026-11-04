//! Promoting queued harness runs and reading harness runs.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Start the next queued run of a session when nothing is active. Returns
    /// `None` when a run is still `running`/`awaiting_approval` or the queue is
    /// empty, so concurrent callers can race safely: exactly one of them
    /// promotes a given run. A rollback run removes the transcript turns of the
    /// run it displaced in the same transaction, before it is dispatched.
    pub async fn promote_next_harness_run(
        &self,
        session_id: &str,
    ) -> Result<Option<PromotedHarnessRun>> {
        let promoted = {
            let mut conn = self.conn.lock().await;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let active: Option<String> = tx
                .query_row(
                    "SELECT id FROM harness_runs
                     WHERE session_id = ?1 AND status IN ('running', 'awaiting_approval')
                     LIMIT 1",
                    params![session_id],
                    |row| row.get(0),
                )
                .optional()?;
            if active.is_some() {
                return Ok(None);
            }
            let next: Option<(String, String, String, i64, Option<String>)> = tx
                .query_row(
                    "SELECT id, input_json, execution_profile, event_seq, rollback_run_id
                     FROM harness_runs
                     WHERE session_id = ?1 AND status = 'pending'
                     ORDER BY queue_priority DESC, created_at ASC, rowid ASC
                     LIMIT 1",
                    params![session_id],
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
                .optional()?;
            let Some((run_id, sealed_input, profile_json, current_seq, rollback_run_id)) = next
            else {
                return Ok(None);
            };
            let conversation_id: String = tx.query_row(
                "SELECT conversation_id FROM sessions WHERE id = ?1",
                params![session_id],
                |row| row.get(0),
            )?;
            let input_json = self.cipher.open(&sealed_input)?;
            let input: serde_json::Value = serde_json::from_str(&input_json)?;
            let mut removed_message_ids = Vec::new();
            if let Some(rolled_back) = rollback_run_id.as_deref() {
                removed_message_ids =
                    rollback_harness_run_turns_locked(&tx, &conversation_id, rolled_back)?;
            }
            let now = now_millis();
            tx.execute(
                "UPDATE harness_runs SET status = 'running', started_at = ?1 WHERE id = ?2",
                params![now, run_id],
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
                u64::try_from(current_seq.max(0)).unwrap_or(0),
                now,
                parse_execution_profile(&profile_json),
                ryu_tracing::hash_args(&input),
                harness_message_count(&input),
            )?;
            tx.commit()?;
            (run_id, input, conversation_id, removed_message_ids, events)
        };
        let (run_id, input, conversation_id, removed_message_ids, events) = promoted;
        for event in events {
            let _ = harness_events_sender().send(event);
        }
        // The search indexes skip message ids that no longer resolve, so the
        // removed turns stop appearing in recall without an index write here.
        let run = self
            .get_harness_run(&run_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("promoted harness run disappeared"))?;
        Ok(Some(PromotedHarnessRun {
            run,
            input,
            conversation_id,
            removed_messages: removed_message_ids.len(),
        }))
    }

    /// Sessions that still hold queued (`pending`) harness runs, with whether
    /// their conversation is attributed to a person or org. Used at boot to
    /// drain queues that a restart left behind.
    pub async fn list_sessions_with_queued_harness_runs(
        &self,
    ) -> Result<Vec<QueuedHarnessSession>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT r.session_id,
                    (c.owner_user_id IS NOT NULL OR c.org_id IS NOT NULL)
             FROM harness_runs r
             JOIN sessions s ON s.id = r.session_id
             LEFT JOIN conversations c ON c.id = s.conversation_id
             WHERE r.status = 'pending'",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(QueuedHarnessSession {
                session_id: row.get(0)?,
                attributed: row.get::<_, Option<bool>>(1)?.unwrap_or(false),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Fetch one durable harness run by id.
    pub async fn get_harness_run(&self, run_id: &str) -> Result<Option<HarnessRun>> {
        let raw = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT id, session_id, parent_run_id, status, attempt, idempotency_key,
                        execution_profile, input_json, output_json, error, event_seq,
                        created_at, started_at, finished_at, multitask_strategy
                 FROM harness_runs WHERE id = ?1",
                params![run_id],
                read_harness_run_row,
            )
            .optional()?
        };
        raw.map(|row| decode_harness_run(&self.cipher, row))
            .transpose()
    }

    /// List a session's runs newest-first.
    pub async fn list_harness_runs(&self, session_id: &str) -> Result<Vec<HarnessRun>> {
        let raw = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, session_id, parent_run_id, status, attempt, idempotency_key,
                        execution_profile, input_json, output_json, error, event_seq,
                        created_at, started_at, finished_at, multitask_strategy
                 FROM harness_runs WHERE session_id = ?1
                 ORDER BY created_at DESC, rowid DESC",
            )?;
            let rows = stmt.query_map(params![session_id], read_harness_run_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        // A row whose sealed fields do not open is skipped and counted, never
        // allowed to fail the whole list (get-by-id still errors).
        let mut runs = Vec::with_capacity(raw.len());
        let mut skipped = 0u64;
        for row in raw {
            match decode_harness_run(&self.cipher, row) {
                Ok(run) => runs.push(run),
                Err(error) => {
                    skipped += 1;
                    tracing::debug!("harness run skipped: {error:#}");
                }
            }
        }
        if skipped > 0 {
            let total = self
                .harness_unreadable
                .fetch_add(skipped, Ordering::Relaxed)
                + skipped;
            tracing::warn!(
                skipped,
                total,
                "harness runs: skipped rows whose sealed fields did not open \
                 (conversations.db.unreadable_rows)"
            );
        }
        Ok(runs)
    }
}
