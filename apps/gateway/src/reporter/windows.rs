//! Usage window reporter (managed guardrails spec 04.4, 03.6.2).
//!
//! Closes finished minutes of [`crate::usage_windows::UsageWindows`] into the
//! violation outbox and posts them to `POST /api/abuse/ingest` in the
//! `windows` array, on their own task, cursor and requests. A window request
//! never carries violation events, so a window backlog or a refused window
//! batch can never delay a strike signal.
//!
//! - Only `Fleet` and `ManagedNode` Gateways report windows; a `SelfHosted`
//!   Gateway spawns no window task and its push is a no-op.
//! - A request carries at most [`MAX_WINDOWS`] windows and at most
//!   [`MAX_BODY_BYTES`] of them, under the control plane's 2000-window and
//!   4 MB limits, and only windows queued under one instance id: the
//!   control plane keys a window by instance, credential and minute, so a
//!   window queued before a restart is resent under the id it was closed
//!   with.
//! - The window cursor advances only on 2xx. Anything else holds it and the
//!   next tick resends the same bytes, which the control plane stores once.

use std::time::Duration;

use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::audit::{WindowRecord, WindowRow, DEFAULT_MAX_WINDOW_ROWS};
use crate::state::{AppState, SharedState};
use crate::usage_windows::{reports_windows, window_reporting_active};

/// Most windows one ingest request carries (the control plane's limit).
pub const MAX_WINDOWS: usize = 2000;
/// Most window bytes one ingest request carries, well inside the control
/// plane's 4 MB body limit.
pub const MAX_BODY_BYTES: usize = 3 * 1024 * 1024;
/// How often finished minutes are closed and the queue drained.
const TICK: Duration = Duration::from_secs(10);

/// What one push did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WindowPushSummary {
    /// Windows closed into the outbox by this push.
    pub closed: usize,
    /// Windows posted.
    pub sent: usize,
    /// Windows the control plane newly stored (its `windows` answer).
    pub stored: u64,
    /// Ingest requests made.
    pub requests: usize,
}

/// Spawn the window reporting loop. A no-op on a self-hosted Gateway, when
/// the control plane is disabled, or when no gateway key is configured.
pub fn spawn(state: SharedState) {
    let cfg = state.config.control_plane.clone();
    if !window_reporting_active(state.custody, &cfg) {
        return;
    }
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(TICK);
        loop {
            interval.tick().await;
            if let Err(error) = push_windows(&state).await {
                warn!("usage window report failed: {error}");
            }
        }
    });
}

/// Move every closed minute into the outbox under this process's instance
/// id. Returns how many windows were queued.
pub fn close_windows(
    state: &AppState,
    now: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<usize> {
    if !reports_windows(state.custody) {
        return Ok(0);
    }
    let closed = state.usage_windows.drain_closed(now);
    if closed.is_empty() {
        return Ok(0);
    }
    let records = closed
        .iter()
        .map(|window| {
            Ok(WindowRecord {
                credential_id: window.credential_id.clone(),
                minute: window.minute.clone(),
                json: serde_json::to_string(window)?,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    state
        .violations
        .enqueue_windows(crate::policy::gateway_instance_id(), &records)
}

/// The leading run of `rows` that shares the first row's instance id and
/// fits one request.
fn next_batch(rows: &[WindowRow]) -> &[WindowRow] {
    let Some(first) = rows.first() else {
        return rows;
    };
    let mut bytes = 0usize;
    let mut end = 0usize;
    for row in rows.iter().take(MAX_WINDOWS) {
        if row.instance_id != first.instance_id {
            break;
        }
        let next = bytes + row.json.len() + 1;
        if end > 0 && next > MAX_BODY_BYTES {
            break;
        }
        bytes = next;
        end += 1;
    }
    &rows[..end]
}

async fn post(state: &AppState, key: &str, batch: &[WindowRow]) -> anyhow::Result<u64> {
    let windows = batch
        .iter()
        .map(|row| serde_json::from_str::<Value>(&row.json))
        .collect::<Result<Vec<_>, _>>()?;
    let body = json!({
        "gatewayInstance": batch.first().map(|row| row.instance_id.as_str()),
        "events": [],
        "windows": windows,
        "evidence": {},
    });
    let url = format!(
        "{}/api/abuse/ingest",
        state.config.control_plane.base_url.trim_end_matches('/')
    );
    let response = state
        .http
        .post(&url)
        .header("x-gateway-key", key)
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("abuse ingest returned {status} for usage windows");
    }
    let answer = response.json::<Value>().await.unwrap_or_default();
    Ok(answer.get("windows").and_then(Value::as_u64).unwrap_or(0))
}

/// Close finished minutes, then post queued windows until the queue is empty
/// or a request fails. The cursor advances per request, only on 2xx.
pub async fn push_windows(state: &AppState) -> anyhow::Result<WindowPushSummary> {
    push_windows_at(state, chrono::Utc::now()).await
}

pub(crate) async fn push_windows_at(
    state: &AppState,
    now: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<WindowPushSummary> {
    if !reports_windows(state.custody) {
        return Ok(WindowPushSummary::default());
    }
    let key = state
        .config
        .control_plane
        .gateway_key
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("missing gateway key"))?;
    let mut summary = WindowPushSummary {
        closed: close_windows(state, now)?,
        ..WindowPushSummary::default()
    };
    if let Err(error) = state.violations.maintain_windows(DEFAULT_MAX_WINDOW_ROWS) {
        warn!("usage window outbox maintenance failed: {error}");
    }
    loop {
        let rows = state.violations.pending_windows(MAX_WINDOWS)?;
        let batch = next_batch(&rows);
        let Some(last) = batch.last() else {
            break;
        };
        let stored = post(state, key, batch).await?;
        state.violations.acknowledge_windows(last.id)?;
        summary.requests += 1;
        summary.sent += batch.len();
        summary.stored += stored;
    }
    if summary.sent > 0 {
        debug!(
            sent = summary.sent,
            stored = summary.stored,
            "pushed usage windows to the control plane"
        );
    }
    Ok(summary)
}

#[cfg(test)]
#[path = "windows_tests.rs"]
mod tests;
