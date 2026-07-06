//! Control-plane reporter (M7 / U29).
//!
//! Periodically pushes the gateway's local eval/budget/audit state up to the
//! control plane for aggregation and dashboards, and (when configured)
//! reconciles a shared budget through the coordinator so spend stays bounded
//! across every user and machine on that budget.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::{
    audit::{AuditEntry, AuditQuery},
    state::SharedState,
};

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

/// Length of the leading `YYYY-MM-DD` slice of a SQLite `datetime('now')`
/// timestamp (always UTC), used as the per-day rollup key.
const DAY_KEY_LEN: usize = 10;
/// Divisor from milliseconds to whole seconds for `agentSeconds`.
const MS_PER_SEC: u64 = 1000;

/// Per-`(userId, day)` accumulator for the control-plane usage rollup. Mirrors
/// the `UserUsageDaily` shape the ingest upserts via `$inc`.
#[derive(Default)]
struct UserDailyBucket {
    input_tokens: u64,
    output_tokens: u64,
    request_count: u64,
    /// Distinct session ids seen this day → `sessionCount`.
    sessions: HashSet<String>,
    /// Summed exec `duration_ms`; divided down to whole seconds at emit time.
    agent_ms: u64,
    /// Per-feature request counts (`chat` | `island` | `agent`).
    feat_chat: u64,
    feat_island: u64,
    feat_agent: u64,
    /// Predict impressions. We can only observe requests, so `accepted` is 0.
    predict_shown: u64,
    /// Per-model request counts.
    by_model: HashMap<String, u64>,
    /// Per-skill request counts from `x-ryu-skill-ids`.
    by_skill: HashMap<String, u64>,
    /// Per-transport request counts. Gateway-observed rows are exact; ACP rows can
    /// be added later by Core/app-observed usage events.
    by_transport: HashMap<String, u64>,
}

impl UserDailyBucket {
    /// Fold a single audit row (already known to carry a `user_id`) into the bucket.
    fn absorb(&mut self, entry: &AuditEntry) {
        self.input_tokens = self.input_tokens.saturating_add(entry.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(entry.output_tokens);
        if entry.event_type == "model_call" {
            self.request_count = self.request_count.saturating_add(1);
            *self.by_model.entry(entry.model.clone()).or_insert(0) += 1;
            *self.by_transport.entry("gateway".to_string()).or_insert(0) += 1;
        }
        if let Some(skill_ids) = &entry.skill_ids {
            for skill in skill_ids
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                *self.by_skill.entry(skill.to_string()).or_insert(0) += 1;
            }
        }
        if let Some(session) = &entry.session_id {
            self.sessions.insert(session.clone());
        }
        if let Some(ms) = entry.duration_ms {
            self.agent_ms = self.agent_ms.saturating_add(ms);
        }
        match entry.feature.as_deref() {
            Some("chat") => self.feat_chat += 1,
            Some("island") => self.feat_island += 1,
            Some("agent") => self.feat_agent += 1,
            Some("predict") => self.predict_shown += 1,
            _ => {}
        }
    }

    /// Serialise the `byFeature` object, emitting only the surfaces that fired so
    /// the payload stays sparse (matches the optional `FeatureUsage` fields).
    fn by_feature_json(&self) -> Value {
        let mut feature = serde_json::Map::new();
        if self.feat_chat > 0 {
            feature.insert("chat".to_string(), json!(self.feat_chat));
        }
        if self.feat_island > 0 {
            feature.insert("island".to_string(), json!(self.feat_island));
        }
        if self.feat_agent > 0 {
            feature.insert("agent".to_string(), json!(self.feat_agent));
        }
        if self.predict_shown > 0 {
            feature.insert(
                "predict".to_string(),
                json!({ "shown": self.predict_shown, "accepted": 0 }),
            );
        }
        Value::Object(feature)
    }
}

