//! Sandbox metering heartbeat: the Core→Gateway billing tick loop.
//!
//! While a remote (billable) sandbox run is live, Core must keep the Gateway
//! informed of elapsed wall-clock so the Gateway can meter + debit against the
//! run's wallet, and Core must enforce whatever budget verdict the Gateway
//! returns. This module owns that loop:
//!
//!   1. A run registers via [`register`] when its sandbox is created.
//!   2. A single background ticker (started lazily, once) wakes every
//!      [`TICK_INTERVAL`] (~10 s — kept ≥ 10 s so per-tick cost clears the
//!      Gateway's sub-1-micro rounding guard) and, for each live run, POSTs
//!      `{gateway_url}/sandbox/tick` with the elapsed second-delta, the billed
//!      [`SandboxSpec`], the per-run budget, and a monotonic `tick_index`.
//!   3. On a `kill_budget` / `kill_balance` verdict Core stops the sandbox
//!      (`destroy_workspace` — the SIGKILL/stop hook) and marks the run killed;
//!      on `warn` it logs and continues.
//!   4. A run deregisters via [`unregister`] on normal completion.
//!
//! Placement (Core-vs-Gateway): keeping a sandbox alive and killing it is "what
//! runs" → Core. Deciding whether the wallet may pay for the next tick is "what
//! is allowed/paid" → the Gateway returns the verdict; Core only enforces it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;

use super::spec::SandboxSpec;
use super::{SandboxBackend, WorkspaceId};
use crate::host::{gateway_bearer, gateway_url};

/// How often the ticker meters each live run. Kept at ≥ 10 s per the contract so
/// a per-tick cost exceeds 1 micro-USD (sub-1-micro ticks round toward 0 and are
/// skipped by the Gateway's `amount == 0` guard).
pub const TICK_INTERVAL: Duration = Duration::from_secs(10);

/// Core node preference key holding the default per-run execution budget in
/// micro-USD (`0` = no cap). Written by the desktop Billing UI (implementer E),
/// read here to fill `per_run_budget_micro_usd`. Single source of truth for the
/// budget (a "what runs" cap), so it lives as a Core pref, not a Gateway config.
pub const PREF_DEFAULT_RUN_BUDGET: &str = "sandbox-default-run-budget-micro-usd";

/// One live, metered sandbox run.
struct ActiveRun {
    /// Owning org, or `None` when Core cannot resolve one (billing skipped, the
    /// Gateway never returns `kill_balance` in that case).
    org_id: Option<String>,
    /// The billed resource shape, sent verbatim to the Gateway each tick.
    spec: SandboxSpec,
    /// Backend name the run's workspace belongs to (used to rebuild the backend
    /// for [`super::build_command_backend`] when a kill verdict lands).
    backend: String,
    /// Opaque remote workspace/sandbox id to stop on a kill verdict.
    workspace: WorkspaceId,
    /// Per-run execution cap in micro-USD; `0` = no cap.
    per_run_budget_micro_usd: u64,
    /// Wall-clock at registration, for the run's total elapsed in a snapshot.
    started_at: Instant,
    /// Wall-clock of the previous tick (or registration, for the first tick).
    last_tick_at: Instant,
    /// Monotonic tick counter, starting at 0. The Gateway dedups replays on it.
    tick_index: u64,
    /// Seconds already metered to the Gateway by the periodic ticker. A final
    /// one-shot debit charges only `measured - ticked_seconds` so the ticker and
    /// the final debit never double-bill. Advanced optimistically each tick
    /// (matching `last_tick_at`), regardless of send success.
    ticked_seconds: u64,
    /// Cumulative billed micro-USD last reported by the Gateway (0 until the
    /// first tick returns). Surfaced in [`SandboxRunSnapshot`] for billing
    /// visibility; never used to make a cost decision (the Gateway prices).
    last_accrued_micro_usd: u64,
}

/// Why a run left the registry, for observability + a future run-lifecycle join.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KillReason {
    /// The per-run budget cap was reached (`kill_budget`).
    Budget,
    /// The org wallet balance went non-positive (`kill_balance`).
    Balance,
}

/// A record of a budget-killed run, retained so callers can mark the run.
#[derive(Debug, Clone)]
pub struct KillRecord {
    pub run_id: String,
    pub reason: KillReason,
    /// Cumulative billed micro-USD reported by the Gateway at kill time.
    pub accrued_micro_usd: u64,
}

