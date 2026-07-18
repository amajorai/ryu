//! HTTP API for the hardware device registry (`/api/hardware/*`, PROTOCOL.md §6).
//!
//! - `POST   /api/hardware/pair`         — verify the pairing nonce, register the
//!   device, return its one-time `device_token` + `node_url`.
//! - `GET    /api/hardware/devices`      — list paired devices (presence + battery).
//! - `PATCH  /api/hardware/devices/:id`  — rename / update prefs.
//! - `DELETE /api/hardware/devices/:id`  — revoke (delete the device + its token).
//!
//! ## Auth split (flagged for the router wiring)
//!
//! `pair` is **public**: the proof-of-possession is the pairing nonce shown
//! out-of-band on the device (QR / BLE), and the companion app may hold only a
//! better-auth session, not the node's `RYU_TOKEN`. `devices` list/patch/delete
//! are **management** routes and sit behind `require_auth` with the rest of the
//! protected surface.
//!
//! Placement (Core vs Gateway): the registry decides *which device may drive this
//! node*, so it is Core.

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;

use std::sync::Arc;

use crate::feed::DashboardFeed;
use crate::protocol::{device_type_str, DeviceListItem, DeviceType, DeviceUpdate};
use crate::store::{DeviceRecord, DeviceStore};

/// Router state for the hardware HTTP surface: the device registry ([`DeviceStore`])
/// + the [`DashboardFeed`] the TRMNL display render + per-device dashboard binding
/// reach through. The feed inverts the old direct `ryu_dashboards` coupling, so
/// this surface has ZERO dependency on the dashboards crate (Core supplies an
/// in-process or sidecar-backed impl).
#[derive(Clone)]
pub struct HardwareCtx {
    pub hardware: DeviceStore,
    pub dashboards: Arc<dyn DashboardFeed>,
}

/// Build the PROTECTED device-registry CRUD router (relative paths, state baked in),
/// returning a state-less `Router<()>` the host nests at `/api/hardware/devices`
/// behind the Hardware App gate. These are management routes (desktop +
/// `dashboard_builder`); the host mounts them INSIDE `require_auth`.
pub fn devices_routes(ctx: HardwareCtx) -> Router<()> {
    Router::new()
        .route("/", get(list_devices))
        .route(
            "/:id",
            axum::routing::patch(update_device).delete(delete_device),
        )
        .route(
            "/:id/dashboard",
            get(get_device_dashboard).put(set_device_dashboard),
        )
        .with_state(ctx)
}

/// Build the PUBLIC TRMNL display router (relative paths, state baked in), returning
/// a state-less `Router<()>` the host nests at `/api/hardware/display` on the public
/// router. A device polls these with its OWN per-device Bearer token (which the
/// global-`RYU_TOKEN` `require_auth` cannot gate), so each handler authenticates the
/// device token against the registry itself — hence public, ungated.
pub fn display_routes(ctx: HardwareCtx) -> Router<()> {
    Router::new()
        .route("/:device_id", get(display_manifest))
        .route("/:device_id/image", get(display_image))
        .with_state(ctx)
}

/// The OpenAPI sub-document for the hardware device-registry + display surface,
/// merged into Core's spec. The public ws/pair ingress keeps its own annotations in
/// `apps/core` (see `server::hardware_ws` / `server::hardware_public`).
pub fn openapi() -> utoipa::openapi::OpenApi {
    <HardwareApiDoc as utoipa::OpenApi>::openapi()
}

#[derive(utoipa::OpenApi)]
#[openapi(paths(
    list_devices,
    update_device,
    delete_device,
    get_device_dashboard,
    set_device_dashboard,
    display_manifest,
    display_image,
))]
struct HardwareApiDoc;

/// A device is considered "online" if it was seen within this window (ms). The WS
/// handler `touch`es the row on connect + every telemetry frame.
const ONLINE_WINDOW_MS: i64 = 90_000;

/// Map a stored [`DeviceRecord`] to the REST [`DeviceListItem`] wire shape.
fn to_list_item(record: &DeviceRecord) -> DeviceListItem {
    let now = chrono::Utc::now().timestamp_millis();
    let online = record
        .last_seen
        .map(|ts| now - ts <= ONLINE_WINDOW_MS)
        .unwrap_or(false);
    DeviceListItem {
        device_id: record.device_id.clone(),
        device_type: record.device_type,
        name: record.name.clone(),
        last_seen: record.last_seen,
        online,
        battery_pct: record.battery_pct,
    }
}

