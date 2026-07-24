//! Core-side typed HTTP client + host callbacks for the out-of-process
//! `ryu-monitors` sidecar.
//!
//! Website monitors (price / stock / keyword / content-diff / uptime) used to run
//! in-process: a `ryu_monitors::MonitorEngine` field on `ServerState`, an
//! `/api/monitors/*` route merge, a scheduler `JobTarget::Monitor` arm that called
//! `global_engine().run_monitor()` directly, an activity subscribe-loop over the
//! in-process alert broadcast, and an events fan-out over the same bus. Monitors is
//! now an out-of-process app (`com.ryu.monitors`): the `ryu-monitors` sidecar owns
//! `monitors.db`, the engine, and the `/api/monitors/*` surface — served through the
//! generic ext-proxy `public_mount`. Core links NO monitor code; its reverse
//! couplings reach the sidecar over loopback via this client, and the sidecar reaches
//! BACK into Core through two ext-bearer-authed host callbacks:
//!
//! - **scheduler run** — the `JobTarget::Monitor` tick posts `POST /api/monitors/:id/run`.
//! - **scheduler-job lifecycle** — the sidecar stubs its `sync_backing_job`, so Core
//!   owns `JobTarget::Monitor` jobs by reconciling them from the monitor list on a
//!   background loop ([`spawn`]): every enabled monitor gets an enabled job (on its own
//!   per-monitor interval), disabled monitors get theirs disabled, gone monitors get
//!   theirs removed.
//! - **Spider fetch** (`POST /api/host/monitors/spider`) — the sidecar's Spider fetch
//!   backend needs Core's `McpRegistry`, which it cannot host; [`host_spider_crawl`]
//!   runs `spider__crawl` (the declarative command plugin) on its behalf.
//! - **alert fan-out** (`POST /api/host/monitors/alert`) — the sidecar posts each fired
//!   alert back; [`host_monitor_alert`] fans it out through the kernel notification
//!   store AND records it on the unified activity feed (the two independent consumers
//!   the old in-process design had, collapsed into one behavior-preserving callback).
//!
//! Security mirrors the ext-proxy hop exactly: the loopback client presents the
//! per-plugin minted bearer ([`crate::sidecar::ext_proxy::ext_token`]); the host
//! callbacks authenticate the sidecar with the SAME token via
//! [`crate::sidecar::ext_proxy::authenticate_sidecar`] — nothing hardcoded.

use std::time::Duration;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use ryu_activity::{ActivityItem, ActivityLevel};
use ryu_notify::NotifyTarget;

use crate::plugins::builtins::MONITORS_PLUGIN_ID;
use crate::scheduler::store::{self as job_store, JobTarget, Schedule, ScheduledJob};
use crate::server::ServerState;
use crate::sidecar::ext_proxy::{authenticate_sidecar, ext_token, node_token};

/// Fallback loopback port if the manifest is somehow absent — matches the
/// `monitors.manifest.json` fixture `port`. Core injects this as `RYU_MONITORS_PORT`
/// at spawn.
const MONITORS_FALLBACK_PORT: u16 = 8003;

/// How often Core reconciles `JobTarget::Monitor` jobs from the sidecar's monitor list.
const RECONCILE_EVERY: Duration = Duration::from_secs(30);

/// The scheduler job id backing a monitor (kept byte-identical to the old in-process
/// `monitors_host::job_id_for`, so a decoupled node keeps ticking pre-existing jobs).
fn job_id_for(monitor_id: &str) -> String {
    format!("monitor-{monitor_id}")
}

/// Resolve the `ryu-monitors` sidecar's loopback port from the loaded manifests,
/// profile-shifted the same way the ext-proxy forwards ([`crate::profile::port`]).
pub fn sidecar_port(manifests: &[crate::plugin_manifest::PluginManifest]) -> u16 {
    let raw = manifests
        .iter()
        .find(|m| m.id == MONITORS_PLUGIN_ID)
        .and_then(|m| m.sidecars.iter().find(|s| s.name == "ryu-monitors"))
        .map(|s| s.port)
        .unwrap_or(MONITORS_FALLBACK_PORT);
    crate::profile::port(raw)
}

