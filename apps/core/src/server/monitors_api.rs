//! HTTP API for website monitors (`/api/monitors/*`).
//!
//! CRUD over monitor definitions, an immediate "run now" check, snapshot/alert
//! history, an SSE alert stream, and Expo push-token registration for mobile.
//!
//! Each monitor is mirrored by a scheduled job (`monitor-<id>`, target
//! [`crate::scheduler::store::JobTarget::Monitor`]) so it rides the same tick
//! loop as workflows and agents. Creating/updating a monitor (re)writes that job;
//! deleting a monitor removes it.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

use super::ServerState;
use crate::monitors::notify::NotifyTarget;
use crate::monitors::{CheckType, FetchBackend, Monitor};
use crate::scheduler::store::{self as job_store, JobTarget, Schedule, ScheduledJob};

fn job_id_for(monitor_id: &str) -> String {
    format!("monitor-{monitor_id}")
}

/// Map a monitor's interval string to a scheduler [`Schedule`]: a humantime
/// duration (`5m`, `1h`) becomes `Every`, otherwise it is treated as cron.
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

/// Create or replace the scheduled job backing a monitor.
fn sync_backing_job(monitor: &Monitor) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let id = job_id_for(&monitor.id);
    let existing = job_store::load_job(&id).ok();
    let job = ScheduledJob {
        id: id.clone(),
        name: format!("monitor: {}", monitor.name),
        schedule: schedule_from_interval(&monitor.interval),
        target: JobTarget::Monitor {
            monitor_id: monitor.id.clone(),
        },
        enabled: monitor.enabled,
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
    job_store::save_job(&job).map_err(|e| format!("failed to persist backing job: {e}"))
}

/// Request body for creating/updating a monitor.
#[derive(Debug, Deserialize)]
pub struct MonitorBody {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub backend: FetchBackend,
    pub check: CheckType,
    pub interval: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub notify: Vec<NotifyTarget>,
}

fn default_true() -> bool {
    true
}

/// `GET /api/monitors` — list all monitors.
pub async fn list_monitors(State(state): State<ServerState>) -> Json<serde_json::Value> {
    match state.monitors.store.list_monitors().await {
        Ok(monitors) => Json(json!({ "monitors": monitors })),
        Err(e) => Json(json!({ "monitors": [], "error": e.to_string() })),
    }
}

/// `POST /api/monitors` — create a monitor (and its backing scheduled job).
pub async fn create_monitor(
    State(state): State<ServerState>,
    Json(body): Json<MonitorBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(msg) = validate_body(&body) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg })));
    }
    let now = chrono::Utc::now().to_rfc3339();
    let monitor = Monitor {
        id: format!("mon_{}", uuid::Uuid::new_v4().simple()),
        name: body.name,
        url: body.url,
        backend: body.backend,
        check: body.check,
        interval: body.interval,
        enabled: body.enabled,
        notify: body.notify,
        created_at: now.clone(),
        updated_at: now,
        last_check_at: None,
        last_status: None,
        last_value: None,
    };
    if let Err(e) = state.monitors.store.upsert_monitor(&monitor).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        );
    }
    if let Err(e) = sync_backing_job(&monitor) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        );
    }
    (StatusCode::OK, Json(json!({ "monitor": monitor })))
}

/// `GET /api/monitors/:id` — one monitor.
pub async fn get_monitor(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.monitors.store.get_monitor(&id).await {
        Ok(Some(m)) => (StatusCode::OK, Json(json!({ "monitor": m }))),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `PUT /api/monitors/:id` — replace a monitor's definition.
pub async fn update_monitor(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<MonitorBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(msg) = validate_body(&body) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg })));
    }
    let existing = match state.monitors.store.get_monitor(&id).await {
        Ok(Some(m)) => m,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    };
    let monitor = Monitor {
        id: existing.id,
        name: body.name,
        url: body.url,
        backend: body.backend,
        check: body.check,
        interval: body.interval,
        enabled: body.enabled,
        notify: body.notify,
        created_at: existing.created_at,
        updated_at: chrono::Utc::now().to_rfc3339(),
        last_check_at: existing.last_check_at,
        last_status: existing.last_status,
        last_value: existing.last_value,
    };
    if let Err(e) = state.monitors.store.upsert_monitor(&monitor).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        );
    }
    if let Err(e) = sync_backing_job(&monitor) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        );
    }
    (StatusCode::OK, Json(json!({ "monitor": monitor })))
}

