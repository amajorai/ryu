//! Run registry: register, unregister, completion, snapshots and the final-debit handoff.

use super::*;

pub(super) fn runs() -> &'static Mutex<HashMap<String, ActiveRun>> {
    static RUNS: OnceLock<Mutex<HashMap<String, ActiveRun>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn kills() -> &'static Mutex<HashMap<String, KillRecord>> {
    static KILLS: OnceLock<Mutex<HashMap<String, KillRecord>>> = OnceLock::new();
    KILLS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn lock_runs() -> std::sync::MutexGuard<'static, HashMap<String, ActiveRun>> {
    runs().lock().unwrap_or_else(|e| e.into_inner())
}

pub(super) fn lock_kills() -> std::sync::MutexGuard<'static, HashMap<String, KillRecord>> {
    kills().lock().unwrap_or_else(|e| e.into_inner())
}

pub(super) fn lock_callbacks() -> std::sync::MutexGuard<'static, HashMap<String, TickCallback>> {
    static CALLBACKS: OnceLock<Mutex<HashMap<String, TickCallback>>> = OnceLock::new();
    CALLBACKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Runs Core stopped metering whose Gateway completion has not been sent yet.
pub(super) fn pending_completions() -> &'static Mutex<HashSet<String>> {
    static PENDING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(super) fn lock_pending_completions() -> std::sync::MutexGuard<'static, HashSet<String>> {
    pending_completions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
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
    register_run(
        run_id,
        org_id,
        backend,
        workspace,
        spec,
        per_run_budget_micro_usd,
        RunOptions::default(),
    );
}

/// [`register`] with the run's [`KillAction`], Box size and Box id. Session
/// and cloud-task Boxes register with [`KillAction::Park`], their actual
/// size, and `spec` = [`crate::box_types::spec_for`] of that size, so the tick
/// meters the Box that exists whatever `RYU_SANDBOX_BOX_SIZE` says.
pub fn register_run(
    run_id: impl Into<String>,
    org_id: Option<String>,
    backend: impl Into<String>,
    workspace: WorkspaceId,
    spec: SandboxSpec,
    per_run_budget_micro_usd: u64,
    options: RunOptions,
) {
    insert_run(
        run_id.into(),
        org_id,
        backend.into(),
        workspace,
        spec,
        per_run_budget_micro_usd,
        options,
    );
    ensure_ticker();
}

pub(super) fn insert_run(
    run_id: String,
    org_id: Option<String>,
    backend: String,
    workspace: WorkspaceId,
    spec: SandboxSpec,
    per_run_budget_micro_usd: u64,
    options: RunOptions,
) {
    static GENERATIONS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let generation = GENERATIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let now = Instant::now();
    lock_runs().insert(
        run_id.clone(),
        ActiveRun {
            generation,
            org_id,
            spec,
            backend,
            workspace,
            per_run_budget_micro_usd,
            started_at: now,
            last_tick_at: now,
            tick_index: 0,
            ticked_seconds: 0,
            last_accrued_micro_usd: 0,
            consecutive_tick_failures: 0,
            tick_failing_since: None,
            kill_action: options.kill_action,
            size: options.size,
            box_id: options.box_id,
            minimum_waiver: options.minimum_waiver,
            last_verdict: None,
            balance_micro_usd: None,
            rate_micro_usd_per_hour: None,
            stopping: false,
            kill_pending: None,
        },
    );
    // A previous kill record for a reused run id is stale once it re-registers,
    // and a queued completion must not clear the new run's Gateway accrual.
    lock_kills().remove(&run_id);
    lock_pending_completions().remove(&run_id);
}