fn runs() -> &'static Mutex<HashMap<String, ActiveRun>> {
    static RUNS: OnceLock<Mutex<HashMap<String, ActiveRun>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn kills() -> &'static Mutex<HashMap<String, KillRecord>> {
    static KILLS: OnceLock<Mutex<HashMap<String, KillRecord>>> = OnceLock::new();
    KILLS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_runs() -> std::sync::MutexGuard<'static, HashMap<String, ActiveRun>> {
    runs().lock().unwrap_or_else(|e| e.into_inner())
}

fn lock_kills() -> std::sync::MutexGuard<'static, HashMap<String, KillRecord>> {
    kills().lock().unwrap_or_else(|e| e.into_inner())
}

/// Read the default per-run budget (micro-USD) from the Core preferences store.
/// Returns `0` (no cap) when the pref is unset, unparseable, or the store cannot
/// be opened — a budget cap is opt-in, never fail-closed. The preferences read
/// itself lives Core-side, injected via the [`crate::host`] seam.
pub async fn default_run_budget_micro_usd() -> u64 {
    crate::host::default_run_budget_micro_usd().await
}

/// Register a live sandbox run for metering and ensure the ticker is running.
///
/// `per_run_budget_micro_usd` is the execution cap (`0` = none); callers that
/// want the node default should pass [`default_run_budget_micro_usd`]. Re-
/// registering the same `run_id` replaces the prior entry (its tick counter
/// resets, matching a fresh sandbox).
pub fn register(
    run_id: impl Into<String>,
    org_id: Option<String>,
    backend: impl Into<String>,
    workspace: WorkspaceId,
    spec: SandboxSpec,
    per_run_budget_micro_usd: u64,
) {
    let run_id = run_id.into();
    let now = Instant::now();
    lock_runs().insert(
        run_id.clone(),
        ActiveRun {
            org_id,
            spec,
            backend: backend.into(),
            workspace,
            per_run_budget_micro_usd,
            started_at: now,
            last_tick_at: now,
            tick_index: 0,
            ticked_seconds: 0,
            last_accrued_micro_usd: 0,
        },
    );
    // A previous kill record for a reused run id is stale once it re-registers.
    lock_kills().remove(&run_id);
    ensure_ticker();
}

/// Register a run using the node's default per-run budget preference
/// (`sandbox-default-run-budget-micro-usd`). The natural entry point for a run
/// that has not been given an explicit cap: it resolves the Core pref, then
/// defers to [`register`].
pub async fn register_with_default_budget(
    run_id: impl Into<String>,
    org_id: Option<String>,
    backend: impl Into<String>,
    workspace: WorkspaceId,
    spec: SandboxSpec,
) {
    let budget = default_run_budget_micro_usd().await;
    register(run_id, org_id, backend, workspace, spec, budget);
}

/// Deregister a run on normal completion. Idempotent.
pub fn unregister(run_id: &str) {
    lock_runs().remove(run_id);
}

/// Whether a run was stopped by a budget/balance verdict (and why).
pub fn kill_record(run_id: &str) -> Option<KillRecord> {
    lock_kills().get(run_id).cloned()
}

/// A serializable point-in-time view of one live, metered sandbox run, exposed
/// to the node selector via `GET /api/sandboxes` so a client can see which
/// remote (billable) sandboxes a node is currently running.
#[derive(Debug, Clone, Serialize)]
pub struct SandboxRunSnapshot {
    /// The run's unique id (the uuid minted at register time).
    pub run_id: String,
    /// Owning/bill-to org, or `null` when Core could not resolve one.
    pub org_id: Option<String>,
    /// Sandbox backend the run belongs to (e.g. `"daytona"`).
    pub backend: String,
    /// The billed resource shape reported to the Gateway each tick.
    pub spec: SandboxSpec,
    /// Wall-clock seconds since the run registered.
    pub elapsed_seconds: u64,
    /// Seconds already metered to the Gateway by the periodic ticker.
    pub ticked_seconds: u64,
    /// Monotonic tick counter (number of ticks issued so far).
    pub tick_index: u64,
    /// Cumulative billed micro-USD last reported by the Gateway (`0` until the
    /// first tick returns).
    pub accrued_micro_usd: u64,
    /// Per-run execution cap in micro-USD; `0` = no cap.
    pub per_run_budget_micro_usd: u64,
}

