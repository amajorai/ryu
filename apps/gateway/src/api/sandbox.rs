use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::{extract::State, http::HeaderMap, Json};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

mod minimum_waiver;

use crate::{
    config::{box_billable_seconds, CreditsConfig, GpuKind, OsKind, SandboxSize},
    error::GatewayError,
    pipeline::{authenticate, AuthInputs},
    state::SharedState,
};

/// Canonical sandbox resource spec (Daytona-shaped). Core mirrors this struct —
/// and the `GpuKind`/`OsKind` enums it imports from `crate::config` — byte-for-byte
/// in `apps/core/src/sidecar/sandbox/spec.rs`. The serde wire strings are frozen
/// (see the sandbox metering contract); do not rely on `rename_all`.
///
/// Canonical wire JSON:
/// `{ "vcpu": 2, "mem_gib": 4, "storage_gib": 10, "gpu": "none", "gpu_count": 0, "os": "linux" }`
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SandboxSpec {
    pub vcpu: u32,
    pub mem_gib: u32,
    pub storage_gib: u32,
    pub gpu: GpuKind,
    /// 0 for `None`; if `gpu != None` and 0 the cost math treats it as 1.
    #[serde(default)]
    pub gpu_count: u32,
    pub os: OsKind,
}

/// Body accepted by `POST /sandbox/tick`.
///
/// Core posts one tick per run per heartbeat interval. `org_id` is `None` when
/// Core cannot resolve an org (billing is skipped and `kill_balance` never
/// fires). `per_run_budget_micro_usd == 0` means "no per-run cap".
#[derive(Debug, Deserialize)]
pub struct SandboxTickBody {
    /// Sandbox run identifier; the accrual key.
    pub run_id: String,
    /// Org whose wallet is debited. `None` ⇒ meter + budget-kill only, no debit.
    #[serde(default)]
    pub org_id: Option<String>,
    /// Provisioned resources being billed.
    pub spec: SandboxSpec,
    /// Seconds elapsed since Core's previous tick for this run.
    pub elapsed_seconds_delta: u64,
    /// Monotonic tick counter from 0. Guards against double-accrual on retry.
    pub tick_index: u64,
    /// Per-run execution cap in micro-USD. `0` ⇒ no cap.
    #[serde(default)]
    pub per_run_budget_micro_usd: u64,
    /// The Box size, for a session or cloud-task Box. Prices the tick when
    /// `sandbox_size_rates` is configured; otherwise recorded only.
    #[serde(default)]
    pub size: Option<SandboxSize>,
    /// The Box id, recorded in the debit attribution so reconciliation can
    /// match ledger debits to Box running time.
    #[serde(default)]
    pub box_id: Option<String>,
    /// The run's metered seconds after this tick (every delta Core has
    /// metered for the run, this one included). Sent with Box runs. A sized
    /// tick that carries it is priced from the body alone
    /// ([`stateless_sized_charge`]), so every Gateway replica, and a Gateway
    /// that restarted, charges the same per-start minimum and whole minutes.
    /// Without it (an older Core) the tick is priced from this process's own
    /// run meter.
    #[serde(default)]
    pub elapsed_seconds_total: Option<u64>,
    /// The Box service's signed waiver of this run's per-start minimum
    /// (`PublicBox.billing.waiver`): the run is a resume onto the Box's own
    /// parked VM inside the provider hour its last charged start there
    /// already paid for. The run is priced in whole minutes only when the
    /// token verifies under `box_minimum_waiver_public_key` for this tick's
    /// Box, org and start ([`minimum_waiver::verify`]): the run must have begun
    /// at the signed `startedAtMs` (within a small clock-skew allowance), not
    /// merely before the paid hour ends. The forwarder key alone never waives a
    /// minimum: absent, forged, another Box's or another start's waiver (and a
    /// bare `minimum_waived` flag, which is ignored) keeps the five-minute
    /// minimum.
    #[serde(default)]
    pub minimum_waiver: Option<String>,
}

/// Whether `body`'s per-start minimum is waived: it carries a waiver the Box
/// service signed for this Box, org and start (see [`minimum_waiver`]).
fn minimum_waived(credits: &CreditsConfig, body: &SandboxTickBody, now_ms: i64) -> bool {
    let Some(token) = body.minimum_waiver.as_deref() else {
        return false;
    };
    let run = minimum_waiver::WaiverRun {
        box_id: body.box_id.as_deref(),
        org_id: body.org_id.as_deref(),
        elapsed_seconds_total: body.elapsed_seconds_total,
        now_ms,
    };
    match minimum_waiver::verify(
        credits.box_minimum_waiver_public_key.as_deref(),
        token,
        &run,
    ) {
        Ok(_) => true,
        Err(minimum_waiver::WaiverRejection::NoKey) => {
            tracing::debug!(
                run_id = %body.run_id,
                "sandbox tick carried a minimum waiver but no GATEWAY_BOX_MINIMUM_WAIVER_PUBLIC_KEY is set; charging the per-start minimum"
            );
            false
        }
        Err(reason) => {
            tracing::warn!(
                run_id = %body.run_id,
                ?reason,
                "sandbox tick carried a minimum waiver that does not hold; charging the per-start minimum"
            );
            false
        }
    }
}

/// Unix milliseconds now.
fn unix_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

/// Longest Box id accepted on a tick (`bx_` plus 32 hex is 35).
const MAX_BOX_ID_CHARS: usize = 64;

/// A Box id safe to put in a ledger attribution: 1–64 of `[A-Za-z0-9_-]`.
fn valid_box_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_BOX_ID_CHARS
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// What one tick costs and the hourly rate it was priced at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TickPrice {
    /// The marked-up (or size-rate) micro-USD to accrue and debit.
    billed_micro: u64,
    /// The customer rate for this run's shape, micro-USD per hour.
    rate_micro_usd_per_hour: u64,
}

/// Price one tick's delta on its own: a sized tick at the size's hourly rate
/// when size rates are configured (the default), else the per-resource math
/// (raw cost, then the sandbox markup). The rate is what Core shows; a sized
/// tick's billed amount is replaced by [`sized_tick_charge`], which applies
/// the run's per-start minimum and whole-minute rounding.
fn price_tick(credits: &CreditsConfig, body: &SandboxTickBody) -> TickPrice {
    price_shape(credits, &body.spec, body.size, body.elapsed_seconds_delta)
}

/// What a run has been metered for, kept per run in [`accrual_map`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RunMeter {
    /// Seconds of every accepted tick so far.
    elapsed_seconds: u64,
    /// Whether the run's per-start minimum applies: its first accepted tick
    /// was tick 0. A run first seen mid-way (after a Gateway restart) paid its
    /// minimum before the restart.
    minimum: bool,
}

/// The size-rate charge of one tick of a Box run: the run's billable seconds
/// after the tick ([`box_billable_seconds`]: whole minutes, at least five per
/// start), priced cumulatively, less what its earlier ticks were charged. The
/// first tick of a run therefore pays the five-minute minimum, and the ticks
/// after it pay nothing until the run passes it. `None` without size rates
/// or a size.
fn sized_tick_charge(
    credits: &CreditsConfig,
    size: Option<SandboxSize>,
    before: Option<RunMeter>,
    after: RunMeter,
) -> Option<u64> {
    let size = size?;
    let total = |meter: RunMeter| {
        credits.sandbox_size_debit_micro(
            size,
            box_billable_seconds(meter.elapsed_seconds, meter.minimum),
        )
    };
    let charged_before = match before {
        Some(meter) => total(meter)?,
        None => 0,
    };
    Some(total(after)?.saturating_sub(charged_before))
}

/// The size-rate charge of one Box tick from the tick body alone: the run's
/// billable seconds after it (`elapsed_seconds_total`, at least five minutes,
/// whole minutes), priced, less the same for the run before it
/// (`elapsed_seconds_total - elapsed_seconds_delta`; a run with no seconds
/// before has been charged nothing). `minimum` is false for a run whose
/// per-start minimum was waived (whole minutes only). Every tick of a run is priced the same
/// way wherever it lands, so the ticks of a run sum to its billable time at
/// the size rate, and a tick delivered to two replicas is the same debit
/// (deduplicated on its ref id by the control plane). `None` without size
/// rates or a size.
fn stateless_sized_charge(
    credits: &CreditsConfig,
    size: Option<SandboxSize>,
    elapsed_seconds_total: u64,
    elapsed_seconds_delta: u64,
    minimum: bool,
) -> Option<u64> {
    let size = size?;
    let charged = |seconds: u64| {
        if seconds == 0 {
            return Some(0);
        }
        credits.sandbox_size_debit_micro(size, box_billable_seconds(seconds, minimum))
    };
    let before = elapsed_seconds_total.saturating_sub(elapsed_seconds_delta);
    Some(charged(elapsed_seconds_total)?.saturating_sub(charged(before)?))
}