/// `GET /api/hardware/devices` — list paired devices with presence + battery.
#[utoipa::path(
    get,
    path = "/api/hardware/devices",
    tag = "Hardware",
    summary = "list paired devices with presence + battery.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_devices(
    State(ctx): State<HardwareCtx>,
) -> (StatusCode, Json<serde_json::Value>) {
    match ctx.hardware.list().await {
        Ok(records) => {
            let items: Vec<DeviceListItem> = records.iter().map(to_list_item).collect();
            (StatusCode::OK, Json(json!({ "devices": items })))
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "devices": [], "error": e.to_string() })),
        ),
    }
}

/// `PATCH /api/hardware/devices/:id` — update a device's name / prefs.
#[utoipa::path(
    patch,
    path = "/api/hardware/devices/{id}",
    tag = "Hardware",
    summary = "update a device's name / prefs.",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn update_device(
    State(ctx): State<HardwareCtx>,
    Path(id): Path<String>,
    Json(body): Json<DeviceUpdate>,
) -> (StatusCode, Json<serde_json::Value>) {
    match ctx.hardware.update(&id, body.name, body.prefs).await {
        Ok(true) => match ctx.hardware.get(&id).await {
            Ok(Some(record)) => (
                StatusCode::OK,
                Json(json!({ "device": to_list_item(&record) })),
            ),
            _ => (StatusCode::OK, Json(json!({ "ok": true }))),
        },
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "device not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `DELETE /api/hardware/devices/:id` — revoke a device (delete it + its token).
#[utoipa::path(
    delete,
    path = "/api/hardware/devices/{id}",
    tag = "Hardware",
    summary = "revoke a device (delete it + its token).",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn delete_device(
    State(ctx): State<HardwareCtx>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    // Also drop the device's dashboard binding so a re-paired id starts clean.
    ctx.dashboards.delete_device(&id).await;
    match ctx.hardware.revoke(&id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "device not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

// ── Dashboard display surface (TRMNL model, apps/hardware/DASHBOARD.md) ───────

/// Extract a `Bearer` device token from the upgrade/request headers.
fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string)
}

/// Verify the device's own Bearer token against the registry. The display routes
/// are on the **public** router (a device presents a per-device token, which the
/// global-`RYU_TOKEN` `require_auth` would reject), so each handler authenticates
/// the device token here — the same model the WS upgrade uses (PROTOCOL.md §2).
/// Loopback self-calls (the desktop preview, the nudge loop's own render) present
/// the shared `RYU_TOKEN` instead and are allowed through.
async fn device_authorized(ctx: &HardwareCtx, device_id: &str, headers: &HeaderMap) -> bool {
    let Some(token) = bearer_token(headers) else {
        return false;
    };
    // A management caller (desktop) may present the node's shared token.
    if let Ok(shared) = std::env::var("RYU_TOKEN") {
        if !shared.is_empty() && token == shared {
            return true;
        }
    }
    ctx
        .hardware
        .verify_token(device_id, &token)
        .await
        .unwrap_or(false)
}

/// `GET /api/hardware/display/:device_id` — the display manifest. Returns the
/// content hash (`rev`), the poll interval, the screen geometry, and the image URL
/// the device should fetch. The device skips re-downloading when `rev` is unchanged.
#[utoipa::path(
    get,
    path = "/api/hardware/display/{device_id}",
    tag = "Hardware",
    summary = "the display manifest. Returns the",
    params(("device_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn display_manifest(
    State(ctx): State<HardwareCtx>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !device_authorized(&ctx, &device_id, &headers).await {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        )
            .into_response();
    }
    let record = match ctx.hardware.get(&device_id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "device not found" })),
            )
                .into_response()
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    };
    match ctx
        .dashboards
        .device_manifest(
            &device_id,
            &record.name,
            device_type_str(record.device_type),
            &record.prefs,
        )
        .await
    {
        Ok(m) => {
            let s = &m.screen;
            let rev = m.rev;
            (
                StatusCode::OK,
                Json(json!({
                    "image_url": format!("/api/hardware/display/{device_id}/image?rev={rev}"),
                    "rev": rev,
                    "refresh_rate": m.refresh_rate,
                    "screen": {
                        "w": s.w,
                        "h": s.h,
                        "bit_depth": s.bit_depth,
                        "palette": s.palette,
                        "rotation": s.rotation,
                    },
                })),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        )
            .into_response(),
    }
}

/// Query for the image endpoint: the `rev` the device already holds (so an
/// unchanged image returns `304 Not Modified` and saves the download).
#[derive(Debug, Deserialize)]
pub struct ImageQuery {
    #[serde(default)]
    pub rev: Option<String>,
}

