//! Home dashboards as Core consumes them: through the `dashboards.*` capabilities,
//! never through a named app.
//!
//! Dashboards are stored, refreshed and rendered by whichever enabled app `provides`
//! these capabilities (today the Dashboards satellite, whose sidecar owns its store).
//! Core keeps only the two parts welded to its own runtime and reaches the provider
//! through the generic Core-as-consumer helper
//! ([`crate::sidecar::capability_consumer::CapabilityConsumer`]):
//!
//! - **the hardware display + nudge loop**: [`CapabilityDashboardFeed`] implements the
//!   kernel [`ryu_hardware::DashboardFeed`] seam (render a device's dashboard, read or
//!   write its binding, and stream change events to the nudge loop);
//! - **the `dashboard_builder` MCP runnable**: [`DashboardAuthoring`] is the
//!   authoring seam it writes through, implemented for the consumer.
//!
//! No app id, sidecar name, port or route appears here.
//!
//! Wire contract (JSON bodies, provider replies):
//!
//! | Capability | Request | Reply |
//! |---|---|---|
//! | `dashboards.get` | `{ id }` | `{ dashboard, widgets }` or 404 |
//! | `dashboards.create` | `{ name }` | `{ dashboard: { id, … } }` |
//! | `dashboards.rename` | `{ id, name }` | `{ dashboard }`; 4xx on a bad name |
//! | `dashboards.upsertWidget` | `{ dashboard_id, widget }` | `{ widget }`; 4xx is a readable rejection |
//! | `dashboards.deleteWidget` | `{ dashboard_id, widget_id }` | 2xx removed, 404 absent |
//! | `dashboards.ensureDeviceDashboard` | `{ device_id, device_name? }` | `{ dashboard_id }` |
//! | `dashboards.deviceManifest` | device render request | `{ rev, refresh_rate, screen }` |
//! | `dashboards.deviceImage` | device render request + `known_rev` | panel bytes (`Content-Type`, `ETag`), or 304 |
//! | `dashboards.deviceConfig` | device render request | config JSON |
//! | `dashboards.setDevice` | `{ device_id, device_name, refresh_rate?, widgets? }` | `{ dashboard_id, refresh_rate }` |
//! | `dashboards.unbindDevice` | `{ device_id }` | `{ ok }` |
//! | `dashboards.deviceBindings` | `{}` | `{ bindings: [{ device_id, dashboard_id }] }` |
//! | `dashboards.changes` | `{}` | SSE; every frame's JSON carries the changed `dashboard_id` |
//!
//! Fail-open posture: hardware keeps working when no app provides dashboards. Render
//! calls return the refusal as their error string (the display endpoint answers with
//! that error; pairing and the device link are unaffected),
//! [`DashboardFeed::delete_device`] is best-effort, and the change subscription keeps
//! retrying in the background without ever closing the nudge loop's channel. Every
//! call re-resolves the binding, so enabling a provider later needs no restart.

use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Value};

use ryu_hardware::feed::{
    DashboardFeed, DeviceBinding, DeviceManifest, RenderedImage, ScreenProfile, SetDeviceResult,
};

use crate::sidecar::capability_consumer::{CapabilityCallError, CapabilityConsumer};

pub const CAP_GET: &str = "dashboards.get";
pub const CAP_CREATE: &str = "dashboards.create";
pub const CAP_RENAME: &str = "dashboards.rename";
pub const CAP_UPSERT_WIDGET: &str = "dashboards.upsertWidget";
pub const CAP_DELETE_WIDGET: &str = "dashboards.deleteWidget";
pub const CAP_ENSURE_DEVICE_DASHBOARD: &str = "dashboards.ensureDeviceDashboard";
pub const CAP_DEVICE_MANIFEST: &str = "dashboards.deviceManifest";
pub const CAP_DEVICE_IMAGE: &str = "dashboards.deviceImage";
pub const CAP_DEVICE_CONFIG: &str = "dashboards.deviceConfig";
pub const CAP_SET_DEVICE: &str = "dashboards.setDevice";
pub const CAP_UNBIND_DEVICE: &str = "dashboards.unbindDevice";
pub const CAP_DEVICE_BINDINGS: &str = "dashboards.deviceBindings";
pub const CAP_CHANGES: &str = "dashboards.changes";

