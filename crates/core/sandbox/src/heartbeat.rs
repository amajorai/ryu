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
//!   3. On a `kill_budget` / `kill_balance` / `kill_accounting` verdict Core stops the sandbox
//!      with the run's [`KillAction`] — `destroy_workspace` (the SIGKILL/stop
//!      hook) or, for session Boxes, a park that saves state — retrying with
//!      backoff (1 s, 5 s, 30 s, then every 60 s) until the stop is confirmed,
//!      and marks the run killed; on `warn` it records the warning (see
//!      [`run_snapshot`]) and continues. A transient transport failure (Gateway
//!      unreachable, timed out, 5xx, 408, 429) is retried within the cycle and
//!      then gets a bounded grace of [`MAX_CONSECUTIVE_TICK_FAILURES`] ticks or
//!      [`MAX_TICK_FAILURE_GRACE`], whichever ends first, before an org-bound run
//!      is stopped for accounting, so a Gateway restart does not destroy every
//!      live sandbox. Explicit verdicts and protocol
//!      failures (no bearer, other 4xx, an unparseable 2xx) stop it immediately.
//!   4. A run deregisters via [`unregister`] on normal completion. Once Core
//!      will never tick a run again (normal completion after its final
//!      accounting, or a kill whose provider teardown is confirmed) it sends
//!      the Gateway an idempotent `POST {gateway_url}/sandbox/complete` so the
//!      Gateway releases the run's accrual state.
//!   5. A kill verdict is sticky. When the provider stop fails, the run stays
//!      registered as kill-pending: it is never ticked again (the Gateway also
//!      keeps repeating the kill), every cycle retries the provider stop, and
//!      persistent `exec` is refused until the run is gone.
//!
//! Each parsed tick records the Gateway's verdict, balance and hourly rate for
//! the run, so a session can show its cost, rate and a low-credit warning. An
//! accepted tick (`continue` or `warn`) also fires the run's
//! [`on_tick_accepted`] hook, which session Boxes use to renew their Box
//! service liveness lease.
//!
//! Placement (Core-vs-Gateway): keeping a sandbox alive and killing it is "what
//! runs" → Core. Deciding whether the wallet may pay for the next tick is "what
//! is allowed/paid" → the Gateway returns the verdict; Core only enforces it.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;

use super::spec::SandboxSpec;
use super::{BoxFuture, SandboxBackend, WorkspaceId};
use crate::box_types::{BoxSize, ParkReason};
use crate::host::{gateway_bearer, gateway_url};

/// How often the ticker meters each live run. Kept at ≥ 10 s per the contract so
/// a per-tick cost exceeds 1 micro-USD (sub-1-micro ticks round toward 0 and are
/// skipped by the Gateway's `amount == 0` guard).
pub const TICK_INTERVAL: Duration = Duration::from_secs(10);

/// Consecutive ticks an org-bound run may fail transiently (after the in-cycle
/// retries) before Core stops it for accounting: about 30 s of Gateway outage.
/// Explicit `kill_*` verdicts and protocol failures bypass this grace.
const MAX_CONSECUTIVE_TICK_FAILURES: u32 = 3;

/// Longest an org-bound run may keep failing transiently, from its first failed
/// tick, before Core stops it for accounting. The tick loop is sequential, so
/// during a Gateway hang one cycle stretches with the number of live runs; the
/// tick count alone would then let unbilled time grow with every extra run.
const MAX_TICK_FAILURE_GRACE: Duration = Duration::from_secs(30);

/// POST attempts per tick. Retries reuse the same `tick_index`, which the
/// Gateway dedups, so a retried tick that already committed is not re-billed.
const TICK_SEND_ATTEMPTS: u64 = 3;

/// How long after [`deregister_for_final_debit`] the completion backstop waits
/// before telling the Gateway a run is complete. Longer than [`debit_final`]'s
/// worst case (three 5 s attempts plus back-off), which sends the completion
/// itself; the backstop covers callers that skip the final debit.
const COMPLETION_BACKSTOP_DELAY: Duration = Duration::from_secs(60);

/// POST attempts for one completion transition. A completion that is never
/// delivered is bounded by the Gateway's idle expiry.
const COMPLETION_SEND_ATTEMPTS: u64 = 3;

/// Core node preference key holding the default per-run execution budget in
/// micro-USD (`0` = no cap). Written by the desktop Billing UI (implementer E),
/// read here to fill `per_run_budget_micro_usd`. Single source of truth for the
/// budget (a "what runs" cap), so it lives as a Core pref, not a Gateway config.
pub const PREF_DEFAULT_RUN_BUDGET: &str = "sandbox-default-run-budget-micro-usd";

/// Parks one run's Box. Called with why the run is being stopped; `Ok` means
/// the Box service confirmed the park (or that the Box is already stopped,
/// deleted or in error), so metering may end.
pub type ParkFn = Arc<dyn Fn(KillReason) -> BoxFuture<anyhow::Result<()>> + Send + Sync>;

/// What a kill verdict does to a run's sandbox.
#[derive(Clone, Default)]
pub enum KillAction {
    /// Destroy the remote workspace through its backend (the generic sandbox
    /// paths).
    #[default]
    Destroy,
    /// Park the Box (save its state, release its machine). Session and
    /// cloud-task Boxes use this so an exhausted wallet never loses work.
    Park(ParkFn),
}

impl fmt::Debug for KillAction {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Destroy => formatter.write_str("Destroy"),
            Self::Park(_) => formatter.write_str("Park(..)"),
        }
    }
}

