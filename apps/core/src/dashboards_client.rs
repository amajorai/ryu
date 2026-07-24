//! Core-side typed loopback client for the out-of-process `ryu-dashboards`
//! sidecar, and its [`ryu_hardware::DashboardFeed`] impl.
//!
//! Home dashboards used to run in-process: a `ryu_dashboards::DashboardEngine`
//! field on `ServerState`, an in-process `/api/dashboards/*` route merge, a
//! dashboard-owned refresh loop, and the hardware device-dashboard renderer +
//! nudge loop reaching the engine directly. Dashboards is now an out-of-process app
//! (`com.ryu.dashboards`): the `ryu-dashboards` sidecar owns `dashboards.db`, the
//! refresh loop, and the `/api/dashboards/*` surface — served to the desktop
//! through the generic ext-proxy `public_mount`. Core links NO dashboard code; its
//! remaining reverse couplings reach the sidecar over loopback through this client:
//!
//! - **hardware display + nudge** — the kernel hardware surface renders a device's
//!   dashboard through the `DashboardFeed` seam; [`DashboardsClient`] answers it by
//!   POSTing the sidecar's internal `/api/dashboards/device/*` endpoints (which run
//!   the SAME `ryu_dashboards::device` render fns Core used in-process), and
//!   consumes the sidecar's `/api/dashboards/events` SSE (with `?internal=1`, so it
//!   never fakes a UI viewer) for the nudge loop — reconnecting across a sidecar
//!   restart.
//! - **`dashboard_builder` MCP runnable** — authors dashboards/widgets through the
//!   sidecar's REST surface (`create_dashboard` / `create_widget` / …) instead of
//!   the store.
//!
//! Security mirrors the ext-proxy hop exactly: the loopback client presents the
//! per-plugin minted bearer ([`crate::sidecar::ext_proxy::ext_token`]), the same
//! value the sidecar was spawned with — a hand-rolled local request without it is
//! rejected fail-closed. Nothing hardcoded (the port resolves from the manifest).

use std::time::Duration;

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Value};

use ryu_hardware::feed::{
    DashboardFeed, DeviceBinding, DeviceManifest, RenderedImage, ScreenProfile, SetDeviceResult,
};

use crate::sidecar::ext_proxy::{ext_token, node_token};

/// The built-in Dashboards app id (matches `plugins::builtins::DASHBOARDS_PLUGIN_ID`
/// and the `dashboards.manifest.json` fixture).
const DASHBOARDS_PLUGIN_ID: &str = "com.ryu.dashboards";
/// Fallback loopback port if the manifest is somehow absent — matches the
/// `dashboards.manifest.json` fixture `port`. Core injects this as
/// `RYU_DASHBOARDS_PORT` at spawn.
const DASHBOARDS_FALLBACK_PORT: u16 = 7997;
/// Backoff between SSE reconnect attempts for the nudge subscription.
const SSE_RECONNECT_EVERY: Duration = Duration::from_secs(5);

/// Process-global dashboards client so the state-free `dashboard_builder` MCP
/// runnable can reach the sidecar without carrying `ServerState`. Set once from
/// `main.rs`, mirroring the `quests_client` / `monitors_client` pattern.
static GLOBAL_CLIENT: std::sync::OnceLock<DashboardsClient> = std::sync::OnceLock::new();

/// Publish the process-global dashboards client. Idempotent (first write wins).
pub fn set_global_client(client: DashboardsClient) {
    let _ = GLOBAL_CLIENT.set(client);
}

/// The process-global dashboards client, or `None` before `main.rs` has set it.
pub fn global_client() -> Option<&'static DashboardsClient> {
    GLOBAL_CLIENT.get()
}

/// Resolve the `ryu-dashboards` sidecar's loopback port from the loaded manifests,
/// profile-shifted the same way the ext-proxy forwards ([`crate::profile::port`]).
pub fn sidecar_port(manifests: &[crate::plugin_manifest::PluginManifest]) -> u16 {
    let raw = manifests
        .iter()
        .find(|m| m.id == DASHBOARDS_PLUGIN_ID)
        .and_then(|m| m.sidecars.iter().find(|s| s.name == "ryu-dashboards"))
        .map(|s| s.port)
        .unwrap_or(DASHBOARDS_FALLBACK_PORT);
    crate::profile::port(raw)
}

/// Typed loopback client for the `ryu-dashboards` sidecar. Cheap to clone (holds
/// only the resolved port); the bearer is minted per call so it always tracks the
/// current node token.
#[derive(Clone)]
pub struct DashboardsClient {
    port: u16,
}

impl DashboardsClient {
    /// Build a client bound to the sidecar's resolved loopback port.
    pub fn new(port: u16) -> Self {
        Self { port }
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/api/dashboards", self.port)
    }

    /// The per-plugin minted bearer the sidecar was spawned with.
    fn bearer(&self) -> String {
        ext_token(node_token().as_deref(), DASHBOARDS_PLUGIN_ID)
    }

    // ── dashboard_builder REST helpers ───────────────────────────────────────

