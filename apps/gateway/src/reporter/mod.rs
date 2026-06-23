//! Control-plane reporter (M7 / U29).
//!
//! Periodically pushes the gateway's local eval/budget/audit state up to the
//! control plane for aggregation and dashboards, and (when configured)
//! reconciles a shared budget through the coordinator so spend stays bounded
//! across every user and machine on that budget.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::{audit::AuditQuery, state::SharedState};

/// Spawn the background reporting loop. A no-op when the control plane is
/// disabled or no gateway key is configured.
pub fn spawn(state: SharedState) {
    let cfg = state.config.control_plane.clone();
    if !cfg.enabled || cfg.gateway_key.is_none() {
        debug!("control-plane reporting disabled");
        return;
    }

    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(Duration::from_secs(cfg.report_interval_secs.max(1)));
        loop {
            interval.tick().await;
            if let Err(e) = push_report(&state).await {
                warn!("control-plane report failed: {e}");
            }
            if let Err(e) = reconcile_budget(&state).await {
                warn!("control-plane budget reconcile failed: {e}");
            }
        }
    });
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Estimated spend in micro-USD for the given token totals.
fn cost_micro_usd(state: &SharedState, input: u64, output: u64) -> u64 {
    let per_1k = state.config.control_plane.cost_per_1k_micro_usd;
    (input + output).saturating_mul(per_1k) / 1000
}

/// Build the aggregate report plus a bounded slice of recent (redacted) audit
/// rows and POST them to `/aggregation/ingest`.
async fn push_report(state: &SharedState) -> anyhow::Result<()> {
    let cfg = &state.config.control_plane;
    let key = cfg
        .gateway_key
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("missing gateway key"))?;

    let summary = state.audit.summary()?;
    let cost = cost_micro_usd(state, summary.input_tokens, summary.output_tokens);
    let eval_scores = state.evals.all_provider_scores();

    let entries = state.audit.query(&AuditQuery {
        limit: Some(cfg.audit_limit),
        ..Default::default()
    })?;
    let audit: Vec<Value> = entries
        .iter()
        .map(|e| {
            json!({
                "id": e.id,
                "timestamp": e.timestamp,
                "requestId": e.request_id,
                "apiKey": e.api_key,
                "userName": e.user_name,
                "teamId": e.team_id,
                "projectId": e.project_id,
                "provider": e.provider,
                "model": e.model,
                "inputTokens": e.input_tokens,
                "outputTokens": e.output_tokens,
                "latencyMs": e.latency_ms,
                "evalScore": e.eval_score,
                "error": e.error,
            })
        })
        .collect();

    let payload = json!({
        "report": {
            "windowStart": now_ms().saturating_sub(cfg.report_interval_secs * 1000),
            "windowEnd": now_ms(),
            "inputTokens": summary.input_tokens,
            "outputTokens": summary.output_tokens,
            "costMicroUsd": cost,
            "requestCount": summary.request_count,
            "errorCount": summary.error_count,
            "evalScores": eval_scores,
        },
        "audit": audit,
    });

    let url = format!("{}/aggregation/ingest", cfg.base_url.trim_end_matches('/'));
    let resp = state
        .http
        .post(&url)
        .header("x-gateway-key", key)
        .json(&payload)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("ingest returned {status}: {body}");
    }

    debug!(
        requests = summary.request_count,
        cost_micro_usd = cost,
        audit_rows = audit.len(),
        "pushed report to control plane"
    );
    Ok(())
}

/// Report this gateway's total spend against a shared budget and read back the
/// reconciled remaining balance. The coordinator is the single source of truth.
async fn reconcile_budget(state: &SharedState) -> anyhow::Result<()> {
    let cfg = &state.config.control_plane;
    let Some(budget_id) = cfg.shared_budget_id.as_ref() else {
        return Ok(());
    };
    let key = cfg
        .gateway_key
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("missing gateway key"))?;

    let summary = state.audit.summary()?;
    let consumed = cost_micro_usd(state, summary.input_tokens, summary.output_tokens);

    let url = format!(
        "{}/aggregation/budgets/{}/reserve",
        cfg.base_url.trim_end_matches('/'),
        budget_id
    );
    let resp = state
        .http
        .post(&url)
        .header("x-gateway-key", key)
        .json(&json!({ "consumedMicroUsd": consumed }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("reserve returned {status}: {body}");
    }

    let body: Value = resp.json().await?;
    if body["exceeded"].as_bool().unwrap_or(false) {
        state.shared_budget.set_shared_exceeded(true);
        warn!(
            budget_id = %budget_id,
            consumed_micro_usd = consumed,
            "shared budget exceeded; gateway will enforce locally"
        );
    } else {
        state.shared_budget.set_shared_exceeded(false);
    }
    Ok(())
}