/// `DELETE /api/monitors/:id` — remove a monitor, its history, and its job.
pub async fn delete_monitor(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let _ = job_store::delete_job(&job_id_for(&id));
    match state.monitors.store.delete_monitor(&id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `POST /api/monitors/:id/run` — run one check immediately and return the status.
pub async fn run_monitor(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.monitors.run_monitor(&id).await {
        Ok(status) => (StatusCode::OK, Json(json!({ "status": status }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))),
    }
}

/// `GET /api/monitors/:id/snapshots?limit=N` — recent check history.
pub async fn list_snapshots(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let limit = params
        .get("limit")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(50)
        .min(500);
    match state.monitors.store.list_snapshots(&id, limit).await {
        Ok(snapshots) => Json(json!({ "snapshots": snapshots })),
        Err(e) => Json(json!({ "snapshots": [], "error": e.to_string() })),
    }
}

/// `GET /api/monitors/alerts?limit=N` and `GET /api/monitors/:id/alerts` — alerts.
pub async fn list_all_alerts(
    State(state): State<ServerState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let limit = alerts_limit(&params);
    match state.monitors.store.list_alerts(None, limit).await {
        Ok(alerts) => Json(json!({ "alerts": alerts })),
        Err(e) => Json(json!({ "alerts": [], "error": e.to_string() })),
    }
}

pub async fn list_monitor_alerts(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let limit = alerts_limit(&params);
    match state.monitors.store.list_alerts(Some(&id), limit).await {
        Ok(alerts) => Json(json!({ "alerts": alerts })),
        Err(e) => Json(json!({ "alerts": [], "error": e.to_string() })),
    }
}

fn alerts_limit(params: &HashMap<String, String>) -> u32 {
    params
        .get("limit")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(100)
        .min(1000)
}

/// `POST /api/monitors/alerts/:id/ack` — acknowledge an alert.
pub async fn ack_alert(
    State(state): State<ServerState>,
    Path(id): Path<i64>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.monitors.store.ack_alert(id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `GET /api/monitors/alerts/stream` — SSE feed of new alerts as they fire.
pub async fn alerts_stream(
    State(state): State<ServerState>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    let rx = state.monitors.store.subscribe();
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(alert) => {
                    let data = serde_json::to_string(&alert).unwrap_or_default();
                    return Some((Ok(Event::default().data(data)), rx));
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Request body for `POST /api/monitors/push-tokens`.
#[derive(Debug, Deserialize)]
pub struct PushTokenBody {
    pub token: String,
    #[serde(default)]
    pub platform: Option<String>,
    /// The member registering this device, so notifications can be pushed to a
    /// specific person's phones. Omitted by anonymous / single-user nodes.
    #[serde(default)]
    pub user_id: Option<String>,
}

/// `POST /api/monitors/push-tokens` — register a mobile Expo push token.
pub async fn register_push_token(
    State(state): State<ServerState>,
    Json(body): Json<PushTokenBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state
        .monitors
        .store
        .register_push_token(
            &body.token,
            body.platform.as_deref(),
            body.user_id.as_deref(),
        )
        .await
    {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `DELETE /api/monitors/push-tokens/:token` — unregister a push token.
pub async fn remove_push_token(
    State(state): State<ServerState>,
    Path(token): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.monitors.store.remove_push_token(&token).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Validate a monitor body: a parseable http/https URL and a schedulable interval.
fn validate_body(body: &MonitorBody) -> Result<(), String> {
    let parsed = url::Url::parse(&body.url).map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("url must be http or https".to_string());
    }
    if body.name.trim().is_empty() {
        return Err("name is required".to_string());
    }
    // The interval must be a valid duration or a valid cron expression.
    if humantime::parse_duration(&body.interval).is_err()
        && crate::scheduler::cron::CronSchedule::parse(&body.interval).is_err()
    {
        return Err(format!(
            "interval '{}' is neither a duration (e.g. 5m) nor a cron expression",
            body.interval
        ));
    }
    Ok(())
}