/// What one accepted tick of `body` is charged: a sized Box tick that carries
/// the run's total from the body alone ([`stateless_sized_charge`]), else
/// from this process's run meter ([`sized_tick_charge`]), else `flat` (the
/// per-resource price). A run whose minimum the Box service waived (`waived`,
/// from a verified [`minimum_waiver`]) is charged whole minutes only on
/// either path.
fn tick_charge(
    credits: &CreditsConfig,
    body: &SandboxTickBody,
    waived: bool,
    before: Option<RunMeter>,
    after: RunMeter,
    flat: u64,
) -> u64 {
    let minimum = !waived;
    let waive = |meter: RunMeter| RunMeter {
        minimum: meter.minimum && minimum,
        ..meter
    };
    body.elapsed_seconds_total
        .and_then(|total| {
            stateless_sized_charge(
                credits,
                body.size,
                total,
                body.elapsed_seconds_delta,
                minimum,
            )
        })
        .or_else(|| sized_tick_charge(credits, body.size, before.map(waive), waive(after)))
        .unwrap_or(flat)
}

/// Price `seconds` of a sandbox of `spec` (and Box `size`, when it has one).
/// The tick and the quote both price through here, so a quote is exactly the
/// rate the run's ticks will be billed at.
fn price_shape(
    credits: &CreditsConfig,
    spec: &SandboxSpec,
    size: Option<SandboxSize>,
    seconds: u64,
) -> TickPrice {
    if let Some(size) = size {
        if let (Some(billed_micro), Some(rate)) = (
            credits.sandbox_size_debit_micro(size, seconds),
            credits.sandbox_size_debit_micro(size, 3600),
        ) {
            return TickPrice {
                billed_micro,
                rate_micro_usd_per_hour: rate,
            };
        }
    }
    let raw_for = |seconds: u64| {
        credits.sandbox_tick_cost_raw_micro(
            spec.vcpu,
            spec.mem_gib,
            spec.storage_gib,
            spec.gpu,
            spec.gpu_count,
            spec.os,
            seconds,
        )
    };
    TickPrice {
        billed_micro: credits.sandbox_debit_amount(raw_for(seconds)),
        rate_micro_usd_per_hour: credits.sandbox_debit_amount(raw_for(3600)),
    }
}

/// Body accepted by `POST /sandbox/quote`: the shape a run would be ticked
/// with, before it exists.
#[derive(Debug, Deserialize)]
pub struct SandboxQuoteBody {
    /// Provisioned resources the run would be billed for.
    pub spec: SandboxSpec,
    /// The Box size, for a session or cloud-task Box.
    #[serde(default)]
    pub size: Option<SandboxSize>,
}

/// Response from `POST /sandbox/quote`.
#[derive(Debug, Serialize)]
pub struct SandboxQuoteResponse {
    /// The customer rate the run's ticks would be billed at, micro-USD per
    /// hour, from this Gateway's own rate table (the size table when one is
    /// configured, else the per-resource rates plus the sandbox markup).
    pub rate_micro_usd_per_hour: u64,
}

/// `POST /sandbox/quote` — the hourly rate a sandbox of this shape would be
/// billed at. Core's credit pre-flight checks a new Box against it, so the
/// pre-flight and the ticks always read the same rate table. Same auth as
/// [`sandbox_tick`]: trusted-forwarder or master key.
pub async fn sandbox_quote(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<SandboxQuoteBody>,
) -> Result<Json<SandboxQuoteResponse>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    let is_trusted =
        ctx.is_master_key || ctx.key_config.as_ref().is_some_and(|k| k.trusted_forwarder);
    if !is_trusted {
        return Err(GatewayError::Unauthorized(
            "Sandbox quote requires a trusted-forwarder or master key.".to_string(),
        ));
    }
    let price = price_shape(&state.config.credits, &body.spec, body.size, 0);
    Ok(Json(SandboxQuoteResponse {
        rate_micro_usd_per_hour: price.rate_micro_usd_per_hour,
    }))
}

/// Verdict returned to Core for a tick. Snake-case on the wire (frozen).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxVerdict {
    /// Keep running.
    Continue,
    /// Approaching a limit; Core surfaces a warning but keeps running.
    Warn,
    /// Per-run budget cap reached; Core must destroy the workspace.
    KillBudget,
    /// Wallet balance non-positive; Core must destroy the workspace.
    KillBalance,
    /// Billing could not be confirmed; Core must destroy the workspace rather
    /// than continue an org-bound sandbox without accounting.
    KillAccounting,
}

/// Response from `POST /sandbox/tick`.
#[derive(Debug, Serialize)]
pub struct SandboxTickResponse {
    /// Cumulative billed (marked-up) micro-USD accrued for this run.
    pub accrued_micro_usd: u64,
    /// Authoritative wallet balance after the debit, or `null` when the path is
    /// intentionally unmetered or an accounting kill is being returned.
    pub balance_micro_usd: Option<i64>,
    /// Continue / warn / kill decision for this tick.
    pub verdict: SandboxVerdict,
    /// The customer rate for this run's shape in micro-USD per hour, from this
    /// Gateway's own rate table. Core shows it as the session's Box rate.
    pub rate_micro_usd_per_hour: u64,
}

/// Body accepted by `POST /sandbox/complete`.
#[derive(Debug, Deserialize)]
pub struct SandboxCompleteBody {
    /// Sandbox run identifier whose accrual state Core no longer needs.
    pub run_id: String,
}

/// Response from `POST /sandbox/complete`.
#[derive(Debug, Serialize)]
pub struct SandboxCompleteResponse {
    /// Echo of the completed run.
    pub run_id: String,
    /// Whether accrual state existed and was removed. `false` on a repeated or
    /// unknown completion: the transition is idempotent.
    pub removed: bool,
}

/// Per-run accrual state, held process-global in `accrual_map`.
struct RunAccrual {
    /// Cumulative billed (marked-up) micro-USD.
    accrued_micro: u64,
    /// Highest `tick_index` accrued so far (monotonic dedup guard).
    last_tick_index: u64,
    /// The run's metered seconds, for the per-start minimum.
    meter: RunMeter,
    /// When Core last ticked this run. Idle entries (a lost completion, a Core
    /// that went away) expire after [`ACCRUAL_IDLE_TTL`].
    last_seen: Instant,
    /// The sticky kill verdict once a budget, balance, or accounting kill was
    /// returned. Later ticks for the run return it again without accruing or
    /// debiting, so a failed provider stop cannot restart the run's budget at
    /// zero. Only Core's completion transition (or idle expiry) clears it.
    terminal: Option<SandboxVerdict>,
}

/// An entry with no tick for this long is dropped. Core ticks every live run
/// about every 10 s and never ticks a run again after completing or killing
/// it, so only an abandoned run (lost completion, departed Core) goes idle.
const ACCRUAL_IDLE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// Upper bound on tracked runs in this process. A new run past the bound is
/// refused with `kill_accounting` (it cannot be accounted), never admitted by
/// evicting a live run's accrual.
const MAX_TRACKED_RUNS: usize = 100_000;

/// Minimum spacing between idle sweeps on the tick path.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// Process-global accrual + last-tick map, keyed by `run_id`. A static rather
/// than an `AppState` field: it is self-contained metering state consulted only
/// by `sandbox_tick` / `sandbox_complete`, so it lives in one place (mirrors the
/// widget rate limiter). Bounded by [`ACCRUAL_IDLE_TTL`] and [`MAX_TRACKED_RUNS`].
///
/// It is per process: with several replicas each holds the runs it saw. A Box
/// tick that carries `elapsed_seconds_total` is priced without it; the map
/// still guards replays to this process and feeds the per-run budget verdict.
fn accrual_map() -> &'static DashMap<String, RunAccrual> {
    static MAP: OnceLock<DashMap<String, RunAccrual>> = OnceLock::new();
    MAP.get_or_init(DashMap::new)
}

/// Drop idle entries. Callers must not hold any reference into `map`.
fn sweep_idle(map: &DashMap<String, RunAccrual>, now: Instant) {
    map.retain(|_, run| now.saturating_duration_since(run.last_seen) < ACCRUAL_IDLE_TTL);
}

/// Sweep idle entries at most once per [`SWEEP_INTERVAL`] on the process map.
fn sweep_idle_if_due(map: &DashMap<String, RunAccrual>, now: Instant) {
    static LAST_SWEEP: Mutex<Option<Instant>> = Mutex::new(None);
    let due = {
        let mut last = LAST_SWEEP.lock().unwrap_or_else(|e| e.into_inner());
        let due = last.is_none_or(|at| now.saturating_duration_since(at) >= SWEEP_INTERVAL);
        if due {
            *last = Some(now);
        }
        due
    };
    if due {
        sweep_idle(map, now);
    }
}

