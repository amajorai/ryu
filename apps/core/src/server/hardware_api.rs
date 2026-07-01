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
    Json,
};
use serde::Deserialize;
use serde_json::json;

use super::ServerState;
use crate::dashboard::render::{self, DeviceProfile, Palette};
use crate::dashboard::{Dashboard, DeviceDashboard};
use crate::hardware::pairing::{self, PairError};
use crate::hardware::protocol::{DeviceListItem, DeviceType, DeviceUpdate, PairRequest};
use crate::hardware::store::DeviceRecord;

/// Refresh-rate floor (seconds) so a device can't be told to hammer the node.
const MIN_REFRESH_RATE: u32 = 30;
/// Default device dashboard poll interval (seconds) when none is set.
const DEFAULT_REFRESH_RATE: u32 = 300;

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

/// Resolve the WS URL a freshly-paired device should connect to. Prefers the
/// `Host` the app actually reached the node on (the address that demonstrably
/// works from the app's network), then the mesh MagicDNS name, then the bound
/// address. Nothing is hardcoded; `RYU_HARDWARE_NODE_URL` overrides everything.
async fn resolve_node_url(state: &ServerState, headers: &HeaderMap) -> String {
    // 1. Explicit operator override always wins.
    if let Ok(explicit) = std::env::var("RYU_HARDWARE_NODE_URL") {
        if !explicit.trim().is_empty() {
            return explicit;
        }
    }
    let bind = std::env::var("RYU_BIND").unwrap_or_else(|_| "127.0.0.1:7980".to_string());
    let magic_dns = state
        .mesh
        .status()
        .await
        .magic_dns_name
        .filter(|d| !d.is_empty());

    // 2. The `Host` the app reached the node on — but ONLY when it names an
    // address in the device's own trust domain. The `Host` header is attacker-
    // controllable, so a forged public host must never be reflected into the
    // node_url: that would redirect the freshly-paired device (and its
    // device_token) to attacker infrastructure. See `host_is_trusted`.
    if let Some(host) = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .filter(|h| !h.is_empty())
    {
        if host_is_trusted(&host, &bind, magic_dns.as_deref()) {
            return format!("{}://{host}/api/hardware/ws", ws_scheme(&host));
        }
        tracing::warn!(
            host = %host,
            "hardware: ignoring untrusted Host header for device node_url; using mesh/bind address"
        );
    }

    // 3. Mesh MagicDNS name (stable across networks) when the daemon is up. A
    // tailnet host is not loopback, so it uses the secure scheme.
    if let Some(dns) = magic_dns {
        return format!("wss://{dns}:7980/api/hardware/ws");
    }
    // 4. The bound address.
    format!("{}://{bind}/api/hardware/ws", ws_scheme(&bind))
}

/// Extract the IP literal from a `Host`/bind value, with or without a `:port`
/// and with or without `[..]` brackets for IPv6. Returns `None` for hostnames.
fn host_ip(host: &str) -> Option<std::net::IpAddr> {
    if let Ok(sa) = host.parse::<std::net::SocketAddr>() {
        return Some(sa.ip());
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return Some(ip);
    }
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .ok()
}

/// Whether a `Host` header may be reflected verbatim into a device's `node_url`.
///
/// The header is attacker-controllable, so it is honored ONLY when it names an
/// address in the device's own trust domain:
///   - a loopback / private / link-local / CGNAT IP literal (leaking the token
///     to such an address keeps it on the same LAN/tailnet as the device), as
///     classified by the shared SSRF guard [`super::is_blocked_ip`];
///   - `localhost`, or the address Core is actually bound to (`RYU_BIND`);
///   - the node's mesh MagicDNS name;
///   - an operator allowlist (`RYU_HARDWARE_ALLOWED_HOSTS`, comma-separated).
///
/// Any other host (an arbitrary public name/IP) is refused, so a forged `Host`
/// cannot redirect a paired device and its token off-box.
fn host_is_trusted(host: &str, bind: &str, magic_dns: Option<&str>) -> bool {
    // IP literal: trust exactly the private/loopback/link-local ranges.
    if let Some(ip) = host_ip(host) {
        return super::is_blocked_ip(ip);
    }
    // Hostname: strip an optional `:port`, then match known-good names.
    let name = host
        .rsplit_once(':')
        .map_or(host, |(h, _)| h)
        .to_ascii_lowercase();
    if name == "localhost" {
        return true;
    }
    let bind_name = bind
        .rsplit_once(':')
        .map_or(bind, |(h, _)| h)
        .to_ascii_lowercase();
    if name == bind_name {
        return true;
    }
    if magic_dns.is_some_and(|d| d.to_ascii_lowercase() == name) {
        return true;
    }
    if let Ok(allowed) = std::env::var("RYU_HARDWARE_ALLOWED_HOSTS") {
        return allowed
            .split(',')
            .map(|s| s.trim().to_ascii_lowercase())
            .any(|a| !a.is_empty() && a == name);
    }
    false
}

