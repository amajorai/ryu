//! HTTP API for Home dashboards (`/api/dashboards/*`).
//!
//! CRUD over dashboards and their widgets, a debounced layout-only update (the
//! drag/resize path), a force-refresh that resolves a widget's source on demand,
//! a small catalog endpoint (the allowed widget kinds + curated source names the
//! desktop builder UI offers), and an SSE event stream of live widget values.
//!
//! Widget *layout* (x/y/w/h) is a first-class persisted field here — the AI
//! builder arranges widgets, so positions round-trip through Core rather than
//! living in client localStorage.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::ServerState;
use crate::dashboard::{
    sources, Dashboard, GridLayout, Widget, WidgetKind, WidgetSource, CORE_ENDPOINT_NAMES,
};

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ── Dashboards ───────────────────────────────────────────────────────────────

/// `GET /api/dashboards` — list all dashboards.
pub async fn list_dashboards(State(state): State<ServerState>) -> Json<Value> {
    match state.dashboards.store.list_dashboards().await {
        Ok(dashboards) => Json(json!({ "dashboards": dashboards })),
        Err(e) => Json(json!({ "dashboards": [], "error": e.to_string() })),
    }
}

/// Request body for creating/renaming a dashboard.
#[derive(Debug, Deserialize)]
pub struct DashboardBody {
    pub name: String,
}

/// `POST /api/dashboards` — create a dashboard.
pub async fn create_dashboard(
    State(state): State<ServerState>,
    Json(body): Json<DashboardBody>,
) -> (StatusCode, Json<Value>) {
    let name = body.name.trim();
    if name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "name is required" })),
        );
    }
    let now = now();
    let dashboard = Dashboard {
        id: format!("dash_{}", uuid::Uuid::new_v4().simple()),
        name: name.to_string(),
        created_at: now.clone(),
        updated_at: now,
    };
    if let Err(e) = state.dashboards.store.upsert_dashboard(&dashboard).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        );
    }
    (StatusCode::OK, Json(json!({ "dashboard": dashboard })))
}

/// `GET /api/dashboards/:id` — a dashboard with its widgets.
pub async fn get_dashboard(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<Value>) {
    let dashboard = match state.dashboards.store.get_dashboard(&id).await {
        Ok(Some(d)) => d,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    };
    let widgets = state
        .dashboards
        .store
        .list_widgets(&id)
        .await
        .unwrap_or_default();
    (
        StatusCode::OK,
        Json(json!({ "dashboard": dashboard, "widgets": widgets })),
    )
}

/// `PUT /api/dashboards/:id` — rename a dashboard.
pub async fn update_dashboard(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<DashboardBody>,
) -> (StatusCode, Json<Value>) {
    let mut dashboard = match state.dashboards.store.get_dashboard(&id).await {
        Ok(Some(d)) => d,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    };
    let name = body.name.trim();
    if name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "name is required" })),
        );
    }
    dashboard.name = name.to_string();
    dashboard.updated_at = now();
    if let Err(e) = state.dashboards.store.upsert_dashboard(&dashboard).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        );
    }
    (StatusCode::OK, Json(json!({ "dashboard": dashboard })))
}

/// `DELETE /api/dashboards/:id` — remove a dashboard and its widgets.
pub async fn delete_dashboard(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<Value>) {
    match state.dashboards.store.delete_dashboard(&id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

// ── Widgets ──────────────────────────────────────────────────────────────────

/// `GET /api/dashboards/:id/widgets` — the widgets on a dashboard.
pub async fn list_widgets(State(state): State<ServerState>, Path(id): Path<String>) -> Json<Value> {
    match state.dashboards.store.list_widgets(&id).await {
        Ok(widgets) => Json(json!({ "widgets": widgets })),
        Err(e) => Json(json!({ "widgets": [], "error": e.to_string() })),
    }
}

/// Request body for creating/updating a widget. All optional except `kind` +
/// `source` on create; on update, missing fields keep their current value.
#[derive(Debug, Deserialize)]
pub struct WidgetBody {
    pub kind: Option<WidgetKind>,
    pub title: Option<String>,
    pub config: Option<Value>,
    pub source: Option<WidgetSource>,
    pub refresh_interval: Option<String>,
    pub layout: Option<GridLayout>,
}

/// `POST /api/dashboards/:id/widgets` — add a widget.
pub async fn create_widget(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<WidgetBody>,
) -> (StatusCode, Json<Value>) {
    if state
        .dashboards
        .store
        .get_dashboard(&id)
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "dashboard not found" })),
        );
    }
    let kind = match body.kind {
        Some(k) => k,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "kind is required" })),
            )
        }
    };
    let source = body
        .source
        .unwrap_or(WidgetSource::Static { data: Value::Null });
    let widget = Widget {
        id: format!("wgt_{}", uuid::Uuid::new_v4().simple()),
        dashboard_id: id,
        kind,
        title: body.title.unwrap_or_default(),
        config: body.config.unwrap_or(Value::Null),
        source,
        refresh_interval: body.refresh_interval.filter(|s| !s.trim().is_empty()),
        layout: body.layout.unwrap_or_default(),
        last_value: None,
        last_refresh_at: None,
        last_error: None,
    };
    if let Err(e) = state.dashboards.store.upsert_widget(&widget).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        );
    }
    (StatusCode::OK, Json(json!({ "widget": widget })))
}

