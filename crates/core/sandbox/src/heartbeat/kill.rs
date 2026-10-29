//! Kill enforcement: provider stop, park, retries and kill records.

use super::*;

/// Mark a run as stopping. `false` when a stop is already in progress for it,
/// so a second kill verdict does not start a second one.
pub(super) fn begin_kill(run_id: &str) -> bool {
    match lock_runs().get_mut(run_id) {
        Some(run) if run.stopping => false,
        Some(run) => {
            run.stopping = true;
            true
        }
        None => true,
    }
}

/// Stop a sandbox on a kill verdict and mark the run: run its
/// [`KillAction`], then drop it from the live registry and record the kill.
/// A failed stop is retried in the background with [`kill_retry_delay`]
/// until it is confirmed, so a remote sandbox is never silently leaked; the
/// run keeps being metered meanwhile, because it is still running.
pub(super) async fn enforce_kill(job: &TickJob, reason: KillReason, accrued: u64) {
    enforce_kill_with(job, reason, accrued, kill_retry_delay).await;
}

pub(super) async fn enforce_kill_with(
    job: &TickJob,
    reason: KillReason,
    accrued: u64,
    retry_delay: fn(u32) -> Duration,
) {
    if !begin_kill(&job.run_id) {
        return;
    }
    // A failed first attempt leaves the run kill-pending (sticky: never ticked
    // or charged again), so the retries below and each metering cycle keep
    // trying to confirm the stop.
    if attempt_stop(job, reason, accrued).await {
        return;
    }
    if tokio::runtime::Handle::try_current().is_err() {
        clear_stopping(&job.run_id);
        return;
    }
    let job = job.clone();
    tokio::spawn(async move {
        let mut attempt: u32 = 1;
        loop {
            tokio::time::sleep(retry_delay(attempt)).await;
            if !is_current(&job) {
                // The owner ended the run itself (normal completion, an
                // explicit delete or park), or the id now names a later run
                // (a resumed Box): there is nothing left to stop.
                return;
            }
            if attempt_stop(&job, reason, accrued).await {
                return;
            }
            attempt = attempt.saturating_add(1);
            tracing::warn!(
                run_id = %job.run_id,
                attempt,
                next_retry_secs = retry_delay(attempt).as_secs(),
                "sandbox tick: stop on kill verdict still failing; retrying"
            );
        }
    });
}

/// One stop attempt for a kill verdict. `true` when the stop is confirmed:
/// the run leaves the registry, the kill is recorded and the Gateway's sticky
/// kill state is released. A failed stop marks the run kill-pending.
pub(super) async fn attempt_stop(job: &TickJob, reason: KillReason, accrued: u64) -> bool {
    if !run_kill_action(job, reason).await {
        record_kill_if_stopped(job, reason, accrued, false);
        return false;
    }
    if record_kill_if_stopped(job, reason, accrued, true) {
        // Teardown is confirmed: release the Gateway's sticky kill state.
        complete_run(&job.run_id).await;
    }
    true
}

/// The per-cycle retry of a kill-pending run's stop. Runs alongside the
/// background retry a kill verdict starts, so a stop still converges when that
/// task could not be spawned.
pub(super) async fn retry_pending_stop(job: &TickJob, reason: KillReason, accrued: u64) {
    attempt_stop(job, reason, accrued).await;
}

/// Whether the run `job` was taken from is still the registered one.
pub(super) fn is_current(job: &TickJob) -> bool {
    lock_runs()
        .get(&job.run_id)
        .is_some_and(|run| run.generation == job.generation)
}

pub(super) fn clear_stopping(run_id: &str) {
    if let Some(run) = lock_runs().get_mut(run_id) {
        run.stopping = false;
    }
}

/// Run one stop attempt. `true` when the stop is confirmed.
pub(super) async fn run_kill_action(job: &TickJob, reason: KillReason) -> bool {
    match &job.kill_action {
        KillAction::Park(park) => match park(reason).await {
            Ok(()) => {
                tracing::info!(
                    run_id = %job.run_id,
                    workspace = %job.workspace.0,
                    reason = reason.as_str(),
                    "sandbox tick: Box parked on kill verdict"
                );
                true
            }
            Err(error) => {
                tracing::error!(
                    run_id = %job.run_id,
                    workspace = %job.workspace.0,
                    error = %error,
                    "sandbox tick: failed to park the Box on kill verdict; will retry"
                );
                false
            }
        },
        KillAction::Destroy => destroy_on_kill(job).await,
    }
}

pub(super) async fn destroy_on_kill(job: &TickJob) -> bool {
    match SandboxBackend::from_name(&job.backend).and_then(|b| crate::build_command_backend(&b)) {
        Ok(backend) => {
            if let Err(e) = backend.destroy_workspace(&job.workspace).await {
                tracing::error!(
                    run_id = %job.run_id,
                    workspace = %job.workspace.0,
                    error = %e,
                    "sandbox tick: failed to stop sandbox on kill verdict; will retry"
                );
                false
            } else {
                tracing::info!(
                    run_id = %job.run_id,
                    workspace = %job.workspace.0,
                    "sandbox tick: sandbox stopped on kill verdict"
                );
                true
            }
        }
        Err(e) => {
            tracing::error!(
                run_id = %job.run_id,
                backend = %job.backend,
                error = %e,
                "sandbox tick: cannot rebuild backend to stop sandbox on kill verdict"
            );
            false
        }
    }
}

/// Record a kill verdict's outcome. Returns whether the run left the registry
/// (stop confirmed). A failed stop marks the run kill-pending instead: it is
/// not proof the billable workspace was terminated, so the run stays
/// registered, is never ticked again, and the stop is retried every cycle.
pub(super) fn record_kill_if_stopped(
    job: &TickJob,
    reason: KillReason,
    accrued: u64,
    stopped: bool,
) -> bool {
    if !stopped {
        if let Some(run) = lock_runs().get_mut(&job.run_id) {
            if run.generation == job.generation {
                run.kill_pending.get_or_insert((reason, accrued));
            }
        }
        return false;
    }
    let removed = {
        let mut runs = lock_runs();
        if runs
            .get(&job.run_id)
            .is_some_and(|run| run.generation != job.generation)
        {
            // A later run re-registered the id; this kill was for an earlier
            // one and must not end it.
            return false;
        }
        runs.remove(&job.run_id).is_some()
    };
    lock_callbacks().remove(&job.run_id);
    lock_kills().insert(
        job.run_id.clone(),
        KillRecord {
            run_id: job.run_id.clone(),
            reason,
            accrued_micro_usd: accrued,
        },
    );
    if removed {
        lock_pending_completions().insert(job.run_id.clone());
    }
    removed
}

/// Test seam: put a registered run into the kill-pending state a failed
/// provider stop leaves behind.
#[cfg(test)]
pub(crate) fn mark_kill_pending_for_test(run_id: &str, reason: KillReason, accrued: u64) {
    if let Some(run) = lock_runs().get_mut(run_id) {
        run.kill_pending.get_or_insert((reason, accrued));
    }
}