/// Run `callback` after every accepted (`continue` or `warn`) tick of
/// `run_id`, until the run leaves the registry. A later call replaces the
/// earlier hook. Session Boxes use it to send the Box service keepalive.
pub fn on_tick_accepted(run_id: impl Into<String>, callback: TickCallback) {
    lock_callbacks().insert(run_id.into(), callback);
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

/// Deregister a run on normal completion and tell the Gateway to release its
/// accrual state. Idempotent. A run whose kill verdict is still waiting for a
/// confirmed provider stop is left registered, so the stop keeps being retried.
pub fn unregister(run_id: &str) {
    let removed = {
        let mut runs = lock_runs();
        // A kill verdict whose provider teardown is unconfirmed keeps a
        // destroy-on-kill run registered, so the stop keeps being retried. A
        // park-on-kill run (a session Box) is torn down by its owner, whose
        // unregister follows its own park or delete.
        if runs.get(run_id).is_some_and(|run| {
            run.kill_pending.is_some() && matches!(run.kill_action, KillAction::Destroy)
        }) {
            return;
        }
        runs.remove(run_id).is_some()
    };
    lock_callbacks().remove(run_id);
    if removed {
        lock_pending_completions().insert(run_id.to_owned());
        schedule_completion_backstop(run_id.to_owned(), Duration::ZERO);
    }
}

/// Whether a run was stopped by a budget/balance/accounting verdict (and why).
pub fn kill_record(run_id: &str) -> Option<KillRecord> {
    lock_kills().get(run_id).cloned()
}

/// Whether a run received a kill verdict, whether or not its provider stop has
/// been confirmed yet. A terminal run must not execute anything further.
pub fn run_is_terminal(run_id: &str) -> bool {
    lock_runs()
        .get(run_id)
        .is_some_and(|run| run.kill_pending.is_some())
        || lock_kills().contains_key(run_id)
}

/// Tell the Gateway that Core will never tick `run_id` again, so it can drop
/// the run's accrual (and sticky kill) state. Idempotent and best effort:
/// retried a few times, and bounded on the Gateway by idle expiry when lost.
pub async fn complete_run(run_id: &str) {
    lock_pending_completions().remove(run_id);
    let Ok(bearer) = gateway_bearer() else {
        return;
    };
    let endpoint = format!("{}/sandbox/complete", gateway_url().trim_end_matches('/'));
    if let Err(error) = post_completion(&endpoint, &bearer, run_id).await {
        tracing::warn!(
            run_id = %run_id,
            error = %error,
            "sandbox completion: gateway did not confirm; it expires the run when idle"
        );
    }
}

/// POST one completion transition, retrying transport errors and transient
/// statuses.
pub(super) async fn post_completion(
    endpoint: &str,
    bearer: &str,
    run_id: &str,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let body = json!({ "run_id": run_id });
    let mut last_error = String::from("completion not sent");
    for attempt in 1..=COMPLETION_SEND_ATTEMPTS {
        match client
            .post(endpoint)
            .timeout(Duration::from_secs(5))
            .bearer_auth(bearer)
            .json(&body)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) if !is_transient_status(response.status()) => {
                return Err(format!("gateway returned HTTP {}", response.status()));
            }
            Ok(response) => last_error = format!("gateway returned HTTP {}", response.status()),
            Err(error) => last_error = format!("gateway request failed: {error}"),
        }
        if attempt < COMPLETION_SEND_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(250 * attempt)).await;
        }
    }
    Err(last_error)
}

/// Send the completion for `run_id` after `delay`, unless it was already sent
/// or the run id was registered again meanwhile. A no-op outside a runtime.
pub(super) fn schedule_completion_backstop(run_id: String, delay: Duration) {
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    tokio::spawn(async move {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        let still_pending =
            lock_pending_completions().contains(&run_id) && !lock_runs().contains_key(&run_id);
        if still_pending {
            complete_run(&run_id).await;
        }
    });
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
    /// The latest Gateway verdict (`warn` is the low-credit signal).
    pub last_verdict: Option<Verdict>,
    /// The wallet balance the Gateway reported with the latest tick.
    pub balance_micro_usd: Option<i64>,
    /// The Gateway's hourly rate for this run's shape, from its own table.
    pub rate_micro_usd_per_hour: Option<u64>,
    /// The Box id, for a Box run.
    pub box_id: Option<String>,
    /// The Box size, for a Box run.
    pub size: Option<BoxSize>,
    /// A kill verdict landed and its stop is still being retried.
    pub stopping: bool,
    /// The Box service waived this run's per-start minimum (a resume onto
    /// the Box's own parked VM inside the hour already paid for).
    #[serde(default)]
    pub minimum_waived: bool,
}

