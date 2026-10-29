//! Tick jobs and the periodic metering cycle over every live run.

use super::*;

/// Snapshot of the fields needed to send one tick, taken under the registry lock
/// so the async HTTP call happens without holding it.
#[derive(Clone)]
pub(super) struct TickJob {
    pub(super) run_id: String,
    /// The [`ActiveRun::generation`] this job was taken from.
    pub(super) generation: u64,
    pub(super) org_id: Option<String>,
    pub(super) spec: SandboxSpec,
    pub(super) backend: String,
    pub(super) workspace: WorkspaceId,
    pub(super) per_run_budget_micro_usd: u64,
    pub(super) elapsed_seconds_delta: u64,
    pub(super) tick_index: u64,
    pub(super) kill_action: KillAction,
    pub(super) size: Option<BoxSize>,
    pub(super) box_id: Option<String>,
    /// The run's metered seconds after this tick, sent with Box runs so the
    /// Gateway prices the tick from the body alone (`elapsed_seconds_total`).
    pub(super) elapsed_seconds_total: u64,
    /// The Box service's signed waiver of the run's per-start minimum.
    pub(super) minimum_waiver: Option<String>,
}

impl TickJob {
    /// The `POST /sandbox/tick` body. `size` and `box_id` are sent only for
    /// Box runs, so the generic sandbox wire is unchanged.
    pub(super) fn body(&self) -> serde_json::Value {
        tick_body(&TickBody {
            run_id: &self.run_id,
            org_id: self.org_id.as_deref(),
            spec: &self.spec,
            elapsed_seconds_delta: self.elapsed_seconds_delta,
            tick_index: self.tick_index,
            per_run_budget_micro_usd: self.per_run_budget_micro_usd,
            size: self.size,
            box_id: self.box_id.as_deref(),
            elapsed_seconds_total: self.elapsed_seconds_total,
            minimum_waiver: self.minimum_waiver.as_deref(),
        })
    }
}

/// The fields of one `POST /sandbox/tick` body, shared by the periodic ticks
/// and the final tail debit so both carry the same Box attribution.
pub(super) struct TickBody<'a> {
    pub(super) run_id: &'a str,
    pub(super) org_id: Option<&'a str>,
    pub(super) spec: &'a SandboxSpec,
    pub(super) elapsed_seconds_delta: u64,
    pub(super) tick_index: u64,
    pub(super) per_run_budget_micro_usd: u64,
    pub(super) size: Option<BoxSize>,
    pub(super) box_id: Option<&'a str>,
    /// The run's metered seconds after this tick; sent only for Box runs.
    pub(super) elapsed_seconds_total: u64,
    /// The Box service's signed waiver, sent (as `minimum_waiver`) only for
    /// a Box run whose per-start minimum the Box service waived; omitted
    /// otherwise, so the Gateway applies the minimum.
    pub(super) minimum_waiver: Option<&'a str>,
}

/// Serialize a tick body. `size`, `box_id` and `elapsed_seconds_total` are
/// sent only for Box runs, so the generic sandbox wire is unchanged. With the
/// run's total the Gateway prices a Box tick (its per-start minimum and whole
/// minutes) from the body alone, the same on every replica and after a
/// Gateway restart.
pub(super) fn tick_body(fields: &TickBody<'_>) -> serde_json::Value {
    let mut body = json!({
        "run_id": fields.run_id,
        "org_id": fields.org_id,
        "spec": fields.spec,
        "elapsed_seconds_delta": fields.elapsed_seconds_delta,
        "tick_index": fields.tick_index,
        "per_run_budget_micro_usd": fields.per_run_budget_micro_usd,
    });
    if let Some(size) = fields.size {
        body["size"] = json!(size.as_str());
        body["elapsed_seconds_total"] = json!(fields.elapsed_seconds_total);
        if let Some(waiver) = fields.minimum_waiver {
            body["minimum_waiver"] = json!(waiver);
        }
    }
    if let Some(box_id) = fields.box_id {
        body["box_id"] = json!(box_id);
    }
    body
}