/// Process-global monitors client, so the state-free scheduler (`JobTarget::Monitor`)
/// can reach the sidecar without carrying `ServerState`. Set once from `main.rs`,
/// mirroring the `quests_client` pattern.
static GLOBAL_CLIENT: std::sync::OnceLock<MonitorsClient> = std::sync::OnceLock::new();

/// Publish the process-global monitors client. Idempotent (first write wins).
pub fn set_global_client(client: MonitorsClient) {
    let _ = GLOBAL_CLIENT.set(client);
}

/// The process-global monitors client, or `None` before `main.rs` has set it.
pub fn global_client() -> Option<&'static MonitorsClient> {
    GLOBAL_CLIENT.get()
}

/// Typed loopback client for the `ryu-monitors` sidecar. Cheap to clone (holds only
/// the resolved port); the bearer is minted per call so it always tracks the current
/// node token.
#[derive(Clone)]
pub struct MonitorsClient {
    port: u16,
}

impl MonitorsClient {
    /// Build a client bound to the sidecar's resolved loopback port.
    pub fn new(port: u16) -> Self {
        Self { port }
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/api/monitors", self.port)
    }

    /// The per-plugin minted bearer the sidecar was spawned with — the same value the
    /// ext-proxy stamps on its hop, so a hand-rolled local request without it is
    /// rejected fail-closed.
    fn bearer(&self) -> String {
        ext_token(node_token().as_deref(), MONITORS_PLUGIN_ID)
    }

    /// Run one check for `monitor_id` (`POST /api/monitors/:id/run`). Surfaced as
    /// `Err` on a transport error or non-2xx so the scheduler records the outcome.
    pub async fn run(&self, monitor_id: &str) -> Result<Value, String> {
        let resp = reqwest::Client::new()
            .post(format!("{}/{monitor_id}/run", self.base_url()))
            .bearer_auth(self.bearer())
            .json(&json!({}))
            .send()
            .await
            .map_err(|e| format!("monitors sidecar not reachable: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            Ok(body)
        } else {
            Err(body
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("monitors run failed: HTTP {status}")))
        }
    }

