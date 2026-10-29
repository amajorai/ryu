//! Violation event reporter (spec 03.6.2, screener addendum section 11.1).
//!
//! Drains the violation outbox to `POST /api/abuse/ingest` on its own task
//! and its own cursor, so an audit backlog never delays a strike signal.
//!
//! - At most [`MAX_BATCH`] events per request, oldest first, each resent
//!   with the same `eventId` until the control plane answers 2xx.
//! - The cursor advances, and the acknowledged excerpts are cleared, only
//!   on 2xx. Any other answer holds the cursor and the next tick resends.
//! - A per-event rejection is not a failed request. An
//!   `evidence_forbidden_for_category` rejection drops that excerpt and
//!   resends the event once without it, in the same tick; any other reason is
//!   logged and the event is not retried.
//! - An event without a tenant org cannot be attributed by the control plane,
//!   so it stays in the local outbox and is never sent.
//!
//! Authentication is the gateway's control-plane key: on the hosted fleet a
//! node-control credential of Ryu's platform org holding the
//! `gateway.violations.report` operation; on any other node its own
//! `node.resolve` credential, whose events the control plane stores as
//! self-reported for that node's own org only.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Map, Value};
use tracing::{debug, warn};

use crate::audit::OutboxRow;
use crate::state::{AppState, SharedState};

/// Most events one ingest request carries (the control plane's limit).
pub const MAX_BATCH: usize = 500;
/// The rejection reason that means "send this event without its excerpt".
const EVIDENCE_FORBIDDEN: &str = "evidence_forbidden_for_category";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IngestResponse {
    #[serde(default)]
    ingested: u64,
    #[serde(default)]
    duplicates: u64,
    #[serde(default)]
    rejected: Vec<Rejection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rejection {
    #[serde(default)]
    event_id: String,
    #[serde(default)]
    reason: String,
}

/// What one push did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PushSummary {
    /// Events in the slice that were posted.
    pub sent: usize,
    /// Events kept local because they name no tenant org.
    pub local_only: usize,
    pub ingested: u64,
    pub duplicates: u64,
    /// `(eventId, reason)` the control plane refused, after any resend.
    pub rejected: Vec<(String, String)>,
    /// Events resent without their excerpt.
    pub resent_without_excerpt: usize,
}

/// Spawn the violation reporting loop beside the aggregate reporter. A no-op
/// when the control plane is disabled or no gateway key is configured.
pub fn spawn(state: SharedState) {
    let cfg = state.config.control_plane.clone();
    if !cfg.enabled || cfg.gateway_key.is_none() {
        return;
    }
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(Duration::from_secs(cfg.report_interval_secs.max(1)));
        loop {
            interval.tick().await;
            if let Err(error) = push_violations(&state).await {
                warn!("violation report failed: {error}");
            }
        }
    });
}

/// A 24-hex organization id, the only form the ingest route attributes.
fn is_org_id(value: &str) -> bool {
    value.len() == 24
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn ingest_url(base_url: &str) -> String {
    format!("{}/api/abuse/ingest", base_url.trim_end_matches('/'))
}

/// The request body for `rows`. Excerpts travel in `evidence`, keyed by the
/// event's `evidenceRef`, only when `with_evidence` and the row still holds
/// one with its keyed hash.
fn ingest_body(rows: &[&OutboxRow], with_evidence: bool) -> Value {
    let mut evidence = Map::new();
    let mut events = Vec::with_capacity(rows.len());
    for row in rows {
        let mut event = row.event.clone();
        let excerpt = row
            .excerpt
            .as_deref()
            .filter(|_| with_evidence && !event.excerpt_forbidden());
        match (excerpt, event.evidence_hmac.as_deref()) {
            (Some(excerpt), Some(hmac)) => {
                let reference = format!("evd_{}", event.event_id);
                evidence.insert(
                    reference.clone(),
                    json!({ "excerpt": excerpt, "hmac": hmac }),
                );
                event.evidence_ref = Some(reference);
            }
            _ => event.evidence_ref = None,
        }
        events.push(serde_json::to_value(&event).unwrap_or(Value::Null));
    }
    json!({
        "gatewayInstance": crate::policy::gateway_instance_id(),
        "events": events,
        "windows": [],
        "evidence": evidence,
    })
}

async fn post(state: &AppState, key: &str, body: &Value) -> anyhow::Result<IngestResponse> {
    let url = ingest_url(&state.config.control_plane.base_url);
    let response = state
        .http
        .post(&url)
        .header("x-gateway-key", key)
        .json(body)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        // The body is the control plane's own error text; never echo the
        // request back.
        anyhow::bail!("abuse ingest returned {status}");
    }
    Ok(response.json::<IngestResponse>().await.unwrap_or_default())
}