/// `GET /api/hardware/display/:device_id/image?rev=` — the rendered image bytes
/// (packed 1-bit for e-ink, RGB565, or PNG). Returns `304` when the device's `rev`
/// matches the freshly-rendered content hash.
#[utoipa::path(
    get,
    path = "/api/hardware/display/{device_id}/image",
    tag = "Hardware",
    summary = "the rendered image bytes",
    params(("device_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn display_image(
    State(ctx): State<HardwareCtx>,
    Path(device_id): Path<String>,
    Query(q): Query<ImageQuery>,
    headers: HeaderMap,
) -> Response {
    if !device_authorized(&ctx, &device_id, &headers).await {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let record = match ctx.hardware.get(&device_id).await {
        Ok(Some(r)) => r,
        Ok(None) => return (StatusCode::NOT_FOUND, "device not found").into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    match ctx
        .dashboards
        .device_image(
            &device_id,
            &record.name,
            device_type_str(record.device_type),
            &record.prefs,
            q.rev.as_deref(),
        )
        .await
    {
        // `None` ⇒ the device's `rev` still matches the freshly-rendered content.
        Ok(None) => StatusCode::NOT_MODIFIED.into_response(),
        Ok(Some(image)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, image.content_type),
                (header::ETAG, format!("\"{}\"", image.rev)),
                (header::CACHE_CONTROL, "no-cache".to_string()),
            ],
            image.bytes,
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// `GET /api/hardware/devices/:id/dashboard` — the device's dashboard config
/// (the binding + the bound dashboard's widgets).
#[utoipa::path(
    get,
    path = "/api/hardware/devices/{id}/dashboard",
    tag = "Hardware",
    summary = "the device's dashboard config",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_device_dashboard(
    State(ctx): State<HardwareCtx>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let record = match ctx.hardware.get(&id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "device not found" })),
            )
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    };
    match ctx
        .dashboards
        .device_config(
            &id,
            &record.name,
            device_type_str(record.device_type),
            &record.prefs,
        )
        .await
    {
        Ok(config) => (StatusCode::OK, Json(config)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        ),
    }
}

/// Request body for `PUT /api/hardware/devices/:id/dashboard`. Any field may be
/// omitted; only the present ones are applied. `widgets` (when present) **replaces**
/// the bound dashboard's widget set (the device-scoped analog of the desktop grid).
#[derive(Debug, Deserialize)]
pub struct DeviceDashboardUpdate {
    #[serde(default)]
    pub refresh_rate: Option<u32>,
    #[serde(default)]
    pub widgets: Option<serde_json::Value>,
}

/// `PUT /api/hardware/devices/:id/dashboard` — set the device's poll interval and/or
/// replace its widget selection + layout. Reuses the dashboard store so the same
/// widgets the desktop builder authors render on the device. Pushes a `display`
/// nudge so a connected device re-polls immediately.
#[utoipa::path(
    put,
    path = "/api/hardware/devices/{id}/dashboard",
    tag = "Hardware",
    summary = "set the device's poll interval and/or",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn set_device_dashboard(
    State(ctx): State<HardwareCtx>,
    Path(id): Path<String>,
    Json(body): Json<DeviceDashboardUpdate>,
) -> (StatusCode, Json<serde_json::Value>) {
    let record = match ctx.hardware.get(&id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "device not found" })),
            )
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    };

    let result = match ctx
        .dashboards
        .set_device_config(&id, &record.name, body.refresh_rate, body.widgets)
        .await
    {
        Ok(r) => r,
        // A bad widget batch is a client error (the feed validates the source
        // allowlist); everything else is a store failure.
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e })),
            )
        }
    };

    // Nudge: tell a connected device its dashboard changed so it re-polls now.
    nudge_device_display(&record, "dashboard").await;

    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "dashboard_id": result.dashboard_id,
            "refresh_rate": result.refresh_rate,
        })),
    )
}

/// Send the RHP `display` re-poll signal to a connected device over its live WS.
/// Best-effort: a no-op when the device is offline (it will poll on its own cadence).
/// The surface (`eink`/`lcd`) is derived from the device class so the firmware knows
/// which panel to refresh.
pub async fn nudge_device_display(record: &DeviceRecord, widget: &str) {
    use crate::protocol::{RhpServerMsg, Surface};
    let surface = match record.device_type {
        DeviceType::Watch => Surface::Lcd,
        _ => Surface::Eink,
    };
    crate::session::live::send(
        &record.device_id,
        RhpServerMsg::Display {
            surface,
            widget: widget.to_string(),
            payload: json!({ "action": "repoll" }),
        },
    )
    .await;
}
