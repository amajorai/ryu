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
//!
//! The router is built with its own state ([`DashboardsCtx`]) inside this crate so
//! it returns a state-less, mergeable `Router<()>`. The routes are declared
//! relative to `/api/dashboards` (Core nests this service at that prefix behind
//! the Dashboards-App gate), while the OpenAPI annotations keep the full external
//! paths.

use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    sources, CanvasLayout, Dashboard, DashboardEngine, GridLayout, Widget, WidgetKind,
    WidgetSource, CORE_ENDPOINT_NAMES,
};

/// Router state for the dashboards HTTP surface: the [`DashboardEngine`] (which
/// owns the store, the shared HTTP client, and the inverted host).
#[derive(Clone)]
pub struct DashboardsCtx {
    pub engine: DashboardEngine,
}

impl DashboardsCtx {
    pub fn new(engine: DashboardEngine) -> Self {
        Self { engine }
    }
}

/// Build the `/api/dashboards/*` router with its own state baked in, returning a
/// state-less `Router<()>` the host nests at `/api/dashboards` behind the App
/// gate. Static segments (`events`, `catalog`) are registered before `:id` so
/// they match first.
pub fn routes(ctx: DashboardsCtx) -> Router<()> {
    Router::new()
        .route("/events", get(dashboard_events))
        .route("/catalog", get(catalog))
        // Internal hardware device-dashboard surface (Core's `dashboards_client`
        // reaches these over loopback; they are NOT desktop-facing / public_mount
        // routes). Registered before `/:id` so the static `device*` segments win.
        .route("/device/manifest", post(device_manifest))
        .route("/device/image", post(device_image))
        .route("/device/config", post(device_config).put(set_device_config))
        .route("/device/ensure", post(device_ensure))
        .route("/device-bindings", get(device_bindings))
        .route("/device/:device_id", axum::routing::delete(delete_device_binding))
        .route("/", get(list_dashboards).post(create_dashboard))
        .route(
            "/:id",
            get(get_dashboard).put(update_dashboard).delete(delete_dashboard),
        )
        .route("/:id/widgets", get(list_widgets).post(create_widget))
        .route(
            "/:id/widgets/:wid",
            axum::routing::put(update_widget).delete(delete_widget),
        )
        .route("/:id/widgets/:wid/layout", axum::routing::put(update_widget_layout))
        .route("/:id/widgets/:wid/refresh", post(refresh_widget))
        .with_state(ctx)
}

/// The OpenAPI sub-document for the dashboards surface, merged into Core's spec.
pub fn openapi() -> utoipa::openapi::OpenApi {
    <DashboardsApiDoc as utoipa::OpenApi>::openapi()
}

#[derive(utoipa::OpenApi)]
#[openapi(paths(
    catalog,
    create_dashboard,
    create_widget,
    dashboard_events,
    delete_dashboard,
    delete_widget,
    get_dashboard,
    list_dashboards,
    list_widgets,
    refresh_widget,
    update_dashboard,
    update_widget,
    update_widget_layout,
))]
struct DashboardsApiDoc;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Query for the SSE `/events` stream: an internal subscriber (the hardware nudge
/// loop) passes `internal=1` so it does NOT register a UI viewer.
#[derive(Debug, Default, Deserialize)]
pub struct EventsQuery {
    #[serde(default, deserialize_with = "de_bool_flag")]
    pub internal: bool,
}

/// Deserialize a permissive boolean flag (`1`/`true`/`yes` ⇒ true) from the query
/// string, so `?internal=1` works the same as `?internal=true`.
fn de_bool_flag<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    let s = String::deserialize(d)?;
    Ok(matches!(s.as_str(), "1" | "true" | "yes" | "on"))
}

// ── Dashboards ───────────────────────────────────────────────────────────────

/// `GET /api/dashboards` — list all dashboards.
#[utoipa::path(
    get,
    path = "/api/dashboards",
    tag = "Dashboards",
    summary = "list all dashboards.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_dashboards(State(ctx): State<DashboardsCtx>) -> Json<Value> {
    match ctx.engine.store.list_dashboards().await {
        Ok(dashboards) => Json(json!({ "dashboards": dashboards })),
        Err(e) => Json(json!({ "dashboards": [], "error": e.to_string() })),
    }
}