    /// Fetch the current monitor list (`GET /api/monitors`), returning the `monitors`
    /// array. `Err` = the sidecar is unreachable or returned an error — the caller MUST
    /// distinguish this from `Ok(vec![])` (an authoritative empty list), or the reconcile
    /// orphan-sweep would wipe live jobs on a transient fetch failure (the last-monitor
    /// job-leak fix — mirrors `quests_client::list_quests`).
    pub async fn list_monitors(&self) -> Result<Vec<Value>, String> {
        let resp = reqwest::Client::new()
            .get(self.base_url())
            .bearer_auth(self.bearer())
            .send()
            .await
            .map_err(|e| format!("monitors sidecar not reachable: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("monitors sidecar returned {}", resp.status()));
        }
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(body
            .get("monitors")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// Delete a monitor (`DELETE /api/monitors/:id`). Returns `Ok(true)` when a row was
    /// removed. The backing `JobTarget::Monitor` job is torn down Core-side (the
    /// sidecar's `remove_backing_job` is a stub) — see [`clear_backing_job`].
    pub async fn delete_monitor(&self, monitor_id: &str) -> Result<bool, String> {
        let resp = reqwest::Client::new()
            .delete(format!("{}/{monitor_id}", self.base_url()))
            .bearer_auth(self.bearer())
            .send()
            .await
            .map_err(|e| format!("monitors sidecar not reachable: {e}"))?;
        let ok = resp.status().is_success();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        Ok(ok && body.get("ok").and_then(Value::as_bool).unwrap_or(false))
    }
}

/// Tear down the `JobTarget::Monitor` scheduler job backing a monitor (best-effort).
/// The sidecar stubs `remove_backing_job`, so Core owns job teardown; used by the
/// data-admin `clear_all_monitors` path so a bulk clear does not leave orphan jobs
/// ticking (the reconcile loop would eventually sweep them, but explicit is cleaner).
pub fn clear_backing_job(monitor_id: &str) {
    let _ = job_store::delete_job(&job_id_for(monitor_id));
}

/// Map a monitor's interval string to a scheduler [`Schedule`]: a humantime duration
/// (`5m`, `1h`) becomes `Every`, otherwise it is treated as cron. Lifted from the old
/// in-process `monitors_host::schedule_from_interval`.
fn schedule_from_interval(interval: &str) -> Schedule {
    if humantime::parse_duration(interval).is_ok() {
        Schedule::Every {
            interval: interval.to_string(),
        }
    } else {
        Schedule::Cron {
            expr: interval.to_string(),
        }
    }
}

/// Create or update the `JobTarget::Monitor` backing job for a monitor — lifted
/// verbatim from the old in-process `monitors_host::CoreMonitorsHost::sync_backing_job`
/// so a decoupled node produces byte-identical scheduler jobs.
fn sync_backing_job(monitor_id: &str, name: &str, interval: &str, enabled: bool) {
    let now = chrono::Utc::now().to_rfc3339();
    let id = job_id_for(monitor_id);
    let existing = job_store::load_job(&id).ok();
    let job = ScheduledJob {
        id: id.clone(),
        name: format!("monitor: {name}"),
        schedule: schedule_from_interval(interval),
        target: JobTarget::Monitor {
            monitor_id: monitor_id.to_owned(),
        },
        enabled,
        require_approval: false,
        created_at: existing
            .as_ref()
            .map(|j| j.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        last_run_at: existing.as_ref().and_then(|j| j.last_run_at.clone()),
        last_outcome: existing.as_ref().and_then(|j| j.last_outcome),
        history: existing.map(|j| j.history).unwrap_or_default(),
    };
    let _ = job_store::save_job(&job);
}

/// Reconcile Core-owned `JobTarget::Monitor` scheduler jobs against the sidecar's
/// monitor list: every monitor gets a backing job on its OWN interval, enabled iff the
/// monitor is enabled (created on first sight, so this replaces the sidecar's stubbed
/// `sync_backing_job`); jobs whose monitor no longer exists are removed.
async fn reconcile_jobs(client: &MonitorsClient) {
    // Only sweep on a REACHABLE list. An unreachable sidecar (Err) must NOT be read as
    // "all monitors deleted" — skip so we never wipe live jobs on a transient failure.
    // A reachable-empty list (Ok(vec![])) DOES sweep, so deleting the last monitor tears
    // down its orphaned JobTarget::Monitor job instead of leaking it forever.
    let monitors = match client.list_monitors().await {
        Ok(list) => list,
        Err(e) => {
            tracing::debug!("monitors reconcile skipped: {e}");
            return;
        }
    };

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for monitor in &monitors {
        let Some(id) = monitor.get("id").and_then(Value::as_str) else {
            continue;
        };
        let name = monitor.get("name").and_then(Value::as_str).unwrap_or("");
        // Default the interval to a safe cadence if the row is somehow missing it.
        let interval = monitor
            .get("interval")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("5m");
        // A monitor with no `enabled` field is treated as enabled (mirrors the crate's
        // `default_true`).
        let enabled = monitor
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        seen.insert(job_id_for(id));
        sync_backing_job(id, name, interval, enabled);
    }

    // Remove backing jobs whose monitor no longer exists.
    for job in job_store::list_jobs() {
        if let JobTarget::Monitor { monitor_id } = &job.target {
            if !seen.contains(&job_id_for(monitor_id)) {
                let _ = job_store::delete_job(&job.id);
            }
        }
    }
}

/// Spawn the long-lived Core-side reverse-coupling task for monitors: the
/// `JobTarget::Monitor` reconcile loop (job lifecycle). Best-effort and self-healing
/// across a sidecar restart. Alert fan-out + activity arrive over the
/// [`host_monitor_alert`] callback, not a spawned loop — so unlike quests there is no
/// SSE-fold task here.
pub fn spawn(client: MonitorsClient) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(RECONCILE_EVERY);
        loop {
            tick.tick().await;
            reconcile_jobs(&client).await;
        }
    });
}

// ── Host callbacks (sidecar → Core) ───────────────────────────────────────────────

/// `POST /api/host/monitors/spider` — run `spider__crawl` (or any MCP tool the
/// monitor engine requests) through Core's [`McpRegistry`](crate::sidecar::mcp::McpRegistry) on
/// the sidecar's behalf. Registered on the PUBLIC router (the sidecar holds only its
/// minted ext token, not the node bearer); [`authenticate_sidecar`] does the token +
/// enabled check in-handler, and we additionally assert the caller IS the monitors app.
pub(crate) async fn host_spider_crawl(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let plugin_id = match authenticate_sidecar(&state, &headers).await {
        Ok((id, _grants)) => id,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };
    if plugin_id != MONITORS_PLUGIN_ID {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not the monitors app" })),
        )
            .into_response();
    }

