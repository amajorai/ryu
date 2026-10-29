//! Sending one tick and handling the Gateway's verdict or failure.

use super::*;

/// Send one `POST /sandbox/tick` and enforce its verdict.
pub(super) async fn send_tick(job: TickJob) {
    let endpoint = format!("{}/sandbox/tick", gateway_url().trim_end_matches('/'));
    deliver_tick(job, &endpoint, gateway_bearer()).await;
}

/// [`send_tick`] against an explicit endpoint and bearer.
pub(super) async fn deliver_tick(job: TickJob, endpoint: &str, bearer: Result<String, String>) {
    let bearer = match bearer {
        Ok(b) => b,
        Err(e) if job.org_id.is_none() => {
            tracing::warn!(run_id = %job.run_id, error = %e, "sandbox tick: no gateway bearer, skipping");
            return;
        }
        Err(e) => {
            tracing::warn!(run_id = %job.run_id, error = %e, "sandbox tick: no gateway bearer for org-bound run, stopping for accounting");
            enforce_kill(&job, KillReason::Accounting, 0).await;
            return;
        }
    };
    let body = job.body();

    let resp = post_tick(endpoint, &bearer, &body).await;

    let value = match resp {
        Ok(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
            Ok(v) => v,
            Err(e) if job.org_id.is_none() => {
                tracing::warn!(run_id = %job.run_id, error = %e, "sandbox tick: unparseable verdict for unattributed run, stopping metering");
                return;
            }
            Err(e) => {
                tracing::warn!(run_id = %job.run_id, error = %e, "sandbox tick: unparseable verdict, stopping for accounting");
                enforce_kill(&job, KillReason::Accounting, 0).await;
                return;
            }
        },
        Ok(r) if job.org_id.is_none() => {
            tracing::warn!(run_id = %job.run_id, status = %r.status(), "sandbox tick: gateway non-2xx for unattributed run, stopping metering");
            return;
        }
        Ok(r) if is_transient_status(r.status()) => {
            let detail = format!("gateway returned HTTP {}", r.status());
            handle_transient_tick_failure(&job, &detail).await;
            return;
        }
        Ok(r) => {
            tracing::warn!(run_id = %job.run_id, status = %r.status(), "sandbox tick: gateway non-2xx, stopping for accounting");
            enforce_kill(&job, KillReason::Accounting, 0).await;
            return;
        }
        Err(e) if job.org_id.is_none() => {
            tracing::warn!(run_id = %job.run_id, error = %e, "sandbox tick: gateway unreachable for unattributed run, skipping");
            return;
        }
        Err(e) => {
            let detail = format!("gateway unreachable: {e}");
            handle_transient_tick_failure(&job, &detail).await;
            return;
        }
    };

    let verdict = parse_verdict(value.get("verdict").and_then(|v| v.as_str()).unwrap_or(""));
    let Some(accrued) = value
        .get("accrued_micro_usd")
        .and_then(serde_json::Value::as_u64)
    else {
        if job.org_id.is_some() {
            tracing::warn!(run_id = %job.run_id, "sandbox tick: response omitted accrued amount, stopping for accounting");
            enforce_kill(&job, KillReason::Accounting, 0).await;
        }
        return;
    };

    let balance = value
        .get("balance_micro_usd")
        .and_then(serde_json::Value::as_i64);
    let rate = value
        .get("rate_micro_usd_per_hour")
        .and_then(serde_json::Value::as_u64);

    // Record the latest accrued figure, verdict, balance and rate for the
    // billing-visibility snapshot and clear the transient-failure streak. Only
    // if the run is still live (a kill verdict removes it just below, without
    // any grace).
    note_tick_success(
        &job.run_id,
        TickReport {
            accrued,
            verdict,
            balance,
            rate,
        },
    );

    match verdict {
        Verdict::Continue => {
            notify_tick_accepted(&job, accrued, balance, verdict);
        }
        Verdict::Warn => {
            tracing::warn!(
                run_id = %job.run_id,
                accrued_micro_usd = accrued,
                balance_micro_usd = ?balance,
                "sandbox tick: budget/balance warning"
            );
            notify_tick_accepted(&job, accrued, balance, verdict);
        }
        Verdict::KillAccounting if job.org_id.is_none() => {
            tracing::warn!(run_id = %job.run_id, "sandbox tick: accounting verdict for unattributed run, stopping metering");
        }
        Verdict::KillBudget | Verdict::KillBalance | Verdict::KillAccounting => {
            let reason = if verdict == Verdict::KillBudget {
                KillReason::Budget
            } else if verdict == Verdict::KillBalance {
                KillReason::Balance
            } else {
                KillReason::Accounting
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

/// Whether a tick response status is worth retrying: the Gateway is restarting,
/// overloaded, or rate limiting. Any other non-2xx is a protocol failure.
pub(super) fn is_transient_status(status: reqwest::StatusCode) -> bool {
    status.is_server_error()
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
}

/// POST one tick, retrying transport errors and transient statuses within the
/// cycle (mirroring [`debit_final`]). The body, and so its `tick_index`, is the
/// same on every attempt. Returns the last outcome for the caller to classify.
pub(super) async fn post_tick(
    endpoint: &str,
    bearer: &str,
    body: &serde_json::Value,
) -> reqwest::Result<reqwest::Response> {
    let client = reqwest::Client::new();
    let mut attempt = 1;
    loop {
        let result = client
            .post(endpoint)
            .timeout(Duration::from_secs(5))
            .bearer_auth(bearer)
            .json(body)
            .send()
            .await;
        let transient = match &result {
            Ok(response) => is_transient_status(response.status()),
            Err(_) => true,
        };
        if !transient || attempt >= TICK_SEND_ATTEMPTS {
            return result;
        }
        tokio::time::sleep(Duration::from_millis(250 * attempt)).await;
        attempt += 1;
    }
}

/// A run's current streak of transient tick failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct TickFailureStreak {
    /// Failed ticks in a row, including this one.
    pub(super) failures: u32,
    /// Time since the streak's first failed tick.
    pub(super) failing_for: Duration,
}

/// Count one transient tick failure. Returns the new streak while the run is
/// live, or `None` once it has left the registry.
pub(super) fn note_tick_failure(run_id: &str) -> Option<TickFailureStreak> {
    let now = Instant::now();
    let mut runs = lock_runs();
    let run = runs.get_mut(run_id)?;
    run.consecutive_tick_failures = run.consecutive_tick_failures.saturating_add(1);
    let since = *run.tick_failing_since.get_or_insert(now);
    Some(TickFailureStreak {
        failures: run.consecutive_tick_failures,
        failing_for: now.saturating_duration_since(since),
    })
}

/// Whether a transient-failure streak has used up the grace: too many failed
/// ticks, or failing for too long.
pub(super) fn tick_grace_exhausted(streak: TickFailureStreak) -> bool {
    streak.failures >= MAX_CONSECUTIVE_TICK_FAILURES || streak.failing_for >= MAX_TICK_FAILURE_GRACE
}

/// The figures one parsed Gateway tick response carries.
#[derive(Debug, Clone, Copy)]
pub(super) struct TickReport {
    pub(super) accrued: u64,
    pub(super) verdict: Verdict,
    pub(super) balance: Option<i64>,
    pub(super) rate: Option<u64>,
}

/// Record a parsed Gateway response for the snapshot (accrued, verdict,
/// balance and rate), and end any transient-failure streak. A Gateway that
/// predates the rate field keeps the last known rate.
pub(super) fn note_tick_success(run_id: &str, report: TickReport) {
    if let Some(run) = lock_runs().get_mut(run_id) {
        run.last_accrued_micro_usd = report.accrued;
        run.last_verdict = Some(report.verdict);
        run.balance_micro_usd = report.balance;
        if report.rate.is_some() {
            run.rate_micro_usd_per_hour = report.rate;
        }
        run.consecutive_tick_failures = 0;
        run.tick_failing_since = None;
    }
}

/// Fire the run's [`on_tick_accepted`] hook, if any, without awaiting it.
pub(super) fn notify_tick_accepted(
    job: &TickJob,
    accrued: u64,
    balance: Option<i64>,
    verdict: Verdict,
) {
    let Some(callback) = lock_callbacks().get(&job.run_id).cloned() else {
        return;
    };
    let accepted = TickAccepted {
        run_id: job.run_id.clone(),
        box_id: job.box_id.clone(),
        tick_index: job.tick_index,
        accrued_micro_usd: accrued,
        balance_micro_usd: balance,
        verdict,
    };
    if tokio::runtime::Handle::try_current().is_ok() {
        tokio::spawn(callback(accepted));
    }
}

/// An org-bound tick failed transiently after its retries: keep the run live
/// until the streak uses up the grace ([`tick_grace_exhausted`]), then stop it.
pub(super) async fn handle_transient_tick_failure(job: &TickJob, detail: &str) {
    match note_tick_failure(&job.run_id) {
        Some(streak) if tick_grace_exhausted(streak) => {
            tracing::warn!(
                run_id = %job.run_id,
                failures = streak.failures,
                failing_for_secs = streak.failing_for.as_secs(),
                error = %detail,
                "sandbox tick: gateway unavailable for consecutive ticks, stopping for accounting"
            );
            enforce_kill(job, KillReason::Accounting, 0).await;
        }
        Some(streak) => {
            tracing::warn!(
                run_id = %job.run_id,
                failures = streak.failures,
                max_failures = MAX_CONSECUTIVE_TICK_FAILURES,
                failing_for_secs = streak.failing_for.as_secs(),
                error = %detail,
                "sandbox tick: transient gateway failure, keeping run live"
            );
        }
        None => {}
    }
}

/// Delay before stop retry `attempt` (1-based): 1 s, 5 s, 30 s, then every
/// 60 s.
pub(super) fn kill_retry_delay(attempt: u32) -> Duration {
    match attempt {
        0 | 1 => Duration::from_secs(1),
        2 => Duration::from_secs(5),
        3 => Duration::from_secs(30),
        _ => Duration::from_secs(60),
    }
}