/// Request body for creating a dashboard.
#[derive(Debug, Deserialize)]
pub struct DashboardBody {
    pub name: String,
}

/// Request body for updating a dashboard: rename and/or switch the desktop render
/// mode. Both fields are optional and applied only when present, so the existing
/// rename client (`{ name }`) and the new view-toggle client (`{ view_mode }`)
/// coexist without either clobbering the other's field.
#[derive(Debug, Default, Deserialize)]
pub struct DashboardUpdateBody {
    pub name: Option<String>,
    pub view_mode: Option<String>,
}

/// `POST /api/dashboards` — create a dashboard.
#[utoipa::path(
    post,
    path = "/api/dashboards",
    tag = "Dashboards",
    summary = "create a dashboard.",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn create_dashboard(
    State(ctx): State<DashboardsCtx>,
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
        view_mode: None,
    };
    if let Err(e) = ctx.engine.store.upsert_dashboard(&dashboard).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        );
    }
    (StatusCode::OK, Json(json!({ "dashboard": dashboard })))
}

/// `GET /api/dashboards/:id` — a dashboard with its widgets.
#[utoipa::path(
    get,
    path = "/api/dashboards/{id}",
    tag = "Dashboards",
    summary = "a dashboard with its widgets.",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_dashboard(
    State(ctx): State<DashboardsCtx>,
    Path(id): Path<String>,
) -> (StatusCode, Json<Value>) {
    let dashboard = match ctx.engine.store.get_dashboard(&id).await {
        Ok(Some(d)) => d,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    };
    let widgets = ctx
        .engine
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
#[utoipa::path(
    put,
    path = "/api/dashboards/{id}",
    tag = "Dashboards",
    summary = "rename a dashboard.",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn update_dashboard(
    State(ctx): State<DashboardsCtx>,
    Path(id): Path<String>,
    Json(body): Json<DashboardUpdateBody>,
) -> (StatusCode, Json<Value>) {
    let mut dashboard = match ctx.engine.store.get_dashboard(&id).await {
        Ok(Some(d)) => d,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    };
    // Rename when a (non-empty) name is supplied; a present-but-blank name is a bad
    // request (the historical contract), while an absent name is a view-only update.
    if let Some(name) = body.name.as_deref() {
        let name = name.trim();
        if name.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "name is required" })),
            );
        }
        dashboard.name = name.to_string();
    }
    if let Some(view_mode) = body.view_mode.as_deref() {
        if !matches!(view_mode, "grid" | "canvas") {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "view_mode must be 'grid' or 'canvas'" })),
            );
        }
        dashboard.view_mode = Some(view_mode.to_string());
    }
    dashboard.updated_at = now();
    if let Err(e) = ctx.engine.store.upsert_dashboard(&dashboard).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        );
    }
    (StatusCode::OK, Json(json!({ "dashboard": dashboard })))
}

