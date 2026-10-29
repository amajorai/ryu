//! The background audit writer thread and its retry/backlog policy.

use super::*;

/// Append one row to `audit_log` inside the caller's transaction.
pub(crate) fn insert_audit_row(
    tx: &rusqlite::Transaction<'_>,
    record: &AuditRecord,
    service_usage: Option<&AuditServiceUsage>,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO audit_log (
             request_id, api_key, api_key_prefix, user_name, org_id, team_id, project_id,
             provider, model, input_tokens, output_tokens,
             cache_hit, latency_ms, eval_score, error, skill_ids, session_id,
             event_type, backend, command, duration_ms, exit_code,
             user_id, agent_id, feature, managed_inference, provider_cost_micro_usd,
             widget_instance_id, service_requests, service_documents,
             service_provider_credits, service_cost_source, service_cost_is_estimate,
             cache_read_tokens, cache_write_tokens, prompt_cache_outcome, prompt_cache_read_tokens,
             prompt_cache_write_tokens, key_id, team_ids, cache_write_1h_tokens, purpose
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,
                   ?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38,?39,?40,?41,?42)",
        params![
            &record.request_id,
            api_key_storage_key(&record.api_key),
            if record.event_type == EventType::ServiceCall { credential_log_id(&record.api_key) } else { redact_key(&record.api_key) },
            record.user_name.as_deref(),
            record.org_id.as_deref(),
            record.team_id.as_deref(),
            record.project_id.as_deref(),
            &record.provider,
            &record.model,
            record.input_tokens as i64,
            record.output_tokens as i64,
            record.cache_hit as i32,
            record.latency_ms as i64,
            record.eval_score,
            record.error.as_deref(),
            record.skill_ids.as_deref(),
            record.session_id.as_deref(),
            record.event_type.as_str(),
            record.backend.as_deref(),
            record.command.as_deref(),
            record.duration_ms.map(|v| v as i64),
            record.exit_code,
            record.user_id.as_deref(),
            record.agent_id.as_deref(),
            record.feature.as_deref(),
            record.managed_inference as i32,
            record.provider_cost_micro_usd.map(|v| v as i64),
            record.widget_instance_id.as_deref(),
            service_usage.map(|usage| usage.requests as i64),
            service_usage.map(|usage| usage.documents as i64),
            service_usage.and_then(|usage| usage.provider_credits).map(|value| value as i64),
            service_usage.map(|usage| usage.cost_source.as_str()),
            service_usage.map(|usage| i64::from(usage.cost_is_estimate)),
            record.cache_read_tokens.map(|value| value as i64),
            record.cache_write_tokens.map(|value| value as i64),
            record.prompt_cache_outcome.as_deref(),
            record.prompt_cache_read_tokens.map(|v| v as i64),
            record.prompt_cache_write_tokens.map(|v| v as i64),
            record.key_id.as_deref(),
            record.team_ids.as_deref(),
            record.cache_write_1h_tokens.map(|value| value as i64),
            record.purpose.as_deref().and_then(valid_purpose),
        ],
    )?;
    Ok(())
}

/// Run `body` in one writer transaction. While the test-only fault counter is
/// non-zero, the attempt fails (and decrements it) before touching SQLite.
pub(crate) fn write_transaction(
    conn: &mut Connection,
    injected_failures: &AtomicU64,
    body: impl FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
) -> Result<(), String> {
    let injected = injected_failures
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |left| {
            left.checked_sub(1)
        })
        .is_ok();
    if injected {
        return Err("injected audit write failure".to_owned());
    }
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    body(&tx)
        .and_then(|()| tx.commit())
        .map_err(|error| error.to_string())
}

/// Persist one row together with every pending counter increment in a single
/// transaction, so the normal path stays one commit per row and a burst
/// coalesces its counters. The row itself is best-effort: on failure the
/// counters are merged back and written on their own at once, so a row that
/// cannot be stored never holds the lifetime totals hostage.
pub(crate) fn write_audit_row(
    conn: &mut Connection,
    queued: &QueuedAudit,
    pending: &PendingCounters,
    injected_failures: &AtomicU64,
) -> Result<(), String> {
    let deltas = take_pending(pending);
    let result = write_transaction(conn, injected_failures, |tx| {
        insert_audit_row(tx, &queued.record, queued.service_usage.as_ref())?;
        deltas.apply(tx)
    });
    let Err(error) = result else {
        return Ok(());
    };
    error!("audit log write failed: {error}; usage totals will be retried");
    merge_pending(pending, deltas);
    drain_audit_counters(conn, pending, injected_failures)
}

