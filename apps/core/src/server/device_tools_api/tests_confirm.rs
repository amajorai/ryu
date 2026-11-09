//! P6 routes: pairing with a user-presence key, the signed Home accessory
//! cache and on-device confirmation.

use super::tests::{lane_state, owner_auth, signed, status_and_json};
use super::*;
use crate::device_tools::confirm::confirm_message;
use crate::device_tools::identity_tests::{sign_b64, test_key};
use crate::device_tools::prompts::{self, OnDeviceBinding, PromptAnswer};
use crate::server::*;

/// Pair `device` as the local owner with an optional confirmation key, then
/// approve it on the host.
async fn pair_active(
    state: &ServerState,
    device: &str,
    key: &p256::ecdsa::SigningKey,
    spki: &str,
    confirm_spki: Option<&str>,
) -> (StatusCode, Value) {
    let mut body = json!({
        "device_id": device, "app": "ryu-bot", "platform": "ios", "label": "Phone",
        "public_key_spki": spki,
    });
    if let Some(confirm) = confirm_spki {
        body["confirm_public_key_spki"] = json!(confirm);
    }
    let body = serde_json::to_vec(&body).unwrap();
    let paired = status_and_json(
        device_tools_pair(
            State(state.clone()),
            signed(PAIR_ROUTE, device, &body, key),
            Extension(None),
            Extension(VerifiedUserJwt(None)),
            owner_auth(),
            body.into(),
        )
        .await,
    )
    .await;
    if paired.0 == StatusCode::OK && paired.1["state"] == "pending" {
        let approved = REQUEST_PEER_IS_LOCAL
            .scope(
                true,
                device_tools_approve_pair(Path(device.to_owned()), Extension(None), owner_auth()),
            )
            .await;
        assert_eq!(approved.status(), StatusCode::OK);
    }
    paired
}

async fn post_confirm(
    state: &ServerState,
    device: &str,
    key: &p256::ecdsa::SigningKey,
    body: &Value,
) -> (StatusCode, Value) {
    let body = serde_json::to_vec(body).unwrap();
    status_and_json(
        device_tools_confirm(
            State(state.clone()),
            signed(CONFIRM_ROUTE, device, &body, key),
            Extension(None),
            Extension(VerifiedUserJwt(None)),
            owner_auth(),
            body.into(),
        )
        .await,
    )
    .await
}

#[tokio::test]
async fn pairing_records_a_distinct_confirmation_key() {
    let (_directory, state) = lane_state(true).await;
    let (key, spki) = test_key(51);
    let device = uuid::Uuid::new_v4().to_string();
    let (status, _) = pair_active(&state, &device, &key, &spki, Some(&spki)).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "the signing key cannot double as it"
    );
    let (_confirm, confirm_spki) = test_key(52);
    let (status, body) = pair_active(&state, &device, &key, &spki, Some(&confirm_spki)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["confirmations"], true);
    let store = crate::device_tools::registry::store().unwrap();
    assert!(store.confirm_key("owner:local", &device).is_some());
    // Re-pairing without one clears it.
    let (status, body) = pair_active(&state, &device, &key, &spki, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["confirmations"], false);
    assert!(store.confirm_key("owner:local", &device).is_none());
}

#[tokio::test]
async fn the_home_cache_is_signed_and_replaces_the_snapshot() {
    let (_directory, state) = lane_state(true).await;
    let (key, spki) = test_key(53);
    let device = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        pair_active(&state, &device, &key, &spki, None).await.0,
        StatusCode::OK
    );
    let post = |headers, body: Vec<u8>| {
        device_tools_home_accessories(
            State(state.clone()),
            headers,
            Extension(None),
            Extension(VerifiedUserJwt(None)),
            owner_auth(),
            body.into(),
        )
    };
    let body = serde_json::to_vec(&json!({
        "device_id": device,
        "accessories": [{ "accessory_id": "lamp", "name": "Desk lamp", "services": ["Lightbulb"] }],
    }))
    .unwrap();
    let (status, _) = status_and_json(post(axum::http::HeaderMap::new(), body.clone()).await).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "unsigned");
    let (status, json) = status_and_json(
        post(
            signed(HOME_ACCESSORIES_ROUTE, &device, &body, &key),
            body.clone(),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["accessories"], 1);
    let store = crate::device_tools::registry::store().unwrap();
    let lamp =
        crate::device_tools::home::classify(&store, "owner:local", &device, "lamp", now_ms());
    assert!(!lamp.security_class);
    let other = uuid::Uuid::new_v4().to_string();
    let mismatch = serde_json::to_vec(&json!({ "device_id": other, "accessories": [] })).unwrap();
    let (status, _) = status_and_json(
        post(
            signed(HOME_ACCESSORIES_ROUTE, &device, &mismatch, &key),
            mismatch,
        )
        .await,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "body device must be the signer"
    );
}

fn now_ms() -> i64 {
    crate::device_tools::now_ms()
}

#[tokio::test]
async fn only_the_target_phone_with_its_presence_key_approves() {
    let (_directory, state) = lane_state(true).await;
    let (key, spki) = test_key(54);
    let (confirm_key, confirm_spki) = test_key(55);
    let device = uuid::Uuid::new_v4().to_string();
    let (status, _) = pair_active(&state, &device, &key, &spki, Some(&confirm_spki)).await;
    assert_eq!(status, StatusCode::OK);
    let (request_id, answer) = prompts::register_on_device(
        "conv-confirm",
        "owner:local",
        OnDeviceBinding {
            target_device_id: device.clone(),
            input_sha256: "hash-1".into(),
        },
    );
    let body = |option: &str, sig: Option<String>, hash: &str| {
        let ts = now_ms();
        json!({
            "device_id": device, "request_id": request_id, "option_id": option,
            "input_sha256": hash, "confirmed_at_ms": ts,
            "confirm_signature": sig.unwrap_or_else(|| sign_b64(
                &confirm_key, &confirm_message(&request_id, hash, option, ts))),
        })
    };
    let (status, _) = post_confirm(
        &state,
        &device,
        &key,
        &json!({ "device_id": device, "request_id": "perm-dev-unknown", "option_id": "allow_once",
                 "input_sha256": "hash-1" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let forged = sign_b64(&key, "not the confirmation string");
    let (status, _) = post_confirm(
        &state,
        &device,
        &key,
        &body("allow_once", Some(forged), "hash-1"),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "the device key alone cannot approve"
    );
    let (status, _) =
        post_confirm(&state, &device, &key, &body("allow_once", None, "hash-2")).await;
    assert_eq!(status, StatusCode::CONFLICT, "bound to the frozen input");
    let (status, json) =
        post_confirm(&state, &device, &key, &body("allow_once", None, "hash-1")).await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["decision"], "allow_once");
    assert_eq!(answer.await.unwrap(), PromptAnswer::AllowOnce);
    // A fresh millisecond, so this is a new request rather than a replay.
    tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    let (status, _) =
        post_confirm(&state, &device, &key, &body("allow_once", None, "hash-1")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "single use");
}
