use std::sync::OnceLock;
use std::time::Duration;

use axum::{extract::State, http::HeaderMap, Json};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    config::{GpuKind, OsKind},
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
}

/// Verdict returned to Core for a tick. Snake-case on the wire (frozen).
#[derive(Debug, Clone, Copy, Serialize)]
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
}

/// Response from `POST /sandbox/tick`.
#[derive(Debug, Serialize)]
pub struct SandboxTickResponse {
    /// Cumulative billed (marked-up) micro-USD accrued for this run.
    pub accrued_micro_usd: u64,
    /// Authoritative wallet balance after the debit, or `null` when unknown
    /// (credits inactive / no org / debit unreachable).
    pub balance_micro_usd: Option<i64>,
    /// Continue / warn / kill decision for this tick.
    pub verdict: SandboxVerdict,
}

/// Per-run accrual state, held process-global in `accrual_map`.
struct RunAccrual {
    /// Cumulative billed (marked-up) micro-USD.
    accrued_micro: u64,
    /// Highest `tick_index` accrued so far (monotonic dedup guard).
    last_tick_index: u64,
}

/// Process-global accrual + last-tick map, keyed by `run_id`. A static rather
/// than an `AppState` field: it is self-contained metering state consulted only
/// by `sandbox_tick`, so it lives in one place (mirrors the widget rate limiter).
fn accrual_map() -> &'static DashMap<String, RunAccrual> {
    static MAP: OnceLock<DashMap<String, RunAccrual>> = OnceLock::new();
    MAP.get_or_init(DashMap::new)
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

    let map = accrual_map();

    // Step 1 — replay guard. A repeated/out-of-order tick for a known run is a
    // no-op: return the current accrual, verdict `continue`, and an unknown
    // balance, without debiting. The `map.get` guard only fires when an entry
    // already exists, so a genuine first tick (index 0) is not mistaken for a
    // replay of the zero-initialized default.
    if let Some(existing) = map.get(&body.run_id) {
        if body.tick_index <= existing.last_tick_index {
            return Ok(Json(SandboxTickResponse {
                accrued_micro_usd: existing.accrued_micro,
                balance_micro_usd: None,
                verdict: SandboxVerdict::Continue,
            }));
        }
    }

    // Steps 2-3 — raw cost of this delta, then apply the sandbox markup. Both
    // live on `CreditsConfig` (owner: config.rs); never reimplement the math here.
    let credits = &state.config.credits;
    let raw_micro = credits.sandbox_tick_cost_raw_micro(
        body.spec.vcpu,
        body.spec.mem_gib,
        body.spec.storage_gib,
        body.spec.gpu,
        body.spec.gpu_count,
        body.spec.os,
        body.elapsed_seconds_delta,
    );
    let billed_micro = credits.sandbox_debit_amount(raw_micro);

    // Step 4 — accrue and advance the tick watermark under one short lock, then
    // drop the guard BEFORE any await (a held DashMap ref across `.await` would
    // deadlock the shard).
    let accrued = {
        let mut entry = map.entry(body.run_id.clone()).or_insert(RunAccrual {
            accrued_micro: 0,
            last_tick_index: 0,
        });
        entry.accrued_micro = entry.accrued_micro.saturating_add(billed_micro);
        entry.last_tick_index = body.tick_index;
        entry.accrued_micro
    };

    // Step 5 — synchronous (awaited) debit; balance is the authoritative wallet
    // reading, or `None` when unknown (fail-open).
    let balance = debit_sandbox_sync(
        &state,
        body.org_id.as_deref(),
        &body.run_id,
        body.tick_index,
        billed_micro,
    )
    .await;

    // Step 6 — verdict, in the frozen priority order.
    let verdict = compute_verdict(accrued, body.per_run_budget_micro_usd, balance, billed_micro);

    // Step 7 — a kill verdict ends the run; evict its accrual state.
    if matches!(
        verdict,
        SandboxVerdict::KillBudget | SandboxVerdict::KillBalance
    ) {
        map.remove(&body.run_id);
    }

    Ok(Json(SandboxTickResponse {
        accrued_micro_usd: accrued,
        balance_micro_usd: balance,
        verdict,
    }))
}

/// Verdict priority (frozen): `kill_balance` > `kill_budget` > `warn` > `continue`.
/// - `kill_balance`: balance known and non-positive.
/// - `kill_budget`: per-run cap set and reached.
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
/// or `None` when credits are inactive, no org is present, the amount rounds to
/// zero, or the control plane is unreachable (fail-open).
async fn debit_sandbox_sync(
    state: &SharedState,
    org_id: Option<&str>,
    run_id: &str,
    tick_index: u64,
    billed_micro: u64,
) -> Option<i64> {
    let org_id = org_id.filter(|s| !s.is_empty())?;
    let credits = &state.config.credits;
    if !credits.is_active() || billed_micro == 0 {
        return None;
    }
    let secret = credits.internal_secret.as_deref()?;

    let url = format!("{}/credits/debit", credits.base_url.trim_end_matches('/'));
    let ref_id = format!("{run_id}:sandbox:{tick_index}");
    let body = json!({
        "orgId": org_id,
        "amountMicroUsd": billed_micro,
        "reason": "sandbox",
        "refId": ref_id,
    });

    let resp = state
        .http
        .post(&url)
        .header("x-ryu-internal-secret", secret)
        .timeout(Duration::from_millis(credits.timeout_ms.max(1)))
        .json(&body)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }

    let v = resp.json::<Value>().await.ok()?;
    let balance = v["balanceMicroUsd"].as_i64()?;
    // Steady-state truth: keep the cached empty flag in sync so the chat path is
    // gated after a sandbox drains the wallet (self-heals after a top-up).
    state.wallet.set_org_empty(org_id, balance <= 0);
    Some(balance)
}

#[cfg(test)]
mod tests {
    use super::{compute_verdict, SandboxVerdict};

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
}