/// Post one slice of the outbox and advance its cursor on success.
pub async fn push_violations(state: &AppState) -> anyhow::Result<PushSummary> {
    let key = state
        .config
        .control_plane
        .gateway_key
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("missing gateway key"))?;
    if let Err(error) = state.violations.maintain() {
        warn!("violation outbox maintenance failed: {error}");
    }
    let rows = state.violations.pending(MAX_BATCH)?;
    let Some(last_id) = rows.last().map(|row| row.id) else {
        return Ok(PushSummary::default());
    };
    let sendable: Vec<&OutboxRow> = rows
        .iter()
        .filter(|row| row.event.org_id.as_deref().is_some_and(is_org_id))
        .collect();
    let mut summary = PushSummary {
        sent: sendable.len(),
        local_only: rows.len() - sendable.len(),
        ..PushSummary::default()
    };
    if !sendable.is_empty() {
        let response = post(state, key, &ingest_body(&sendable, true)).await?;
        summary.ingested = response.ingested;
        summary.duplicates = response.duplicates;
        let forbidden: HashSet<&str> = response
            .rejected
            .iter()
            .filter(|r| r.reason == EVIDENCE_FORBIDDEN)
            .map(|r| r.event_id.as_str())
            .collect();
        let mut rejected: HashMap<String, String> = response
            .rejected
            .iter()
            .filter(|r| r.reason != EVIDENCE_FORBIDDEN)
            .map(|r| (r.event_id.clone(), r.reason.clone()))
            .collect();
        if !forbidden.is_empty() {
            for event_id in &forbidden {
                state.violations.drop_excerpt(event_id)?;
            }
            let resend: Vec<&OutboxRow> = sendable
                .iter()
                .copied()
                .filter(|row| forbidden.contains(row.event.event_id.as_str()))
                .collect();
            summary.resent_without_excerpt = resend.len();
            // Once, without evidence. A failure here holds the cursor and the
            // next tick resends the slice, its excerpts already dropped.
            let again = post(state, key, &ingest_body(&resend, false)).await?;
            summary.ingested += again.ingested;
            summary.duplicates += again.duplicates;
            for r in again.rejected {
                rejected.insert(r.event_id, r.reason);
            }
        }
        let refused_org = rejected
            .values()
            .filter(|reason| reason.as_str() == "org_not_permitted")
            .count();
        if refused_org > 0 && refused_org == sendable.len() {
            // Every tenant event refused for its org: this replica reports
            // with a credential that is not the platform reporter, so the
            // control plane treats it as self-reported. On the fleet that
            // discards every strike signal; the key needs fixing.
            tracing::error!(
                events = refused_org,
                "control plane refused every violation event as org_not_permitted;                  the control-plane key lacks the gateway.violations.report operation"
            );
        }
        for (event_id, reason) in &rejected {
            warn!(
                event_id = event_id.as_str(),
                reason = reason.as_str(),
                "control plane refused a violation event"
            );
        }
        let mut rejected: Vec<(String, String)> = rejected.into_iter().collect();
        rejected.sort();
        summary.rejected = rejected;
    }
    state.violations.acknowledge(last_id)?;
    debug!(
        sent = summary.sent,
        ingested = summary.ingested,
        duplicates = summary.duplicates,
        "pushed violation events to the control plane"
    );
    Ok(summary)
}

#[cfg(test)]
#[path = "violations_tests.rs"]
mod tests;
