//! Boot-time recovery: tenancy backfill, interrupted-run reconciliation and
//! the bounded auto-resume claim.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Decide, once, what a pre-existing NULL-tenancy conversation row MEANS.
    ///
    /// Before the per-resource ACL was populated, every conversation row was
    /// created with `owner_user_id` and `org_id` NULL. `resource_access`
    /// (`server/mod.rs`) reads an untenanted row as "the local single-user row":
    /// full access on an UNBOUND node, DENIED on an ORG-BOUND (shared) one. So:
    ///
    ///   - **Node UNBOUND** (no `registered_org()`): return immediately, stamping
    ///     nothing. There is exactly one principal on a personal node and the node
    ///     token is the boundary (the same rule `enforce_permission` already
    ///     applies), so scoping rows there would buy no security and would lock the
    ///     owner out of their own chats whenever the control plane is unreachable
    ///     and their JWT cannot be minted. The marker is NOT written, so this reruns
    ///     (and does the real work) if the node later joins an org.
    ///   - **Node ORG-BOUND**: attribute every untenanted row to the LOCAL OWNER —
    ///     the signed-in account in the vault — because those chats were had by
    ///     whoever was sitting at this node before it was shared. Idempotent via the
    ///     `conv_meta` marker.
    ///   - **Node ORG-BOUND with no local account**: there is nobody to attribute
    ///     them to. Leave them NULL and warn. Combined with the ACL's
    ///     untenanted-row-on-a-bound-node DENY they become unreachable (data intact
    ///     on disk, recoverable by an explicit admin action) rather than readable by
    ///     every member of the org. Fail closed.
    pub(super) fn backfill_tenancy(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS conv_meta (key TEXT PRIMARY KEY, value TEXT)",
        )
        .context("creating conv_meta")?;
        let done: Option<String> = conn
            .query_row(
                "SELECT value FROM conv_meta WHERE key = 'tenancy_backfill_v1'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if done.is_some() {
            return Ok(());
        }

        // Unbound (personal) node: rows stay untenanted, by design. Not marked done.
        let Some(org) = crate::sidecar::control_plane::registered_org() else {
            return Ok(());
        };

        let Some(owner) = crate::auth::load_accounts()
            .active()
            .map(|a| a.user_id.clone())
        else {
            let orphans: i64 = conn.query_row(
                "SELECT COUNT(*) FROM conversations
                 WHERE owner_user_id IS NULL AND org_id IS NULL",
                [],
                |r| r.get(0),
            )?;
            if orphans > 0 {
                tracing::warn!(
                    "tenancy backfill: {orphans} pre-ACL conversation(s) on an org-bound node with \
                     no signed-in local account to attribute them to — leaving them untenanted, \
                     which the per-resource ACL denies (fail closed). Sign in and restart to claim them."
                );
            }
            return Ok(());
        };

        let claimed = conn
            .execute(
                "UPDATE conversations SET owner_user_id = ?1, org_id = ?2
                 WHERE owner_user_id IS NULL AND org_id IS NULL",
                params![owner, org.id],
            )
            .context("backfilling conversation tenancy")?;
        conn.execute(
            "INSERT OR REPLACE INTO conv_meta (key, value) VALUES ('tenancy_backfill_v1', ?1)",
            params![owner],
        )?;
        tracing::info!(
            "tenancy backfill: attributed {claimed} pre-ACL conversation(s) to the local owner"
        );
        Ok(())
    }

    /// Close the books, at boot, on turns this node died in the middle of.
    ///
    /// A turn's status is written by the streaming loop at exactly two terminal
    /// points (`completed` / `failed`), so a process that is killed mid-stream —
    /// crash, force-quit, OOM, power loss — leaves the conversation parked at
    /// `running` forever and its assistant row holding only what had been flushed.
    /// Nothing downstream can tell that row apart from a finished answer that just
    /// happens to stop mid-sentence. At startup a `running` row means its producer
    /// died with the process. During a live Kill Switch action, Core first signals
    /// every producer, then marks the still-running rows interrupted.
    ///
    /// Three statements, in this order:
    ///   1. flag the trailing assistant message of every `running` conversation
    ///      (it is the row that was being written when the node went down), and
    ///   2. move the conversation itself off `running`.
    ///   3. close any durable harness run that was still live and append its
    ///      terminal `run_interrupted` event in the same transaction.
    /// The message pass keys off `run_status = 'running'`, so flipping the status
    /// first would flag nothing.
    ///
    /// Raw SQL rather than a `set_run_status` loop on purpose. The caller handling
    /// a live pause publishes summaries after this batch write; boot reconciliation
    /// has no subscribers yet and should not pay for those summary loads.
    ///
    /// Returns `(runs_reconciled, messages_flagged)` for the log line.
    pub(super) fn reconcile_interrupted_runs(
        conn: &mut Connection,
        cipher: &ryu_crypto::FieldCipher,
    ) -> Result<(usize, usize)> {
        let flagged = conn
            .execute(
                "UPDATE messages SET interrupted = 1
                 WHERE id IN (
                     SELECT m.id FROM messages m
                     JOIN conversations c ON c.id = m.conversation_id
                     WHERE c.run_status = 'running'
                       AND m.role = 'assistant'
                       AND m.id = (
                           SELECT m2.id FROM messages m2
                           WHERE m2.conversation_id = c.id
                           ORDER BY m2.created_at DESC, m2.rowid DESC
                           LIMIT 1
                       )
                 )",
                [],
            )
            .context("flagging interrupted assistant messages")?;
        let runs = conn
            .execute(
                "UPDATE conversations SET run_status = 'interrupted' WHERE run_status = 'running'",
                [],
            )
            .context("reconciling interrupted run statuses")?;

        // A harness run has a separate lifecycle from the legacy conversation
        // row. Reconcile both together so a restarted node cannot leave the
        // cursorable event stream parked forever without a terminal event.
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("starting harness interruption transaction")?;
        let stuck: Vec<(String, String, i64)> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id, session_id, event_seq FROM harness_runs
                     WHERE status IN ('running', 'awaiting_approval')",
                )
                .context("listing interrupted harness runs")?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let harness_runs = stuck.len();
        let now = now_millis();
        for (run_id, session_id, current_seq) in stuck {
            let next_seq = u64::try_from(current_seq.max(0) + 1).unwrap_or(u64::MAX);
            let event = build_harness_event(
                &run_id,
                &session_id,
                next_seq,
                now,
                RunEvent::RunInterrupted,
            );
            insert_harness_event(&tx, cipher, &event)
                .with_context(|| format!("appending interruption for harness run {run_id}"))?;
            tx.execute(
                "UPDATE harness_runs
                 SET status = 'interrupted', event_seq = ?1, finished_at = ?2
                 WHERE id = ?3 AND status IN ('running', 'awaiting_approval')",
                params![i64::try_from(next_seq).unwrap_or(i64::MAX), now, run_id,],
            )?;
            tx.execute(
                "UPDATE sessions SET status = 'failed', updated_at = ?1
                 WHERE id = ?2 AND status = 'running'",
                params![now, session_id],
            )?;
        }
        tx.commit()
            .context("committing harness interruption transaction")?;
        if runs > 0 || harness_runs > 0 {
            tracing::info!(
                "run reconciliation: {runs} conversation(s) and {harness_runs} harness run(s) \
                 were still live at boot ({flagged} truncated assistant message(s) marked interrupted)"
            );
        }
        Ok((runs + harness_runs, flagged))
    }

    /// Ids of conversations parked at `running`, oldest turn first. Only
    /// meaningful at boot, where `running` means the producer died with the
    /// previous process.
    pub(super) fn list_running_conversations(conn: &Connection) -> Result<Vec<String>> {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM conversations WHERE run_status = 'running'
                 ORDER BY updated_at ASC, rowid ASC",
            )
            .context("listing running conversations")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("reading running conversations")
    }

    /// Take the conversations whose turns the previous process died in the
    /// middle of. Returns them once; later calls get an empty list.
    pub fn take_boot_interrupted_runs(&self) -> Vec<String> {
        self.boot_interrupted
            .lock()
            .map(|mut ids| std::mem::take(&mut *ids))
            .unwrap_or_default()
    }

    /// Atomically move an `interrupted` run back to `running` for one automatic
    /// resume of the user turn `user_message_id`.
    ///
    /// The attempt is recorded in the same transaction as the status flip, so
    /// it is durable before any model work starts: if the resumed turn takes
    /// the node down again, the next boot sees the spent attempt. A different
    /// `user_message_id` than the recorded one starts a fresh budget.
    ///
    /// The conditional status update is the duplicate-work guard against a
    /// desktop reconnect retry racing this claim, the same way
    /// [`Self::claim_terminal_run_for_retry`] guards two desktop windows.
    ///
    /// Only node-owned (untenanted) conversations are claimed: a conversation
    /// with an owner or org returns [`AutoResumeClaim::Attributed`] untouched.
    pub async fn claim_interrupted_run_for_auto_resume(
        &self,
        conversation_id: &str,
        user_message_id: &str,
        max_attempts: u32,
    ) -> Result<AutoResumeClaim> {
        let now = now_millis();
        let claim = {
            let mut conn = self.conn.lock().await;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .context("starting auto-resume claim")?;
            let previous: Option<(String, i64)> = tx
                .query_row(
                    "SELECT user_message_id, attempts FROM run_auto_resume
                     WHERE conversation_id = ?1",
                    params![conversation_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .context("reading auto-resume attempts")?;
            let spent = previous
                .filter(|(message_id, _)| message_id == user_message_id)
                .map_or(0, |(_, attempts)| {
                    u32::try_from(attempts.max(0)).unwrap_or(u32::MAX)
                });
            let attributed: bool = tx
                .query_row(
                    "SELECT owner_user_id IS NOT NULL OR org_id IS NOT NULL
                     FROM conversations WHERE id = ?1",
                    params![conversation_id],
                    |row| row.get(0),
                )
                .optional()
                .context("reading conversation tenancy")?
                .unwrap_or(false);
            let claim = if attributed {
                AutoResumeClaim::Attributed
            } else if spent >= max_attempts {
                AutoResumeClaim::Exhausted
            } else {
                let moved = tx
                    .execute(
                        "UPDATE conversations
                         SET run_status = 'running', updated_at = ?1
                         WHERE id = ?2 AND run_status = 'interrupted'
                           AND owner_user_id IS NULL AND org_id IS NULL",
                        params![now, conversation_id],
                    )
                    .context("claiming interrupted run")?;
                if moved == 1 {
                    let attempt = spent + 1;
                    tx.execute(
                        "INSERT INTO run_auto_resume
                             (conversation_id, user_message_id, attempts, updated_at)
                         VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT(conversation_id) DO UPDATE SET
                             user_message_id = excluded.user_message_id,
                             attempts = excluded.attempts,
                             updated_at = excluded.updated_at",
                        params![conversation_id, user_message_id, i64::from(attempt), now],
                    )
                    .context("recording auto-resume attempt")?;
                    AutoResumeClaim::Claimed {
                        attempt,
                        claimed_at: now,
                    }
                } else {
                    AutoResumeClaim::NotInterrupted
                }
            };
            tx.commit().context("committing auto-resume claim")?;
            claim
        };
        if matches!(claim, AutoResumeClaim::Claimed { .. }) {
            if let Ok(Some(run)) = self.run_summary(conversation_id).await {
                let _ = run_events_sender().send(RunStatusEvent { run });
            }
        }
        Ok(claim)
    }

    /// Close an auto-resumed run whose turn ended before it ever started.
    ///
    /// A turn that gets going writes `running` again (bumping `updated_at`)
    /// and later its own terminal status. One rejected up front (an agent that
    /// no longer exists, a Kill Switch pause) writes nothing, which would leave
    /// the claim's `running` in place with no producer behind it. Matching on
    /// the claim's own `updated_at` makes this a no-op for every turn that
    /// started, and for any newer turn in the same conversation.
    pub async fn fail_unstarted_auto_resume(
        &self,
        conversation_id: &str,
        claimed_at: i64,
    ) -> Result<bool> {
        let failed = {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE conversations
                 SET run_status = 'failed', updated_at = ?1
                 WHERE id = ?2 AND run_status = 'running' AND updated_at = ?3",
                params![now_millis(), conversation_id, claimed_at],
            )
            .context("failing unstarted auto-resume")?
                == 1
        };
        if failed {
            if let Ok(Some(run)) = self.run_summary(conversation_id).await {
                let _ = run_events_sender().send(RunStatusEvent { run });
            }
        }
        Ok(failed)
    }
}