/// Backoff between change-stream subscriptions: after the provider closes the
/// stream (a restart) and while no app provides the capability at all.
const RECONNECT_EVERY: Duration = Duration::from_secs(5);

/// Turn a refused capability call into a legible message. A missing provider is the
/// common case (the app is disabled or not installed), so it says so instead of
/// surfacing a binding code.
fn refusal(err: CapabilityCallError) -> String {
    match err {
        CapabilityCallError::Unbound { capability, .. } => format!(
            "no enabled app provides the '{capability}' capability; install or enable an app \
             that provides dashboards"
        ),
        other => other.to_string(),
    }
}

/// The `{ "error": … }` a provider replied with, else the bare status.
fn reply_error(capability: &str, status: u16, body: &Value) -> String {
    match body["error"].as_str() {
        Some(message) => message.to_owned(),
        None => format!("'{capability}' returned HTTP {status}"),
    }
}

/// Invoke a JSON capability and require a 2xx; the error is a legible string.
async fn call_ok(
    capabilities: &CapabilityConsumer,
    cap: &str,
    body: &Value,
) -> Result<Value, String> {
    let reply = capabilities
        .call_capability(cap, body)
        .await
        .map_err(refusal)?;
    if reply.is_success() {
        Ok(reply.body)
    } else {
        Err(reply_error(cap, reply.status, &reply.body))
    }
}

/// Strip HTTP-widget request headers (credentials) from a dashboard projection before
/// it reaches a model, leaving only a `headers_configured` marker.
fn redact_dashboard_widget_headers(value: &mut Value) {
    let Some(widgets) = value.get_mut("widgets").and_then(Value::as_array_mut) else {
        return;
    };
    for widget in widgets {
        if let Some(source) = widget.get_mut("source").and_then(Value::as_object_mut) {
            if source.remove("headers").is_some() {
                source.insert("headers_configured".to_owned(), Value::Bool(true));
            }
        }
    }
}

// ── Authoring (the `dashboard_builder` runnable) ─────────────────────────────

/// The dashboard-authoring seam `runnable::dashboard_builder` writes through.
///
/// Prod uses [`CapabilityConsumer`]. Tests supply an in-memory double so the
/// builder's mapping (soft errors, device targeting) stays unit-testable without a
/// live provider.
#[async_trait]
pub trait DashboardAuthoring: Send + Sync {
    /// A dashboard + its widgets (`{ dashboard, widgets }`, widget credentials
    /// redacted), or `None` for an unknown id.
    async fn get_dashboard(&self, id: &str) -> Result<Option<Value>>;
    /// Create a dashboard and return its id.
    async fn create_dashboard(&self, name: &str) -> Result<String>;
    /// Rename a dashboard.
    async fn rename_dashboard(&self, id: &str, name: &str) -> Result<()>;
    /// Upsert one model-authored widget. `Ok(Err(msg))` is a rejection the model can
    /// read and retry (bad widget, disallowed source); `Err` is a hard failure.
    async fn upsert_widget(
        &self,
        dashboard_id: &str,
        widget: &Value,
    ) -> Result<std::result::Result<(), String>>;
    /// Delete a widget; `Ok(true)` when one was removed.
    async fn delete_widget(&self, dashboard_id: &str, widget_id: &str) -> Result<bool>;
    /// Ensure a hardware device has a bound dashboard (created on first use) and
    /// return its id.
    async fn ensure_device_dashboard(&self, device_id: &str) -> Result<String>;
}

#[async_trait]
impl DashboardAuthoring for CapabilityConsumer {
    async fn get_dashboard(&self, id: &str) -> Result<Option<Value>> {
        let reply = self
            .call_capability(CAP_GET, &json!({ "id": id }))
            .await
            .map_err(|e| anyhow!(refusal(e)))?;
        if reply.status == 404 {
            return Ok(None);
        }
        if !reply.is_success() {
            bail!(reply_error(CAP_GET, reply.status, &reply.body));
        }
        let mut body = reply.body;
        redact_dashboard_widget_headers(&mut body);
        Ok(Some(body))
    }