/// Snapshot every live, metered sandbox run for the node selector surface.
///
/// Read-only: takes the registry lock, copies each run into a serializable
/// [`SandboxRunSnapshot`], and releases the lock. Never blocks on I/O.
pub fn list_active_runs() -> Vec<SandboxRunSnapshot> {
    let now = Instant::now();
    lock_runs()
        .iter()
        .map(|(run_id, run)| SandboxRunSnapshot {
            run_id: run_id.clone(),
            org_id: run.org_id.clone(),
            backend: run.backend.clone(),
            spec: run.spec.clone(),
            elapsed_seconds: now.saturating_duration_since(run.started_at).as_secs(),
            ticked_seconds: run.ticked_seconds,
            tick_index: run.tick_index,
            accrued_micro_usd: run.last_accrued_micro_usd,
            per_run_budget_micro_usd: run.per_run_budget_micro_usd,
        })
        .collect()
}

/// Residual metering state captured as a run deregisters, so a caller can issue
/// a single final debit for the tail the periodic ticker never charged.
#[derive(Debug, Clone, Copy)]
pub struct RunResidual {
    /// Seconds already metered by the ticker; subtract from the measured total.
    pub ticked_seconds: u64,
    /// The next unused, monotonic tick index — dedup-safe for the final debit
    /// (the ticker never sent this index).
    pub next_tick_index: u64,
}

/// Deregister a run and return its residual metering state for a final debit.
///
/// Returns `None` when the run is not live (already deregistered, or stopped by
/// a budget/balance kill verdict — the Gateway already charged/killed it, so
/// there is no residual tail to bill). Removing the entry also stops any further
/// periodic ticks for the run, so the caller may safely debit afterward without
/// racing the ticker.
pub fn deregister_for_final_debit(run_id: &str) -> Option<RunResidual> {
    lock_runs().remove(run_id).map(|run| RunResidual {
        ticked_seconds: run.ticked_seconds,
        next_tick_index: run.tick_index,
    })
}

/// Issue a single final metering debit for a completed one-shot run's un-ticked
/// tail (rounded-up seconds). Call it after [`deregister_for_final_debit`] so
/// the periodic ticker can no longer fire for the run — this charges the
/// remainder the ticker missed (typically a sub-[`TICK_INTERVAL`] run the ticker
/// never saw).
///
/// Fully fail-open: a gateway/auth/transport error is logged and swallowed so it
/// can never fail the user's sandbox exec. `seconds == 0` is a no-op. This is a
/// standalone POST (not routed through the ticker's `send_tick`) because the run
/// has already completed — there is nothing left to kill, so no verdict is
/// enforced, only logged.
pub async fn debit_final(
    run_id: String,
    org_id: Option<String>,
    spec: SandboxSpec,
    seconds: u64,
    per_run_budget_micro_usd: u64,
    tick_index: u64,
) {
    if seconds == 0 {
        return;
    }
    let bearer = match gateway_bearer() {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(run_id = %run_id, error = %e, "sandbox final debit: no gateway bearer, tail not billed (fail-open)");
            return;
        }
    };
    let endpoint = format!("{}/sandbox/tick", gateway_url().trim_end_matches('/'));
    let body = json!({
        "run_id": run_id,
        "org_id": org_id,
        "spec": spec,
        "elapsed_seconds_delta": seconds,
        "tick_index": tick_index,
        "per_run_budget_micro_usd": per_run_budget_micro_usd,
    });

    let resp = reqwest::Client::new()
        .post(&endpoint)
        .timeout(Duration::from_secs(5))
        .bearer_auth(bearer)
        .json(&body)
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            let accrued = r
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| {
                    v.get("accrued_micro_usd")
                        .and_then(serde_json::Value::as_u64)
                })
                .unwrap_or(0);
            tracing::info!(
                run_id = %run_id,
                seconds,
                accrued_micro_usd = accrued,
                "sandbox final debit: un-ticked tail reported to gateway"
            );
        }
        Ok(r) => {
            tracing::warn!(run_id = %run_id, status = %r.status(), "sandbox final debit: gateway non-2xx, tail not billed (fail-open)");
        }
        Err(e) => {
            tracing::warn!(run_id = %run_id, error = %e, "sandbox final debit: gateway unreachable, tail not billed (fail-open)");
        }
    }
}

