//! Final tail debit and rate quotes against the Gateway.

use super::*;

/// Issue a single final metering debit for a completed one-shot run's un-ticked
/// tail (rounded-up seconds). Call it after [`deregister_for_final_debit`] so
/// the periodic ticker can no longer fire for the run — this charges the
/// remainder the ticker missed (typically a sub-[`TICK_INTERVAL`] run the ticker
/// never saw).
///
/// `residual` is what [`deregister_for_final_debit`] returned: its
/// `next_tick_index` dedups the debit, and a Box run's `size` and `box_id` go
/// on the wire exactly as the ticks send them, so the tail is priced at the
/// size rate and its ledger row carries the same `box:<id>` label.
///
/// A completed run has nothing left to kill, so a failed tail is retried and
/// returned as an error to the caller. The caller must still destroy the remote
/// workspace, but it must not silently report a successful billable execution
/// when the final charge could not be confirmed.
pub async fn debit_final(
    run_id: String,
    org_id: Option<String>,
    spec: SandboxSpec,
    seconds: u64,
    per_run_budget_micro_usd: u64,
    residual: RunResidual,
) -> Result<(), String> {
    let completed_run = run_id.clone();
    let result = settle_final_debit(
        run_id,
        org_id,
        spec,
        seconds,
        per_run_budget_micro_usd,
        &residual,
    )
    .await;
    // Final accounting is done (or definitively failed): Core never ticks this
    // run again, including on the zero-residual path that sent nothing.
    complete_run(&completed_run).await;
    result
}

pub(super) async fn settle_final_debit(
    run_id: String,
    org_id: Option<String>,
    spec: SandboxSpec,
    seconds: u64,
    per_run_budget_micro_usd: u64,
    residual: &RunResidual,
) -> Result<(), String> {
    if seconds == 0 {
        return Ok(());
    }
    if org_id.is_none() {
        return Ok(());
    }
    let bearer = match gateway_bearer() {
        Ok(b) => b,
        Err(e) => {
            return Err(format!("no gateway bearer: {e}"));
        }
    };
    let endpoint = format!("{}/sandbox/tick", gateway_url().trim_end_matches('/'));
    let body = final_debit_body(
        &run_id,
        org_id.as_deref(),
        &spec,
        seconds,
        per_run_budget_micro_usd,
        residual,
    );
    send_final_debit(&endpoint, &bearer, &run_id, seconds, &body).await
}

/// The Gateway's customer rate (micro-USD per hour) for a run of `spec` and
/// Box `size`, from `POST /sandbox/quote`: the same rate table, and the same
/// math, the run's ticks will be priced with. An error means the rate is
/// unknown; callers must not substitute a guess.
pub async fn quote_rate(spec: &SandboxSpec, size: Option<BoxSize>) -> Result<u64, String> {
    let bearer = gateway_bearer().map_err(|e| format!("no gateway bearer: {e}"))?;
    let endpoint = format!("{}/sandbox/quote", gateway_url().trim_end_matches('/'));
    quote_rate_at(&endpoint, &bearer, spec, size).await
}

/// [`quote_rate`] against an explicit endpoint and bearer.
pub async fn quote_rate_at(
    endpoint: &str,
    bearer: &str,
    spec: &SandboxSpec,
    size: Option<BoxSize>,
) -> Result<u64, String> {
    let mut body = json!({ "spec": spec });
    if let Some(size) = size {
        body["size"] = json!(size.as_str());
    }
    let response = reqwest::Client::new()
        .post(endpoint)
        .timeout(Duration::from_secs(3))
        .bearer_auth(bearer)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("sandbox quote failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("sandbox quote answered {status}"));
    }
    let answer: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("sandbox quote was not JSON: {e}"))?;
    answer
        .get("rate_micro_usd_per_hour")
        .and_then(serde_json::Value::as_u64)
        .filter(|rate| *rate > 0)
        .ok_or_else(|| "sandbox quote carried no positive rate".to_owned())
}

/// The final tail debit's tick body: the residual's next tick index and the
/// run's Box `size` and `box_id`, the same attribution its ticks sent.
pub(super) fn final_debit_body(
    run_id: &str,
    org_id: Option<&str>,
    spec: &SandboxSpec,
    seconds: u64,
    per_run_budget_micro_usd: u64,
    residual: &RunResidual,
) -> serde_json::Value {
    tick_body(&TickBody {
        run_id,
        org_id,
        spec,
        elapsed_seconds_delta: seconds,
        tick_index: residual.next_tick_index,
        per_run_budget_micro_usd,
        size: residual.size,
        box_id: residual.box_id.as_deref(),
        elapsed_seconds_total: residual.ticked_seconds.saturating_add(seconds),
        minimum_waiver: residual.minimum_waiver.as_deref(),
    })
}

/// POST one final-debit `body` to `endpoint`, retrying up to three times until
/// the Gateway confirms it with a billing verdict and an accrued amount.
pub(super) async fn send_final_debit(
    endpoint: &str,
    bearer: &str,
    run_id: &str,
    seconds: u64,
    body: &serde_json::Value,
) -> Result<(), String> {
    let mut last_error = String::from("final debit failed");
    for attempt in 0..3 {
        match reqwest::Client::new()
            .post(endpoint)
            .timeout(Duration::from_secs(5))
            .bearer_auth(bearer)
            .json(body)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
                Ok(value) => {
                    let verdict = value
                        .get("verdict")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    let Some(accrued) = value
                        .get("accrued_micro_usd")
                        .and_then(serde_json::Value::as_u64)
                    else {
                        last_error = "gateway response omitted accrued amount".to_owned();
                        continue;
                    };
                    if !matches!(
                        verdict,
                        "continue" | "warn" | "kill_budget" | "kill_balance"
                    ) {
                        last_error = format!("gateway returned accounting verdict {verdict:?}");
                        continue;
                    }
                    tracing::info!(
                        run_id = %run_id,
                        seconds,
                        accrued_micro_usd = accrued,
                        "sandbox final debit: un-ticked tail reported to gateway"
                    );
                    return Ok(());
                }
                Err(error) => {
                    last_error = format!("gateway response was not valid JSON: {error}");
                }
            },
            Ok(response) => {
                last_error = format!("gateway returned HTTP {}", response.status());
            }
            Err(error) => {
                last_error = format!("gateway request failed: {error}");
            }
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(250 * (attempt + 1))).await;
        }
    }
    Err(last_error)
}