    async fn create_dashboard(&self, name: &str) -> Result<String> {
        let body = call_ok(self, CAP_CREATE, &json!({ "name": name }))
            .await
            .map_err(|e| anyhow!(e))?;
        body["dashboard"]["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("'{CAP_CREATE}' returned no dashboard id"))
    }

    async fn rename_dashboard(&self, id: &str, name: &str) -> Result<()> {
        call_ok(self, CAP_RENAME, &json!({ "id": id, "name": name }))
            .await
            .map(drop)
            .map_err(|e| anyhow!(e))
    }

    async fn upsert_widget(
        &self,
        dashboard_id: &str,
        widget: &Value,
    ) -> Result<std::result::Result<(), String>> {
        let reply = self
            .call_capability(
                CAP_UPSERT_WIDGET,
                &json!({ "dashboard_id": dashboard_id, "widget": widget }),
            )
            .await
            .map_err(|e| anyhow!(refusal(e)))?;
        if reply.is_success() {
            return Ok(Ok(()));
        }
        // 4xx ⇒ a rejection the model can read and retry within the turn.
        if (400..500).contains(&reply.status) {
            return Ok(Err(reply_error(
                CAP_UPSERT_WIDGET,
                reply.status,
                &reply.body,
            )));
        }
        bail!(reply_error(CAP_UPSERT_WIDGET, reply.status, &reply.body))
    }

    async fn delete_widget(&self, dashboard_id: &str, widget_id: &str) -> Result<bool> {
        let reply = self
            .call_capability(
                CAP_DELETE_WIDGET,
                &json!({ "dashboard_id": dashboard_id, "widget_id": widget_id }),
            )
            .await
            .map_err(|e| anyhow!(refusal(e)))?;
        Ok(reply.is_success())
    }

    async fn ensure_device_dashboard(&self, device_id: &str) -> Result<String> {
        let body = call_ok(
            self,
            CAP_ENSURE_DEVICE_DASHBOARD,
            &json!({ "device_id": device_id }),
        )
        .await
        .map_err(|e| anyhow!(e))?;
        body["dashboard_id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("'{CAP_ENSURE_DEVICE_DASHBOARD}' returned no dashboard id"))
    }
}

// ── Hardware feed ────────────────────────────────────────────────────────────

/// The kernel [`DashboardFeed`] over the `dashboards.*` capabilities. Cheap to
/// clone; build one wherever a feed is needed.
#[derive(Clone)]
pub struct CapabilityDashboardFeed {
    capabilities: CapabilityConsumer,
    reconnect_every: Duration,
}

impl CapabilityDashboardFeed {
    #[must_use]
    pub fn new(capabilities: CapabilityConsumer) -> Self {
        Self {
            capabilities,
            reconnect_every: RECONNECT_EVERY,
        }
    }

    #[cfg(test)]
    fn with_reconnect_every(mut self, every: Duration) -> Self {
        self.reconnect_every = every;
        self
    }

    /// One subscription to `dashboards.changes`, forwarding each changed
    /// `dashboard_id` until the provider closes the stream or the receiver drops.
    async fn forward_changes(&self, tx: &tokio::sync::mpsc::Sender<String>) -> Result<(), String> {
        let mut stream = self
            .capabilities
            .subscribe_capability(CAP_CHANGES, &json!({}))
            .await
            .map_err(refusal)?;
        while let Some(item) = stream.next().await {
            let event = item.map_err(refusal)?;
            // Every change frame carries the changed dashboard id; frames that do
            // not (or are not JSON) are not nudges.
            let Ok(payload) = serde_json::from_str::<Value>(&event.data) else {
                continue;
            };
            if let Some(dashboard_id) = payload["dashboard_id"].as_str() {
                if tx.send(dashboard_id.to_owned()).await.is_err() {
                    return Ok(()); // the nudge loop dropped its receiver
                }
            }
        }
        Ok(())
    }
}

/// Body shared by the device render capabilities.
fn device_request(device_id: &str, device_name: &str, device_type: &str, prefs: &Value) -> Value {
    json!({
        "device_id": device_id,
        "device_name": device_name,
        "device_type": device_type,
        "prefs": prefs,
    })
}

/// Parse a `screen` JSON object into the seam's plain [`ScreenProfile`].
fn screen_from_json(v: &Value) -> ScreenProfile {
    let number = |key: &str| v[key].as_u64().unwrap_or(0);
    ScreenProfile {
        w: u32::try_from(number("w")).unwrap_or(0),
        h: u32::try_from(number("h")).unwrap_or(0),
        bit_depth: u8::try_from(number("bit_depth")).unwrap_or(0),
        palette: v["palette"].as_str().unwrap_or("mono").to_owned(),
        rotation: u16::try_from(number("rotation")).unwrap_or(0),
    }
}

fn refresh_rate_of(body: &Value) -> u32 {
    u32::try_from(body["refresh_rate"].as_u64().unwrap_or(0)).unwrap_or(0)
}

#[async_trait]
impl DashboardFeed for CapabilityDashboardFeed {
    async fn device_manifest(
        &self,
        device_id: &str,
        device_name: &str,
        device_type: &str,
        prefs: &Value,
    ) -> std::result::Result<DeviceManifest, String> {
        let body = call_ok(
            &self.capabilities,
            CAP_DEVICE_MANIFEST,
            &device_request(device_id, device_name, device_type, prefs),
        )
        .await?;
        Ok(DeviceManifest {
            rev: body["rev"].as_str().unwrap_or_default().to_owned(),
            refresh_rate: refresh_rate_of(&body),
            screen: screen_from_json(&body["screen"]),
        })
    }

    async fn device_image(
        &self,
        device_id: &str,
        device_name: &str,
        device_type: &str,
        prefs: &Value,
        known_rev: Option<&str>,
    ) -> std::result::Result<Option<RenderedImage>, String> {
        let mut request = device_request(device_id, device_name, device_type, prefs);
        request["known_rev"] = json!(known_rev);
        let reply = self
            .capabilities
            .call_capability_raw(CAP_DEVICE_IMAGE, &request)
            .await
            .map_err(refusal)?;
        if reply.status == 304 {
            return Ok(None);
        }
        if !reply.is_success() {
            let body = serde_json::from_slice(&reply.body).unwrap_or(Value::Null);
            return Err(reply_error(CAP_DEVICE_IMAGE, reply.status, &body));
        }
        // The provider echoes the render's content type and its `rev` as the ETag.
        let content_type = reply
            .header("content-type")
            .unwrap_or("application/octet-stream")
            .to_owned();
        let rev = reply
            .header("etag")
            .map(|s| s.trim_matches('"').to_owned())
            .unwrap_or_default();
        Ok(Some(RenderedImage {
            bytes: reply.body.to_vec(),
            content_type,
            rev,
        }))
    }

    async fn device_config(
        &self,
        device_id: &str,
        device_name: &str,
        device_type: &str,
        prefs: &Value,
    ) -> std::result::Result<Value, String> {
        call_ok(
            &self.capabilities,
            CAP_DEVICE_CONFIG,
            &device_request(device_id, device_name, device_type, prefs),
        )
        .await
    }

    async fn set_device_config(
        &self,
        device_id: &str,
        device_name: &str,
        refresh_rate: Option<u32>,
        widgets: Option<Value>,
    ) -> std::result::Result<SetDeviceResult, String> {
        let body = call_ok(
            &self.capabilities,
            CAP_SET_DEVICE,
            &json!({
                "device_id": device_id,
                "device_name": device_name,
                "refresh_rate": refresh_rate,
                "widgets": widgets,
            }),
        )
        .await?;
        Ok(SetDeviceResult {
            dashboard_id: body["dashboard_id"].as_str().unwrap_or_default().to_owned(),
            refresh_rate: refresh_rate_of(&body),
        })
    }

    async fn delete_device(&self, device_id: &str) {
        // Best-effort by contract: a revoked device must not be blocked by a
        // missing or stopped dashboards provider.
        if let Err(e) = call_ok(
            &self.capabilities,
            CAP_UNBIND_DEVICE,
            &json!({ "device_id": device_id }),
        )
        .await
        {
            tracing::debug!("dropping device dashboard binding skipped: {e}");
        }
    }

    async fn list_bindings(&self) -> std::result::Result<Vec<DeviceBinding>, String> {
        let body = call_ok(&self.capabilities, CAP_DEVICE_BINDINGS, &json!({})).await?;
        let items = body["bindings"].as_array().cloned().unwrap_or_default();
        Ok(items
            .into_iter()
            .filter_map(|b| {
                Some(DeviceBinding {
                    device_id: b["device_id"].as_str()?.to_owned(),
                    dashboard_id: b["dashboard_id"].as_str()?.to_owned(),
                })
            })
            .collect())
    }

    async fn subscribe_changes(&self) -> tokio::sync::mpsc::Receiver<String> {
        let (tx, rx) = tokio::sync::mpsc::channel::<String>(64);
        let feed = self.clone();
        // Reconnect policy lives here, not in the helper: a closed stream (provider
        // restart) or a refusal (no provider yet) is latency-only for the nudge loop
        // (devices still re-poll on their own cadence), so retry on a fixed backoff
        // until the receiver drops. The channel itself never closes from this side,
        // so the nudge loop keeps running while dashboards is disabled.
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    () = tx.closed() => return,
                    result = feed.forward_changes(&tx) => {
                        if let Err(e) = result {
                            tracing::debug!("dashboard change stream unavailable ({e}); retrying");
                        }
                    }
                }
                tokio::select! {
                    biased;
                    () = tx.closed() => return,
                    () = tokio::time::sleep(feed.reconnect_every) => {}
                }
            }
        });
        rx
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::capability_consumer::test_support::{
        consumer_without_providers, registered, serve,
    };
    use axum::response::IntoResponse;
    use axum::routing::post;
    use axum::{Json, Router};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Every capability this adapter consumes, paired with the route the fixture
    /// provider declares for it.
    const FIXTURE_PROVIDES: &[(&str, Option<&str>)] = &[
        (CAP_GET, Some("/resolve")),
        (CAP_CREATE, Some("/create")),
        (CAP_RENAME, Some("/rename")),
        (CAP_UPSERT_WIDGET, Some("/widgets/upsert")),
        (CAP_DELETE_WIDGET, Some("/widgets/remove")),
        (CAP_ENSURE_DEVICE_DASHBOARD, Some("/device/ensure")),
        (CAP_DEVICE_MANIFEST, Some("/device/manifest")),
        (CAP_DEVICE_IMAGE, Some("/device/image")),
        (CAP_DEVICE_CONFIG, Some("/device/config")),
        (CAP_SET_DEVICE, Some("/device/config/set")),
        (CAP_UNBIND_DEVICE, Some("/device/unbind")),
        (CAP_DEVICE_BINDINGS, Some("/device-bindings")),
        (CAP_CHANGES, Some("/changes")),
    ];

    /// The capability names Core consumes must not name an app.
    #[test]
    fn capability_names_carry_no_app_id() {
        for (cap, _) in FIXTURE_PROVIDES {
            assert!(!cap.contains('@') && !cap.contains('/'), "{cap}");
        }
    }

    /// The Core adapter and the shipped Dashboards manifest agree on the capability
    /// set, so a renamed `provides` row cannot silently unbind the hardware feed.
    #[test]
    fn the_shipped_manifest_provides_every_consumed_capability() {
        let manifest: Value =
            serde_json::from_str(include_str!("../../../generated/ryu-runtime/apps-store/dashboards/manifest.json"))
                .unwrap();
        let provided: Vec<&str> = manifest["provides"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p["capability"].as_str())
            .collect();
        for (cap, _) in FIXTURE_PROVIDES {
            assert!(provided.contains(cap), "manifest does not provide {cap}");
        }
    }

    #[test]
    fn dashboard_projections_do_not_return_http_widget_headers() {
        let mut body = json!({
            "widgets": [{
                "source": {
                    "type": "http",
                    "url": "https://example.test/data",
                    "headers": {"Authorization": "Bearer secret"}
                }
            }]
        });
        redact_dashboard_widget_headers(&mut body);
        let source = &body["widgets"][0]["source"];
        assert!(source.get("headers").is_none());
        assert_eq!(source["headers_configured"], true);
        assert!(!body.to_string().contains("Bearer secret"));
    }

    /// The feed's render, binding and write calls map onto the fixture provider's
    /// replies, including the image's headers and its 304 path.
    #[tokio::test]
    async fn the_feed_maps_device_calls_onto_the_provider() {
        let (consumer, _sidecar, port) = registered(FIXTURE_PROVIDES).await;
        let app = Router::new()
            .route(
                "/api/fixture/device/manifest",
                post(|Json(body): Json<Value>| async move {
                    assert_eq!(body["device_type"], json!("desk"));
                    Json(json!({
                        "rev": "r1",
                        "refresh_rate": 300,
                        "screen": { "w": 800, "h": 480, "bit_depth": 1, "palette": "mono", "rotation": 0 }
                    }))
                }),
            )
            .route(
                "/api/fixture/device/image",
                post(|Json(body): Json<Value>| async move {
                    if body["known_rev"] == json!("r1") {
                        return axum::http::StatusCode::NOT_MODIFIED.into_response();
                    }
                    (
                        [
                            (axum::http::header::CONTENT_TYPE, "image/png"),
                            (axum::http::header::ETAG, "\"r1\""),
                        ],
                        vec![1_u8, 2, 3],
                    )
                        .into_response()
                }),
            )
            .route(
                "/api/fixture/device/config/set",
                post(|Json(body): Json<Value>| async move {
                    if body["widgets"] == json!("bad") {
                        return (
                            axum::http::StatusCode::BAD_REQUEST,
                            Json(json!({ "error": "widgets must be an array" })),
                        )
                            .into_response();
                    }
                    Json(json!({ "ok": true, "dashboard_id": "dash_d", "refresh_rate": 60 }))
                        .into_response()
                }),
            )
            .route(
                "/api/fixture/device-bindings",
                post(|| async {
                    Json(json!({ "bindings": [
                        { "device_id": "rhw_1", "dashboard_id": "dash_d" },
                        { "device_id": "malformed" }
                    ] }))
                }),
            );
        let server = serve(port, app).await;
        let feed = CapabilityDashboardFeed::new(consumer);
        let prefs = json!({});

        let manifest = feed
            .device_manifest("rhw_1", "Desk", "desk", &prefs)
            .await
            .unwrap();
        assert_eq!(manifest.rev, "r1");
        assert_eq!(manifest.refresh_rate, 300);
        assert_eq!((manifest.screen.w, manifest.screen.h), (800, 480));

        let image = feed
            .device_image("rhw_1", "Desk", "desk", &prefs, None)
            .await
            .unwrap()
            .expect("a fresh render");
        assert_eq!(image.bytes, vec![1, 2, 3]);
        assert_eq!(image.content_type, "image/png");
        assert_eq!(image.rev, "r1");
        assert!(feed
            .device_image("rhw_1", "Desk", "desk", &prefs, Some("r1"))
            .await
            .unwrap()
            .is_none());

        let set = feed
            .set_device_config("rhw_1", "Desk", Some(60), None)
            .await
            .unwrap();
        assert_eq!(
            (set.dashboard_id.as_str(), set.refresh_rate),
            ("dash_d", 60)
        );
        let err = feed
            .set_device_config("rhw_1", "Desk", None, Some(json!("bad")))
            .await
            .unwrap_err();
        assert_eq!(err, "widgets must be an array");

        let bindings = feed.list_bindings().await.unwrap();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].dashboard_id, "dash_d");
        server.abort();
    }

    /// With no app providing dashboards, every feed call fails open: renders return a
    /// legible error, unbinding is a no-op, and the change channel stays open (so
    /// the nudge loop keeps running) while yielding nothing.
    #[tokio::test]
    async fn a_missing_provider_fails_open() {
        let feed = CapabilityDashboardFeed::new(consumer_without_providers())
            .with_reconnect_every(Duration::from_millis(20));
        let err = feed
            .device_manifest("rhw_1", "Desk", "desk", &json!({}))
            .await
            .unwrap_err();
        assert!(err.contains(CAP_DEVICE_MANIFEST), "{err}");
        assert!(feed
            .device_image("rhw_1", "Desk", "desk", &json!({}), None)
            .await
            .is_err());
        assert!(feed.list_bindings().await.is_err());
        feed.delete_device("rhw_1").await;

        let mut changes = feed.subscribe_changes().await;
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert!(matches!(
            changes.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
    }

    /// The change subscription forwards each frame's `dashboard_id`, survives a
    /// provider restart by resubscribing on its own backoff, and skips frames that
    /// carry no id.
    #[tokio::test]
    async fn the_change_feed_reconnects_across_a_provider_restart() {
        let (consumer, _sidecar, port) = registered(FIXTURE_PROVIDES).await;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .unwrap();
        let server = tokio::spawn(async move {
            for frames in [
                "data: {\"dashboard_id\":\"d1\"}\n\n: comment\n\ndata: not-json\n\n",
                "data: {\"type\":\"widget\",\"dashboard_id\":\"d2\"}\n\n",
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 4096];
                let read = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..read]);
                assert!(
                    request.starts_with("POST /api/fixture/changes "),
                    "{request}"
                );
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                     Transfer-Encoding: chunked\r\n\r\n{:x}\r\n{frames}\r\n",
                    frames.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.flush().await.unwrap();
                // Dropping the socket mid-body is the provider restarting.
            }
            listener
        });
        let feed =
            CapabilityDashboardFeed::new(consumer).with_reconnect_every(Duration::from_millis(20));
        let mut changes = feed.subscribe_changes().await;
        let first = tokio::time::timeout(Duration::from_secs(5), changes.recv())
            .await
            .unwrap();
        assert_eq!(first.as_deref(), Some("d1"));
        let second = tokio::time::timeout(Duration::from_secs(5), changes.recv())
            .await
            .expect("the feed must resubscribe after the provider restarts");
        assert_eq!(second.as_deref(), Some("d2"));
        drop(changes);
        drop(server.await.unwrap());
    }

    /// Dropping the nudge loop's receiver closes the provider connection, whether
    /// the provider has answered the response head yet or not.
    #[tokio::test]
    async fn the_change_feed_disconnects_when_its_consumer_closes() {
        for response_prefix in [
            "",
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
        ] {
            let (consumer, _sidecar, port) = registered(FIXTURE_PROVIDES).await;
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
                .await
                .unwrap();
            let (started, ready) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 4096];
                assert!(socket.read(&mut buffer).await.unwrap() > 0);
                socket.write_all(response_prefix.as_bytes()).await.unwrap();
                started.send(()).unwrap();
                loop {
                    match socket.read(&mut buffer).await {
                        Ok(0) => break,
                        Ok(_) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => break,
                        Err(error) => panic!("unexpected socket read failure: {error}"),
                    }
                }
            });
            let feed = CapabilityDashboardFeed::new(consumer);
            let receiver = feed.subscribe_changes().await;
            tokio::time::timeout(Duration::from_secs(3), ready)
                .await
                .unwrap()
                .unwrap();
            drop(receiver);
            tokio::time::timeout(Duration::from_secs(2), server)
                .await
                .expect("dropping the change consumer must close the provider connection")
                .unwrap();
        }
    }

    /// The authoring seam maps provider replies: 404 is `None`, a 4xx upsert is a
    /// readable rejection, and a missing provider is a legible hard error.
    #[tokio::test]
    async fn authoring_maps_provider_replies() {
        let (consumer, _sidecar, port) = registered(FIXTURE_PROVIDES).await;
        let app = Router::new()
            .route(
                "/api/fixture/resolve",
                post(|Json(body): Json<Value>| async move {
                    if body["id"] == json!("missing") {
                        return (axum::http::StatusCode::NOT_FOUND, Json(json!({})))
                            .into_response();
                    }
                    Json(json!({
                        "dashboard": { "id": body["id"] },
                        "widgets": [{ "source": { "type": "http", "headers": { "x": "secret" } } }]
                    }))
                    .into_response()
                }),
            )
            .route(
                "/api/fixture/widgets/upsert",
                post(|Json(body): Json<Value>| async move {
                    if body["widget"]["kind"] == json!("bogus") {
                        return (
                            axum::http::StatusCode::BAD_REQUEST,
                            Json(json!({ "error": "unknown kind" })),
                        )
                            .into_response();
                    }
                    Json(json!({ "widget": body["widget"] })).into_response()
                }),
            )
            .route(
                "/api/fixture/device/ensure",
                post(|| async { Json(json!({ "dashboard_id": "dash_dev" })) }),
            );
        let server = serve(port, app).await;

        let found = consumer.get_dashboard("dash_1").await.unwrap().unwrap();
        assert_eq!(found["dashboard"]["id"], json!("dash_1"));
        assert!(!found.to_string().contains("secret"), "{found}");
        assert!(consumer.get_dashboard("missing").await.unwrap().is_none());
        assert_eq!(
            consumer
                .upsert_widget("dash_1", &json!({ "kind": "bogus" }))
                .await
                .unwrap(),
            Err("unknown kind".to_owned())
        );
        assert_eq!(
            consumer
                .upsert_widget("dash_1", &json!({ "kind": "stat" }))
                .await
                .unwrap(),
            Ok(())
        );
        assert_eq!(
            consumer.ensure_device_dashboard("rhw_1").await.unwrap(),
            "dash_dev"
        );
        server.abort();

        let err = consumer_without_providers()
            .create_dashboard("x")
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains(CAP_CREATE), "{err}");
    }
}