/// `DELETE /api/dashboards/:id` — remove a dashboard and its widgets.
#[utoipa::path(
    delete,
    path = "/api/dashboards/{id}",
    tag = "Dashboards",
    summary = "remove a dashboard and its widgets.",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn delete_dashboard(
    State(ctx): State<DashboardsCtx>,
    Path(id): Path<String>,
) -> (StatusCode, Json<Value>) {
    match ctx.engine.store.delete_dashboard(&id).await {
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
#[utoipa::path(
    get,
    path = "/api/dashboards/{id}/widgets",
    tag = "Dashboards",
    summary = "the widgets on a dashboard.",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_widgets(State(ctx): State<DashboardsCtx>, Path(id): Path<String>) -> Json<Value> {
    match ctx.engine.store.list_widgets(&id).await {
        Ok(widgets) => Json(json!({ "widgets": widgets })),
        Err(e) => Json(json!({ "widgets": [], "error": e.to_string() })),
    }
}

/// Request body for creating/updating a widget. All optional except `kind` +
/// `source` on create; on update, missing fields keep their current value.
#[derive(Debug, Deserialize)]
pub struct WidgetBody {
    /// Optional caller-chosen widget id. When present + non-empty on `create`, the
    /// widget is upserted under THIS id (INSERT-OR-REPLACE) rather than a fresh
    /// generated one — so the `dashboard_builder` "pass an id to replace it" path
    /// round-trips through one create endpoint. Absent ⇒ a new `wgt_…` id.
    pub id: Option<String>,
    pub kind: Option<WidgetKind>,
    pub title: Option<String>,
    pub config: Option<Value>,
    pub source: Option<WidgetSource>,
    pub refresh_interval: Option<String>,
    pub layout: Option<GridLayout>,
    /// Optional canvas (v2) position/size. Additive: old clients omit it and the
    /// widget derives its canvas placement from `layout` on demand.
    pub canvas: Option<CanvasLayout>,
}

/// Reject a widget whose `core_endpoint` source names a non-allowlisted endpoint.
/// Enforced here (the store-owning process) so both the desktop builder UI and the
/// `dashboard_builder` MCP tool get the same curated-catalog guarantee. Other
/// source kinds are structurally validated by serde.
fn validate_widget_source(source: &WidgetSource) -> Result<(), String> {
    if let WidgetSource::CoreEndpoint { endpoint, .. } = source {
        if sources::core_endpoint_path(endpoint).is_none() {
            return Err(format!(
                "'{endpoint}' is not an allowed core_endpoint. Allowed: {}",
                CORE_ENDPOINT_NAMES.join(", ")
            ));
        }
    }
    Ok(())
}

/// `POST /api/dashboards/:id/widgets` — add a widget.
#[utoipa::path(
    post,
    path = "/api/dashboards/{id}/widgets",
    tag = "Dashboards",
    summary = "add a widget.",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn create_widget(
    State(ctx): State<DashboardsCtx>,
    Path(id): Path<String>,
    Json(body): Json<WidgetBody>,
) -> (StatusCode, Json<Value>) {
    if ctx
        .engine
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
    if let Err(e) = validate_widget_source(&source) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": e })));
    }
    let widget = Widget {
        id: body
            .id
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("wgt_{}", uuid::Uuid::new_v4().simple())),
        dashboard_id: id,
        kind,
        title: body.title.unwrap_or_default(),
        config: body.config.unwrap_or(Value::Null),
        source,
        refresh_interval: body.refresh_interval.filter(|s| !s.trim().is_empty()),
        layout: body.layout.unwrap_or_default(),
        canvas: body.canvas,
        last_value: None,
        last_refresh_at: None,
        last_error: None,
    };
    if let Err(e) = ctx.engine.store.upsert_widget(&widget).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        );
    }
    (StatusCode::OK, Json(json!({ "widget": widget })))
}

/// `PUT /api/dashboards/:id/widgets/:wid` — edit a widget (partial patch).
#[utoipa::path(
    put,
    path = "/api/dashboards/{id}/widgets/{wid}",
    tag = "Dashboards",
    summary = "edit a widget (partial patch).",
    params(("id" = String, Path)),
    params(("wid" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn update_widget(
    State(ctx): State<DashboardsCtx>,
    Path((id, wid)): Path<(String, String)>,
    Json(body): Json<WidgetBody>,
) -> (StatusCode, Json<Value>) {
    let mut widget = match ctx
        .engine
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
    if let Some(c) = body.canvas {
        widget.canvas = Some(c);
    }
    if let Err(e) = ctx.engine.store.upsert_widget(&widget).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        );
    }
    (StatusCode::OK, Json(json!({ "widget": widget })))
}

