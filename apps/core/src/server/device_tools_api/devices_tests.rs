//! `/api/device-tools/devices[/:device_id]` lists, patches and forgets only
//! the caller's own devices, driven through the handlers.

use super::devices::{
    device_tools_devices, device_tools_forget_device, device_tools_patch_device, DevicePatch,
};
use super::tests::{owner_auth, status_and_json};
use crate::device_tools::registry::{DeviceState, NewDevice};
use crate::server::*;

const OWNER: &str = "owner:local";
const OTHER: &str = "user:someone-else";

/// Pair a device row directly in the process store and return its id.
fn seed_device(principal_id: &str, label: &str, state: DeviceState) -> String {
    let device_id = uuid::Uuid::new_v4().to_string();
    seed_keyed_device(principal_id, &device_id, device_id.as_bytes(), label, state);
    device_id
}

/// Pair `device_id` with the exact `public_key` bytes.
fn seed_keyed_device(
    principal_id: &str,
    device_id: &str,
    public_key: &[u8],
    label: &str,
    state: DeviceState,
) {
    let store = crate::device_tools::registry::store().expect("device store");
    store
        .pair(
            &NewDevice {
                principal_id,
                device_id,
                public_key,
                app: "ryu-bot",
                platform: "ios",
                label,
                attestation: None,
                initial_state: state,
            },
            crate::device_tools::now_ms(),
        )
        .expect("pair");
}

fn patch(body: Value) -> Json<DevicePatch> {
    Json(serde_json::from_value(body).expect("device patch"))
}

async fn list() -> (StatusCode, Value) {
    status_and_json(device_tools_devices(Extension(None), owner_auth()).await).await
}

fn listed<'a>(body: &'a Value, device_id: &str) -> Option<&'a Value> {
    body["devices"]
        .as_array()?
        .iter()
        .find(|row| row["device_id"] == device_id)
}

#[tokio::test]
async fn the_list_holds_the_callers_devices_and_their_grants_only() {
    let mine = seed_device(OWNER, "Alex's iPhone", DeviceState::Active);
    let pending = seed_device(OWNER, "Spare phone", DeviceState::Pending);
    let theirs = seed_device(OTHER, "Not yours", DeviceState::Active);
    let store = crate::device_tools::registry::store().unwrap();
    store
        .grant(OWNER, &mine, "device.calendar.search", 1)
        .unwrap();

    let (status, body) = list().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["principal_id"], OWNER);
    let row = listed(&body, &mine).expect("own device listed");
    assert_eq!(row["label"], "Alex's iPhone");
    assert_eq!(row["state"], "active");
    assert_eq!(row["app"], "ryu-bot");
    assert_eq!(row["platform"], "ios");
    assert_eq!(row["foreground"], false);
    assert_eq!(row["always_allowed"], json!(["device.calendar.search"]));
    assert_eq!(
        listed(&body, &pending).expect("pending listed")["state"],
        "pending"
    );
    assert!(
        listed(&body, &theirs).is_none(),
        "another principal's device never appears"
    );
}

#[tokio::test]
async fn every_listed_device_carries_the_check_code_of_its_stored_key() {
    // The shared golden vector: this id with a 91-byte all-zero SPKI.
    let golden = "00000000-0000-4000-8000-000000000001";
    seed_keyed_device(OWNER, golden, &[0u8; 91], "Golden", DeviceState::Pending);
    let active = seed_device(OWNER, "Active phone", DeviceState::Active);
    let (status, body) = list().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let pending_row = listed(&body, golden).expect("pending pairing listed");
    assert_eq!(pending_row["state"], "pending");
    assert_eq!(pending_row["check_code"], "ZDX-MJ5");
    assert_eq!(
        listed(&body, &active).expect("active listed")["check_code"],
        crate::device_tools::check_code::check_code(&active, active.as_bytes())
    );
}

#[tokio::test]
async fn patch_renames_and_revokes_on_the_callers_device() {
    let device = seed_device(OWNER, "Old name", DeviceState::Active);
    let store = crate::device_tools::registry::store().unwrap();
    store
        .grant(OWNER, &device, "device.calendar.search", 1)
        .unwrap();
    store
        .grant(OWNER, &device, "device.contacts.search", 1)
        .unwrap();

    let (status, body) = status_and_json(
        device_tools_patch_device(
            Path(format!(" {device} ")),
            Extension(None),
            owner_auth(),
            patch(json!({ "label": "  New name  ", "revoke": ["device_calendar_search"] })),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["device_id"], device.as_str());
    assert_eq!(body["always_allowed"], json!(["device.contacts.search"]));
    assert!(!store.has_grant(OWNER, &device, "device.calendar.search"));
    let row = store.device(OWNER, &device).unwrap().expect("row");
    assert_eq!(row.label, "New name");
}

#[tokio::test]
async fn patch_refuses_unknown_tools_and_devices_it_does_not_own() {
    let device = seed_device(OWNER, "Mine", DeviceState::Active);
    let (status, body) = status_and_json(
        device_tools_patch_device(
            Path(device.clone()),
            Extension(None),
            owner_auth(),
            patch(json!({ "revoke": ["not_a_device_tool"] })),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "invalid_input");

    let theirs = seed_device(OTHER, "Not yours", DeviceState::Active);
    let (status, body) = status_and_json(
        device_tools_patch_device(
            Path(theirs.clone()),
            Extension(None),
            owner_auth(),
            patch(json!({ "label": "Hijacked" })),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "not_found");
    let store = crate::device_tools::registry::store().unwrap();
    assert_eq!(
        store.device(OTHER, &theirs).unwrap().expect("row").label,
        "Not yours"
    );
}

#[tokio::test]
async fn forget_removes_only_the_callers_device() {
    let store = crate::device_tools::registry::store().unwrap();
    let theirs = seed_device(OTHER, "Not yours", DeviceState::Active);
    let forget =
        |device: String| device_tools_forget_device(Path(device), Extension(None), owner_auth());
    let (status, _) = status_and_json(forget(theirs.clone()).await).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(store.device(OTHER, &theirs).unwrap().is_some());

    let mine = seed_device(OWNER, "Mine", DeviceState::Active);
    let (status, body) = status_and_json(forget(mine.clone()).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["forgotten"], true);
    assert!(store.device(OWNER, &mine).unwrap().is_none());
    let (_, listing) = list().await;
    assert!(listed(&listing, &mine).is_none());

    let (status, _) = status_and_json(forget(mine).await).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "forgetting twice is a 404");
}

#[tokio::test]
async fn credentials_outside_the_device_lane_are_refused() {
    let (status, body) = status_and_json(device_tools_devices(Extension(None), None).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "device_not_paired");
}
