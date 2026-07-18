//! HTTP API for website monitors (`/api/monitors/*`).
//!
//! CRUD over monitor definitions, an immediate "run now" check, snapshot/alert
//! history, an SSE alert stream, and Expo push-token registration for mobile.
//!
//! Each monitor is mirrored by a scheduled job (`monitor-<id>`) so it rides the
//! same tick loop as workflows and agents. Creating/updating a monitor (re)writes
//! that job; deleting a monitor removes it. The scheduler `JobTarget::Monitor`
//! variant + job store stay Core-side (kernel); this surface reaches them only
//! through [`crate::MonitorsHost::sync_backing_job`] / `remove_backing_job`.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

use ryu_notify::NotifyTarget;

use crate::{CheckType, FetchBackend, Monitor, MonitorEngine};

/// Router state for the monitors HTTP surface: the [`MonitorEngine`] (which owns
/// the store and the inverted [`crate::MonitorsHost`]).
#[derive(Clone)]
pub struct MonitorsCtx {
    pub engine: MonitorEngine,
}

impl MonitorsCtx {
    pub fn new(engine: MonitorEngine) -> Self {
        Self { engine }
    }
}

/// Build the `/api/monitors/*` router with its own state baked in, returning a
/// state-less `Router<()>` the host nests at `/api/monitors` behind the
/// Monitors-App gate. Static segments (`alerts`) are registered before the `:id`
/// routes so they match first.
///
/// Push-token registration is NOT here: mobile push is a kernel
/// notification-delivery concern, served by Core at `/api/notifications/push-tokens`.
pub fn routes(ctx: MonitorsCtx) -> Router<()> {
    Router::new()
        .route("/alerts/stream", get(alerts_stream))
        .route("/alerts", get(list_all_alerts))
        .route("/alerts/:id/ack", post(ack_alert))
        .route("/", get(list_monitors).post(create_monitor))
        .route(
            "/:id",
            get(get_monitor).put(update_monitor).delete(delete_monitor),
        )
        .route("/:id/run", post(run_monitor))
        .route("/:id/snapshots", get(list_snapshots))
        .route("/:id/alerts", get(list_monitor_alerts))
        .with_state(ctx)
}

/// The OpenAPI sub-document for the monitors surface, merged into Core's spec.
/// The `#[utoipa::path]` annotations keep their absolute `/api/monitors/...`
/// paths even though the router registers relative segments (the meetings/quests
/// split: openapi = absolute, routes = relative).
pub fn openapi() -> utoipa::openapi::OpenApi {
    <MonitorsApiDoc as utoipa::OpenApi>::openapi()
}

#[derive(utoipa::OpenApi)]
#[openapi(paths(
    ack_alert,
    alerts_stream,
    create_monitor,
    delete_monitor,
    get_monitor,
    list_all_alerts,
    list_monitor_alerts,
    list_monitors,
    list_snapshots,
    run_monitor,
    update_monitor,
))]
struct MonitorsApiDoc;

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
#[utoipa::path(
    get,
    path = "/api/monitors",
    tag = "Monitors",
    summary = "list all monitors.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_monitors(State(state): State<MonitorsCtx>) -> Json<serde_json::Value> {
    match state.engine.store.list_monitors().await {
        Ok(monitors) => Json(json!({ "monitors": monitors })),
        Err(e) => Json(json!({ "monitors": [], "error": e.to_string() })),
    }
}

/// `POST /api/monitors` — create a monitor (and its backing scheduled job).
#[utoipa::path(
    post,
    path = "/api/monitors",
    tag = "Monitors",
    summary = "create a monitor (and its backing scheduled job).",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn create_monitor(
    State(state): State<MonitorsCtx>,
    Json(body): Json<MonitorBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(msg) = validate_body(&body, state.engine.host().as_ref()) {
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
    if let Err(e) = state.engine.store.upsert_monitor(&monitor).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        );
    }
    if let Err(e) = state.engine.host().sync_backing_job(
        &monitor.id,
        &monitor.name,
        &monitor.interval,
        monitor.enabled,
    ) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        );
    }
    (StatusCode::OK, Json(json!({ "monitor": monitor })))
}

/// `GET /api/monitors/:id` — one monitor.
#[utoipa::path(
    get,
    path = "/api/monitors/{id}",
    tag = "Monitors",
    summary = "one monitor.",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_monitor(
    State(state): State<MonitorsCtx>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.engine.store.get_monitor(&id).await {
        Ok(Some(m)) => (StatusCode::OK, Json(json!({ "monitor": m }))),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `PUT /api/monitors/:id` — replace a monitor's definition.
#[utoipa::path(
    put,
    path = "/api/monitors/{id}",
    tag = "Monitors",
    summary = "replace a monitor's definition.",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn update_monitor(
    State(state): State<MonitorsCtx>,
    Path(id): Path<String>,
    Json(body): Json<MonitorBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(msg) = validate_body(&body, state.engine.host().as_ref()) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg })));
    }
    let existing = match state.engine.store.get_monitor(&id).await {
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
    if let Err(e) = state.engine.store.upsert_monitor(&monitor).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        );
    }
    if let Err(e) = state.engine.host().sync_backing_job(
        &monitor.id,
        &monitor.name,
        &monitor.interval,
        monitor.enabled,
    ) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        );
    }
    (StatusCode::OK, Json(json!({ "monitor": monitor })))
}