/// Group the recent audit rows that carry a forwarded `user_id` into per-user,
/// per-UTC-day buckets shaped like `UserUsageDaily`. Self-hosted / untagged rows
/// (no `user_id`) are skipped, so this is empty on single-user deployments.
fn build_user_daily(state: &SharedState, entries: &[AuditEntry]) -> Vec<Value> {
    let mut buckets: HashMap<(String, String), UserDailyBucket> = HashMap::new();
    for entry in entries {
        let Some(user_id) = entry.user_id.clone() else {
            continue;
        };
        let Some(day) = entry.timestamp.get(..DAY_KEY_LEN) else {
            continue;
        };
        buckets
            .entry((user_id, day.to_string()))
            .or_default()
            .absorb(entry);
    }

    buckets
        .into_iter()
        .map(|((user_id, day), bucket)| {
            json!({
                "userId": user_id,
                "day": day,
                "inputTokens": bucket.input_tokens,
                "outputTokens": bucket.output_tokens,
                "requestCount": bucket.request_count,
                "sessionCount": bucket.sessions.len() as u64,
                "agentSeconds": bucket.agent_ms / MS_PER_SEC,
                // Per-row provider cost isn't recorded; reuse the same flat token
                // estimate the aggregate report uses so the field is populated
                // consistently rather than sent as zero.
                "costMicroUsd": cost_micro_usd(state, bucket.input_tokens, bucket.output_tokens),
                "byFeature": bucket.by_feature_json(),
                "byModel": bucket.by_model,
                "bySkill": bucket.by_skill,
                "byTransport": bucket.by_transport,
            })
        })
        .collect()
}

/// Per-`(userId, agentId, day)` accumulator for the control-plane agent usage
/// rollup. Mirrors the `AgentUsageDaily` shape the ingest upserts via `$inc`.
#[derive(Default)]
struct AgentDailyBucket {
    input_tokens: u64,
    output_tokens: u64,
    request_count: u64,
    /// Distinct session ids seen this day → `sessionCount`.
    sessions: HashSet<String>,
    /// Summed exec `duration_ms`; divided down to whole seconds at emit time.
    agent_ms: u64,
    /// Per-model request counts.
    by_model: HashMap<String, u64>,
}

impl AgentDailyBucket {
    /// Fold a single audit row (already known to carry both a `user_id` and an
    /// `agent_id`) into the bucket.
    fn absorb(&mut self, entry: &AuditEntry) {
        self.input_tokens = self.input_tokens.saturating_add(entry.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(entry.output_tokens);
        if entry.event_type == "model_call" {
            self.request_count = self.request_count.saturating_add(1);
            *self.by_model.entry(entry.model.clone()).or_insert(0) += 1;
        }
        if let Some(session) = &entry.session_id {
            self.sessions.insert(session.clone());
        }
        if let Some(ms) = entry.duration_ms {
            self.agent_ms = self.agent_ms.saturating_add(ms);
        }
    }
}

/// Group the recent audit rows that carry BOTH a forwarded `user_id` AND an
/// `agent_id` into per-user, per-agent, per-UTC-day buckets shaped like
/// `AgentUsageDaily`. Rows missing either id are skipped, so this is empty on
/// single-user / untagged deployments.
fn build_agent_daily(state: &SharedState, entries: &[AuditEntry]) -> Vec<Value> {
    let mut buckets: HashMap<(String, String, String), AgentDailyBucket> = HashMap::new();
    for entry in entries {
        let Some(user_id) = entry.user_id.clone() else {
            continue;
        };
        let Some(agent_id) = entry.agent_id.clone() else {
            continue;
        };
        let Some(day) = entry.timestamp.get(..DAY_KEY_LEN) else {
            continue;
        };
        buckets
            .entry((user_id, agent_id, day.to_string()))
            .or_default()
            .absorb(entry);
    }

    buckets
        .into_iter()
        .map(|((user_id, agent_id, day), bucket)| {
            json!({
                "userId": user_id,
                "agentId": agent_id,
                "day": day,
                "inputTokens": bucket.input_tokens,
                "outputTokens": bucket.output_tokens,
                "requestCount": bucket.request_count,
                "sessionCount": bucket.sessions.len() as u64,
                "agentSeconds": bucket.agent_ms / MS_PER_SEC,
                // Per-row provider cost isn't recorded; reuse the same flat token
                // estimate the aggregate report uses so the field is populated
                // consistently rather than sent as zero.
                "costMicroUsd": cost_micro_usd(state, bucket.input_tokens, bucket.output_tokens),
                "byModel": bucket.by_model,
            })
        })
        .collect()
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

    // Per-user daily rollup (profiles / usage-points). Derived from the SAME
    // recent audit slice as `audit` above; rows without a forwarded user_id are
    // skipped, so this is empty on self-hosted / single-user gateways.
    let user_daily = build_user_daily(state, &entries);

    // Per-user-per-agent daily rollup (agent-level attribution). Derived from the
    // SAME recent audit slice; rows missing a user_id OR agent_id are skipped, so
    // this is empty on self-hosted / single-user / untagged gateways.
    let agent_daily = build_agent_daily(state, &entries);

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
        "userDaily": user_daily,
        "agentDaily": agent_daily,
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
        user_daily = payload["userDaily"].as_array().map_or(0, Vec::len),
        agent_daily = payload["agentDaily"].as_array().map_or(0, Vec::len),
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