/// `DELETE /api/dashboards/:id/widgets/:wid` — remove a widget.
#[utoipa::path(
    delete,
    path = "/api/dashboards/{id}/widgets/{wid}",
    tag = "Dashboards",
    summary = "remove a widget.",
    params(("id" = String, Path)),
    params(("wid" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn delete_widget(
    State(ctx): State<DashboardsCtx>,
    Path((id, wid)): Path<(String, String)>,
) -> (StatusCode, Json<Value>) {
    match ctx
        .engine
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

/// Additive body for the layout PUT. The v1 grid client sends `{ x, y, w, h }`
/// (all four ⇒ a `GridLayout`); the v2 canvas client sends `{ canvas: {x,y,w,h} }`.
/// Both may be present. Every field is optional so old and new clients coexist and
/// a canvas drag never rewrites the grid arrangement (and vice-versa).
#[derive(Debug, Default, Deserialize)]
pub struct LayoutUpdateBody {
    pub x: Option<u32>,
    pub y: Option<u32>,
    pub w: Option<u32>,
    pub h: Option<u32>,
    pub canvas: Option<CanvasLayout>,
}

/// `PUT /api/dashboards/:id/widgets/:wid/layout` — persist drag/resize only.
///
/// Accepts a grid rect (`x`/`y`/`w`/`h`, the v1 path) and/or a `canvas` rect (v2),
/// applying only the fields present so the two views stay independent.
#[utoipa::path(
    put,
    path = "/api/dashboards/{id}/widgets/{wid}/layout",
    tag = "Dashboards",
    summary = "persist drag/resize only.",
    params(("id" = String, Path)),
    params(("wid" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn update_widget_layout(
    State(ctx): State<DashboardsCtx>,
    Path((id, wid)): Path<(String, String)>,
    Json(body): Json<LayoutUpdateBody>,
) -> (StatusCode, Json<Value>) {
    // A grid update requires the full rect; a partial/absent rect leaves grid alone.
    let grid = match (body.x, body.y, body.w, body.h) {
        (Some(x), Some(y), Some(w), Some(h)) => Some(GridLayout { x, y, w, h }),
        _ => None,
    };
    match ctx
        .engine
        .store
        .update_widget_layout_fields_for_dashboard(&id, &wid, grid, body.canvas)
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
#[utoipa::path(
    post,
    path = "/api/dashboards/{id}/widgets/{wid}/refresh",
    tag = "Dashboards",
    summary = "resolve the source now.",
    params(("id" = String, Path)),
    params(("wid" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn refresh_widget(
    State(ctx): State<DashboardsCtx>,
    Path((id, wid)): Path<(String, String)>,
) -> (StatusCode, Json<Value>) {
    let widget = match ctx
        .engine
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
    let result = sources::resolve(
        &ctx.engine.http,
        ctx.engine.host.as_ref(),
        &widget.source,
        &wid,
    )
    .await
    .map_err(|e| e.to_string());
    let _ = ctx
        .engine
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
#[utoipa::path(
    get,
    path = "/api/dashboards/catalog",
    tag = "Dashboards",
    summary = "the widget kinds + curated source names the",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
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
#[utoipa::path(
    get,
    path = "/api/dashboards/events",
    tag = "Dashboards",
    summary = "SSE feed of live widget values + definition",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn dashboard_events(
    State(ctx): State<DashboardsCtx>,
    axum::extract::Query(q): axum::extract::Query<EventsQuery>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    let rx = ctx.engine.store.subscribe();
    // Hold a viewer guard for the life of the stream so the refresh loop knows a
    // human is watching (and runs expensive sources). Carried in the unfold state so
    // it drops exactly when the client disconnects. An INTERNAL subscriber (the
    // hardware nudge loop via `dashboards_client`) passes `?internal=1` and holds NO
    // guard, so it never fakes a UI viewer and defeats the refresh cost guard.
    let guard = if q.internal {
        None
    } else {
        Some(ctx.engine.store.viewer_guard())
    };
    // Seed the stream with an immediate SSE comment so the FIRST body byte lands at
    // connect, not only when the first dashboard event (or the 15s keep-alive) arrives.
    // Dashboards is frequently idle for long stretches (no source change), so without this
    // seed the stream stays byte-silent until the keep-alive — and any intermediary that
    // withholds the response head behind the first upstream body byte (the ext-proxy's
    // pre-streaming failure mode) reads that as a "no headers for ~15s" hang. A comment
    // line is ignored by `EventSource`, so this is invisible to real consumers. The `true`
    // in the unfold seed is the "emit the priming comment on first poll" flag.
    let stream = futures_util::stream::unfold((rx, guard, true), |(mut rx, guard, first)| async move {
        if first {
            return Some((Ok(Event::default().comment("ready")), (rx, guard, false)));
        }
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let data = serde_json::to_string(&event).unwrap_or_default();
                    return Some((Ok(Event::default().data(data)), (rx, guard, false)));
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ── Internal hardware device-dashboard surface ───────────────────────────────
//
// These endpoints back the `ryu_hardware::DashboardFeed` seam when dashboards runs
// out-of-process: Core's `dashboards_client` calls them over loopback (bearer-
// gated like the rest of the sidecar). They are NOT public_mount / desktop routes.
// Each delegates to `crate::device::*` — the SAME render fns Core's in-process feed
// uses — so a decoupled node renders byte-identically.

/// Device metadata a render call needs: identity + panel class + saved prefs.
#[derive(Debug, Deserialize)]
pub struct DeviceRenderReq {
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub device_type: String,
    #[serde(default)]
    pub prefs: Value,
    /// For the image endpoint: the `rev` the caller already holds (⇒ 304).
    #[serde(default)]
    pub known_rev: Option<String>,
}

/// `POST /api/dashboards/device/manifest` — the display manifest facts (renders
/// internally to compute the current `rev`).
pub async fn device_manifest(
    State(ctx): State<DashboardsCtx>,
    Json(req): Json<DeviceRenderReq>,
) -> Response {
    match crate::device::render_device(
        &ctx.engine,
        &req.device_id,
        &req.device_name,
        &req.device_type,
        &req.prefs,
    )
    .await
    {
        Ok((image, dd)) => Json(json!({
            "rev": image.rev(),
            "refresh_rate": dd.refresh_rate,
            "screen": crate::device::screen_json(&image.profile),
        }))
        .into_response(),
        Err(e) => internal_err(&e.to_string()),
    }
}

/// `POST /api/dashboards/device/image` — the rendered panel bytes, or `304` when
/// the caller's `known_rev` still matches the freshly-rendered content.
pub async fn device_image(
    State(ctx): State<DashboardsCtx>,
    Json(req): Json<DeviceRenderReq>,
) -> Response {
    match crate::device::render_device(
        &ctx.engine,
        &req.device_id,
        &req.device_name,
        &req.device_type,
        &req.prefs,
    )
    .await
    {
        Ok((image, _dd)) => {
            let rev = image.rev();
            if req.known_rev.as_deref() == Some(rev.as_str()) {
                return StatusCode::NOT_MODIFIED.into_response();
            }
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, image.content_type.to_string()),
                    (header::ETAG, format!("\"{rev}\"")),
                    (header::CACHE_CONTROL, "no-cache".to_string()),
                ],
                image.bytes,
            )
                .into_response()
        }
        Err(e) => internal_err(&e.to_string()),
    }
}

/// `POST /api/dashboards/device/config` — the device-dashboard config JSON
/// (binding + widgets + screen). POST (not GET) because it carries device metadata.
pub async fn device_config(
    State(ctx): State<DashboardsCtx>,
    Json(req): Json<DeviceRenderReq>,
) -> Response {
    match crate::device::device_config_json(
        &ctx.engine,
        &req.device_id,
        &req.device_name,
        &req.device_type,
        &req.prefs,
    )
    .await
    {
        Ok(config) => Json(config).into_response(),
        Err(e) => internal_err(&e.to_string()),
    }
}

/// Body for `PUT /api/dashboards/device/config`.
#[derive(Debug, Deserialize)]
pub struct DeviceSetReq {
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub refresh_rate: Option<u32>,
    #[serde(default)]
    pub widgets: Option<Value>,
}

/// `PUT /api/dashboards/device/config` — set the device's poll interval and/or
/// replace its widget selection.
pub async fn set_device_config(
    State(ctx): State<DashboardsCtx>,
    Json(req): Json<DeviceSetReq>,
) -> Response {
    match crate::device::set_device_config(
        &ctx.engine,
        &req.device_id,
        &req.device_name,
        req.refresh_rate,
        req.widgets,
    )
    .await
    {
        Ok((dashboard_id, refresh_rate)) => Json(json!({
            "ok": true,
            "dashboard_id": dashboard_id,
            "refresh_rate": refresh_rate,
        }))
        .into_response(),
        // A bad widget batch is a client error (the render fn validates sources).
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

/// Body for `POST /api/dashboards/device/ensure`.
#[derive(Debug, Deserialize)]
pub struct DeviceEnsureReq {
    pub device_id: String,
    #[serde(default)]
    pub device_name: Option<String>,
}

/// `POST /api/dashboards/device/ensure` — ensure a device has a bound dashboard
/// (created on first use) and return its id. Backs the builder's device-target
/// path ("add a widget to my desk").
pub async fn device_ensure(
    State(ctx): State<DashboardsCtx>,
    Json(req): Json<DeviceEnsureReq>,
) -> Response {
    let name = req.device_name.unwrap_or_else(|| req.device_id.clone());
    match crate::device::ensure_device_dashboard(&ctx.engine, &req.device_id, &name).await {
        Ok(dd) => Json(json!({ "dashboard_id": dd.dashboard_id })).into_response(),
        Err(e) => internal_err(&e.to_string()),
    }
}

/// `GET /api/dashboards/device-bindings` — every device → dashboard binding (the
/// nudge loop's work list).
pub async fn device_bindings(State(ctx): State<DashboardsCtx>) -> Response {
    match ctx.engine.store.list_device_dashboards().await {
        Ok(rows) => {
            let items: Vec<Value> = rows
                .into_iter()
                .map(|dd| json!({ "device_id": dd.device_id, "dashboard_id": dd.dashboard_id }))
                .collect();
            Json(json!({ "bindings": items })).into_response()
        }
        Err(e) => internal_err(&e.to_string()),
    }
}

/// `DELETE /api/dashboards/device/:device_id` — drop a device's dashboard binding
/// (on device revoke). Best-effort; a missing binding is still `ok`.
pub async fn delete_device_binding(
    State(ctx): State<DashboardsCtx>,
    Path(device_id): Path<String>,
) -> Response {
    let _ = ctx.engine.store.delete_device_dashboard(&device_id).await;
    Json(json!({ "ok": true })).into_response()
}

/// A `500` JSON error body used by the device endpoints.
fn internal_err(msg: &str) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": msg }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WidgetSource;

    // The core_endpoint allowlist moved here (from the Core `dashboard_builder`
    // runnable) when dashboards went out-of-process: this crate owns the store, so
    // it owns the curated-catalog guarantee. `create_widget` calls this on every
    // add — both the desktop builder UI and the `dashboard_builder` MCP tool.
    #[test]
    fn validate_widget_source_allows_curated_core_endpoint() {
        let src = WidgetSource::CoreEndpoint {
            endpoint: "connections".into(),
            selector: Some("clients".into()),
        };
        assert!(validate_widget_source(&src).is_ok());
    }

    #[test]
    fn validate_widget_source_rejects_unknown_core_endpoint() {
        let src = WidgetSource::CoreEndpoint {
            endpoint: "secrets".into(),
            selector: None,
        };
        let err = validate_widget_source(&src).expect_err("bad endpoint must fail");
        assert!(err.contains("not an allowed core_endpoint"), "got: {err}");
    }

    #[test]
    fn validate_widget_source_ignores_non_core_endpoint_kinds() {
        // Other source kinds carry no allowlist (serde already shape-validates them).
        assert!(validate_widget_source(&WidgetSource::Static { data: Value::Null }).is_ok());
        assert!(validate_widget_source(&WidgetSource::Monitor {
            monitor_id: "m1".into()
        })
        .is_ok());
    }
}