/// `PUT /api/dashboards/:id/widgets/:wid` — edit a widget (partial patch).
pub async fn update_widget(
    State(state): State<ServerState>,
    Path((id, wid)): Path<(String, String)>,
    Json(body): Json<WidgetBody>,
) -> (StatusCode, Json<Value>) {
    let mut widget = match state
        .dashboards
        .store
        .get_widget_for_dashboard(&id, &wid)
        .await
    {
        Ok(Some(w)) => w,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    };
    if let Some(k) = body.kind {
        widget.kind = k;
    }
    if let Some(t) = body.title {
        widget.title = t;
    }
    if let Some(c) = body.config {
        widget.config = c;
    }
    if let Some(s) = body.source {
        widget.source = s;
        // A new source invalidates the cached value.
        widget.last_value = None;
        widget.last_error = None;
        widget.last_refresh_at = None;
    }
    if let Some(i) = body.refresh_interval {
        widget.refresh_interval = Some(i).filter(|s| !s.trim().is_empty());
    }
    if let Some(l) = body.layout {
        widget.layout = l;
    }
    if let Err(e) = state.dashboards.store.upsert_widget(&widget).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        );
    }
    (StatusCode::OK, Json(json!({ "widget": widget })))
}

/// `DELETE /api/dashboards/:id/widgets/:wid` — remove a widget.
pub async fn delete_widget(
    State(state): State<ServerState>,
    Path((id, wid)): Path<(String, String)>,
) -> (StatusCode, Json<Value>) {
    match state
        .dashboards
        .store
        .delete_widget_for_dashboard(&id, &wid)
        .await
    {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `PUT /api/dashboards/:id/widgets/:wid/layout` — persist drag/resize only.
pub async fn update_widget_layout(
    State(state): State<ServerState>,
    Path((id, wid)): Path<(String, String)>,
    Json(layout): Json<GridLayout>,
) -> (StatusCode, Json<Value>) {
    match state
        .dashboards
        .store
        .update_widget_layout_for_dashboard(&id, &wid, layout)
        .await
    {
        Ok(Some(w)) => (StatusCode::OK, Json(json!({ "widget": w }))),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `POST /api/dashboards/:id/widgets/:wid/refresh` — resolve the source now.
pub async fn refresh_widget(
    State(state): State<ServerState>,
    Path((id, wid)): Path<(String, String)>,
) -> (StatusCode, Json<Value>) {
    let widget = match state
        .dashboards
        .store
        .get_widget_for_dashboard(&id, &wid)
        .await
    {
        Ok(Some(w)) => w,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    };
    let result = sources::resolve(&state.dashboards.http, &widget.source, &wid)
        .await
        .map_err(|e| e.to_string());
    let _ = state
        .dashboards
        .store
        .update_widget_value(&wid, result.clone())
        .await;
    match result {
        Ok(value) => (StatusCode::OK, Json(json!({ "value": value }))),
        Err(error) => (StatusCode::OK, Json(json!({ "error": error }))),
    }
}

/// `GET /api/dashboards/catalog` — the widget kinds + curated source names the
/// builder UI offers (the constrained catalog, surfaced for the desktop pickers).
pub async fn catalog() -> Json<Value> {
    Json(json!({
        "widget_kinds": [
            "stat", "line_chart", "bar_chart", "area_chart", "pie_chart",
            "table", "list", "text", "map", "agent_feed"
        ],
        "source_types": [
            "static", "core_endpoint", "monitor", "workflow", "composio", "http", "agent"
        ],
        "core_endpoints": CORE_ENDPOINT_NAMES,
    }))
}

/// `GET /api/dashboards/events` — SSE feed of live widget values + definition
/// changes. Mirrors `quests_api::quest_events`.
pub async fn dashboard_events(
    State(state): State<ServerState>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    let rx = state.dashboards.store.subscribe();
    // Hold a viewer guard for the life of the stream so the refresh loop knows a
    // human is watching (and runs expensive sources). Carried in the unfold state so
    // it drops exactly when the client disconnects.
    let guard = state.dashboards.store.viewer_guard();
    let stream = futures_util::stream::unfold((rx, guard), |(mut rx, guard)| async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let data = serde_json::to_string(&event).unwrap_or_default();
                    return Some((Ok(Event::default().data(data)), (rx, guard)));
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}
