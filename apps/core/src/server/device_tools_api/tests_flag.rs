//! The lane ships dark: every device-lane route is refused while
//! `mobile.device_tools` is off, and on an unbound node a cloud JWT neither
//! skips the host approval of a pairing nor overrides the local preference.

use super::tests::{lane_state, owner_auth, pair_with, signed, signed_get, status_and_json};
use super::*;
use crate::device_tools::identity::DevicePrincipal;
use crate::device_tools::identity_tests::test_key;
use crate::device_tools::registry::DeviceState;
use crate::server::*;

/// Any string: on an unbound node the handlers must not even look at it.
const FOREIGN_JWT: &str = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzb21lb25lLWVsc2UifQ.sig";

#[test]
fn only_a_verified_user_principal_pairs_active() {
    assert_eq!(
        initial_pair_state(&DevicePrincipal::User("u1".into())),
        DeviceState::Active
    );
    assert_eq!(
        initial_pair_state(&DevicePrincipal::LocalOwner),
        DeviceState::Pending
    );
}

#[tokio::test]
async fn pairing_with_the_flag_off_is_refused_and_writes_nothing() {
    let (_directory, state) = lane_state(false).await;
    let (key, spki) = test_key(31);
    let device = uuid::Uuid::new_v4().to_string();
    let (status, body) = pair_with(&state, &device, &key, &spki, &device, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["code"], "admin_blocked");
    let store = crate::device_tools::registry::store().unwrap();
    assert!(store.device("owner:local", &device).unwrap().is_none());
}

#[tokio::test]
async fn presence_claim_and_stream_are_refused_once_the_flag_is_off() {
    let (_directory, state) = lane_state(true).await;
    let (key, spki) = test_key(32);
    let device = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        pair_with(&state, &device, &key, &spki, &device, None)
            .await
            .0,
        StatusCode::OK
    );
    let approved = REQUEST_PEER_IS_LOCAL
        .scope(
            true,
            device_tools_approve_pair(Path(device.clone()), Extension(None), owner_auth()),
        )
        .await;
    assert_eq!(approved.status(), StatusCode::OK);
    state
        .preferences
        .set(crate::device_tools::flag::LOCAL_PREF_KEY, "false")
        .await
        .unwrap();

    let presence = serde_json::to_vec(&json!({
        "device_id": device, "app": "ryu-bot", "platform": "ios", "foreground": true, "catalog_version": 1, "tools": [],
    }))
    .unwrap();
    let (status, body) = status_and_json(
        device_tools_presence(
            State(state.clone()),
            signed(PRESENCE_ROUTE, &device, &presence, &key),
            Extension(None),
            Extension(VerifiedUserJwt(None)),
            owner_auth(),
            presence.into(),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "admin_blocked");
    assert!(!crate::device_tools::presence::is_foreground(
        "owner:local",
        &device,
        crate::device_tools::now_ms()
    ));

    let claim = serde_json::to_vec(
        &json!({ "conversation_id": "c", "tool_call_id": "t", "device_id": device }),
    )
    .unwrap();
    let claimed = device_tools_claim(
        State(state.clone()),
        signed(CLAIM_ROUTE, &device, &claim, &key),
        Extension(None),
        Extension(VerifiedUserJwt(None)),
        owner_auth(),
        claim.into(),
    )
    .await;
    assert_eq!(claimed.status(), StatusCode::FORBIDDEN);

    let stream = device_tools_stream(
        State(state.clone()),
        signed_get(STREAM_ROUTE, &device, &key),
        Extension(None),
        Extension(VerifiedUserJwt(None)),
        owner_auth(),
    )
    .await;
    assert_eq!(stream.status(), StatusCode::FORBIDDEN);
    assert!(!crate::device_tools::device_stream::is_connected(
        "owner:local",
        &device
    ));
}

#[tokio::test]
async fn an_owner_token_with_a_foreign_jwt_still_pairs_pending_on_an_unbound_node() {
    let (_directory, state) = lane_state(true).await;
    let (key, spki) = test_key(33);
    let device = uuid::Uuid::new_v4().to_string();
    let (status, body) = pair_with(&state, &device, &key, &spki, &device, Some(FOREIGN_JWT)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["state"], "pending");
    assert_eq!(body["principal_id"], "owner:local");
}

#[tokio::test]
async fn the_local_preference_decides_for_the_local_owner_whatever_jwt_is_sent() {
    let (_directory, off) = lane_state(false).await;
    assert!(!device_tools_enabled(&off, &DevicePrincipal::LocalOwner, Some(FOREIGN_JWT)).await);
    assert!(!device_tools_enabled(&off, &DevicePrincipal::LocalOwner, None).await);
    let (_directory, on) = lane_state(true).await;
    assert!(device_tools_enabled(&on, &DevicePrincipal::LocalOwner, Some(FOREIGN_JWT)).await);
    // A user principal with no verifiable token is off (fail closed).
    assert!(!device_tools_enabled(&on, &DevicePrincipal::User("u1".into()), None).await);
}