    let tool = body.get("tool").and_then(Value::as_str).unwrap_or("");
    if tool.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing tool" })),
        )
            .into_response();
    }
    let args = body.get("args").cloned().unwrap_or(Value::Null);

    match state.mcp.call_tool(tool, args, None).await {
        Ok(result) => Json(json!({ "result": result })).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// The `{ alert, targets }` body the sidecar's `MonitorNotifier::deliver` posts.
#[derive(serde::Deserialize)]
pub(crate) struct AlertFanoutBody {
    /// The fired alert, serialized from the crate's `ryu_monitors::Alert`.
    alert: Value,
    /// The monitor's own per-site notification channels.
    #[serde(default)]
    targets: Vec<NotifyTarget>,
}

/// `POST /api/host/monitors/alert` — receive a fired alert from the sidecar and (1) fan
/// it out through the kernel notification store (per-monitor channels + global mobile
/// push + `notification` plugin hooks) and (2) record it on the unified activity feed.
/// This collapses the two independent consumers the old in-process design had (the
/// `CoreMonitorNotifier.deliver` call + the activity subscribe-loop) into one
/// behavior-preserving callback. Registered on the PUBLIC router, ext-bearer authed.
pub(crate) async fn host_monitor_alert(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<AlertFanoutBody>,
) -> Response {
    let plugin_id = match authenticate_sidecar(&state, &headers).await {
        Ok((id, _grants)) => id,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };
    if plugin_id != MONITORS_PLUGIN_ID {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not the monitors app" })),
        )
            .into_response();
    }

    let alert = &body.alert;
    let title = alert
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let message = alert
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let monitor_id = alert
        .get("monitor_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let kind = alert.get("kind").and_then(Value::as_str).unwrap_or("");

    // (1) Fan out through the kernel notify store, exactly as the old
    // `CoreMonitorNotifier.deliver` did.
    if let Some(store) = crate::notify::global_store() {
        let fanout = crate::notify::FanoutAlert {
            title: title.clone(),
            message: message.clone(),
            data: json!({ "monitor_id": monitor_id, "kind": kind }),
            hook_event: alert.clone(),
        };
        crate::notify::notify_all(&state.client, &store, &body.targets, &fanout).await;
    } else {
        tracing::warn!("monitors: notify store not ready; dropping alert fan-out");
    }

    // (2) Record on the unified activity feed (the dep-free successor to the old
    // `activity::ingest::from_monitor_alert`).
    if let Err(e) = state.activity.record(activity_item_from_alert(alert)).await {
        tracing::warn!("activity: failed to record monitor alert: {e:#}");
    }

    Json(json!({ "ok": true })).into_response()
}

/// Map a fired monitor alert (JSON) into an activity item — the dep-free rewrite of
/// the old `activity::ingest::from_monitor_alert`, preserving the
/// `uptime_down`→Warning level.
fn activity_item_from_alert(alert: &Value) -> ActivityItem {
    let title = alert
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let message = alert
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let monitor_id = alert
        .get("monitor_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let monitor_name = alert
        .get("monitor_name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let kind = alert.get("kind").and_then(Value::as_str).unwrap_or("");
    let created_at = alert
        .get("created_at")
        .and_then(Value::as_str)
        .unwrap_or("");

    let level = if kind == "uptime_down" {
        ActivityLevel::Warning
    } else {
        ActivityLevel::Info
    };
    ActivityItem::new("monitor_alert", "monitors", title)
        .with_body(Some(message))
        .with_level(level)
        .with_metadata(json!({
            "monitor_id": monitor_id,
            "monitor_name": monitor_name,
            "alert_kind": kind,
        }))
        .with_created_at(epoch_secs(created_at))
}

/// Parse an RFC3339 timestamp into epoch seconds, falling back to "now" so a malformed
/// source timestamp never drops an item. Mirrors `activity::ingest::epoch_secs`.
fn epoch_secs(rfc3339: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(rfc3339)
        .map(|d| d.timestamp())
        .unwrap_or_else(|_| chrono::Utc::now().timestamp())
}
