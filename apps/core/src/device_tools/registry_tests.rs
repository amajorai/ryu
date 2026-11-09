use super::registry::{DeviceState, DeviceToolStore, NewDevice};

fn new_device<'a>(key: &'a [u8], state: DeviceState) -> NewDevice<'a> {
    NewDevice {
        principal_id: "owner:local",
        device_id: "dev-a",
        public_key: key,
        app: "ryu-bot",
        platform: "ios",
        label: "Alex's iPhone",
        attestation: None,
        initial_state: state,
    }
}

#[test]
fn pending_pairing_is_inactive_until_host_approval() {
    let store = DeviceToolStore::open_in_memory().unwrap();
    assert_eq!(
        store
            .pair(&new_device(b"key-1", DeviceState::Pending), 10)
            .unwrap(),
        DeviceState::Pending
    );
    assert!(store.active_key("owner:local", "dev-a").is_none());
    assert!(!store.has_active_device());
    assert!(store.approve("owner:local", "dev-a").unwrap());
    assert_eq!(
        store.active_key("owner:local", "dev-a").as_deref(),
        Some(&b"key-1"[..])
    );
    assert!(
        !store.approve("owner:local", "dev-a").unwrap(),
        "already active"
    );
    // Re-pairing with the same key keeps it active.
    assert_eq!(
        store
            .pair(&new_device(b"key-1", DeviceState::Pending), 20)
            .unwrap(),
        DeviceState::Active
    );
    // Another principal never sees the row.
    assert!(store.active_key("user:u1", "dev-a").is_none());
}

#[test]
fn a_new_key_drops_grants_and_resets_trust() {
    let store = DeviceToolStore::open_in_memory().unwrap();
    store
        .pair(&new_device(b"key-1", DeviceState::Active), 10)
        .unwrap();
    store
        .grant("owner:local", "dev-a", "device.calendar.search", 11)
        .unwrap();
    assert!(store.has_grant("owner:local", "dev-a", "device.calendar.search"));
    assert!(
        !store.has_grant("owner:local", "dev-a", "device.calendar.create"),
        "grants are per canonical tool"
    );
    assert_eq!(
        store
            .pair(&new_device(b"key-2", DeviceState::Pending), 12)
            .unwrap(),
        DeviceState::Pending
    );
    assert!(!store.has_grant("owner:local", "dev-a", "device.calendar.search"));
    assert!(store.active_key("owner:local", "dev-a").is_none());
}

#[test]
fn quotas_count_per_tool_and_forget_removes_everything() {
    let store = DeviceToolStore::open_in_memory().unwrap();
    store
        .pair(&new_device(b"key-1", DeviceState::Active), 10)
        .unwrap();
    store.record_use(
        "owner:local",
        "dev-a",
        "c1",
        "device.contacts.search",
        3,
        1_000,
    );
    store.record_use(
        "owner:local",
        "dev-a",
        "c1",
        "device.contacts.search",
        4,
        2_000,
    );
    store.record_use(
        "owner:local",
        "dev-a",
        "c1",
        "device.location.current",
        1,
        2_000,
    );
    assert_eq!(
        store.usage_since("owner:local", "dev-a", "device.contacts.search", 0),
        (2, 7)
    );
    assert_eq!(
        store.usage_since("owner:local", "dev-a", "device.contacts.search", 1_500),
        (1, 4)
    );
    store
        .grant("owner:local", "dev-a", "device.timer.set", 11)
        .unwrap();
    assert!(store
        .revoke_grant("owner:local", "dev-a", "device.timer.set")
        .unwrap());
    store
        .grant("owner:local", "dev-a", "device.timer.set", 11)
        .unwrap();
    assert!(store.forget("owner:local", "dev-a").unwrap());
    assert!(store.device("owner:local", "dev-a").unwrap().is_none());
    assert!(store.grants("owner:local", "dev-a").unwrap().is_empty());
    assert_eq!(
        store.usage_since("owner:local", "dev-a", "device.contacts.search", 0),
        (0, 0)
    );
}