/// Snapshot of the fields needed to send one tick, taken under the registry lock
/// so the async HTTP call happens without holding it.
struct TickJob {
    run_id: String,
    org_id: Option<String>,
    spec: SandboxSpec,
    backend: String,
    workspace: WorkspaceId,
    per_run_budget_micro_usd: u64,
    elapsed_seconds_delta: u64,
    tick_index: u64,
}

/// The Gateway's verdict for a tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Continue,
    Warn,
    KillBudget,
    KillBalance,
}

fn parse_verdict(raw: &str) -> Verdict {
    match raw {
        "warn" => Verdict::Warn,
        "kill_budget" => Verdict::KillBudget,
        "kill_balance" => Verdict::KillBalance,
        // `continue` and anything unknown → keep running (fail-open on metering).
        _ => Verdict::Continue,
    }
}

/// Start the single background ticker exactly once.
///
/// A no-op when called outside a Tokio runtime (e.g. a sync unit test): there is
/// nothing to drive the loop, and `STARTED` stays `false` so a later call from
/// within the runtime still starts it.
fn ensure_ticker() {
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

/// One metering pass over every live run.
async fn run_tick_cycle() {
    // Take a snapshot under the lock, advancing each run's tick_index +
    // last_tick_at optimistically so the loop never holds the lock across await.
    let jobs: Vec<TickJob> = {
        let mut guard = lock_runs();
        let now = Instant::now();
        let mut jobs = Vec::with_capacity(guard.len());
        for (run_id, run) in guard.iter_mut() {
            let elapsed = now.saturating_duration_since(run.last_tick_at).as_secs();
            let tick_index = run.tick_index;
            run.last_tick_at = now;
            run.tick_index = run.tick_index.saturating_add(1);
            // Optimistic, matching `last_tick_at`: count the elapsed seconds as
            // metered even if the send below fails (a lost delta, same as the
            // ticker already drops on a failed post). Keeps the final-debit
            // remainder consistent with the ticker's own accounting.
            run.ticked_seconds = run.ticked_seconds.saturating_add(elapsed);
            jobs.push(TickJob {
                run_id: run_id.clone(),
                org_id: run.org_id.clone(),
                spec: run.spec.clone(),
                backend: run.backend.clone(),
                workspace: run.workspace.clone(),
                per_run_budget_micro_usd: run.per_run_budget_micro_usd,
                elapsed_seconds_delta: elapsed,
                tick_index,
            });
        }
        jobs
    };

    for job in jobs {
        // Skip a zero-second delta (nothing accrued): avoids a pointless round-trip.
        if job.elapsed_seconds_delta == 0 {
            continue;
        }
        send_tick(job).await;
    }
}

/// Send one `POST /sandbox/tick` and enforce its verdict.
async fn send_tick(job: TickJob) {
    let bearer = match gateway_bearer() {
        Ok(b) => b,
        Err(e) => {
            // No governed endpoint to reach (remote plane w/o token). Metering is
            // fail-open: log and keep the sandbox running.
            tracing::warn!(run_id = %job.run_id, error = %e, "sandbox tick: no gateway bearer, skipping");
            return;
        }
    };
    let endpoint = format!("{}/sandbox/tick", gateway_url().trim_end_matches('/'));
    let body = json!({
        "run_id": job.run_id,
        "org_id": job.org_id,
        "spec": job.spec,
        "elapsed_seconds_delta": job.elapsed_seconds_delta,
        "tick_index": job.tick_index,
        "per_run_budget_micro_usd": job.per_run_budget_micro_usd,
    });

    let resp = reqwest::Client::new()
        .post(&endpoint)
        .timeout(Duration::from_secs(5))
        .bearer_auth(bearer)
        .json(&body)
        .send()
        .await;

    let value = match resp {
        Ok(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(run_id = %job.run_id, error = %e, "sandbox tick: unparseable verdict, continuing");
                return;
            }
        },
        Ok(r) => {
            tracing::warn!(run_id = %job.run_id, status = %r.status(), "sandbox tick: gateway non-2xx, continuing");
            return;
        }
        Err(e) => {
            // Fail-open: a transient gateway blink must not kill a running job.
            tracing::warn!(run_id = %job.run_id, error = %e, "sandbox tick: gateway unreachable, continuing");
            return;
        }
    };

    let verdict = parse_verdict(
        value
            .get("verdict")
            .and_then(|v| v.as_str())
            .unwrap_or("continue"),
    );
    let accrued = value
        .get("accrued_micro_usd")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);

    // Record the latest accrued figure for the billing-visibility snapshot. Only
    // if the run is still live (a kill verdict removes it just below).
    if let Some(run) = lock_runs().get_mut(&job.run_id) {
        run.last_accrued_micro_usd = accrued;
    }

    match verdict {
        Verdict::Continue => {}
        Verdict::Warn => {
            tracing::warn!(
                run_id = %job.run_id,
                accrued_micro_usd = accrued,
                "sandbox tick: budget/balance warning"
            );
        }
        Verdict::KillBudget | Verdict::KillBalance => {
            let reason = if verdict == Verdict::KillBudget {
                KillReason::Budget
            } else {
                KillReason::Balance
            };
            tracing::warn!(
                run_id = %job.run_id,
                accrued_micro_usd = accrued,
                reason = ?reason,
                "sandbox tick: kill verdict, stopping sandbox"
            );
            enforce_kill(&job, reason, accrued).await;
        }
    }
}