/// `DELETE /api/monitors/:id` — remove a monitor, its history, and its job.
#[utoipa::path(
    delete,
    path = "/api/monitors/{id}",
    tag = "Monitors",
    summary = "remove a monitor, its history, and its job.",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn delete_monitor(
    State(state): State<MonitorsCtx>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    state.engine.host().remove_backing_job(&id);
    match state.engine.store.delete_monitor(&id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `POST /api/monitors/:id/run` — run one check immediately and return the status.
#[utoipa::path(
    post,
    path = "/api/monitors/{id}/run",
    tag = "Monitors",
    summary = "run one check immediately and return the status.",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn run_monitor(
    State(state): State<MonitorsCtx>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.engine.run_monitor(&id).await {
        Ok(status) => (StatusCode::OK, Json(json!({ "status": status }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))),
    }
}

/// `GET /api/monitors/:id/snapshots?limit=N` — recent check history.
#[utoipa::path(
    get,
    path = "/api/monitors/{id}/snapshots",
    tag = "Monitors",
    summary = "recent check history.",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_snapshots(
    State(state): State<MonitorsCtx>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let limit = params
        .get("limit")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(50)
        .min(500);
    match state.engine.store.list_snapshots(&id, limit).await {
        Ok(snapshots) => Json(json!({ "snapshots": snapshots })),
        Err(e) => Json(json!({ "snapshots": [], "error": e.to_string() })),
    }
}

/// `GET /api/monitors/alerts?limit=N` and `GET /api/monitors/:id/alerts` — alerts.
#[utoipa::path(
    get,
    path = "/api/monitors/alerts",
    tag = "Monitors",
    summary = "alerts.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_all_alerts(
    State(state): State<MonitorsCtx>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let limit = alerts_limit(&params);
    match state.engine.store.list_alerts(None, limit).await {
        Ok(alerts) => Json(json!({ "alerts": alerts })),
        Err(e) => Json(json!({ "alerts": [], "error": e.to_string() })),
    }
}

#[utoipa::path(
    get,
    path = "/api/monitors/{id}/alerts",
    tag = "Monitors",
    summary = "List alerts for one monitor",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_monitor_alerts(
    State(state): State<MonitorsCtx>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let limit = alerts_limit(&params);
    match state.engine.store.list_alerts(Some(&id), limit).await {
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
#[utoipa::path(
    post,
    path = "/api/monitors/alerts/{id}/ack",
    tag = "Monitors",
    summary = "acknowledge an alert.",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn ack_alert(
    State(state): State<MonitorsCtx>,
    Path(id): Path<i64>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.engine.store.ack_alert(id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `GET /api/monitors/alerts/stream` — SSE feed of new alerts as they fire.
#[utoipa::path(
    get,
    path = "/api/monitors/alerts/stream",
    tag = "Monitors",
    summary = "SSE feed of new alerts as they fire.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn alerts_stream(
    State(state): State<MonitorsCtx>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    let rx = state.engine.store.subscribe();
    // Seed the stream with an immediate SSE comment so the FIRST body byte lands at
    // connect, not only when the first alert (or the 15s keep-alive) arrives.
    // Monitors is frequently idle for long stretches (no threshold crossed), so without
    // this seed the stream stays byte-silent until the keep-alive — and any intermediary
    // that withholds the response head behind the first upstream body byte (the ext-proxy's
    // pre-streaming failure mode) reads that as a "no headers for ~15s" hang. A comment
    // line is ignored by `EventSource`, so this is invisible to real consumers. The `true`
    // in the unfold seed is the "emit the priming comment on first poll" flag.
    let stream = futures_util::stream::unfold((rx, true), |(mut rx, first)| async move {
        if first {
            return Some((Ok(Event::default().comment("ready")), (rx, false)));
        }
        loop {
            match rx.recv().await {
                Ok(alert) => {
                    let data = serde_json::to_string(&alert).unwrap_or_default();
                    return Some((Ok(Event::default().data(data)), (rx, false)));
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Validate a monitor body: a parseable http/https URL and a schedulable interval.
/// The interval validity (humantime duration OR cron) is decided Core-side via
/// [`crate::MonitorsHost::interval_is_valid`] — the scheduler stays kernel.
fn validate_body(body: &MonitorBody, host: &dyn crate::MonitorsHost) -> Result<(), String> {
    let parsed = url::Url::parse(&body.url).map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("url must be http or https".to_string());
    }
    if body.name.trim().is_empty() {
        return Err("name is required".to_string());
    }
    // The interval must be a valid duration or a valid cron expression.
    if !host.interval_is_valid(&body.interval) {
        return Err(format!(
            "interval '{}' is neither a duration (e.g. 5m) nor a cron expression",
            body.interval
        ));
    }
    Ok(())
}