    /// Fetch a dashboard + its widgets (`{ dashboard, widgets }`). `Ok(None)` on a
    /// 404 (unknown dashboard), matching the old builder `get_dashboard` contract.
    pub async fn get_dashboard(&self, id: &str) -> Result<Option<Value>> {
        let resp = reqwest::Client::new()
            .get(format!("{}/{id}", self.base_url()))
            .bearer_auth(self.bearer())
            .send()
            .await
            .context("GET /api/dashboards/:id on the dashboards sidecar")?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            bail!("dashboards sidecar GET /{id} returned {}", resp.status());
        }
        Ok(Some(resp.json().await.context("decoding dashboard")?))
    }

    /// Create a dashboard, returning its new id.
    pub async fn create_dashboard(&self, name: &str) -> Result<String> {
        let resp = reqwest::Client::new()
            .post(self.base_url())
            .bearer_auth(self.bearer())
            .json(&json!({ "name": name }))
            .send()
            .await
            .context("POST /api/dashboards on the dashboards sidecar")?;
        if !resp.status().is_success() {
            bail!("dashboards sidecar POST / returned {}", resp.status());
        }
        let body: Value = resp.json().await.context("decoding created dashboard")?;
        body["dashboard"]["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow::anyhow!("dashboards sidecar returned no dashboard id"))
    }

    /// Rename a dashboard.
    pub async fn rename_dashboard(&self, id: &str, name: &str) -> Result<()> {
        let resp = reqwest::Client::new()
            .put(format!("{}/{id}", self.base_url()))
            .bearer_auth(self.bearer())
            .json(&json!({ "name": name }))
            .send()
            .await
            .context("PUT /api/dashboards/:id on the dashboards sidecar")?;
        if !resp.status().is_success() {
            bail!("dashboards sidecar PUT /{id} returned {}", resp.status());
        }
        Ok(())
    }

    /// Upsert one widget on a dashboard (the model-authored body; an `id` field, if
    /// present, replaces that widget). Returns:
    /// - `Ok(Ok(()))` — created/updated;
    /// - `Ok(Err(msg))` — a client-side rejection (bad widget / non-allowlisted
    ///   source), surfaced by the builder as a soft, model-readable error;
    /// - `Err(_)` — a transport / server failure (a hard tool error).
    pub async fn upsert_widget(
        &self,
        dashboard_id: &str,
        widget: &Value,
    ) -> Result<std::result::Result<(), String>> {
        let resp = reqwest::Client::new()
            .post(format!("{}/{dashboard_id}/widgets", self.base_url()))
            .bearer_auth(self.bearer())
            .json(widget)
            .send()
            .await
            .context("POST /api/dashboards/:id/widgets on the dashboards sidecar")?;
        let status = resp.status();
        if status.is_success() {
            return Ok(Ok(()));
        }
        // 4xx ⇒ a client-side rejection the model can read + retry within the turn.
        if status.is_client_error() {
            let msg = error_message(resp).await;
            return Ok(Err(msg));
        }
        bail!("dashboards sidecar POST /{dashboard_id}/widgets returned {status}");
    }

    /// Delete a widget by id; `Ok(true)` when a row was removed.
    pub async fn delete_widget(&self, dashboard_id: &str, widget_id: &str) -> Result<bool> {
        let resp = reqwest::Client::new()
            .delete(format!(
                "{}/{dashboard_id}/widgets/{widget_id}",
                self.base_url()
            ))
            .bearer_auth(self.bearer())
            .send()
            .await
            .context("DELETE /api/dashboards/:id/widgets/:wid on the dashboards sidecar")?;
        Ok(resp.status().is_success())
    }

    /// Ensure a hardware device has a bound dashboard (created on first use) and
    /// return its id — the builder's device-target path.
    pub async fn ensure_device_dashboard(&self, device_id: &str) -> Result<String> {
        let resp = reqwest::Client::new()
            .post(format!("{}/device/ensure", self.base_url()))
            .bearer_auth(self.bearer())
            .json(&json!({ "device_id": device_id }))
            .send()
            .await
            .context("POST /api/dashboards/device/ensure on the dashboards sidecar")?;
        if !resp.status().is_success() {
            bail!(
                "dashboards sidecar POST /device/ensure returned {}",
                resp.status()
            );
        }
        let body: Value = resp.json().await.context("decoding ensured binding")?;
        body["dashboard_id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow::anyhow!("dashboards sidecar returned no dashboard id"))
    }
}

/// Read a `{ "error": "…" }` body (falling back to the status) for a soft error.
async fn error_message(resp: reqwest::Response) -> String {
    let status = resp.status();
    match resp.json::<Value>().await {
        Ok(v) => v["error"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("HTTP {status}")),
        Err(_) => format!("HTTP {status}"),
    }
}

/// Parse a `screen` JSON object into the seam's plain [`ScreenProfile`].
fn screen_from_json(v: &Value) -> ScreenProfile {
    ScreenProfile {
        w: v["w"].as_u64().unwrap_or(0) as u32,
        h: v["h"].as_u64().unwrap_or(0) as u32,
        bit_depth: v["bit_depth"].as_u64().unwrap_or(0) as u8,
        palette: v["palette"].as_str().unwrap_or("mono").to_owned(),
        rotation: v["rotation"].as_u64().unwrap_or(0) as u16,
    }
}

#[async_trait]
impl DashboardFeed for DashboardsClient {
    async fn device_manifest(
        &self,
        device_id: &str,
        device_name: &str,
        device_type: &str,
        prefs: &Value,
    ) -> std::result::Result<DeviceManifest, String> {
        let resp = reqwest::Client::new()
            .post(format!("{}/device/manifest", self.base_url()))
            .bearer_auth(self.bearer())
            .json(&json!({
                "device_id": device_id,
                "device_name": device_name,
                "device_type": device_type,
                "prefs": prefs,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(error_message(resp).await);
        }
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(DeviceManifest {
            rev: body["rev"].as_str().unwrap_or_default().to_owned(),
            refresh_rate: body["refresh_rate"].as_u64().unwrap_or(0) as u32,
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
        let resp = reqwest::Client::new()
            .post(format!("{}/device/image", self.base_url()))
            .bearer_auth(self.bearer())
            .json(&json!({
                "device_id": device_id,
                "device_name": device_name,
                "device_type": device_type,
                "prefs": prefs,
                "known_rev": known_rev,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(error_message(resp).await);
        }
        // Recover the content-type + rev from the response headers before consuming
        // the body (the sidecar echoes the render's content-type + ETag = "rev").
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_owned();
        let rev = resp
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim_matches('"').to_owned())
            .unwrap_or_default();
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
        Ok(Some(RenderedImage {
            bytes,
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
        let resp = reqwest::Client::new()
            .post(format!("{}/device/config", self.base_url()))
            .bearer_auth(self.bearer())
            .json(&json!({
                "device_id": device_id,
                "device_name": device_name,
                "device_type": device_type,
                "prefs": prefs,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(error_message(resp).await);
        }
        resp.json().await.map_err(|e| e.to_string())
    }

    async fn set_device_config(
        &self,
        device_id: &str,
        device_name: &str,
        refresh_rate: Option<u32>,
        widgets: Option<Value>,
    ) -> std::result::Result<SetDeviceResult, String> {
        let resp = reqwest::Client::new()
            .put(format!("{}/device/config", self.base_url()))
            .bearer_auth(self.bearer())
            .json(&json!({
                "device_id": device_id,
                "device_name": device_name,
                "refresh_rate": refresh_rate,
                "widgets": widgets,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(error_message(resp).await);
        }
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(SetDeviceResult {
            dashboard_id: body["dashboard_id"].as_str().unwrap_or_default().to_owned(),
            refresh_rate: body["refresh_rate"].as_u64().unwrap_or(0) as u32,
        })
    }

    async fn delete_device(&self, device_id: &str) {
        let _ = reqwest::Client::new()
            .delete(format!("{}/device/{device_id}", self.base_url()))
            .bearer_auth(self.bearer())
            .send()
            .await;
    }

    async fn list_bindings(&self) -> std::result::Result<Vec<DeviceBinding>, String> {
        let resp = reqwest::Client::new()
            .get(format!("{}/device-bindings", self.base_url()))
            .bearer_auth(self.bearer())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
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
        let client = self.clone();
        // Reconnecting SSE consumer: a dropped stream (sidecar restart) is
        // latency-only — the device re-polls on its own cadence — so we retry with
        // a fixed backoff until the nudge loop drops its receiver.
        tokio::spawn(async move {
            loop {
                if tx.is_closed() {
                    return;
                }
                if let Err(e) = client.stream_changes(&tx).await {
                    tracing::debug!("dashboards events stream ended ({e}); retrying");
                }
                tokio::time::sleep(SSE_RECONNECT_EVERY).await;
            }
        });
        rx
    }
}

impl DashboardsClient {
    /// One connection of the dashboards `/events` SSE stream (as an INTERNAL,
    /// non-viewer subscriber), forwarding each changed `dashboard_id` to the nudge
    /// loop until the stream closes/errors (then [`DashboardsClient::subscribe_changes`]
    /// reconnects) or the receiver drops.
    async fn stream_changes(&self, tx: &tokio::sync::mpsc::Sender<String>) -> Result<(), String> {
        let resp = reqwest::Client::new()
            .get(format!("{}/events?internal=1", self.base_url()))
            .bearer_auth(self.bearer())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buf.find('\n') {
                let line = buf[..pos].trim_end_matches('\r').to_string();
                buf.drain(..=pos);
                let Some(payload) = line.strip_prefix("data:") else {
                    continue;
                };
                let payload = payload.trim();
                if payload.is_empty() {
                    continue;
                }
                // Every `DashboardEvent` variant carries the changed dashboard id.
                let Ok(event) = serde_json::from_str::<Value>(payload) else {
                    continue;
                };
                if let Some(dashboard_id) = event["dashboard_id"].as_str() {
                    if tx.send(dashboard_id.to_owned()).await.is_err() {
                        return Ok(()); // nudge loop dropped its receiver
                    }
                }
            }
        }
        Ok(())
    }
}