/// Whether a run not yet tracked may be admitted under the cardinality bound.
/// Sweeps idle entries first when the map is full. Holds no map reference.
fn has_capacity_for_new_run(
    map: &DashMap<String, RunAccrual>,
    max_runs: usize,
    now: Instant,
) -> bool {
    if map.len() < max_runs {
        return true;
    }
    sweep_idle(map, now);
    map.len() < max_runs
}

/// `POST /sandbox/tick` — meter one heartbeat of a running sandbox, debit the
/// org wallet (marked up 30% via `sandbox_debit_amount`), and return a
/// continue/warn/kill verdict.
///
/// Authentication: trusted-forwarder or master-key only (this is a Core→Gateway
/// control call, like exec-audit). Unlike `exec/tool` it is NOT refused under
/// mesh mode.
pub async fn sandbox_tick(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<SandboxTickBody>,
) -> Result<Json<SandboxTickResponse>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;

    let is_trusted =
        ctx.is_master_key || ctx.key_config.as_ref().is_some_and(|k| k.trusted_forwarder);
    if !is_trusted {
        return Err(GatewayError::Unauthorized(
            "Sandbox tick requires a trusted-forwarder or master key.".to_string(),
        ));
    }

    if body
        .box_id
        .as_deref()
        .is_some_and(|box_id| !valid_box_id(box_id))
    {
        return Err(GatewayError::BadRequest(
            "box_id must be 1-64 letters, digits, '_' or '-'".to_string(),
        ));
    }

    // Steps 2-3 — raw cost of this delta, then apply the sandbox markup (or
    // the configured size rate). The rates live on `CreditsConfig` (owner:
    // config.rs); never reimplement the math here.
    let credits = &state.config.credits;
    let price = price_tick(credits, &body);
    let waived = minimum_waived(credits, &body, unix_now_ms());

    let map = accrual_map();
    let now = Instant::now();
    if !map.contains_key(&body.run_id) {
        sweep_idle_if_due(map, now);
        if !has_capacity_for_new_run(map, MAX_TRACKED_RUNS, now) {
            tracing::warn!(
                run_id = %body.run_id,
                tracked_runs = map.len(),
                "sandbox tick: accrual capacity reached, refusing a new run for accounting"
            );
            return Ok(Json(SandboxTickResponse {
                accrued_micro_usd: 0,
                balance_micro_usd: None,
                verdict: SandboxVerdict::KillAccounting,
                rate_micro_usd_per_hour: price.rate_micro_usd_per_hour,
            }));
        }
    }

    // Step 1 + 4 — terminal check, replay guard, accrual, and tick-watermark
    // advance under ONE shard lock (released before any await: a held DashMap
    // ref across `.await` would deadlock the shard). A sized Box tick is priced
    // in there too, from the run's metered seconds (per-start minimum and whole
    // minutes). A killed run repeats its kill verdict without accruing or
    // debiting. A repeated/out-of-order tick for a live run is a no-op: return
    // the current accrual, verdict `continue`, and an unknown balance, without
    // debiting.
    let admission = accrue_tick(
        map,
        &body.run_id,
        body.tick_index,
        body.elapsed_seconds_delta,
        now,
        |before, after| tick_charge(credits, &body, waived, before, after, price.billed_micro),
    );
    let (accrued, billed_micro) = match admission {
        TickAdmission::Accrued {
            accrued,
            billed_micro,
        } => (accrued, billed_micro),
        TickAdmission::Replay(existing_accrued) => {
            return Ok(Json(SandboxTickResponse {
                accrued_micro_usd: existing_accrued,
                balance_micro_usd: None,
                verdict: SandboxVerdict::Continue,
                rate_micro_usd_per_hour: price.rate_micro_usd_per_hour,
            }));
        }
        TickAdmission::Terminal { accrued, verdict } => {
            return Ok(Json(SandboxTickResponse {
                accrued_micro_usd: accrued,
                balance_micro_usd: None,
                verdict,
                rate_micro_usd_per_hour: price.rate_micro_usd_per_hour,
            }));
        }
    };

    // Step 5 — synchronous (awaited) debit; an active org-bound billing path
    // must return an authoritative balance or stop the sandbox.
    let attribution = BoxAttribution {
        box_id: body.box_id.as_deref(),
        size: body.size,
    };
    let (balance, accounting_unavailable) = match debit_sandbox_sync(
        &state,
        body.org_id.as_deref(),
        &body.run_id,
        body.tick_index,
        billed_micro,
        attribution,
    )
    .await
    {
        Ok(balance) => (balance, false),
        Err(()) => (None, true),
    };

    // Step 6 — verdict, in the frozen priority order.
    let verdict = if accounting_unavailable {
        SandboxVerdict::KillAccounting
    } else {
        compute_verdict(
            accrued,
            body.per_run_budget_micro_usd,
            balance,
            billed_micro,
        )
    };

    // Step 7 — a kill verdict is sticky. The accrual entry stays (marked
    // terminal) until Core confirms teardown via `POST /sandbox/complete`, so a
    // failed provider stop followed by another heartbeat cannot open a fresh
    // accrual window at zero.
    mark_terminal(map, &body.run_id, verdict);

    Ok(Json(SandboxTickResponse {
        accrued_micro_usd: accrued,
        balance_micro_usd: balance,
        verdict,
        rate_micro_usd_per_hour: price.rate_micro_usd_per_hour,
    }))
}

/// `POST /sandbox/complete` — Core's authenticated, idempotent completion
/// transition. Core sends it once it will never tick `run_id` again: after the
/// final accounting of a normal completion, or after a kill verdict's provider
/// teardown is confirmed. Removes the run's accrual (and any sticky kill) state.
///
/// Authentication: trusted-forwarder or master-key only, exactly like
/// `/sandbox/tick`.
pub async fn sandbox_complete(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<SandboxCompleteBody>,
) -> Result<Json<SandboxCompleteResponse>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    let is_trusted =
        ctx.is_master_key || ctx.key_config.as_ref().is_some_and(|k| k.trusted_forwarder);
    if !is_trusted {
        return Err(GatewayError::Unauthorized(
            "Sandbox completion requires a trusted-forwarder or master key.".to_string(),
        ));
    }
    let removed = accrual_map().remove(&body.run_id).is_some();
    Ok(Json(SandboxCompleteResponse {
        run_id: body.run_id,
        removed,
    }))
}

/// Outcome of admitting one tick into a run's accrual state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TickAdmission {
    /// Accepted; the new cumulative accrual and this tick's charge.
    Accrued { accrued: u64, billed_micro: u64 },
    /// Replayed or out-of-order tick for a live run; the current accrual.
    Replay(u64),
    /// The run already received a kill verdict; repeat it, accrue nothing.
    Terminal {
        accrued: u64,
        verdict: SandboxVerdict,
    },
}

/// Accrue one tick for `run_id`, atomically with its terminal and replay
/// checks. `charge` prices the tick from the run's meter before it (`None` for
/// a run's first accepted tick) and after it. Checking and advancing under one
/// entry lock means two concurrent deliveries of the same tick (e.g. a
/// forwarder retry racing the original) cannot both accrue. Only an existing
/// entry can reject, so a genuine first tick (index 0) is accepted.
fn accrue_tick(
    map: &DashMap<String, RunAccrual>,
    run_id: &str,
    tick_index: u64,
    elapsed_seconds_delta: u64,
    now: Instant,
    charge: impl FnOnce(Option<RunMeter>, RunMeter) -> u64,
) -> TickAdmission {
    match map.entry(run_id.to_owned()) {
        dashmap::mapref::entry::Entry::Occupied(mut occupied) => {
            let run = occupied.get_mut();
            run.last_seen = now;
            if let Some(verdict) = run.terminal {
                return TickAdmission::Terminal {
                    accrued: run.accrued_micro,
                    verdict,
                };
            }
            if tick_index <= run.last_tick_index {
                return TickAdmission::Replay(run.accrued_micro);
            }
            let after = RunMeter {
                elapsed_seconds: run
                    .meter
                    .elapsed_seconds
                    .saturating_add(elapsed_seconds_delta),
                minimum: run.meter.minimum,
            };
            let billed_micro = charge(Some(run.meter), after);
            run.accrued_micro = run.accrued_micro.saturating_add(billed_micro);
            run.last_tick_index = tick_index;
            run.meter = after;
            TickAdmission::Accrued {
                accrued: run.accrued_micro,
                billed_micro,
            }
        }
        dashmap::mapref::entry::Entry::Vacant(vacant) => {
            let after = RunMeter {
                elapsed_seconds: elapsed_seconds_delta,
                minimum: tick_index == 0,
            };
            let billed_micro = charge(None, after);
            vacant.insert(RunAccrual {
                accrued_micro: billed_micro,
                last_tick_index: tick_index,
                meter: after,
                last_seen: now,
                terminal: None,
            });
            TickAdmission::Accrued {
                accrued: billed_micro,
                billed_micro,
            }
        }
    }
}

