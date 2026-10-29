//! HTTP API for the hardware device registry (`/api/hardware/*`, PROTOCOL.md §6).
//!
//! This crate serves two routers; Core mounts both:
//!
//! - [`devices_routes`] (PROTECTED, behind `require_auth` and the Hardware app gate):
//!   - `GET    /api/hardware/devices`      — paired devices (presence, battery,
//!     protocol level, key badges, live capabilities, stored prefs) plus the node
//!     identity status;
//!   - `PATCH  /api/hardware/devices/:id`  — rename / replace prefs (capability
//!     prefs are type-checked, `400 bad_prefs`);
//!   - `DELETE /api/hardware/devices/:id`  — revoke (ends the live session, deletes
//!     the row, its tokens, its pinned key and its pending pairings);
//!   - `GET|PUT /api/hardware/devices/:id/dashboard`.
//! - [`display_routes`] (PUBLIC): the TRMNL display manifest and image, which a
//!   device polls with its own per-device token (relay tokens are refused).
//!
//! Pairing (`/api/hardware/pair` and `/api/hardware/pair/{begin,reveal,confirm,cancel}`)
//! and `/api/hardware/identity/reset` are also PROTECTED, but are served by Core's
//! `server::hardware_public` over [`crate::pairing`]; the WebSocket ingress is
//! Core's `server::hardware_ws` over [`crate::secure`].
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

use crate::capability;
use crate::feed::DashboardFeed;
use crate::pair_crypto;
use crate::protocol::{
    device_type_str, DeviceCapabilitySummary, DeviceListItem, DeviceType, DeviceUpdate,
};
use crate::session::live::LiveCapabilities;
use crate::store::{DeviceRecord, DeviceStore};

/// Router state for the hardware HTTP surface: the device registry ([`DeviceStore`])
/// and the [`DashboardFeed`] that the TRMNL display render and the per-device
/// dashboard binding reach through. The feed inverts the old direct `ryu_dashboards` coupling, so
/// this surface has ZERO dependency on the dashboards crate (Core supplies an
/// in-process or sidecar-backed impl).
#[derive(Clone)]
pub struct HardwareCtx {
    pub hardware: DeviceStore,
    pub dashboards: Arc<dyn DashboardFeed>,
    /// Live owner token resolver supplied by Core. Keeping this as a callback
    /// avoids a hardware→Core dependency while ensuring runtime rotation revokes
    /// the prior root bearer on these public, self-authenticating routes too.
    pub node_token: Arc<dyn Fn() -> Option<String> + Send + Sync>,
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

/// Map a stored [`DeviceRecord`] (plus its live capabilities, if connected) to the
/// REST [`DeviceListItem`] wire shape. Each capability's `enabled` is derived from
/// the device prefs (`capabilities_enabled`, `capabilities[name]`, default
/// `!sensitive`).
pub fn device_list_item(record: &DeviceRecord, live: Option<&LiveCapabilities>) -> DeviceListItem {
    let now = chrono::Utc::now().timestamp_millis();
    let online = record
        .last_seen
        .map(|ts| now - ts <= ONLINE_WINDOW_MS)
        .unwrap_or(false);
    let key_fingerprint = record
        .noise_pubkey
        .as_deref()
        .and_then(pair_crypto::b64u_decode_array::<32>)
        .map(|key| pair_crypto::fingerprint(&key));
    let capabilities = live
        .map(|live| {
            live.caps
                .iter()
                .map(|cap| DeviceCapabilitySummary {
                    name: cap.name.clone(),
                    description: cap.description.clone(),
                    sensitive: cap.sensitive,
                    confirm: cap.confirm,
                    enabled: capability::capability_enabled(
                        &record.prefs,
                        &cap.name,
                        cap.sensitive,
                    ),
                })
                .collect()
        })
        .unwrap_or_default();
    DeviceListItem {
        device_id: record.device_id.clone(),
        device_type: record.device_type,
        name: record.name.clone(),
        last_seen: record.last_seen,
        online,
        battery_pct: record.battery_pct,
        protocol_level: record.protocol_level,
        secure: record.is_secure(),
        key_verification: record.key_verification.clone(),
        key_source: record.key_source.clone(),
        key_fingerprint,
        needs_repair: record.needs_repair,
        capabilities,
        // Stored prefs are always written as an object (`PATCH` validates them),
        // but the store reads unparseable JSON as null: list that as no prefs.
        prefs: match &record.prefs {
            serde_json::Value::Object(prefs) => prefs.clone(),
            _ => serde_json::Map::new(),
        },
    }
}

/// [`device_list_item`] with the device's current live capabilities.
async fn to_list_item(record: &DeviceRecord) -> DeviceListItem {
    let live = crate::session::live::capabilities_for(&record.device_id).await;
    device_list_item(record, live.as_ref())
}

/// `GET /api/hardware/devices` — list paired devices with presence, battery, key
/// badges and live capabilities, plus the node identity status. Expired pending
/// pairings are purged lazily here.
#[utoipa::path(
    get,
    path = "/api/hardware/devices",
    tag = "Hardware",
    summary = "list paired devices with presence, key badges, capabilities and the node identity status.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_devices(State(ctx): State<HardwareCtx>) -> (StatusCode, Json<serde_json::Value>) {
    let now = chrono::Utc::now().timestamp_millis();
    if let Err(e) = ctx.hardware.purge_expired_pendings(now).await {
        tracing::warn!(target: "hardware", "purging expired pending pairings failed: {e}");
    }
    let node_identity = ctx.hardware.node_identity_status().await;
    match ctx.hardware.list().await {
        Ok(records) => {
            let live = crate::session::live::capabilities().await;
            let items: Vec<DeviceListItem> = records
                .iter()
                .map(|record| {
                    let caps = live.iter().find(|l| l.device_id == record.device_id);
                    device_list_item(record, caps)
                })
                .collect();
            (
                StatusCode::OK,
                Json(json!({ "devices": items, "node_identity": node_identity })),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "devices": [], "node_identity": node_identity, "error": e.to_string() })),
        ),
    }
}

