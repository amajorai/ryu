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

use serde_json::json;

use super::spec::SandboxSpec;
use super::{SandboxBackend, WorkspaceId};
use crate::sidecar::gateway::{gateway_bearer, gateway_url};

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
    /// Wall-clock of the previous tick (or registration, for the first tick).
    last_tick_at: Instant,
    /// Monotonic tick counter, starting at 0. The Gateway dedups replays on it.
    tick_index: u64,
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
/// be opened — a budget cap is opt-in, never fail-closed.
pub async fn default_run_budget_micro_usd() -> u64 {
    let Ok(store) = crate::server::preferences::PreferencesStore::open_default() else {
        return 0;
    };
    match store.get(PREF_DEFAULT_RUN_BUDGET).await {
        Ok(Some(raw)) => raw.trim().parse::<u64>().unwrap_or(0),
        _ => 0,
    }
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
            last_tick_at: now,
            tick_index: 0,
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

    let verdict = parse_verdict(value.get("verdict").and_then(|v| v.as_str()).unwrap_or("continue"));
    let accrued = value
        .get("accrued_micro_usd")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);

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

    match SandboxBackend::from_name(&job.backend)
        .and_then(|b| super::build_command_backend(&b))
    {
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
    use crate::sidecar::sandbox::spec::{GpuKind, OsKind};

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
        assert!(kill_record(&run_id).is_none(), "re-register must clear stale kill");
        unregister(&run_id);
    }
}