/// Record a kill verdict as the run's sticky terminal state. Non-kill verdicts
/// and runs already removed (a racing completion) are left alone.
fn mark_terminal(map: &DashMap<String, RunAccrual>, run_id: &str, verdict: SandboxVerdict) {
    if !matches!(
        verdict,
        SandboxVerdict::KillBudget | SandboxVerdict::KillBalance | SandboxVerdict::KillAccounting
    ) {
        return;
    }
    if let Some(mut run) = map.get_mut(run_id) {
        run.terminal.get_or_insert(verdict);
    }
}

/// Verdict priority (frozen): `kill_accounting` > `kill_balance` > `kill_budget`
/// > `warn` > `continue`.
/// - `kill_balance`: balance known and non-positive.
/// - `kill_budget`: per-run cap set and reached.
/// - `kill_accounting`: the active org-bound debit could not be confirmed.
/// - `warn`: within 80% of the per-run cap, OR balance positive but under 3×
///   this tick's billed amount (about to run dry).
fn compute_verdict(
    accrued: u64,
    per_run_budget: u64,
    balance: Option<i64>,
    billed_micro: u64,
) -> SandboxVerdict {
    if let Some(b) = balance {
        if b <= 0 {
            return SandboxVerdict::KillBalance;
        }
    }
    if per_run_budget > 0 && accrued >= per_run_budget {
        return SandboxVerdict::KillBudget;
    }
    let budget_warn =
        per_run_budget > 0 && accrued.saturating_mul(100) >= per_run_budget.saturating_mul(80);
    let balance_warn =
        matches!(balance, Some(b) if b > 0 && (b as u64) < billed_micro.saturating_mul(3));
    if budget_warn || balance_warn {
        return SandboxVerdict::Warn;
    }
    SandboxVerdict::Continue
}

/// Synchronous control-plane debit for one sandbox tick. Posts the ALREADY
/// marked-up `billed_micro` as-is under `reason = "sandbox"` and the idempotent
/// `ref_id = "{run_id}:sandbox:{tick_index}"`. Returns the authoritative balance,
/// or `None` when credits are inactive, no org is present, or the amount rounds
/// to zero. An active org-bound control-plane failure returns `Err(())` so the
/// caller can stop the sandbox rather than continue unbilled.
/// The Box a sandbox tick belongs to, for the ledger attribution.
#[derive(Debug, Clone, Copy, Default)]
struct BoxAttribution<'a> {
    box_id: Option<&'a str>,
    size: Option<SandboxSize>,
}

/// The control-plane debit body for one sandbox tick. A Box tick carries
/// `boxId` and `size`, and `taskLabel = "box:<id>"` so the ledger row names
/// the Box even before the control plane reads the new fields.
fn sandbox_debit_body(
    org_id: &str,
    run_id: &str,
    tick_index: u64,
    billed_micro: u64,
    attribution: BoxAttribution<'_>,
) -> Value {
    // No `pool` field, and that is deliberate: sandbox compute is Ryu's own
    // container time, not inference drawn from a donated provider allowance.
    // Neither credit pool funds it, so it must never reach pool-restricted grant
    // money — omitting `pool` is what tells the control-plane debit to bill the
    // ordinary subscription/top-up buckets. See `crate::credit_pools`.
    let mut body = json!({
        "orgId": org_id,
        "amountMicroUsd": billed_micro,
        "reason": ryu_gw_contracts::credit_debit::CreditDebitReason::Sandbox.as_str(),
        "refId": format!("{run_id}:sandbox:{tick_index}"),
    });
    if let Some(box_id) = attribution.box_id {
        body["boxId"] = json!(box_id);
        body["taskLabel"] = json!(format!("box:{box_id}"));
    }
    if let Some(size) = attribution.size {
        body["size"] = json!(size.as_str());
    }
    body
}

async fn debit_sandbox_sync(
    state: &SharedState,
    org_id: Option<&str>,
    run_id: &str,
    tick_index: u64,
    billed_micro: u64,
    attribution: BoxAttribution<'_>,
) -> Result<Option<i64>, ()> {
    let Some(org_id) = org_id.filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let credits = &state.config.credits;
    if !credits.enabled || billed_micro == 0 {
        return Ok(None);
    }
    if !credits.is_active() {
        state.wallet.set_org_accounting_unavailable(org_id, true);
        return Err(());
    }
    let Some(secret) = credits.internal_secret.as_deref() else {
        state.wallet.set_org_accounting_unavailable(org_id, true);
        return Err(());
    };

    // `/api` is part of the route — see the long note on the same join in
    // `pipeline/mod.rs`. Without it every sandbox debit 404s and fails open, so
    // sandbox compute bills nothing.
    let url = format!(
        "{}/api/credits/debit",
        credits.base_url.trim_end_matches('/')
    );
    let body = sandbox_debit_body(org_id, run_id, tick_index, billed_micro, attribution);

    let resp = state
        .http
        .post(&url)
        .header("x-ryu-internal-secret", secret)
        .timeout(Duration::from_millis(credits.timeout_ms.max(1)))
        .json(&body)
        .send()
        .await
        .map_err(|_| {
            state.wallet.set_org_accounting_unavailable(org_id, true);
        })?;
    if !resp.status().is_success() {
        state.wallet.set_org_accounting_unavailable(org_id, true);
        return Err(());
    }

    let v = resp.json::<Value>().await.map_err(|_| {
        state.wallet.set_org_accounting_unavailable(org_id, true);
    })?;
    let Some(balance) = v["balanceMicroUsd"].as_i64() else {
        state.wallet.set_org_accounting_unavailable(org_id, true);
        return Err(());
    };
    // Steady-state truth: keep the cached balance (and the empty flag derived
    // from it) in sync so the chat path is gated after a sandbox drains the
    // wallet (self-heals after a top-up), and so Core's dollar-threshold
    // fallback rules see a sandbox's spend too.
    state.wallet.set_org_balance(org_id, balance);
    Ok(Some(balance))
}

#[cfg(test)]
mod tests {
    use super::{
        accrual_map, accrue_tick, compute_verdict, has_capacity_for_new_run, mark_terminal,
        price_tick, sandbox_complete, sandbox_debit_body, sandbox_tick, sized_tick_charge,
        stateless_sized_charge, sweep_idle, tick_charge, BoxAttribution, RunAccrual, RunMeter,
        SandboxCompleteBody, SandboxSpec, SandboxTickBody, SandboxVerdict, TickAdmission,
        TickPrice, ACCRUAL_IDLE_TTL,
    };
    use crate::config::{CreditsConfig, GpuKind, OsKind, SandboxSize, SizeRates};
    use axum::{extract::State, http::HeaderMap, Json};
    use dashmap::DashMap;
    use serde_json::json;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn tick(
        vcpu: u32,
        mem_gib: u32,
        storage_gib: u32,
        size: Option<SandboxSize>,
    ) -> SandboxTickBody {
        SandboxTickBody {
            run_id: "run".into(),
            org_id: Some("org".into()),
            spec: SandboxSpec {
                vcpu,
                mem_gib,
                storage_gib,
                gpu: GpuKind::None,
                gpu_count: 0,
                os: OsKind::Linux,
            },
            elapsed_seconds_delta: 10,
            tick_index: 0,
            per_run_budget_micro_usd: 0,
            size,
            box_id: None,
            elapsed_seconds_total: None,
            minimum_waiver: None,
        }
    }

    /// With size rates off, every tick prices exactly as the per-resource
    /// math did before size rates existed: these totals are a snapshot of that
    /// math at the default rates and 30% markup.
    #[test]
    fn size_rates_none_keeps_the_existing_totals() {
        let credits = CreditsConfig {
            sandbox_size_rates: None,
            ..Default::default()
        };
        let snapshot = [
            ((2, 4, 40), 612, 220_194),
            ((4, 8, 80), 1_226, 441_090),
            ((8, 16, 100), 2_430, 874_458),
            ((2, 4, 10), 601, 215_982),
        ];
        for ((vcpu, mem_gib, storage_gib), billed, hourly) in snapshot {
            for size in [None, Some(SandboxSize::Small), Some(SandboxSize::Large)] {
                let body = tick(vcpu, mem_gib, storage_gib, size);
                let legacy = credits.sandbox_debit_amount(credits.sandbox_tick_cost_raw_micro(
                    vcpu,
                    mem_gib,
                    storage_gib,
                    GpuKind::None,
                    0,
                    OsKind::Linux,
                    10,
                ));
                assert_eq!(legacy, billed);
                assert_eq!(
                    price_tick(&credits, &body),
                    TickPrice {
                        billed_micro: billed,
                        rate_micro_usd_per_hour: hourly,
                    },
                    "{vcpu}/{mem_gib}/{storage_gib} {size:?}"
                );
            }
        }
    }