/// Stop a sandbox on a kill verdict and mark the run: destroy the remote
/// workspace, drop it from the live registry, and record the kill.
async fn enforce_kill(job: &TickJob, reason: KillReason, accrued: u64) {
    // Remove from the live set first so no further ticks fire for it.
    lock_runs().remove(&job.run_id);

    match SandboxBackend::from_name(&job.backend).and_then(|b| super::build_command_backend(&b)) {
        Ok(backend) => {
            if let Err(e) = backend.destroy_workspace(&job.workspace).await {
                tracing::error!(
                    run_id = %job.run_id,
                    workspace = %job.workspace.0,
                    error = %e,
                    "sandbox tick: failed to stop sandbox on kill verdict (may leak a remote sandbox)"
                );
            } else {
                tracing::info!(
                    run_id = %job.run_id,
                    workspace = %job.workspace.0,
                    "sandbox tick: sandbox stopped on kill verdict"
                );
            }
        }
        Err(e) => {
            tracing::error!(
                run_id = %job.run_id,
                backend = %job.backend,
                error = %e,
                "sandbox tick: cannot rebuild backend to stop sandbox on kill verdict"
            );
        }
    }

    lock_kills().insert(
        job.run_id.clone(),
        KillRecord {
            run_id: job.run_id.clone(),
            reason,
            accrued_micro_usd: accrued,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::{GpuKind, OsKind};

    fn sample_spec() -> SandboxSpec {
        SandboxSpec {
            vcpu: 2,
            mem_gib: 4,
            storage_gib: 10,
            gpu: GpuKind::None,
            gpu_count: 0,
            os: OsKind::Linux,
        }
    }

    #[test]
    fn verdict_parsing_is_frozen() {
        assert_eq!(parse_verdict("continue"), Verdict::Continue);
        assert_eq!(parse_verdict("warn"), Verdict::Warn);
        assert_eq!(parse_verdict("kill_budget"), Verdict::KillBudget);
        assert_eq!(parse_verdict("kill_balance"), Verdict::KillBalance);
        // Unknown verdicts fail open to Continue.
        assert_eq!(parse_verdict("explode"), Verdict::Continue);
    }

    #[test]
    fn register_and_unregister_roundtrip() {
        let run_id = format!("run_test_{}", std::process::id());
        register(
            &run_id,
            Some("org_1".to_owned()),
            "daytona",
            WorkspaceId("ws_1".to_owned()),
            sample_spec(),
            1_000_000,
        );
        assert!(lock_runs().contains_key(&run_id));
        unregister(&run_id);
        assert!(!lock_runs().contains_key(&run_id));
    }

    #[test]
    fn re_registering_clears_stale_kill_record() {
        let run_id = format!("run_kill_{}", std::process::id());
        lock_kills().insert(
            run_id.clone(),
            KillRecord {
                run_id: run_id.clone(),
                reason: KillReason::Budget,
                accrued_micro_usd: 42,
            },
        );
        register(
            &run_id,
            None,
            "daytona",
            WorkspaceId("ws_2".to_owned()),
            sample_spec(),
            0,
        );
        assert!(
            kill_record(&run_id).is_none(),
            "re-register must clear stale kill"
        );
        unregister(&run_id);
    }
}
