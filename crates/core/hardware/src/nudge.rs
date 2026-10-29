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
//! **connected** devices ([`crate::session::live::is_connected`]), and it is **debounced**
//! per device so a burst of widget updates collapses into one re-poll. The device
//! still re-polls on its own `refresh_rate` cadence when offline, so a missed nudge
//! is never a correctness problem — only a latency one.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::feed::DashboardFeed;
use crate::protocol::{DeviceType, RhpServerMsg, Surface};
use crate::session::live;
use crate::store::DeviceStore;

/// Minimum gap between two nudges to the same device, so a flurry of widget value
/// changes (e.g. several widgets refreshing in one tick) collapses to one re-poll.
const NUDGE_DEBOUNCE: Duration = Duration::from_secs(2);

/// Spawn the hardware display-nudge loop. Call once at startup with the
/// [`DashboardFeed`] (for change events + the device→dashboard bindings) and the
/// device store (to resolve a device's panel surface). Skips binding reads when
/// no device is connected.
///
/// The feed's `subscribe_changes` owns any reconnect/backoff (an out-of-process
/// dashboards sidecar can restart); this loop just drains the channel and, when it
/// closes, exits — a missed nudge is latency-only (the device re-polls on its own
/// cadence regardless).
pub fn spawn(dashboards: Arc<dyn DashboardFeed>, devices: DeviceStore) {
    tokio::spawn(run(dashboards, devices));
}

async fn run(dashboards: Arc<dyn DashboardFeed>, devices: DeviceStore) {
    let mut rx = dashboards.subscribe_changes().await;
    let mut last_nudge: HashMap<String, Instant> = HashMap::new();
    // Each yielded item is the id of a dashboard whose data/definition changed
    // (only changes warranting a re-poll are emitted by the feed).
    while let Some(dashboard_id) = rx.recv().await {
        if !live::has_connections().await {
            last_nudge.clear();
            continue;
        }
        // Find which device(s) bind this dashboard.
        let bindings = match dashboards.list_bindings().await {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feed::{DeviceBinding, DeviceManifest, RenderedImage, SetDeviceResult};
    use crate::protocol::DeviceType as WireDeviceType;
    use crate::session::live::LiveMeta;
    use crate::session::SessionOutput;
    use serde_json::Value;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::{mpsc, Mutex};

    struct Feed {
        reads: AtomicUsize,
        events: Mutex<Option<mpsc::Receiver<String>>>,
    }

    impl Feed {
        fn with_events(count: usize) -> Arc<Self> {
            let (tx, rx) = mpsc::channel(count.max(1));
            for _ in 0..count {
                tx.try_send("dashboard".to_owned()).unwrap();
            }
            Arc::new(Self {
                reads: AtomicUsize::new(0),
                events: Mutex::new(Some(rx)),
            })
        }
    }

    #[async_trait::async_trait]
    impl DashboardFeed for Feed {
        async fn device_manifest(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &Value,
        ) -> Result<DeviceManifest, String> {
            unreachable!("nudge must not render a device manifest")
        }
        async fn device_image(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &Value,
            _: Option<&str>,
        ) -> Result<Option<RenderedImage>, String> {
            unreachable!("nudge must not render an image")
        }
        async fn device_config(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &Value,
        ) -> Result<Value, String> {
            unreachable!("nudge must not read device config")
        }
        async fn set_device_config(
            &self,
            _: &str,
            _: &str,
            _: Option<u32>,
            _: Option<Value>,
        ) -> Result<SetDeviceResult, String> {
            unreachable!("nudge must not change device config")
        }
        async fn delete_device(&self, _: &str) {
            unreachable!("nudge must not delete devices")
        }
        async fn list_bindings(&self) -> Result<Vec<DeviceBinding>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(vec![DeviceBinding {
                device_id: "nudge-lifetime-test".to_owned(),
                dashboard_id: "dashboard".to_owned(),
            }])
        }
        async fn subscribe_changes(&self) -> mpsc::Receiver<String> {
            self.events.lock().await.take().unwrap()
        }
    }

    fn meta() -> LiveMeta {
        LiveMeta {
            name: "Desk".to_owned(),
            device_type: WireDeviceType::Desk,
            secure: false,
            relay: false,
        }
    }

    #[tokio::test]
    async fn offline_events_skip_bindings_and_connected_devices_still_receive_nudges() {
        let _serial = live::TEST_SERIAL.lock().await;
        let directory = std::env::temp_dir().join(format!("ryu-nudge-{}", uuid::Uuid::new_v4()));
        let devices = DeviceStore::open(directory.join("hardware.db")).unwrap();
        let offline = Feed::with_events(20);
        run(offline.clone(), devices.clone()).await;
        assert_eq!(offline.reads.load(Ordering::SeqCst), 0);

        let (tx, mut rx) = mpsc::channel(4);
        let handle = live::register("nudge-lifetime-test", tx, meta()).await;
        let online = Feed::with_events(3);
        run(online.clone(), devices.clone()).await;
        live::unregister("nudge-lifetime-test", handle.generation).await;
        assert_eq!(online.reads.load(Ordering::SeqCst), 3);
        assert!(matches!(
            rx.recv().await,
            Some(SessionOutput::Control(RhpServerMsg::Display { .. }))
        ));
        assert!(
            rx.recv().await.is_none(),
            "a burst should still be debounced"
        );

        let (tx, rx) = mpsc::channel(1);
        let handle = live::register("nudge-lifetime-test", tx, meta()).await;
        drop(rx);
        let closed = Feed::with_events(20);
        run(closed.clone(), devices.clone()).await;
        live::unregister("nudge-lifetime-test", handle.generation).await;
        assert_eq!(closed.reads.load(Ordering::SeqCst), 0);
        drop(devices);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