    #[test]
    fn size_rates_price_a_sized_tick_without_markup() {
        let credits = CreditsConfig {
            sandbox_size_rates: Some(SizeRates {
                small: 25_000,
                default: 40_000,
                large: 70_000,
            }),
            ..Default::default()
        };
        assert_eq!(
            price_tick(&credits, &tick(8, 16, 100, Some(SandboxSize::Large))),
            TickPrice {
                billed_micro: 194,
                rate_micro_usd_per_hour: 70_000,
            }
        );
        // A tick without a size keeps the per-resource math.
        assert_eq!(
            price_tick(&credits, &tick(2, 4, 40, None)),
            TickPrice {
                billed_micro: 612,
                rate_micro_usd_per_hour: 220_194,
            }
        );
    }

    #[test]
    fn tick_body_accepts_optional_size_and_box_id() {
        let legacy: SandboxTickBody = serde_json::from_value(json!({
            "run_id": "r", "org_id": "o",
            "spec": {"vcpu": 2, "mem_gib": 4, "storage_gib": 40, "gpu": "none", "os": "linux"},
            "elapsed_seconds_delta": 10, "tick_index": 0,
        }))
        .unwrap();
        assert_eq!(legacy.size, None);
        assert_eq!(legacy.box_id, None);
        let sized: SandboxTickBody = serde_json::from_value(json!({
            "run_id": "r", "org_id": "o",
            "spec": {"vcpu": 8, "mem_gib": 16, "storage_gib": 100, "gpu": "none", "os": "linux"},
            "elapsed_seconds_delta": 10, "tick_index": 1,
            "size": "large", "box_id": "bx_0123456789abcdef0123456789abcdef",
        }))
        .unwrap();
        assert_eq!(sized.size, Some(SandboxSize::Large));
        assert!(serde_json::from_value::<SandboxTickBody>(json!({
            "run_id": "r",
            "spec": {"vcpu": 2, "mem_gib": 4, "storage_gib": 40, "gpu": "none", "os": "linux"},
            "elapsed_seconds_delta": 10, "tick_index": 0, "size": "cpx22",
        }))
        .is_err());
        assert!(super::valid_box_id("bx_0123456789abcdef0123456789abcdef"));
        assert!(!super::valid_box_id("bx/../x"));
        assert!(!super::valid_box_id(""));
        assert!(!super::valid_box_id(&"a".repeat(65)));
    }

    #[test]
    fn debit_body_carries_the_box_attribution() {
        let plain = sandbox_debit_body("org_1", "run_1", 7, 612, BoxAttribution::default());
        assert_eq!(
            plain,
            json!({
                "orgId": "org_1",
                "amountMicroUsd": 612,
                "reason": "sandbox",
                "refId": "run_1:sandbox:7",
            })
        );
        let boxed = sandbox_debit_body(
            "org_1",
            "run_1",
            8,
            612,
            BoxAttribution {
                box_id: Some("bx_0123456789abcdef0123456789abcdef"),
                size: Some(SandboxSize::Small),
            },
        );
        assert_eq!(boxed["boxId"], "bx_0123456789abcdef0123456789abcdef");
        assert_eq!(
            boxed["taskLabel"],
            "box:bx_0123456789abcdef0123456789abcdef"
        );
        assert_eq!(boxed["size"], "small");
        assert_eq!(boxed["refId"], "run_1:sandbox:8");
        assert!(boxed.get("pool").is_none());
    }

    /// `accrue_tick` with a flat charge per tick.
    fn accrue_flat(
        map: &DashMap<String, RunAccrual>,
        run: &str,
        tick_index: u64,
        billed: u64,
    ) -> Result<u64, u64> {
        match accrue_tick(map, run, tick_index, 10, Instant::now(), |_, _| billed) {
            TickAdmission::Accrued { accrued, .. } => Ok(accrued),
            TickAdmission::Replay(existing) => Err(existing),
            TickAdmission::Terminal { .. } => panic!("not terminal"),
        }
    }

    /// One tick of a metered run, as its (accrued, charge) pair, or `None`
    /// when the tick was refused.
    fn accrue_metered(
        map: &DashMap<String, RunAccrual>,
        run: &str,
        tick_index: u64,
        delta: u64,
        charge: impl FnOnce(Option<RunMeter>, RunMeter) -> u64,
    ) -> Option<(u64, u64)> {
        match accrue_tick(map, run, tick_index, delta, Instant::now(), charge) {
            TickAdmission::Accrued {
                accrued,
                billed_micro,
            } => Some((accrued, billed_micro)),
            _ => None,
        }
    }

    #[test]
    fn accrue_tick_accepts_first_tick_and_rejects_replays_atomically() {
        let map: DashMap<String, RunAccrual> = DashMap::new();
        assert_eq!(accrue_flat(&map, "run", 0, 10), Ok(10), "first tick 0");
        assert_eq!(accrue_flat(&map, "run", 0, 10), Err(10), "replayed tick 0");
        assert_eq!(accrue_flat(&map, "run", 1, 10), Ok(20));
        assert_eq!(accrue_flat(&map, "run", 1, 10), Err(20), "replayed tick 1");
        assert_eq!(accrue_flat(&map, "run", 0, 10), Err(20), "out of order");
        assert_eq!(accrue_flat(&map, "other", 1, 5), Ok(5), "runs independent");
    }

    /// Feed `deltas` as ticks 0.. of one sized run; return each tick's charge.
    fn sized_run(
        credits: &CreditsConfig,
        size: SandboxSize,
        first: u64,
        deltas: &[u64],
    ) -> Vec<u64> {
        let map: DashMap<String, RunAccrual> = DashMap::new();
        deltas
            .iter()
            .enumerate()
            .map(|(index, delta)| {
                accrue_metered(
                    &map,
                    "run",
                    first + index as u64,
                    *delta,
                    |before, after| {
                        sized_tick_charge(credits, Some(size), before, after).expect("size rates")
                    },
                )
                .expect("accepted")
                .1
            })
            .collect()
    }

    #[test]
    fn a_sized_run_pays_five_minutes_up_front_then_whole_minutes() {
        let credits = CreditsConfig::default();
        // Thirty 10 s ticks at $0.04/h: the first pays 300 s (3,333.3…), the
        // rest pay nothing until the run passes five minutes.
        let charges = sized_run(&credits, SandboxSize::Default, 0, &[10; 30]);
        assert_eq!(charges[0], 3333);
        assert!(charges[1..].iter().all(|charge| *charge == 0));
        // The 31st tick (310 s) opens the sixth minute.
        let charges = sized_run(&credits, SandboxSize::Default, 0, &[10; 31]);
        assert_eq!(charges[30], 4000 - 3333);
        // An hour of 10 s ticks totals the hourly rate exactly.
        for (size, hourly) in [
            (SandboxSize::Small, 25_000),
            (SandboxSize::Default, 40_000),
            (SandboxSize::Large, 70_000),
        ] {
            let total: u64 = sized_run(&credits, size, 0, &[10; 360]).iter().sum();
            assert_eq!(total, hourly, "{size:?}");
        }
        // A start that stops after one tick still pays the minimum.
        assert_eq!(sized_run(&credits, SandboxSize::Large, 0, &[4]), vec![5833]);
        // A run first seen mid-way (a Gateway restart) pays whole minutes only.
        assert_eq!(
            sized_run(&credits, SandboxSize::Default, 7, &[10, 10]),
            vec![667, 0]
        );
    }

    /// Feed `deltas` as one run's ticks priced from the body alone; return
    /// each tick's charge.
    fn stateless_run(credits: &CreditsConfig, size: SandboxSize, deltas: &[u64]) -> Vec<u64> {
        let mut total = 0;
        deltas
            .iter()
            .map(|delta| {
                total += delta;
                stateless_sized_charge(credits, Some(size), total, *delta, true)
                    .expect("size rates")
            })
            .collect()
    }