pub(super) fn snapshot_of(run_id: &str, run: &ActiveRun, now: Instant) -> SandboxRunSnapshot {
    SandboxRunSnapshot {
        run_id: run_id.to_owned(),
        org_id: run.org_id.clone(),
        backend: run.backend.clone(),
        spec: run.spec.clone(),
        elapsed_seconds: now.saturating_duration_since(run.started_at).as_secs(),
        ticked_seconds: run.ticked_seconds,
        tick_index: run.tick_index,
        accrued_micro_usd: run.last_accrued_micro_usd,
        per_run_budget_micro_usd: run.per_run_budget_micro_usd,
        last_verdict: run.last_verdict,
        balance_micro_usd: run.balance_micro_usd,
        rate_micro_usd_per_hour: run.rate_micro_usd_per_hour,
        box_id: run.box_id.clone(),
        size: run.size,
        stopping: run.stopping || run.kill_pending.is_some(),
        minimum_waived: run.minimum_waiver.is_some(),
    }
}

/// Snapshot one live run (running time, cost so far, rate, balance and the
/// latest verdict), or `None` when it is not registered.
pub fn run_snapshot(run_id: &str) -> Option<SandboxRunSnapshot> {
    let now = Instant::now();
    lock_runs()
        .get(run_id)
        .map(|run| snapshot_of(run_id, run, now))
}

/// Snapshot every live, metered sandbox run for the node selector surface.
///
/// Read-only: takes the registry lock, copies each run into a serializable
/// [`SandboxRunSnapshot`], and releases the lock. Never blocks on I/O.
pub fn list_active_runs() -> Vec<SandboxRunSnapshot> {
    let now = Instant::now();
    lock_runs()
        .iter()
        .map(|(run_id, run)| snapshot_of(run_id, run, now))
        .collect()
}

/// Residual metering state captured as a run deregisters, so a caller can issue
/// a single final debit for the tail the periodic ticker never charged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunResidual {
    /// Seconds already metered by the ticker; subtract from the measured total.
    pub ticked_seconds: u64,
    /// The next unused, monotonic tick index — dedup-safe for the final debit
    /// (the ticker never sent this index).
    pub next_tick_index: u64,
    /// The Box size the run registered with, carried into the final debit so
    /// the Gateway prices the tail at the same size rate as the ticks.
    pub size: Option<BoxSize>,
    /// The Box id the run registered with, carried into the final debit so the
    /// tail's ledger row is labelled `box:<id>` like the ticks and the hourly
    /// Box reconcile counts it as paid.
    pub box_id: Option<String>,
    /// The run's signed minimum waiver, carried into the final debit so the
    /// tail is priced the same way as the ticks.
    pub minimum_waiver: Option<String>,
}

/// Deregister a run and return its residual metering state for a final debit.
///
/// Returns `None` when the run is not live (already deregistered, or stopped by
/// a budget/balance/accounting kill verdict — the Gateway already handled or
/// stopped it, so there is no residual tail to bill). A run whose kill verdict
/// is still waiting for a confirmed provider stop is recorded as killed and
/// also returns `None`: the Gateway keeps it terminal and charges nothing more,
/// and the caller is tearing the workspace down. Removing the entry also stops
/// any further periodic ticks for the run, so the caller may safely debit
/// afterward without racing the ticker.
///
/// The Gateway completion follows the final accounting: [`debit_final`] sends
/// it, and a backstop sends it after [`COMPLETION_BACKSTOP_DELAY`] for callers
/// that skip the final debit (no owning org).
pub fn deregister_for_final_debit(run_id: &str) -> Option<RunResidual> {
    lock_callbacks().remove(run_id);
    let run = lock_runs().remove(run_id)?;
    lock_pending_completions().insert(run_id.to_owned());
    schedule_completion_backstop(run_id.to_owned(), COMPLETION_BACKSTOP_DELAY);
    if let Some((reason, accrued_micro_usd)) = run.kill_pending {
        lock_kills().insert(
            run_id.to_owned(),
            KillRecord {
                run_id: run_id.to_owned(),
                reason,
                accrued_micro_usd,
            },
        );
        return None;
    }
    Some(RunResidual {
        ticked_seconds: run.ticked_seconds,
        next_tick_index: run.tick_index,
        size: run.size,
        box_id: run.box_id,
        minimum_waiver: run.minimum_waiver,
    })
}
