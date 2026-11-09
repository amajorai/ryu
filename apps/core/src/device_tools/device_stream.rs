//! The per-device stream (design §1.2, P3): how a phone that is not the turn's
//! origin learns about a call routed to it. One subscriber per
//! `(principal, device)`: a new signed connection replaces the old one (its
//! sender is dropped, so the old stream ends), so a second listener can never
//! listen in. Frames are the same id-carrying data parts as the turn stream
//! and never carry a tool input or a nonce; the phone acts by claiming.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use tokio::sync::mpsc;

use super::frames::DeviceUiEvent;

/// Frames buffered for a slow reader before new ones are dropped.
const CAPACITY: usize = 32;

type DeviceKey = (String, String);

struct Slot {
    connection: u64,
    sender: mpsc::Sender<DeviceUiEvent>,
}

fn slots() -> &'static Mutex<HashMap<DeviceKey, Slot>> {
    static SLOTS: OnceLock<Mutex<HashMap<DeviceKey, Slot>>> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_CONNECTION: AtomicU64 = AtomicU64::new(1);

/// Releases the slot when the stream's response body ends, but only if no
/// newer connection replaced it.
pub(crate) struct StreamGuard {
    key: DeviceKey,
    connection: u64,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = slots().lock() {
            if map
                .get(&self.key)
                .is_some_and(|slot| slot.connection == self.connection)
            {
                map.remove(&self.key);
            }
        }
    }
}

/// Open (or replace) this device's stream. Call only after the signed connect
/// verified for an active paired device.
pub(crate) fn connect(
    principal_id: &str,
    device_id: &str,
) -> (mpsc::Receiver<DeviceUiEvent>, StreamGuard) {
    let key = (principal_id.to_owned(), device_id.to_owned());
    let connection = NEXT_CONNECTION.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = mpsc::channel(CAPACITY);
    if let Ok(mut map) = slots().lock() {
        map.insert(key.clone(), Slot { connection, sender });
    }
    super::presence::notify_changed();
    (receiver, StreamGuard { key, connection })
}

/// Whether the device has a live stream.
pub(crate) fn is_connected(principal_id: &str, device_id: &str) -> bool {
    slots().lock().is_ok_and(|map| {
        map.get(&(principal_id.to_owned(), device_id.to_owned()))
            .is_some_and(|slot| !slot.sender.is_closed())
    })
}

/// Send a frame to the device's stream. `false` when it is not connected or
/// its buffer is full.
pub(crate) fn send(principal_id: &str, device_id: &str, event: DeviceUiEvent) -> bool {
    let Ok(map) = slots().lock() else {
        return false;
    };
    map.get(&(principal_id.to_owned(), device_id.to_owned()))
        .is_some_and(|slot| slot.sender.try_send(event).is_ok())
}

/// Close a forgotten device's stream.
pub(crate) fn disconnect(principal_id: &str, device_id: &str) {
    if let Ok(mut map) = slots().lock() {
        map.remove(&(principal_id.to_owned(), device_id.to_owned()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_tools::frames::{status_frame, DeviceStatus};

    fn frame() -> DeviceUiEvent {
        status_frame("call-1", DeviceStatus::WaitingDevice)
    }

    #[tokio::test]
    async fn one_subscriber_per_device_and_a_new_connect_replaces_the_old() {
        let (mut first, first_guard) = connect("user:s1", "dev-s1");
        assert!(is_connected("user:s1", "dev-s1"));
        assert!(send("user:s1", "dev-s1", frame()));
        assert_eq!(first.recv().await, Some(frame()));

        let (mut second, _second_guard) = connect("user:s1", "dev-s1");
        assert_eq!(first.recv().await, None, "the old listener is cut off");
        assert!(send("user:s1", "dev-s1", frame()));
        assert_eq!(second.recv().await, Some(frame()));

        // The replaced connection's guard must not tear down the new one.
        drop(first_guard);
        assert!(is_connected("user:s1", "dev-s1"));
        assert!(!send("user:s2", "dev-s1", frame()), "another principal");
        disconnect("user:s1", "dev-s1");
        assert!(!is_connected("user:s1", "dev-s1"));
    }

    #[test]
    fn dropping_the_guard_releases_the_slot() {
        let (receiver, guard) = connect("user:s3", "dev-s3");
        drop(guard);
        assert!(!is_connected("user:s3", "dev-s3"));
        drop(receiver);
        assert!(!send("user:s3", "dev-s3", frame()));
    }
}