    #[test]
    fn a_tick_with_the_run_total_prices_the_same_on_any_replica() {
        let credits = CreditsConfig::default();
        // Same as the in-process meter: the minimum up front, whole minutes after.
        let charges = stateless_run(&credits, SandboxSize::Default, &[10; 31]);
        assert_eq!(charges[0], 3333);
        assert!(charges[1..30].iter().all(|charge| *charge == 0));
        assert_eq!(charges[30], 4000 - 3333);
        for (size, hourly) in [
            (SandboxSize::Small, 25_000),
            (SandboxSize::Default, 40_000),
            (SandboxSize::Large, 70_000),
        ] {
            let total: u64 = stateless_run(&credits, size, &[10; 360]).iter().sum();
            assert_eq!(total, hourly, "{size:?}");
        }
        // A tick redelivered (to the same or another replica) is priced the
        // same, so its duplicate debit carries the same amount and ref id.
        assert_eq!(
            stateless_sized_charge(&credits, Some(SandboxSize::Small), 310, 10, true),
            stateless_sized_charge(&credits, Some(SandboxSize::Small), 310, 10, true)
        );
        // A Gateway that restarted mid-run still charges the minimum once:
        // the tick after the restart is priced from the run's total.
        assert_eq!(
            stateless_sized_charge(&credits, Some(SandboxSize::Default), 70, 10, true),
            Some(0),
            "the run's first 60 s already paid the 300 s minimum"
        );
        assert_eq!(
            stateless_sized_charge(&credits, Some(SandboxSize::Default), 10, 10, true),
            Some(3333)
        );
        // An inconsistent body (delta above the total) charges from zero.
        assert_eq!(
            stateless_sized_charge(&credits, Some(SandboxSize::Default), 5, 50, true),
            Some(3333)
        );
        assert_eq!(stateless_sized_charge(&credits, None, 10, 10, true), None);
    }

    /// Feed `deltas` as ticks 0.. of one sized run through the handler's
    /// pricing ([`tick_charge`]) with or without the run total, and with
    /// `waived` as the verified waiver decides it; return each tick's charge.
    fn priced_run(
        credits: &CreditsConfig,
        deltas: &[u64],
        with_total: bool,
        waived: bool,
    ) -> Vec<u64> {
        let map: DashMap<String, RunAccrual> = DashMap::new();
        let mut total = 0;
        deltas
            .iter()
            .enumerate()
            .map(|(index, delta)| {
                total += delta;
                let mut wire = json!({
                    "run_id": "run-e2",
                    "org_id": "org",
                    "spec": {
                        "vcpu": 2, "mem_gib": 4, "storage_gib": 40,
                        "gpu": "none", "gpu_count": 0, "os": "linux"
                    },
                    "elapsed_seconds_delta": delta,
                    "tick_index": index,
                    "size": "default",
                    "box_id": "bx_a",
                });
                if with_total {
                    wire["elapsed_seconds_total"] = json!(total);
                }
                let body: SandboxTickBody = serde_json::from_value(wire).expect("tick body");
                accrue_metered(
                    &map,
                    &body.run_id,
                    body.tick_index,
                    *delta,
                    |before, after| tick_charge(credits, &body, waived, before, after, 0),
                )
                .expect("accepted")
                .1
            })
            .collect()
    }

    #[test]
    fn a_waived_run_pays_whole_minutes_and_any_other_run_pays_the_minimum() {
        let credits = CreditsConfig::default();
        for with_total in [true, false] {
            // A verified waiver for this resume: 20 s bill one minute
            // ($0.04/h → 667), not five (3,333).
            assert_eq!(
                priced_run(&credits, &[10, 10], with_total, true),
                vec![667, 0],
                "with_total={with_total}"
            );
            // Every new minute is charged as it starts, as before.
            let charges = priced_run(&credits, &[30, 30, 30], with_total, true);
            assert_eq!(charges, vec![667, 0, 1333 - 667], "with_total={with_total}");
            // No verified waiver: the start pays the minimum.
            assert_eq!(
                priced_run(&credits, &[10, 10], with_total, false),
                vec![3333, 0],
                "with_total={with_total}"
            );
        }
        // An hour of a waived run still totals the hourly rate.
        let hour: u64 = priced_run(&credits, &[10; 360], true, true).iter().sum();
        assert_eq!(hour, 40_000);
        assert_eq!(
            stateless_sized_charge(&credits, Some(SandboxSize::Default), 10, 10, false),
            Some(667)
        );
    }

    /// A Box tick body for the handler-level waiver tests.
    fn box_tick_wire(run_id: &str, total: u64, waiver: Option<&str>) -> serde_json::Value {
        let mut wire = json!({
            "run_id": run_id,
            "org_id": "org_box",
            "spec": {"vcpu": 2, "mem_gib": 4, "storage_gib": 40, "gpu": "none", "os": "linux"},
            "elapsed_seconds_delta": 10,
            "elapsed_seconds_total": total,
            "tick_index": 0,
            "size": "default",
            "box_id": "bx_0123456789abcdef0123456789abcdef",
        });
        if let Some(waiver) = waiver {
            wire["minimum_waiver"] = json!(waiver);
        }
        wire
    }

    #[test]
    fn only_a_waiver_the_box_service_signed_skips_the_minimum() {
        use super::minimum_waiver::testing::{keypair, sign};
        let (box_service, public) = keypair(11);
        let (forwarder, _) = keypair(12);
        let credits = CreditsConfig {
            box_minimum_waiver_public_key: Some(public),
            ..Default::default()
        };
        let now_ms = 1_792_490_400_000 + 25_000;
        let claims = json!({
            "boxId": "bx_0123456789abcdef0123456789abcdef",
            "tenant": "core:org_box",
            "startedAtMs": 1_792_490_400_000_i64,
            "paidHourEndsAtMs": 1_792_490_400_000_i64 + 40 * 60 * 1000,
        });
        let signed = sign(&box_service, &claims);
        let decide = |credits: &CreditsConfig, wire: serde_json::Value| {
            let body: SandboxTickBody = serde_json::from_value(wire).expect("tick body");
            super::minimum_waived(credits, &body, now_ms)
        };
        assert!(decide(&credits, box_tick_wire("r1", 20, Some(&signed))));
        // The gap this closes: a forwarder that says the minimum was waived
        // (the old bare flag, or a token it signed itself) still pays it.
        let mut flagged = box_tick_wire("r2", 20, None);
        flagged["minimum_waived"] = json!(true);
        assert!(!decide(&credits, flagged));
        assert!(!decide(
            &credits,
            box_tick_wire("r3", 20, Some(&sign(&forwarder, &claims)))
        ));
        // Another org cannot borrow this Box's waiver.
        let mut other_org = box_tick_wire("r4", 20, Some(&signed));
        other_org["org_id"] = json!("org_other");
        assert!(!decide(&credits, other_org));
        // A later start (the run began after the paid hour) pays.
        let later = |wire: serde_json::Value| {
            let body: SandboxTickBody = serde_json::from_value(wire).expect("tick body");
            super::minimum_waived(&credits, &body, now_ms + 60 * 60 * 1000)
        };
        assert!(!later(box_tick_wire("r5", 20, Some(&signed))));
        // A Gateway without the Box service's key honours no waiver.
        assert!(!decide(
            &CreditsConfig::default(),
            box_tick_wire("r6", 20, Some(&signed))
        ));
    }

    #[test]
    fn stale_runs_are_pruned_and_live_ones_kept() {
        let map: DashMap<String, RunAccrual> = DashMap::new();
        let now = Instant::now();
        let meter = RunMeter {
            elapsed_seconds: 10,
            minimum: true,
        };
        for (run, age) in [
            ("ended", ACCRUAL_IDLE_TTL),
            ("live", Duration::from_secs(20)),
        ] {
            map.insert(
                run.to_owned(),
                RunAccrual {
                    accrued_micro: 1,
                    last_tick_index: 3,
                    meter,
                    last_seen: now.checked_sub(age).expect("monotonic clock"),
                    terminal: None,
                },
            );
        }
        sweep_idle(&map, now);
        assert!(map.get("ended").is_none());
        assert!(map.get("live").is_some());
    }

    #[test]
    fn sized_tick_charge_needs_a_size_and_size_rates() {
        let meter = RunMeter {
            elapsed_seconds: 10,
            minimum: true,
        };
        let credits = CreditsConfig::default();
        assert_eq!(sized_tick_charge(&credits, None, None, meter), None);
        let off = CreditsConfig {
            sandbox_size_rates: None,
            ..Default::default()
        };
        assert_eq!(
            sized_tick_charge(&off, Some(SandboxSize::Small), None, meter),
            None
        );
        assert_eq!(
            sized_tick_charge(&credits, Some(SandboxSize::Small), None, meter),
            Some(2083)
        );
    }

