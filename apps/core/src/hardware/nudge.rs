//! Live display nudge: tell a connected device "your dashboard changed, re-poll
//! now" when its bound dashboard's data updates (review gap #4).
//!
//! TRMNL devices poll the node for their display image. Without a push signal, an
//! edit (a new widget, fresh widget data, a builder change from the desktop) would
//! only appear on the next poll — up to `refresh_rate` seconds late. This loop
//! closes that gap: it subscribes to the dashboard store's broadcast (the SAME
//! stream the desktop Home grid reads over SSE) and, when a widget on a
//! device-bound dashboard changes, sends the RHP `display` control message
//! ([`RhpServerMsg::Display`]) over that device's live WS so it re-polls promptly.
//!
//! Cost discipline mirrors the dashboard refresh loop: the nudge is only sent to
//! **connected** devices ([`session::live::is_connected`]), and it is **debounced**
//! per device so a burst of widget updates collapses into one re-poll. The device
//! still re-polls on its own `refresh_rate` cadence when offline, so a missed nudge
//! is never a correctness problem — only a latency one.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::dashboard::{DashboardEngine, DashboardEvent};
use crate::hardware::protocol::{DeviceType, RhpServerMsg, Surface};
use crate::hardware::session::live;
use crate::hardware::store::DeviceStore;

/// Minimum gap between two nudges to the same device, so a flurry of widget value
/// changes (e.g. several widgets refreshing in one tick) collapses to one re-poll.
const NUDGE_DEBOUNCE: Duration = Duration::from_secs(2);

/// Spawn the hardware display-nudge loop. Call once at startup with the dashboard
/// engine (for the broadcast + the device→dashboard bindings) and the device store
/// (to resolve a device's panel surface). No-op-cheap when no devices are bound.
pub fn spawn(dashboards: DashboardEngine, devices: DeviceStore) {
    tokio::spawn(async move {
        let mut rx = dashboards.store.subscribe();
        let mut last_nudge: HashMap<String, Instant> = HashMap::new();
        loop {
            let event = match rx.recv().await {
                Ok(e) => e,
                // Lagged: we dropped some events; that's fine — the next change
                // re-triggers, and the device polls on its own cadence regardless.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            // Only data/error/definition changes warrant a re-poll.
            let dashboard_id = match &event {
                DashboardEvent::WidgetData { dashboard_id, .. }
                | DashboardEvent::WidgetError { dashboard_id, .. }
                | DashboardEvent::WidgetUpdated { dashboard_id, .. }
                | DashboardEvent::WidgetDeleted { dashboard_id, .. }
                | DashboardEvent::DashboardUpdated { dashboard_id } => dashboard_id.clone(),
            };

            // Find which device(s) bind this dashboard.
            let bindings = match dashboards.store.list_device_dashboards().await {
                Ok(b) => b,
                Err(_) => continue,
            };
            for dd in bindings.iter().filter(|d| d.dashboard_id == dashboard_id) {
                if !live::is_connected(&dd.device_id).await {
                    continue;
                }
                // Debounce per device.
                let now = Instant::now();
                if let Some(prev) = last_nudge.get(&dd.device_id) {
                    if now.duration_since(*prev) < NUDGE_DEBOUNCE {
                        continue;
                    }
                }
                let surface = surface_for(&devices, &dd.device_id).await;
                let sent = live::send(
                    &dd.device_id,
                    RhpServerMsg::Display {
                        surface,
                        widget: "dashboard".to_string(),
                        payload: serde_json::json!({ "action": "repoll" }),
                    },
                )
                .await;
                if sent {
                    last_nudge.insert(dd.device_id.clone(), now);
                }
            }
        }
    });
}

/// Resolve the panel surface (`eink`/`lcd`) for a device from its class. The watch
/// is the only LCD device; desk/necklace use e-ink. Defaults to e-ink when the
/// device row can't be read (the firmware treats `eink` as the dashboard panel).
async fn surface_for(devices: &DeviceStore, device_id: &str) -> Surface {
    match devices.get(device_id).await {
        Ok(Some(r)) if matches!(r.device_type, DeviceType::Watch) => Surface::Lcd,
        _ => Surface::Eink,
    }
}
