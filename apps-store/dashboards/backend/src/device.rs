//! Device-dashboard rendering: the single source of truth for the hardware
//! display surface (TRMNL model, `apps/hardware/DASHBOARD.md`).
//!
//! This module used to live inside `ryu_hardware::api` (welding the kernel
//! hardware crate to `ryu_dashboards`). It moved here so BOTH consumers share one
//! implementation with zero drift:
//!
//! - **Core, in-process** (`DashboardEngine` on hand) — the transitional
//!   `InProcDashboardFeed` calls these `fn`s directly.
//! - **The `ryu-dashboards` sidecar** — its internal `/api/dashboards/device/*`
//!   endpoints call these same `fn`s, so a decoupled node renders identically.
//!
//! The device *auth* (per-device Bearer verification against the hardware
//! registry) stays Core-side in `ryu_hardware` — only the dashboard *data +
//! render* live here. The panel geometry is derived from the device class +
//! saved prefs (`device_type` + `prefs`), passed as plain values so this module
//! never depends on the hardware crate's `DeviceType`/`DeviceRecord` types.

use serde_json::{json, Value};

use crate::render::{self, DeviceProfile, Palette};
use crate::{Dashboard, DashboardEngine, DeviceDashboard};

/// Refresh-rate floor (seconds) so a device can't be told to hammer the node.
/// Byte-identical to the old `ryu_hardware::api::MIN_REFRESH_RATE`.
const MIN_REFRESH_RATE: u32 = 30;
/// Default device dashboard poll interval (seconds) when none is set.
const DEFAULT_REFRESH_RATE: u32 = 300;

/// Resolve a device's [`DeviceProfile`] from its class + saved prefs. The class
/// picks a sensible default panel (desk = 800×480 1-bit e-ink; watch = 240×240
/// colour LCD; necklace has no display); `prefs.screen` may override any field so
/// a different panel revision works without a code change. Nothing is hardcoded
/// past the class default.
///
/// `device_type` is the wire string the hardware protocol uses (`"desk"` /
/// `"watch"` / `"necklace"`); an unknown value falls back to the e-ink default so
/// the endpoint still produces something deterministic.
pub fn profile_for_device(device_type: &str, prefs: &Value) -> DeviceProfile {
    let mut profile = match device_type {
        "watch" => DeviceProfile::watch_lcd(),
        // Desk + no-display necklace both fall back to the e-ink default.
        _ => DeviceProfile::desk_eink(),
    };
    if let Some(screen) = prefs.get("screen").filter(|v| v.is_object()) {
        if let Some(w) = screen.get("w").and_then(Value::as_u64) {
            profile.w = w as u32;
        }
        if let Some(h) = screen.get("h").and_then(Value::as_u64) {
            profile.h = h as u32;
        }
        if let Some(bd) = screen.get("bit_depth").and_then(Value::as_u64) {
            profile.bit_depth = bd as u8;
        }
        if let Some(rot) = screen.get("rotation").and_then(Value::as_u64) {
            profile.rotation = rot as u16;
        }
        if let Some(p) = screen.get("palette").and_then(Value::as_str) {
            profile.palette = match p {
                "rgb565" => Palette::Rgb565,
                "rgba" => Palette::Rgba,
                _ => Palette::Mono,
            };
        }
    }
    profile
}

/// The `screen` object echoed in the display manifest + device config, kept
/// byte-identical across both callers.
pub fn screen_json(profile: &DeviceProfile) -> Value {
    json!({
        "w": profile.w,
        "h": profile.h,
        "bit_depth": profile.bit_depth,
        "palette": profile.palette.as_str(),
        "rotation": profile.rotation,
    })
}

/// Ensure the device has a bound dashboard, creating an empty one on first use so
/// every device always has a real, builder-editable surface. Returns the binding.
pub async fn ensure_device_dashboard(
    engine: &DashboardEngine,
    device_id: &str,
    device_name: &str,
) -> anyhow::Result<DeviceDashboard> {
    if let Some(dd) = engine.store.get_device_dashboard(device_id).await? {
        // The bound dashboard could have been deleted out from under us; recreate.
        if engine.store.get_dashboard(&dd.dashboard_id).await?.is_some() {
            return Ok(dd);
        }
    }
    let now = chrono::Utc::now().to_rfc3339();
    let dashboard = Dashboard {
        id: format!("dash_{}", uuid::Uuid::new_v4().simple()),
        name: format!("{device_name} display"),
        created_at: now.clone(),
        updated_at: now.clone(),
        view_mode: None,
    };
    engine.store.upsert_dashboard(&dashboard).await?;
    let dd = DeviceDashboard {
        device_id: device_id.to_string(),
        dashboard_id: dashboard.id,
        refresh_rate: DEFAULT_REFRESH_RATE,
        created_at: now.clone(),
        updated_at: now,
    };
    engine.store.upsert_device_dashboard(&dd).await?;
    Ok(dd)
}

/// Render a device's current dashboard to its panel encoding.
pub async fn render_device(
    engine: &DashboardEngine,
    device_id: &str,
    device_name: &str,
    device_type: &str,
    prefs: &Value,
) -> anyhow::Result<(render::RenderedImage, DeviceDashboard)> {
    let dd = ensure_device_dashboard(engine, device_id, device_name).await?;
    let widgets = engine
        .store
        .list_widgets(&dd.dashboard_id)
        .await
        .unwrap_or_default();
    let profile = profile_for_device(device_type, prefs);
    let image = render::render(&widgets, profile)?;
    Ok((image, dd))
}

/// Build the device-dashboard config JSON (the binding + the bound dashboard's
/// widgets + the screen geometry). Byte-identical to the old
/// `ryu_hardware::api::get_device_dashboard` body.
pub async fn device_config_json(
    engine: &DashboardEngine,
    device_id: &str,
    device_name: &str,
    device_type: &str,
    prefs: &Value,
) -> anyhow::Result<Value> {
    let dd = ensure_device_dashboard(engine, device_id, device_name).await?;
    let widgets = engine
        .store
        .list_widgets(&dd.dashboard_id)
        .await
        .unwrap_or_default();
    let profile = profile_for_device(device_type, prefs);
    Ok(json!({
        "device_id": dd.device_id,
        "dashboard_id": dd.dashboard_id,
        "refresh_rate": dd.refresh_rate,
        "screen": screen_json(&profile),
        "widgets": widgets,
    }))
}

/// Apply a device-dashboard update: set the poll interval and/or replace the
/// widget selection. Returns `(dashboard_id, effective_refresh_rate)`. Mirrors the
/// old `ryu_hardware::api::set_device_dashboard` mutation (the caller owns the
/// live-device nudge, which stays hardware-side).
pub async fn set_device_config(
    engine: &DashboardEngine,
    device_id: &str,
    device_name: &str,
    refresh_rate: Option<u32>,
    widgets: Option<Value>,
) -> anyhow::Result<(String, u32)> {
    let mut dd = ensure_device_dashboard(engine, device_id, device_name).await?;

    if let Some(rate) = refresh_rate {
        dd.refresh_rate = rate.max(MIN_REFRESH_RATE);
        dd.updated_at = chrono::Utc::now().to_rfc3339();
        engine.store.upsert_device_dashboard(&dd).await?;
    }

    if let Some(widgets) = widgets {
        crate::replace_widgets(engine, &dd.dashboard_id, &widgets).await?;
    }

    Ok((dd.dashboard_id, dd.refresh_rate))
}