/// `PATCH /api/hardware/devices/:id` — update a device's name / prefs.
#[utoipa::path(
    patch,
    path = "/api/hardware/devices/{id}",
    tag = "Hardware",
    summary = "update a device's name / prefs (capability prefs are type-checked).",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn update_device(
    State(ctx): State<HardwareCtx>,
    Path(id): Path<String>,
    Json(body): Json<DeviceUpdate>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Some(prefs) = &body.prefs {
        if let Err(message) = capability::validate_prefs(prefs) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": { "code": "bad_prefs", "message": message } })),
            );
        }
    }
    match ctx.hardware.update(&id, body.name, body.prefs).await {
        Ok(true) => match ctx.hardware.get(&id).await {
            Ok(Some(record)) => (
                StatusCode::OK,
                Json(json!({ "device": to_list_item(&record).await })),
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
    // Revoke any already-established socket before deleting the durable row. A
    // handshake-only token check cannot invalidate a session that is already live.
    crate::session::live::revoke(&id).await;
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
/// Only the DEVICE token verifies: a phone's WS-only relay token is refused.
/// Management callers (the desktop preview, the nudge loop's own render) present
/// the shared `RYU_TOKEN` instead and are allowed through.
async fn device_authorized(ctx: &HardwareCtx, device_id: &str, headers: &HeaderMap) -> bool {
    let Some(token) = bearer_token(headers) else {
        return false;
    };
    // A management caller (desktop) may present the node's shared token.
    if let Some(shared) = (ctx.node_token)() {
        // Constant-time over SHA-256 digests: this route is public, so neither
        // the content nor the length of the node token may leak through timing.
        if !shared.is_empty()
            && crate::store::ct_eq_str(
                &crate::store::hash_token(&token),
                &crate::store::hash_token(&shared),
            )
        {
            return true;
        }
    }
    ctx.hardware
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
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feed::{DeviceBinding, DeviceManifest, RenderedImage, SetDeviceResult};
    use crate::identity::PlaintextSealerForTests;
    use crate::store::{hash_token, PROTOCOL_LEVEL_SECURE};
    use axum::http::HeaderValue;
    use serde_json::Value;

    /// A feed that is never reached by these tests.
    struct NullFeed;

    #[async_trait::async_trait]
    impl DashboardFeed for NullFeed {
        async fn device_manifest(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &Value,
        ) -> Result<DeviceManifest, String> {
            Err("unused".into())
        }

        async fn device_image(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &Value,
            _: Option<&str>,
        ) -> Result<Option<RenderedImage>, String> {
            Err("unused".into())
        }

        async fn device_config(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &Value,
        ) -> Result<Value, String> {
            Err("unused".into())
        }

        async fn set_device_config(
            &self,
            _: &str,
            _: &str,
            _: Option<u32>,
            _: Option<Value>,
        ) -> Result<SetDeviceResult, String> {
            Err("unused".into())
        }

        async fn delete_device(&self, _: &str) {}

        async fn list_bindings(&self) -> Result<Vec<DeviceBinding>, String> {
            Ok(Vec::new())
        }

        async fn subscribe_changes(&self) -> tokio::sync::mpsc::Receiver<String> {
            tokio::sync::mpsc::channel(1).1
        }
    }

    fn ctx() -> HardwareCtx {
        let path = std::env::temp_dir()
            .join(format!("ryu-hw-api-{}", uuid::Uuid::new_v4()))
            .join("hardware.db");
        HardwareCtx {
            hardware: DeviceStore::open(path).unwrap(),
            dashboards: Arc::new(NullFeed),
            node_token: Arc::new(|| Some("node-root-token".to_string())),
        }
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        headers
    }

    fn secure_record(id: &str, token: &str, relay: &str) -> DeviceRecord {
        DeviceRecord {
            noise_pubkey: Some(pair_crypto::b64u_encode(&[9u8; 32])),
            protocol_level: PROTOCOL_LEVEL_SECURE,
            key_verification: Some("sas".into()),
            key_source: Some("ble".into()),
            relay_token_hash: Some(hash_token(relay)),
            paired_at: Some(1),
            ..DeviceRecord::new_legacy(id, DeviceType::Watch, "Watch", hash_token(token), 1)
        }
    }

    #[tokio::test]
    async fn display_auth_accepts_device_and_node_tokens_but_not_relay_tokens() {
        let ctx = ctx();
        ctx.hardware
            .insert(secure_record("rhw_auth", "rht_device", "rhr_relay"))
            .await
            .unwrap();
        assert!(device_authorized(&ctx, "rhw_auth", &bearer("rht_device")).await);
        assert!(device_authorized(&ctx, "rhw_auth", &bearer("node-root-token")).await);
        assert!(!device_authorized(&ctx, "rhw_auth", &bearer("rhr_relay")).await);
        assert!(!device_authorized(&ctx, "rhw_auth", &bearer("wrong")).await);
        assert!(!device_authorized(&ctx, "rhw_auth", &HeaderMap::new()).await);
        assert!(!device_authorized(&ctx, "rhw_other", &bearer("rht_device")).await);
    }

    #[tokio::test]
    async fn update_rejects_mistyped_capability_prefs() {
        let ctx = ctx();
        ctx.hardware
            .insert(secure_record("rhw_prefs", "t", "r"))
            .await
            .unwrap();
        for prefs in [
            json!({ "capabilities_enabled": "no" }),
            json!({ "capabilities": { "device.identify": 1 } }),
            json!({ "capabilities": [] }),
            json!({ "relay_mirror": null }),
            json!("not an object"),
        ] {
            let body = DeviceUpdate {
                name: Some("renamed".into()),
                prefs: Some(prefs),
            };
            let (status, Json(response)) =
                update_device(State(ctx.clone()), Path("rhw_prefs".into()), Json(body)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(response["error"]["code"], "bad_prefs");
        }
        // Nothing was applied.
        let record = ctx.hardware.get("rhw_prefs").await.unwrap().unwrap();
        assert_eq!(record.name, "Watch");

        let body = DeviceUpdate {
            name: None,
            prefs: Some(json!({
                "capabilities_enabled": true,
                "capabilities": { "device.identify": false },
                "relay_mirror": false,
                "wake_word": "ryu",
            })),
        };
        let (status, Json(response)) =
            update_device(State(ctx.clone()), Path("rhw_prefs".into()), Json(body)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(response["device"]["protocol_level"], 2);
        assert_eq!(response["device"]["secure"], true);
    }

    #[tokio::test]
    async fn the_list_and_the_patch_reply_carry_the_prefs_a_whole_prefs_patch_replaces() {
        let ctx = ctx();
        ctx.hardware
            .insert(secure_record("rhw_whole", "t", "r"))
            .await
            .unwrap();
        // A device nobody has changed lists an empty prefs object.
        let (_, Json(body)) = list_devices(State(ctx.clone())).await;
        assert_eq!(body["devices"][0]["prefs"], json!({}));

        let prefs = json!({
            "ambient": true,
            "capabilities": { "device.identify": false },
            "capabilities_enabled": false,
            "relay_mirror": false,
            "wake_word": "hey ryu",
        });
        let body = DeviceUpdate {
            name: None,
            prefs: Some(prefs.clone()),
        };
        let (status, Json(reply)) =
            update_device(State(ctx.clone()), Path("rhw_whole".into()), Json(body)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(reply["device"]["prefs"], prefs);

        // The next list shows exactly what was stored, including keys this node
        // does not know, so a client can change one key and send the rest back.
        let (_, Json(body)) = list_devices(State(ctx.clone())).await;
        assert_eq!(body["devices"][0]["prefs"], prefs);

        // A rename leaves the prefs alone.
        let rename = DeviceUpdate {
            name: Some("Kitchen watch".into()),
            prefs: None,
        };
        let (_, Json(reply)) =
            update_device(State(ctx.clone()), Path("rhw_whole".into()), Json(rename)).await;
        assert_eq!(reply["device"]["name"], "Kitchen watch");
        assert_eq!(reply["device"]["prefs"], prefs);
    }

    #[test]
    fn list_item_reports_empty_prefs_when_the_stored_value_is_not_an_object() {
        let mut record = secure_record("rhw_null_prefs", "t", "r");
        record.prefs = Value::Null;
        let wire = serde_json::to_value(device_list_item(&record, None)).unwrap();
        assert_eq!(wire["prefs"], json!({}));
    }

    #[tokio::test]
    async fn list_reports_badges_and_node_identity() {
        let ctx = ctx();
        ctx.hardware
            .insert(secure_record("rhw_list", "t", "r"))
            .await
            .unwrap();
        let (status, Json(body)) = list_devices(State(ctx.clone())).await;
        assert_eq!(status, StatusCode::OK);
        // No key yet (and none is created by listing).
        assert_eq!(body["node_identity"]["status"], "uninitialized");
        let device = &body["devices"][0];
        assert_eq!(device["protocol_level"], 2);
        assert_eq!(device["secure"], true);
        assert_eq!(device["key_source"], "ble");
        assert_eq!(device["key_verification"], "sas");
        assert_eq!(
            device["key_fingerprint"],
            pair_crypto::fingerprint(&[9u8; 32])
        );
        assert_eq!(device["needs_repair"], false);
        assert_eq!(device["capabilities"], json!([]));

        ctx.hardware
            .set_key_sealer(Arc::new(PlaintextSealerForTests));
        let (_, Json(body)) = list_devices(State(ctx.clone())).await;
        assert_eq!(body["node_identity"]["status"], "uninitialized");
        let identity = ctx.hardware.node_identity().await.unwrap();
        let (_, Json(body)) = list_devices(State(ctx)).await;
        assert_eq!(body["node_identity"]["status"], "ok");
        assert_eq!(body["node_identity"]["fingerprint"], identity.fingerprint());
    }

    #[test]
    fn list_item_derives_capability_enablement_from_prefs() {
        use crate::capability::{ConfirmPolicy, ValidCapability};
        use crate::session::live::LiveMeta;
        let capability = |name: &str, sensitive: bool| ValidCapability {
            name: name.into(),
            description: "d".into(),
            params: Vec::new(),
            timeout_ms: 10_000,
            sensitive,
            confirm: ConfirmPolicy::None,
        };
        let live = LiveCapabilities {
            device_id: "rhw_caps".into(),
            generation: 1,
            meta: LiveMeta {
                name: "Watch".into(),
                device_type: DeviceType::Watch,
                secure: true,
                relay: false,
            },
            cap_generation: 1,
            caps: vec![
                capability("device.status", false),
                capability("camera.capture", true),
                capability("device.identify", false),
            ],
        };
        let mut record = secure_record("rhw_caps", "t", "r");
        record.prefs = json!({ "capabilities": { "device.identify": false } });
        let item = device_list_item(&record, Some(&live));
        let enabled: Vec<bool> = item.capabilities.iter().map(|c| c.enabled).collect();
        assert_eq!(enabled, [true, false, false]);

        record.prefs = json!({ "capabilities_enabled": false });
        let item = device_list_item(&record, Some(&live));
        assert!(item.capabilities.iter().all(|c| !c.enabled));
    }
}
