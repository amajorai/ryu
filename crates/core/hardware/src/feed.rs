//! The dashboard *feed* seam: the minimal contract the hardware device-dashboard
//! renderer + the display-nudge loop need from the Home-dashboards capability,
//! inverted so this kernel crate has ZERO compile-time dependency on
//! `ryu_dashboards`.
//!
//! ## Why this exists
//!
//! A hardware device (TRMNL model) renders a Home dashboard onto its e-ink / LCD
//! panel: the device polls Core, Core renders the device's bound dashboard to a
//! panel image. That render reads dashboard widgets + rasterizes them — a
//! *dashboards* concern that had been welded into `ryu_hardware::api` as a direct
//! `ryu_dashboards::DashboardEngine` field. Dashboards is now a swappable,
//! out-of-process app; a kernel crate cannot hard-link it.
//!
//! [`DashboardFeed`] is the inversion. It exposes ONLY what the renderer + nudge
//! loop need (render a device's dashboard, read/write its config + binding,
//! subscribe to change events), in terms of plain owned types — never a
//! `ryu_dashboards` type. Core provides the impl:
//!
//! - in-process (`InProcDashboardFeed`) — wraps the in-process engine;
//! - out-of-process (`dashboards_client::DashboardsClient`) — proxies to the
//!   `ryu-dashboards` sidecar over loopback (+ its SSE stream for change events).
//!
//! The device *auth* (per-device Bearer verification against the registry) stays
//! Core-side; only the render + data cross this seam.

use serde_json::Value;

/// A device's panel geometry echoed in the display manifest + config `screen`
/// object. Computed by the feed impl from the device class + prefs (so the panel
/// constants live with the renderer, not here), and carried back as plain data.
#[derive(Clone, Debug)]
pub struct ScreenProfile {
    pub w: u32,
    pub h: u32,
    pub bit_depth: u8,
    /// Wire palette string (`"mono"` / `"rgba"` / `"rgb565"`).
    pub palette: String,
    pub rotation: u16,
}

/// The display-manifest facts for a device: the content revision (so the device
/// can skip an unchanged re-download), its poll interval, and its panel geometry.
#[derive(Clone, Debug)]
pub struct DeviceManifest {
    pub rev: String,
    pub refresh_rate: u32,
    pub screen: ScreenProfile,
}

/// A rendered device image plus the metadata the display endpoint returns.
#[derive(Clone, Debug)]
pub struct RenderedImage {
    pub bytes: Vec<u8>,
    /// `image/png` or `application/octet-stream` (packed mono / rgb565).
    pub content_type: String,
    /// Content hash the device caches against (`?rev=`).
    pub rev: String,
}

/// The outcome of a device-dashboard write.
#[derive(Clone, Debug)]
pub struct SetDeviceResult {
    pub dashboard_id: String,
    pub refresh_rate: u32,
}

/// A device → dashboard binding (the nudge loop's work list).
#[derive(Clone, Debug)]
pub struct DeviceBinding {
    pub device_id: String,
    pub dashboard_id: String,
}

/// The dashboards capability, seen through the narrow hole the hardware surface
/// needs. Implemented by Core (in-process or sidecar-backed).
#[async_trait::async_trait]
pub trait DashboardFeed: Send + Sync {
    /// The display manifest facts for a device (renders internally to compute the
    /// current `rev`). `device_type` is the RHP wire string; `prefs` the device's
    /// saved prefs (may carry a `screen` override).
    async fn device_manifest(
        &self,
        device_id: &str,
        device_name: &str,
        device_type: &str,
        prefs: &Value,
    ) -> Result<DeviceManifest, String>;

    /// Render a device's dashboard image. Returns `None` when `known_rev` still
    /// matches the freshly-rendered content (the caller answers `304`).
    async fn device_image(
        &self,
        device_id: &str,
        device_name: &str,
        device_type: &str,
        prefs: &Value,
        known_rev: Option<&str>,
    ) -> Result<Option<RenderedImage>, String>;

    /// The device-dashboard config JSON (binding + widgets + screen).
    async fn device_config(
        &self,
        device_id: &str,
        device_name: &str,
        device_type: &str,
        prefs: &Value,
    ) -> Result<Value, String>;

    /// Set a device's poll interval and/or replace its widget selection.
    async fn set_device_config(
        &self,
        device_id: &str,
        device_name: &str,
        refresh_rate: Option<u32>,
        widgets: Option<Value>,
    ) -> Result<SetDeviceResult, String>;

    /// Drop a device's dashboard binding (on device revoke). Best-effort.
    async fn delete_device(&self, device_id: &str);

    /// Every device → dashboard binding (the nudge loop resolves which device(s)
    /// bind a changed dashboard).
    async fn list_bindings(&self) -> Result<Vec<DeviceBinding>, String>;

    /// Subscribe to dashboard change events, yielding the changed `dashboard_id`.
    /// The impl owns any reconnect/backoff (a loopback SSE can drop); the nudge
    /// loop just drains the channel. A dropped subscription is latency-only — the
    /// device still re-polls on its own cadence.
    async fn subscribe_changes(&self) -> tokio::sync::mpsc::Receiver<String>;
}