/// Optional per-run metering details beyond the generic sandbox shape.
#[derive(Debug, Clone, Default)]
pub struct RunOptions {
    /// What a kill verdict does (default: destroy).
    pub kill_action: KillAction,
    /// The Box size the run was created with. Sent on each tick so a Gateway
    /// with size rates prices by it.
    pub size: Option<BoxSize>,
    /// The Box id, sent on each tick and recorded in the debit attribution.
    pub box_id: Option<String>,
    /// The Box service's signed waiver of this run's per-start minimum
    /// (`PublicBox.billing.waiver`: a resume onto the Box's own parked VM
    /// inside the provider hour already paid for). Forwarded verbatim on each
    /// tick of a Box run as `minimum_waiver`; the Gateway verifies it before
    /// pricing the run in whole minutes only. `None` (the default) keeps the
    /// five-minute minimum.
    pub minimum_waiver: Option<String>,
}

/// The Gateway's verdict for a tick. Snake-case on the wire, as the Gateway
/// sends it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Continue,
    Warn,
    KillBudget,
    KillBalance,
    KillAccounting,
}

/// One accepted (`continue` or `warn`) tick, handed to [`on_tick_accepted`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TickAccepted {
    pub run_id: String,
    pub box_id: Option<String>,
    /// The tick's own index (the one the Gateway accepted).
    pub tick_index: u64,
    pub accrued_micro_usd: u64,
    pub balance_micro_usd: Option<i64>,
    pub verdict: Verdict,
}

/// A hook run after every accepted tick of one run. It is spawned, never
/// awaited by the ticker, so a slow hook cannot delay metering.
pub type TickCallback = Arc<dyn Fn(TickAccepted) -> BoxFuture<()> + Send + Sync>;

/// One live, metered sandbox run.
struct ActiveRun {
    /// Unique per registration. A run id re-registered after its run ended
    /// (a parked Box resumed under the same id) is a new generation, so a
    /// stale stop retry of the old one never acts on it.
    generation: u64,
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
    /// Ticks in a row whose send failed transiently. Reset by every parsed
    /// Gateway response; reaching [`MAX_CONSECUTIVE_TICK_FAILURES`] stops an
    /// org-bound run for accounting.
    consecutive_tick_failures: u32,
    /// When the current transient-failure streak began (`None` without one).
    /// A streak older than [`MAX_TICK_FAILURE_GRACE`] also stops the run.
    tick_failing_since: Option<Instant>,
    /// What a kill verdict does to the sandbox.
    kill_action: KillAction,
    /// The Box size, sent on each tick when known.
    size: Option<BoxSize>,
    /// The Box id, sent on each tick when known.
    box_id: Option<String>,
    /// The Box service's signed waiver of this run's per-start minimum.
    minimum_waiver: Option<String>,
    /// The latest parsed verdict (`warn` stays visible until the next tick).
    last_verdict: Option<Verdict>,
    /// The wallet balance the Gateway reported with the latest tick.
    balance_micro_usd: Option<i64>,
    /// The Gateway's hourly rate for this run's shape.
    rate_micro_usd_per_hour: Option<u64>,
    /// A kill is in progress (its stop is being retried); further kill
    /// verdicts do not start a second one.
    stopping: bool,
    /// A kill verdict whose provider stop has not been confirmed yet, with the
    /// accrued figure at kill time. Sticky: the run is never ticked again and
    /// each cycle retries the stop until it succeeds.
    kill_pending: Option<(KillReason, u64)>,
}

/// Why a run left the registry, for observability + a future run-lifecycle join.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KillReason {
    /// The per-run budget cap was reached (`kill_budget`).
    Budget,
    /// The org wallet balance went non-positive (`kill_balance`).
    Balance,
    /// The billing path could not be confirmed: a `kill_accounting` verdict or a
    /// protocol failure (immediate), or a transient Gateway transport failure
    /// streak of [`MAX_CONSECUTIVE_TICK_FAILURES`] ticks or
    /// [`MAX_TICK_FAILURE_GRACE`].
    Accounting,
}

impl KillReason {
    /// The `stopReason` a session shows: `budget`, `balance` or `accounting`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Budget => "budget",
            Self::Balance => "balance",
            Self::Accounting => "accounting",
        }
    }

    /// The Box service park reason. The service has no `accounting` reason:
    /// an unconfirmable debit stops the Box as an unpaid one, `balance`.
    pub fn park_reason(self) -> ParkReason {
        match self {
            Self::Budget => ParkReason::Budget,
            Self::Balance | Self::Accounting => ParkReason::Balance,
        }
    }
}

/// A record of a run stopped by a budget, balance, or accounting verdict.
#[derive(Debug, Clone)]
pub struct KillRecord {
    pub run_id: String,
    pub reason: KillReason,
    /// Cumulative billed micro-USD reported by the Gateway at kill time.
    pub accrued_micro_usd: u64,
}

mod cycle;
mod debit;
mod deliver;
mod kill;
mod registry;

use cycle::*;
#[cfg(test)]
use debit::*;
pub use debit::{debit_final, quote_rate, quote_rate_at};
use deliver::*;
#[cfg(test)]
pub(crate) use kill::mark_kill_pending_for_test;
use kill::*;
use registry::*;
pub use registry::{
    complete_run, default_run_budget_micro_usd, deregister_for_final_debit, kill_record,
    list_active_runs, on_tick_accepted, register, register_run, register_with_default_budget,
    run_is_terminal, run_snapshot, unregister, RunResidual, SandboxRunSnapshot,
};

#[cfg(test)]
mod tests;