/// Write ALL pending counter increments in one transaction. A failed write is
/// merged back so it is retried, never lost.
pub(crate) fn drain_audit_counters(
    conn: &mut Connection,
    pending: &PendingCounters,
    injected_failures: &AtomicU64,
) -> Result<(), String> {
    let deltas = take_pending(pending);
    if deltas.is_empty() {
        return Ok(());
    }
    let result = write_transaction(conn, injected_failures, |tx| deltas.apply(tx));
    if let Err(error) = &result {
        error!("audit usage totals write failed: {error}; will retry");
        merge_pending(pending, deltas);
    }
    result
}

/// The next counter-retry delay after one write: none once it succeeded,
/// otherwise a doubling backoff from [`RETRY_MIN`] up to [`RETRY_MAX`].
pub(crate) fn next_retry(retry: Option<Duration>, result: &Result<(), String>) -> Option<Duration> {
    match result {
        Ok(()) => None,
        Err(_) => Some(retry.map_or(RETRY_MIN, |delay| (delay * 2).min(RETRY_MAX))),
    }
}

/// Most rows held in memory while the one-time rebuild runs. Past it a row is
/// dropped (and counted in a warning); its lifetime counters are merged into
/// [`PendingCounters`] before it is queued, so they are never lost.
pub(crate) const SCRUB_BACKLOG_MAX: usize = 100_000;

/// Run `work` (the one-time rebuild) while a short-lived drain keeps emptying
/// `receiver` into memory, so the bounded queue never fills and drops rows or
/// fails service calls for as long as the rebuild takes. Returns the work's
/// result and the rows received meanwhile, in arrival order, for the caller to
/// persist before it resumes normal draining.
pub(crate) fn buffer_while<R>(
    receiver: &mut mpsc::Receiver<QueuedAudit>,
    max_backlog: usize,
    work: impl FnOnce() -> R,
) -> (R, Vec<QueuedAudit>) {
    let finished = AtomicBool::new(false);
    let finished = &finished;
    thread::scope(|scope| {
        // `move` hands the drain thread the `&mut Receiver` itself (`Send`);
        // borrowing it by shared reference would need `Receiver: Sync`.
        let drain = scope.spawn(move || {
            let mut backlog = Vec::new();
            let mut dropped: u64 = 0;
            while !finished.load(Ordering::Acquire) {
                match receiver.recv_timeout(Duration::from_millis(25)) {
                    Ok(queued) if backlog.len() < max_backlog => backlog.push(queued),
                    Ok(_) => dropped += 1,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            if dropped > 0 {
                warn!(
                    dropped,
                    "audit: the rebuild backlog was full; rows dropped (lifetime counters are kept)"
                );
            }
            backlog
        });
        let result = work();
        finished.store(true, Ordering::Release);
        (result, drain.join().unwrap_or_default())
    })
}

/// Persist every queued row. After a counter write fails the loop wakes ITSELF
/// with exponential backoff, so merged-back totals are retried even when no new
/// row arrives; once the logger is dropped it makes one final attempt.
///
/// `backlog` is persisted first, in order: the rows [`buffer_while`] collected
/// while the one-time rebuild held the writer.
pub(crate) fn audit_write_loop(
    conn: &mut Connection,
    receiver: &mpsc::Receiver<QueuedAudit>,
    backlog: Vec<QueuedAudit>,
    pending: &PendingCounters,
    injected_failures: &AtomicU64,
) {
    let mut retry: Option<Duration> = None;
    for queued in &backlog {
        let result = write_audit_row(conn, queued, pending, injected_failures);
        retry = next_retry(retry, &result);
    }
    drop(backlog);
    loop {
        let received = match retry {
            None => receiver
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
            Some(delay) => receiver.recv_timeout(delay),
        };
        let result = match received {
            Ok(queued) => write_audit_row(conn, &queued, pending, injected_failures),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                drain_audit_counters(conn, pending, injected_failures)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = drain_audit_counters(conn, pending, injected_failures);
                return;
            }
        };
        retry = next_retry(retry, &result);
    }
}