    #[test]
    fn concurrent_duplicate_ticks_accrue_once() {
        let map = std::sync::Arc::new(DashMap::<String, RunAccrual>::new());
        let accepted: usize = (0..16)
            .map(|_| {
                let map = std::sync::Arc::clone(&map);
                std::thread::spawn(move || accrue_flat(&map, "run", 3, 7).is_ok())
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| usize::from(handle.join().expect("tick thread")))
            .sum();
        assert_eq!(accepted, 1);
        assert_eq!(map.get("run").map(|run| run.accrued_micro), Some(7));
    }

    #[test]
    fn accounting_verdict_wire_name_is_frozen() {
        assert_eq!(
            serde_json::to_string(&SandboxVerdict::KillAccounting).expect("serialize verdict"),
            "\"kill_accounting\""
        );
    }

    #[test]
    fn kill_balance_beats_everything() {
        // Balance non-positive → kill_balance, even if budget also exhausted.
        assert!(matches!(
            compute_verdict(2_000_000, 1_000_000, Some(0), 45_000),
            SandboxVerdict::KillBalance
        ));
        assert!(matches!(
            compute_verdict(0, 0, Some(-5), 45_000),
            SandboxVerdict::KillBalance
        ));
    }

    #[test]
    fn kill_budget_when_cap_reached_and_balance_ok() {
        assert!(matches!(
            compute_verdict(1_000_000, 1_000_000, Some(4_200_000), 45_000),
            SandboxVerdict::KillBudget
        ));
        // No cap (0) never kills on budget.
        assert!(matches!(
            compute_verdict(9_999_999, 0, Some(4_200_000), 45_000),
            SandboxVerdict::Continue
        ));
    }

    #[test]
    fn warn_at_eighty_percent_of_budget() {
        // 80% of a 1_000_000 cap.
        assert!(matches!(
            compute_verdict(800_000, 1_000_000, Some(4_200_000), 45_000),
            SandboxVerdict::Warn
        ));
        // Just under 80% stays continue.
        assert!(matches!(
            compute_verdict(799_999, 1_000_000, Some(4_200_000), 45_000),
            SandboxVerdict::Continue
        ));
    }

    #[test]
    fn warn_when_balance_under_three_ticks() {
        // Balance positive but < 3 × billed → about to run dry.
        assert!(matches!(
            compute_verdict(0, 0, Some(100_000), 45_000),
            SandboxVerdict::Warn
        ));
        // Comfortable balance stays continue.
        assert!(matches!(
            compute_verdict(0, 0, Some(1_000_000), 45_000),
            SandboxVerdict::Continue
        ));
    }

    #[test]
    fn unknown_balance_meters_but_never_kill_balance() {
        // No balance reading → verdict driven only by the budget cap.
        assert!(matches!(
            compute_verdict(0, 0, None, 45_000),
            SandboxVerdict::Continue
        ));
        assert!(matches!(
            compute_verdict(1_000_000, 1_000_000, None, 45_000),
            SandboxVerdict::KillBudget
        ));
    }
    /// A one-shot fake control plane: answers the debit with a balance and
    /// hands back the request body it received.
    async fn fake_debit_endpoint(
        balance: i64,
    ) -> (String, tokio::sync::oneshot::Receiver<serde_json::Value>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let count = stream.read(&mut buffer).await.unwrap();
                bytes.extend_from_slice(&buffer[..count]);
                let Some(head_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n")
                else {
                    continue;
                };
                let head = String::from_utf8_lossy(&bytes[..head_end]).to_ascii_lowercase();
                let length = head
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if bytes.len() >= head_end + 4 + length {
                    let body: serde_json::Value =
                        serde_json::from_slice(&bytes[head_end + 4..head_end + 4 + length])
                            .unwrap();
                    let _ = sender.send(body);
                    break;
                }
            }
            let reply = format!(r#"{{"balanceMicroUsd":{balance}}}"#);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        (format!("http://{address}"), receiver)
    }

    fn tick_state(credits: CreditsConfig) -> crate::state::SharedState {
        let config = crate::config::GatewayConfig {
            auth: crate::config::AuthConfig {
                require_auth: true,
                master_key: Some("sk-tick-master".into()),
                api_keys: Vec::new(),
            },
            credits,
            ..crate::config::GatewayConfig::default()
        };
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
        std::sync::Arc::new(crate::state::AppState::new_for_test(config, audit, evals))
    }

    /// The quote reads the same table the ticks do: the per-resource rates
    /// plus markup by default, the size table when one is configured, and it
    /// refuses a caller that could not post a tick.
    #[tokio::test]
    async fn sandbox_quote_prices_from_the_live_rate_table() {
        let quote = |state: crate::state::SharedState, bearer: &str, body: serde_json::Value| {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert("authorization", format!("Bearer {bearer}").parse().unwrap());
            async move {
                super::sandbox_quote(
                    axum::extract::State(state),
                    headers,
                    axum::Json(serde_json::from_value(body).unwrap()),
                )
                .await
            }
        };
        let small = json!({
            "spec": {"vcpu": 2, "mem_gib": 4, "storage_gib": 40, "gpu": "none", "os": "linux"},
            "size": "small",
        });
        let per_resource = tick_state(CreditsConfig {
            sandbox_size_rates: None,
            ..Default::default()
        });
        let answer = quote(per_resource.clone(), "sk-tick-master", small.clone())
            .await
            .expect("quote");
        assert_eq!(answer.0.rate_micro_usd_per_hour, 220_194);
        // The default table is the shared Box rates.
        let answer = quote(
            tick_state(CreditsConfig::default()),
            "sk-tick-master",
            small.clone(),
        )
        .await
        .expect("quote");
        assert_eq!(answer.0.rate_micro_usd_per_hour, 25_000);
        let sized = tick_state(CreditsConfig {
            sandbox_size_rates: Some(SizeRates {
                small: 31_000,
                default: 52_000,
                large: 90_000,
            }),
            ..Default::default()
        });
        let answer = quote(sized.clone(), "sk-tick-master", small)
            .await
            .expect("quote");
        assert_eq!(answer.0.rate_micro_usd_per_hour, 31_000);
        let large = json!({
            "spec": {"vcpu": 8, "mem_gib": 16, "storage_gib": 100, "gpu": "none", "os": "linux"},
            "size": "large",
        });
        let answer = quote(sized.clone(), "sk-tick-master", large.clone())
            .await
            .expect("quote");
        assert_eq!(answer.0.rate_micro_usd_per_hour, 90_000);
        assert!(quote(sized, "sk-not-a-key", large).await.is_err());
    }

    #[tokio::test]
    async fn sandbox_tick_returns_the_rate_and_attributes_the_box() {
        let (base_url, debit) = fake_debit_endpoint(4_200_000).await;
        let state = tick_state(CreditsConfig {
            enabled: true,
            base_url,
            internal_secret: Some("internal-secret".into()),
            ..Default::default()
        });
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("authorization", "Bearer sk-tick-master".parse().unwrap());
        let run_id = format!("run_box_{}", uuid::Uuid::new_v4().simple());
        let body: SandboxTickBody = serde_json::from_value(json!({
            "run_id": run_id,
            "org_id": "org_box",
            "spec": {"vcpu": 2, "mem_gib": 4, "storage_gib": 40, "gpu": "none", "os": "linux"},
            "elapsed_seconds_delta": 10,
            "tick_index": 0,
            "size": "small",
            "box_id": "bx_0123456789abcdef0123456789abcdef",
        }))
        .unwrap();
        let response = super::sandbox_tick(
            axum::extract::State(state.clone()),
            headers.clone(),
            axum::Json(body),
        )
        .await
        .expect("tick accepted");
        // The first 10 s tick of a small Box pays its five-minute minimum at
        // $0.025/h: 2,083.3… micro-USD.
        assert_eq!(response.0.accrued_micro_usd, 2083);
        assert_eq!(response.0.rate_micro_usd_per_hour, 25_000);
        assert_eq!(response.0.balance_micro_usd, Some(4_200_000));
        let wire = serde_json::to_value(&response.0).unwrap();
        assert_eq!(wire["rate_micro_usd_per_hour"], 25_000);
        assert_eq!(wire["verdict"], "continue");
        let sent = debit.await.expect("debit body");
        assert_eq!(sent["boxId"], "bx_0123456789abcdef0123456789abcdef");
        assert_eq!(sent["taskLabel"], "box:bx_0123456789abcdef0123456789abcdef");
        assert_eq!(sent["size"], "small");
        assert_eq!(sent["amountMicroUsd"], 2083);
        assert_eq!(sent["refId"], format!("{run_id}:sandbox:0"));

        let bad: SandboxTickBody = serde_json::from_value(json!({
            "run_id": "run_bad",
            "spec": {"vcpu": 2, "mem_gib": 4, "storage_gib": 40, "gpu": "none", "os": "linux"},
            "elapsed_seconds_delta": 10,
            "tick_index": 0,
            "box_id": "bx/../../x",
        }))
        .unwrap();
        assert!(matches!(
            super::sandbox_tick(axum::extract::State(state), headers, axum::Json(bad)).await,
            Err(crate::error::GatewayError::BadRequest(_))
        ));
    }

    #[tokio::test]
    async fn sandbox_tick_charges_the_minimum_unless_the_box_service_signed_the_waiver() {
        use super::minimum_waiver::testing::{keypair, sign};
        let (box_service, public) = keypair(21);
        let now_ms = super::unix_now_ms();
        let claims = json!({
            "boxId": "bx_0123456789abcdef0123456789abcdef",
            "tenant": "core:org_box",
            "startedAtMs": now_ms - 20_000,
            "paidHourEndsAtMs": now_ms + 30 * 60 * 1000,
        });
        let signed = sign(&box_service, &claims);
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("authorization", "Bearer sk-tick-master".parse().unwrap());
        // (waiver on the tick, bare flag on the tick, what the first tick costs)
        let cases = [
            (Some(signed.as_str()), false, 667),
            (None, true, 3333),
            (None, false, 3333),
        ];
        for (waiver, flag, expected) in cases {
            let (base_url, debit) = fake_debit_endpoint(4_200_000).await;
            let state = tick_state(CreditsConfig {
                enabled: true,
                base_url,
                internal_secret: Some("internal-secret".into()),
                box_minimum_waiver_public_key: Some(public.clone()),
                ..Default::default()
            });
            let run_id = format!("run_waiver_{}", uuid::Uuid::new_v4().simple());
            let mut wire = box_tick_wire(&run_id, 10, waiver);
            if flag {
                wire["minimum_waived"] = json!(true);
            }
            let body: SandboxTickBody = serde_json::from_value(wire).unwrap();
            let response = super::sandbox_tick(
                axum::extract::State(state),
                headers.clone(),
                axum::Json(body),
            )
            .await
            .expect("tick accepted");
            assert_eq!(
                response.0.accrued_micro_usd,
                expected,
                "waiver={} flag={flag}",
                waiver.is_some()
            );
            let sent = debit.await.expect("debit body");
            assert_eq!(sent["amountMicroUsd"], expected);
        }
    }

    /// `accrue_tick` for a legacy (unmetered) tick of a flat `billed` charge,
    /// with the charge detail dropped so the admission compares by total.
    fn admit(
        map: &DashMap<String, RunAccrual>,
        run: &str,
        tick_index: u64,
        billed: u64,
        now: Instant,
    ) -> TickAdmission {
        match accrue_tick(map, run, tick_index, 10, now, |_, _| billed) {
            TickAdmission::Accrued { accrued, .. } => accrued_total(accrued),
            other => other,
        }
    }

    fn accrued_total(value: u64) -> TickAdmission {
        TickAdmission::Accrued {
            accrued: value,
            billed_micro: 0,
        }
    }

    fn accrued(value: u64) -> TickAdmission {
        accrued_total(value)
    }

    #[test]
    fn a_kill_verdict_is_sticky_and_never_reopens_a_fresh_window() {
        // Audit repro: cap 100, 60 per tick, the first provider stop fails and
        // Core keeps ticking. Tick 2 must stay killed at the old accrual.
        let map: DashMap<String, RunAccrual> = DashMap::new();
        let now = Instant::now();
        assert_eq!(admit(&map, "run", 0, 60, now), accrued(60));
        assert_eq!(admit(&map, "run", 1, 60, now), accrued(120));
        let verdict = compute_verdict(120, 100, Some(1_000), 60);
        assert_eq!(verdict, SandboxVerdict::KillBudget);
        mark_terminal(&map, "run", verdict);
        assert_eq!(
            admit(&map, "run", 2, 60, now),
            TickAdmission::Terminal {
                accrued: 120,
                verdict: SandboxVerdict::KillBudget
            }
        );
        // A non-kill verdict never marks a run terminal.
        assert_eq!(admit(&map, "live", 0, 1, now), accrued(1));
        mark_terminal(&map, "live", SandboxVerdict::Warn);
        assert_eq!(admit(&map, "live", 1, 1, now), accrued(2));
    }

    #[test]
    fn idle_entries_expire_and_the_bound_refuses_new_runs() {
        let map: DashMap<String, RunAccrual> = DashMap::new();
        let now = Instant::now();
        let Some(long_ago) = now.checked_sub(ACCRUAL_IDLE_TTL + Duration::from_secs(1)) else {
            return;
        };
        admit(&map, "stale", 0, 1, long_ago);
        admit(&map, "fresh", 0, 1, now);
        sweep_idle(&map, now);
        assert!(!map.contains_key("stale"), "an idle run expires");
        assert!(map.contains_key("fresh"), "a recently ticked run stays");

        assert!(!has_capacity_for_new_run(&map, 1, now), "full of live runs");
        admit(&map, "stale-again", 0, 1, long_ago);
        assert!(
            has_capacity_for_new_run(&map, 2, now),
            "a full map sweeps idle runs before refusing"
        );
        assert_eq!(map.len(), 1);
    }

    fn master_state() -> crate::state::SharedState {
        let mut config = crate::config::GatewayConfig::default();
        config.auth.require_auth = true;
        config.auth.master_key = Some("sandbox-master".to_owned());
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        Arc::new(crate::state::AppState::new_for_test(
            config,
            audit,
            crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
        ))
    }

    fn bearer(key: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            format!("Bearer {key}").parse().expect("header value"),
        );
        headers
    }

    fn terminal_spec() -> SandboxSpec {
        SandboxSpec {
            vcpu: 2,
            mem_gib: 4,
            storage_gib: 10,
            gpu: GpuKind::None,
            gpu_count: 0,
            os: OsKind::Linux,
        }
    }

    fn heartbeat(run_id: &str, tick_index: u64, budget: u64) -> Json<SandboxTickBody> {
        Json(SandboxTickBody {
            run_id: run_id.to_owned(),
            org_id: None,
            spec: terminal_spec(),
            elapsed_seconds_delta: 600,
            tick_index,
            per_run_budget_micro_usd: budget,
            size: None,
            box_id: None,
            elapsed_seconds_total: None,
            minimum_waiver: None,
        })
    }

    #[tokio::test]
    async fn heartbeats_after_a_budget_kill_stay_killed_until_completion() {
        let state = master_state();
        let run_id = format!("sticky-{}", uuid::Uuid::new_v4());
        let Json(first) = sandbox_tick(
            State(Arc::clone(&state)),
            bearer("sandbox-master"),
            heartbeat(&run_id, 0, 0),
        )
        .await
        .expect("first tick");
        let per_tick = first.accrued_micro_usd;
        assert!(
            per_tick > 0,
            "the default sandbox price must bill a 10-minute tick"
        );
        // A cap between one and two ticks: tick 1 crosses it.
        let cap = per_tick + per_tick / 2;
        let Json(killed) = sandbox_tick(
            State(Arc::clone(&state)),
            bearer("sandbox-master"),
            heartbeat(&run_id, 1, cap),
        )
        .await
        .expect("cap-crossing tick");
        assert_eq!(killed.verdict, SandboxVerdict::KillBudget);
        assert_eq!(killed.accrued_micro_usd, per_tick * 2);

        // The provider stop failed; Core's next heartbeat must not restart the
        // budget at zero (the audit-source behaviour returned `continue` here).
        let Json(after) = sandbox_tick(
            State(Arc::clone(&state)),
            bearer("sandbox-master"),
            heartbeat(&run_id, 2, cap),
        )
        .await
        .expect("post-kill tick");
        assert_eq!(after.verdict, SandboxVerdict::KillBudget);
        assert_eq!(
            after.accrued_micro_usd,
            per_tick * 2,
            "no fresh accrual window"
        );

        // An untrusted caller cannot clear the terminal state.
        assert!(sandbox_complete(
            State(Arc::clone(&state)),
            bearer("not-the-master"),
            Json(SandboxCompleteBody {
                run_id: run_id.clone()
            }),
        )
        .await
        .is_err());
        assert!(accrual_map().contains_key(&run_id));

        let Json(done) = sandbox_complete(
            State(Arc::clone(&state)),
            bearer("sandbox-master"),
            Json(SandboxCompleteBody {
                run_id: run_id.clone(),
            }),
        )
        .await
        .expect("completion");
        assert!(done.removed);
        assert!(!accrual_map().contains_key(&run_id));
    }

    #[tokio::test]
    async fn normal_completion_releases_accrual_state_idempotently() {
        let state = master_state();
        let run_id = format!("normal-{}", uuid::Uuid::new_v4());
        let Json(first) = sandbox_tick(
            State(Arc::clone(&state)),
            bearer("sandbox-master"),
            heartbeat(&run_id, 0, 0),
        )
        .await
        .expect("tick");
        assert_eq!(first.verdict, SandboxVerdict::Continue);
        assert!(
            accrual_map().contains_key(&run_id),
            "a continue tick retains state"
        );
        for expected in [true, false] {
            let Json(done) = sandbox_complete(
                State(Arc::clone(&state)),
                bearer("sandbox-master"),
                Json(SandboxCompleteBody {
                    run_id: run_id.clone(),
                }),
            )
            .await
            .expect("completion");
            assert_eq!(done.removed, expected);
        }
        assert!(!accrual_map().contains_key(&run_id));
    }
}