pub(super) fn parse_verdict(raw: &str) -> Verdict {
    match raw {
        "continue" => Verdict::Continue,
        "warn" => Verdict::Warn,
        "kill_budget" => Verdict::KillBudget,
        "kill_balance" => Verdict::KillBalance,
        "kill_accounting" => Verdict::KillAccounting,
        // A missing or unknown verdict is a protocol failure. Org-bound runs
        // must not continue when the billing decision cannot be parsed.
        _ => Verdict::KillAccounting,
    }
}

/// Start the single background ticker exactly once.
///
/// A no-op when called outside a Tokio runtime (e.g. a sync unit test): there is
/// nothing to drive the loop, and `STARTED` stays `false` so a later call from
/// within the runtime still starts it.
pub(super) fn ensure_ticker() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(TICK_INTERVAL).await;
            run_tick_cycle().await;
        }
    });
}

/// A kill-pending run whose provider stop is retried this cycle.
pub(super) struct StopRetry {
    pub(super) job: TickJob,
    pub(super) reason: KillReason,
    pub(super) accrued: u64,
}

/// One metering pass over every live run.
pub(super) async fn run_tick_cycle() {
    let (jobs, retries) = snapshot_cycle(Instant::now());
    for retry in retries {
        retry_pending_stop(&retry.job, retry.reason, retry.accrued).await;
    }
    for job in jobs {
        // Skip a zero-second delta (nothing accrued): avoids a pointless round-trip.
        if job.elapsed_seconds_delta == 0 {
            continue;
        }
        send_tick(job).await;
    }
}

/// Take one cycle's work under the lock: a tick for every live run (advancing
/// its tick_index + last_tick_at optimistically so the loop never holds the
/// lock across await) and a stop retry for every kill-pending run, which is
/// never ticked or charged again.
pub(super) fn snapshot_cycle(now: Instant) -> (Vec<TickJob>, Vec<StopRetry>) {
    let mut guard = lock_runs();
    let mut jobs = Vec::with_capacity(guard.len());
    let mut retries = Vec::new();
    for (run_id, run) in guard.iter_mut() {
        if let Some((reason, accrued)) = run.kill_pending.clone() {
            retries.push(StopRetry {
                job: tick_job_for(run_id, run, 0, run.tick_index),
                reason,
                accrued,
            });
            continue;
        }
        let elapsed = now.saturating_duration_since(run.last_tick_at).as_secs();
        let tick_index = run.tick_index;
        run.last_tick_at = now;
        run.tick_index = run.tick_index.saturating_add(1);
        // Optimistic, matching `last_tick_at`: count the elapsed seconds as
        // metered even if the send below fails (a lost delta, same as the
        // ticker already drops on a failed post). Keeps the final-debit
        // remainder consistent with the ticker's own accounting.
        run.ticked_seconds = run.ticked_seconds.saturating_add(elapsed);
        jobs.push(tick_job_for(run_id, run, elapsed, tick_index));
    }
    (jobs, retries)
}

/// The tick (or stop-retry) job for one registered run.
pub(super) fn tick_job_for(
    run_id: &str,
    run: &ActiveRun,
    elapsed: u64,
    tick_index: u64,
) -> TickJob {
    TickJob {
        run_id: run_id.to_owned(),
        generation: run.generation,
        org_id: run.org_id.clone(),
        spec: run.spec.clone(),
        backend: run.backend.clone(),
        workspace: run.workspace.clone(),
        per_run_budget_micro_usd: run.per_run_budget_micro_usd,
        elapsed_seconds_delta: elapsed,
        tick_index,
        kill_action: run.kill_action.clone(),
        size: run.size,
        box_id: run.box_id.clone(),
        elapsed_seconds_total: run.ticked_seconds,
        minimum_waiver: run.minimum_waiver.clone(),
    }
}