/// The WS scheme for a host: plain `ws` for loopback (no TLS in front), secure
/// `wss` for anything reachable off-box (PROTOCOL.md §2 uses `wss` for the
/// non-loopback endpoint). A node fronted by a non-loopback bind / tunnel is
/// expected to terminate TLS, so the device dials `wss`.
fn ws_scheme(host: &str) -> &'static str {
    let bare = host.split(':').next().unwrap_or(host);
    let loopback = bare == "localhost"
        || bare == "127.0.0.1"
        || bare == "::1"
        || bare == "[::1]"
        || bare.starts_with("127.");
    if loopback {
        "ws"
    } else {
        "wss"
    }
}

/// `POST /api/hardware/pair` — register a device from a pairing nonce. **Public**.
pub async fn pair_device(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(req): Json<PairRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let node_url = resolve_node_url(&state, &headers).await;
    match pairing::pair(&state.hardware, &req, &node_url).await {
        Ok(resp) => (StatusCode::OK, Json(json!(resp))),
        Err(e) => {
            let status = match e {
                PairError::AlreadyPaired => StatusCode::CONFLICT,
                PairError::BadNonce => StatusCode::UNAUTHORIZED,
                PairError::Storage => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (
                status,
                Json(json!({ "error": { "code": e.code(), "message": e.message() } })),
            )
        }
    }
}

/// `GET /api/hardware/devices` — list paired devices with presence + battery.
pub async fn list_devices(
    State(state): State<ServerState>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.hardware.list().await {
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
pub async fn update_device(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<DeviceUpdate>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.hardware.update(&id, body.name, body.prefs).await {
        Ok(true) => match state.hardware.get(&id).await {
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
pub async fn delete_device(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    // Also drop the device's dashboard binding so a re-paired id starts clean.
    let _ = state.dashboards.store.delete_device_dashboard(&id).await;
    match state.hardware.revoke(&id).await {
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

/// Resolve a device's [`DeviceProfile`] from its class + saved prefs. The class
/// picks a sensible default panel (desk = 800×480 1-bit e-ink; watch = 240×240
/// colour LCD; necklace has no display); `prefs.screen` may override any field so a
/// different panel revision works without a code change. Nothing is hardcoded past
/// the class default.
fn profile_for_device(record: &DeviceRecord) -> DeviceProfile {
    let mut profile = match record.device_type {
        DeviceType::Desk => DeviceProfile::desk_eink(),
        DeviceType::Watch => DeviceProfile::watch_lcd(),
        // No-display class: fall back to the e-ink default so the endpoint still
        // produces something deterministic if ever polled.
        DeviceType::Necklace => DeviceProfile::desk_eink(),
    };
    if let Some(screen) = record.prefs.get("screen").filter(|v| v.is_object()) {
        if let Some(w) = screen.get("w").and_then(serde_json::Value::as_u64) {
            profile.w = w as u32;
        }
        if let Some(h) = screen.get("h").and_then(serde_json::Value::as_u64) {
            profile.h = h as u32;
        }
        if let Some(bd) = screen.get("bit_depth").and_then(serde_json::Value::as_u64) {
            profile.bit_depth = bd as u8;
        }
        if let Some(rot) = screen.get("rotation").and_then(serde_json::Value::as_u64) {
            profile.rotation = rot as u16;
        }
        if let Some(p) = screen.get("palette").and_then(serde_json::Value::as_str) {
            profile.palette = match p {
                "rgb565" => Palette::Rgb565,
                "rgba" => Palette::Rgba,
                _ => Palette::Mono,
            };
        }
    }
    profile
}

/// Ensure the device has a bound dashboard, creating an empty one on first use so
/// every device always has a real, builder-editable surface. Returns the binding.
async fn ensure_device_dashboard(
    state: &ServerState,
    device_id: &str,
    device_name: &str,
) -> anyhow::Result<DeviceDashboard> {
    if let Some(dd) = state
        .dashboards
        .store
        .get_device_dashboard(device_id)
        .await?
    {
        // The bound dashboard could have been deleted out from under us; recreate.
        if state
            .dashboards
            .store
            .get_dashboard(&dd.dashboard_id)
            .await?
            .is_some()
        {
            return Ok(dd);
        }
    }
    let now = chrono::Utc::now().to_rfc3339();
    let dashboard = Dashboard {
        id: format!("dash_{}", uuid::Uuid::new_v4().simple()),
        name: format!("{device_name} display"),
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    state.dashboards.store.upsert_dashboard(&dashboard).await?;
    let dd = DeviceDashboard {
        device_id: device_id.to_string(),
        dashboard_id: dashboard.id,
        refresh_rate: DEFAULT_REFRESH_RATE,
        created_at: now.clone(),
        updated_at: now,
    };
    state.dashboards.store.upsert_device_dashboard(&dd).await?;
    Ok(dd)
}

/// Render a device's current dashboard to its panel encoding.
async fn render_device(
    state: &ServerState,
    record: &DeviceRecord,
) -> anyhow::Result<(render::RenderedImage, DeviceDashboard)> {
    let dd = ensure_device_dashboard(state, &record.device_id, &record.name).await?;
    let widgets = state
        .dashboards
        .store
        .list_widgets(&dd.dashboard_id)
        .await
        .unwrap_or_default();
    let profile = profile_for_device(record);
    let image = render::render(&widgets, profile)?;
    Ok((image, dd))
}

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
async fn device_authorized(state: &ServerState, device_id: &str, headers: &HeaderMap) -> bool {
    let Some(token) = bearer_token(headers) else {
        return false;
    };
    // A management caller (desktop) may present the node's shared token.
    if let Ok(shared) = std::env::var("RYU_TOKEN") {
        if !shared.is_empty() && token == shared {
            return true;
        }
    }
    state
        .hardware
        .verify_token(device_id, &token)
        .await
        .unwrap_or(false)
}

/// `GET /api/hardware/display/:device_id` — the display manifest. Returns the
/// content hash (`rev`), the poll interval, the screen geometry, and the image URL
/// the device should fetch. The device skips re-downloading when `rev` is unchanged.
pub async fn display_manifest(
    State(state): State<ServerState>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !device_authorized(&state, &device_id, &headers).await {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        )
            .into_response();
    }
    let record = match state.hardware.get(&device_id).await {
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
    match render_device(&state, &record).await {
        Ok((image, dd)) => {
            let rev = image.rev();
            let p = image.profile;
            (
                StatusCode::OK,
                Json(json!({
                    "image_url": format!("/api/hardware/display/{device_id}/image?rev={rev}"),
                    "rev": rev,
                    "refresh_rate": dd.refresh_rate,
                    "screen": {
                        "w": p.w,
                        "h": p.h,
                        "bit_depth": p.bit_depth,
                        "palette": p.palette.as_str(),
                        "rotation": p.rotation,
                    },
                })),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
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
pub async fn display_image(
    State(state): State<ServerState>,
    Path(device_id): Path<String>,
    Query(q): Query<ImageQuery>,
    headers: HeaderMap,
) -> Response {
    if !device_authorized(&state, &device_id, &headers).await {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let record = match state.hardware.get(&device_id).await {
        Ok(Some(r)) => r,
        Ok(None) => return (StatusCode::NOT_FOUND, "device not found").into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    match render_device(&state, &record).await {
        Ok((image, _dd)) => {
            let rev = image.rev();
            if q.rev.as_deref() == Some(rev.as_str()) {
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
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// `GET /api/hardware/devices/:id/dashboard` — the device's dashboard config
/// (the binding + the bound dashboard's widgets).
pub async fn get_device_dashboard(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let record = match state.hardware.get(&id).await {
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
    let dd = match ensure_device_dashboard(&state, &id, &record.name).await {
        Ok(dd) => dd,
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
        .list_widgets(&dd.dashboard_id)
        .await
        .unwrap_or_default();
    let profile = profile_for_device(&record);
    (
        StatusCode::OK,
        Json(json!({
            "device_id": dd.device_id,
            "dashboard_id": dd.dashboard_id,
            "refresh_rate": dd.refresh_rate,
            "screen": {
                "w": profile.w,
                "h": profile.h,
                "bit_depth": profile.bit_depth,
                "palette": profile.palette.as_str(),
                "rotation": profile.rotation,
            },
            "widgets": widgets,
        })),
    )
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
pub async fn set_device_dashboard(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<DeviceDashboardUpdate>,
) -> (StatusCode, Json<serde_json::Value>) {
    let record = match state.hardware.get(&id).await {
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
    let mut dd = match ensure_device_dashboard(&state, &id, &record.name).await {
        Ok(dd) => dd,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    };

    if let Some(rate) = body.refresh_rate {
        dd.refresh_rate = rate.max(MIN_REFRESH_RATE);
        dd.updated_at = chrono::Utc::now().to_rfc3339();
        if let Err(e) = state.dashboards.store.upsert_device_dashboard(&dd).await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            );
        }
    }

    if let Some(widgets) = body.widgets {
        if let Err(e) =
            crate::dashboard::replace_widgets(&state.dashboards, &dd.dashboard_id, &widgets).await
        {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e.to_string() })),
            );
        }
    }

    // Nudge: tell a connected device its dashboard changed so it re-polls now.
    nudge_device_display(&record, "dashboard").await;

    (
        StatusCode::OK,
        Json(
            json!({ "ok": true, "dashboard_id": dd.dashboard_id, "refresh_rate": dd.refresh_rate }),
        ),
    )
}

/// Send the RHP `display` re-poll signal to a connected device over its live WS.
/// Best-effort: a no-op when the device is offline (it will poll on its own cadence).
/// The surface (`eink`/`lcd`) is derived from the device class so the firmware knows
/// which panel to refresh.
pub async fn nudge_device_display(record: &DeviceRecord, widget: &str) {
    use crate::hardware::protocol::{RhpServerMsg, Surface};
    let surface = match record.device_type {
        DeviceType::Watch => Surface::Lcd,
        _ => Surface::Eink,
    };
    crate::hardware::session::live::send(
        &record.device_id,
        RhpServerMsg::Display {
            surface,
            widget: widget.to_string(),
            payload: json!({ "action": "repoll" }),
        },
    )
    .await;
}
