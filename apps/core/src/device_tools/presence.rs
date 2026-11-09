//! The presence lease (design §1.2): whether a paired phone has Ryu in the
//! foreground right now, and the last app declaration it sent. Refreshed by a
//! signed presence POST or a signed chat-request declaration; the foreground
//! lease expires after 90 s, and `foreground:false` (app in the background or
//! screen locked) clears it at once. The declaration outlives the lease so
//! routing (`routing`) knows which apps a phone that is away can run.
//!
//! Every refresh wakes the calls that wait for a device (`waiting-device`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use super::declaration::ClientDeviceDecl;

pub(crate) const LEASE_TTL_MS: i64 = 90_000;

#[derive(Clone, Debug)]
struct Lease {
    foreground: bool,
    expires_at_ms: i64,
    decl: Option<Arc<ClientDeviceDecl>>,
}

type DeviceKey = (String, String);

fn leases() -> &'static Mutex<HashMap<DeviceKey, Lease>> {
    static LEASES: OnceLock<Mutex<HashMap<DeviceKey, Lease>>> = OnceLock::new();
    LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Woken on every lease refresh and device-stream connect.
pub(crate) fn changed() -> &'static tokio::sync::Notify {
    static CHANGED: OnceLock<tokio::sync::Notify> = OnceLock::new();
    CHANGED.get_or_init(tokio::sync::Notify::new)
}

/// Wake every call waiting for a device.
pub(crate) fn notify_changed() {
    changed().notify_waiters();
}

fn store_lease(
    principal_id: &str,
    device_id: &str,
    foreground: bool,
    decl: Option<Arc<ClientDeviceDecl>>,
    now_ms: i64,
) {
    if let Ok(mut map) = leases().lock() {
        let key = (principal_id.to_owned(), device_id.to_owned());
        let decl = decl.or_else(|| map.get(&key).and_then(|lease| lease.decl.clone()));
        map.insert(
            key,
            Lease {
                foreground,
                expires_at_ms: now_ms + LEASE_TTL_MS,
                decl,
            },
        );
    }
    notify_changed();
}

/// Record a presence report without a declaration (tests drive leases
/// directly; production refreshes always carry the validated declaration).
#[cfg(test)]
pub(crate) fn refresh(principal_id: &str, device_id: &str, foreground: bool, now_ms: i64) {
    store_lease(principal_id, device_id, foreground, None, now_ms);
}

/// Record a verified, validated declaration (presence POST or chat request).
pub(crate) fn refresh_with_decl(
    principal_id: &str,
    device_id: &str,
    decl: &ClientDeviceDecl,
    now_ms: i64,
) {
    store_lease(
        principal_id,
        device_id,
        decl.foreground,
        Some(Arc::new(decl.clone())),
        now_ms,
    );
}

/// Whether the device holds a fresh foreground lease.
pub(crate) fn is_foreground(principal_id: &str, device_id: &str, now_ms: i64) -> bool {
    leases()
        .lock()
        .ok()
        .and_then(|map| {
            map.get(&(principal_id.to_owned(), device_id.to_owned()))
                .cloned()
        })
        .is_some_and(|lease| lease.foreground && lease.expires_at_ms > now_ms)
}

/// The last declaration this device sent, even when its lease has expired.
pub(crate) fn declaration(principal_id: &str, device_id: &str) -> Option<Arc<ClientDeviceDecl>> {
    leases()
        .lock()
        .ok()?
        .get(&(principal_id.to_owned(), device_id.to_owned()))?
        .decl
        .clone()
}

/// Drop a forgotten device's lease and declaration.
pub(crate) fn forget(principal_id: &str, device_id: &str) {
    if let Ok(mut map) = leases().lock() {
        map.remove(&(principal_id.to_owned(), device_id.to_owned()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decl(device_id: &str, foreground: bool) -> ClientDeviceDecl {
        serde_json::from_value(serde_json::json!({
            "device_id": device_id, "app": "ryu-bot", "platform": "ios",
            "foreground": foreground, "catalog_version": 1,
            "tools": [{ "app": "calendar", "permission": "granted" }],
        }))
        .unwrap()
    }

    #[test]
    fn lease_expires_and_background_clears_it() {
        refresh("user:p1", "dev-lease", true, 1_000);
        assert!(is_foreground(
            "user:p1",
            "dev-lease",
            1_000 + LEASE_TTL_MS - 1
        ));
        assert!(!is_foreground("user:p1", "dev-lease", 1_000 + LEASE_TTL_MS));
        assert!(!is_foreground("user:p2", "dev-lease", 1_000));
        refresh("user:p1", "dev-lease", false, 2_000);
        assert!(!is_foreground("user:p1", "dev-lease", 2_001));
    }

    #[test]
    fn declaration_outlives_the_lease_and_a_bare_refresh_keeps_it() {
        refresh_with_decl("user:p3", "dev-decl", &decl("dev-decl", true), 1_000);
        refresh("user:p3", "dev-decl", false, 2_000);
        let kept = declaration("user:p3", "dev-decl").expect("kept");
        assert_eq!(kept.tools[0].app, "calendar");
        assert!(!is_foreground("user:p3", "dev-decl", 2_001));
        assert!(declaration("user:p4", "dev-decl").is_none());
        forget("user:p3", "dev-decl");
        assert!(declaration("user:p3", "dev-decl").is_none());
    }

    #[tokio::test]
    async fn a_refresh_wakes_waiters() {
        let notified = changed().notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        refresh("user:p5", "dev-wake", true, 1_000);
        tokio::time::timeout(std::time::Duration::from_secs(1), notified)
            .await
            .expect("woken");
    }
}
