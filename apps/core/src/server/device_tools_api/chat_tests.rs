//! The chat-stream half of the device lane: stamping the per-turn offer, the
//! device lane of `POST /api/chat/client-tool-result` and device prompts on
//! `POST /api/chat/permission`, driven through the real functions.

use super::chat::{
    is_device_result, resolve_device_result, stamp_device_offer, OfferRequest, CHAT_STREAM_ROUTE,
    RESULT_ROUTE,
};
use super::tests::{lane_state, owner_auth, signed, status_and_json};
use crate::device_tools::claims::{self, CallEvent, ClaimPhase, ClaimRequest, DeviceCallSpec};
use crate::device_tools::identity::{decode_public_key, DevicePrincipal};
use crate::device_tools::identity_tests::test_key;
use crate::device_tools::registry::{DeviceState, NewDevice};
use crate::server::*;
use axum::response::Response;

const OWNER: &str = "owner:local";

fn owner() -> ResolvedAuthorization {
    owner_auth().expect("owner auth").0
}

/// An ACTIVE device of the local owner, keyed by `test_key(seed)`.
fn active_device(seed: u8) -> (String, p256::ecdsa::SigningKey) {
    let (key, spki) = test_key(seed);
    let public_key = decode_public_key(&spki).expect("spki");
    let device_id = uuid::Uuid::new_v4().to_string();
    crate::device_tools::registry::store()
        .expect("device store")
        .pair(
            &NewDevice {
                principal_id: OWNER,
                device_id: &device_id,
                public_key: &public_key,
                app: "ryu-bot",
                platform: "ios",
                label: "Phone",
                attestation: None,
                initial_state: DeviceState::Active,
            },
            crate::device_tools::now_ms(),
        )
        .expect("pair");
    (device_id, key)
}

fn decl(device: &str, foreground: bool) -> Value {
    json!({
        "device_id": device, "app": "ryu-bot", "platform": "ios", "foreground": foreground,
        "catalog_version": 1, "tools": [{ "app": "calendar", "permission": "granted" }],
    })
}

fn chat_request(extra: Value) -> ChatStreamRequest {
    let mut body = json!({ "conversation_id": uuid::Uuid::new_v4().to_string(), "messages": [] });
    if let (Some(target), Some(fields)) = (body.as_object_mut(), extra.as_object()) {
        for (key, value) in fields {
            target.insert(key.clone(), value.clone());
        }
    }
    serde_json::from_value(body).expect("chat request")
}

/// A fresh request body, so no two signatures in a test collide.
fn unique_body() -> Vec<u8> {
    serde_json::to_vec(&json!({ "nonce": uuid::Uuid::new_v4().to_string() })).unwrap()
}

async fn stamp(
    state: &ServerState,
    headers: &axum::http::HeaderMap,
    body: &[u8],
    auth: Option<&ResolvedAuthorization>,
    req: &mut ChatStreamRequest,
) -> Result<(), Response> {
    stamp_device_offer(
        state,
        OfferRequest {
            headers,
            body,
            auth,
            caller: None,
            user_jwt: None,
        },
        req,
    )
    .await
}

#[tokio::test]
async fn ineligible_turns_offer_nothing_and_drop_the_declaration() {
    let (_directory, state) = lane_state(true).await;
    let auth = owner();
    let headers = axum::http::HeaderMap::new();
    let device = uuid::Uuid::new_v4().to_string();

    let mut no_decl = chat_request(json!({ "device_tools_consent": true }));
    assert!(stamp(&state, &headers, b"", Some(&auth), &mut no_decl)
        .await
        .is_ok());
    assert!(no_decl.device.device_tools_offer.is_none());

    for extra in [
        json!({ "client_device": decl(&device, true), "device_tools_consent": false }),
        json!({ "client_device": decl(&device, true), "device_tools_consent": true, "persist": false }),
        json!({ "client_device": decl(&device, true), "device_tools_consent": true, "team_id": "t" }),
    ] {
        let mut req = chat_request(extra.clone());
        assert!(
            stamp(&state, &headers, b"", Some(&auth), &mut req)
                .await
                .is_ok(),
            "{extra}"
        );
        assert!(req.device.device_tools_offer.is_none(), "{extra}");
        assert!(
            req.device.client_device.is_none(),
            "the declaration is consumed"
        );
    }

    // No device principal (no authorization at all): nothing, no refusal.
    let mut req =
        chat_request(json!({ "client_device": decl(&device, true), "device_tools_consent": true }));
    assert!(stamp(&state, &headers, b"", None, &mut req).await.is_ok());
    assert!(req.device.device_tools_offer.is_none());
}

#[tokio::test]
async fn the_flag_off_offers_nothing_even_for_an_unsigned_declaration() {
    let (_directory, state) = lane_state(false).await;
    let device = uuid::Uuid::new_v4().to_string();
    let mut req =
        chat_request(json!({ "client_device": decl(&device, true), "device_tools_consent": true }));
    let outcome = stamp(
        &state,
        &axum::http::HeaderMap::new(),
        b"",
        Some(&owner()),
        &mut req,
    )
    .await;
    assert!(outcome.is_ok());
    assert!(req.device.device_tools_offer.is_none());
}

#[tokio::test]
async fn an_unsigned_or_mismatched_declaration_is_refused() {
    let (_directory, state) = lane_state(true).await;
    let auth = owner();
    let (device, key) = active_device(61);

    let mut unsigned =
        chat_request(json!({ "client_device": decl(&device, true), "device_tools_consent": true }));
    let refused = stamp(
        &state,
        &axum::http::HeaderMap::new(),
        b"",
        Some(&auth),
        &mut unsigned,
    )
    .await
    .expect_err("unsigned declaration");
    let (status, body) = status_and_json(refused).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "invalid_signature");
    assert!(unsigned.device.device_tools_offer.is_none());

    // Signed by this device, but the body declares another one.
    let other = uuid::Uuid::new_v4().to_string();
    let mut mismatched =
        chat_request(json!({ "client_device": decl(&other, true), "device_tools_consent": true }));
    let body = unique_body();
    let refused = stamp(
        &state,
        &signed(CHAT_STREAM_ROUTE, &device, &body, &key),
        &body,
        Some(&auth),
        &mut mismatched,
    )
    .await
    .expect_err("mismatched declaration");
    let (status, body) = status_and_json(refused).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "invalid_signature");

    // A signature over another route does not verify.
    let mut wrong_route =
        chat_request(json!({ "client_device": decl(&device, true), "device_tools_consent": true }));
    let body = unique_body();
    let refused = stamp(
        &state,
        &signed(RESULT_ROUTE, &device, &body, &key),
        &body,
        Some(&auth),
        &mut wrong_route,
    )
    .await
    .expect_err("wrong route");
    assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);
    assert!(wrong_route.device.device_tools_offer.is_none());
}

#[tokio::test]
async fn a_chat_that_is_not_the_callers_own_or_a_background_phone_offers_nothing() {
    let (_directory, state) = lane_state(true).await;
    let auth = owner();
    let (device, key) = active_device(62);

    let foreign = uuid::Uuid::new_v4().to_string();
    state
        .conversations
        .ensure_conversation(
            &foreign,
            None,
            None,
            crate::server::conversations::Tenancy::Owned {
                user_id: "someone-else".into(),
                org_id: None,
            },
        )
        .await
        .unwrap();
    let mut req = chat_request(json!({
        "conversation_id": foreign, "client_device": decl(&device, true), "device_tools_consent": true,
    }));
    let body = unique_body();
    let outcome = stamp(
        &state,
        &signed(CHAT_STREAM_ROUTE, &device, &body, &key),
        &body,
        Some(&auth),
        &mut req,
    )
    .await;
    assert!(outcome.is_ok());
    assert!(
        req.device.device_tools_offer.is_none(),
        "another user's chat"
    );
    assert!(
        crate::device_tools::presence::is_foreground(OWNER, &device, crate::device_tools::now_ms()),
        "the signed declaration still refreshed the lease"
    );

    let mut background = chat_request(
        json!({ "client_device": decl(&device, false), "device_tools_consent": true }),
    );
    let body = unique_body();
    let outcome = stamp(
        &state,
        &signed(CHAT_STREAM_ROUTE, &device, &body, &key),
        &body,
        Some(&auth),
        &mut background,
    )
    .await;
    assert!(outcome.is_ok());
    assert!(background.device.device_tools_offer.is_none());
}

#[tokio::test]
async fn the_callers_own_new_chat_is_offered_the_declared_apps() {
    let (_directory, state) = lane_state(true).await;
    let (device, key) = active_device(63);
    let conversation_id = uuid::Uuid::new_v4().to_string();
    let mut req = chat_request(json!({
        "conversation_id": &conversation_id, "client_device": decl(&device, true), "device_tools_consent": true,
    }));
    let body = unique_body();
    let outcome = stamp(
        &state,
        &signed(CHAT_STREAM_ROUTE, &device, &body, &key),
        &body,
        Some(&owner()),
        &mut req,
    )
    .await;
    assert!(outcome.is_ok());
    let offer = req.device.device_tools_offer.clone().expect("offer");
    assert_eq!(offer.conversation_id, conversation_id);
    assert_eq!(offer.principal, DevicePrincipal::LocalOwner);
    assert_eq!(offer.origin.device_id, device);
    assert!(
        offer.offers("device.calendar.search"),
        "{:?}",
        offer.offerable
    );
    assert!(
        matches!(
            state.conversations.get_access_meta(&conversation_id).await,
            Ok(Some(_))
        ),
        "the new conversation row was created for the caller"
    );
}

fn result_body(
    conversation_id: &str,
    tool_call_id: &str,
    claim_id: &str,
    input_sha256: &str,
    source: &str,
    device: &str,
    result: Value,
) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "conversation_id": conversation_id, "tool_call_id": tool_call_id, "claim_id": claim_id,
        "input_sha256": input_sha256,
        "provenance": { "source": source, "device_id": device },
        "result": result,
    }))
    .unwrap()
}

#[tokio::test]
async fn a_device_result_is_bound_to_the_claim_the_hash_and_the_device() {
    let auth = owner();
    let (device, key) = active_device(64);
    let conversation_id = uuid::Uuid::new_v4().to_string();
    let tool_call_id = format!("call-{}", uuid::Uuid::new_v4());
    let now = crate::device_tools::now_ms();
    assert!(!is_device_result(&conversation_id, &tool_call_id));
    let (mut events, _cleanup) = claims::register(
        DeviceCallSpec {
            conversation_id: conversation_id.clone(),
            tool_call_id: tool_call_id.clone(),
            owner_principal_id: OWNER.to_owned(),
            target_device_id: device.clone(),
            tool: "device.calendar.search".to_owned(),
            input: json!({ "query": "dentist" }),
            input_sha256: "frozen-hash".to_owned(),
            awaiting_permission: false,
            security_confirmed: false,
        },
        now,
    )
    .expect("register call");
    assert!(is_device_result(&conversation_id, &tool_call_id));
    let grant = claims::claim(&ClaimRequest {
        conversation_id: &conversation_id,
        tool_call_id: &tool_call_id,
        principal_id: OWNER,
        device_id: &device,
        phase: ClaimPhase::Execute,
        foreground: true,
        now_ms: now,
    })
    .expect("claim");
    assert!(matches!(
        events.try_recv(),
        Ok(CallEvent::Claimed {
            phase: ClaimPhase::Execute,
            ..
        })
    ));
    let submit = |body: &[u8], auth: Option<&ResolvedAuthorization>| {
        resolve_device_result(&signed(RESULT_ROUTE, &device, body, &key), body, auth, None)
    };
    let ok = json!({ "ok": true, "events": [] });
    let claim_id = grant.claim_id.as_str();

    let body = result_body(
        &conversation_id,
        &tool_call_id,
        claim_id,
        "frozen-hash",
        "ryu-device",
        &device,
        ok.clone(),
    );
    let (status, json) = status_and_json(submit(&body, None)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(json["code"], "device_not_paired");

    let unsigned = resolve_device_result(&axum::http::HeaderMap::new(), &body, Some(&auth), None);
    assert_eq!(unsigned.status(), StatusCode::UNAUTHORIZED);

    let forged = result_body(
        &conversation_id,
        &tool_call_id,
        claim_id,
        "frozen-hash",
        "somewhere-else",
        &device,
        ok.clone(),
    );
    let (status, json) = status_and_json(submit(&forged, Some(&auth))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json["code"], "invalid_signature");

    let changed = result_body(
        &conversation_id,
        &tool_call_id,
        claim_id,
        "other-hash",
        "ryu-device",
        &device,
        ok.clone(),
    );
    let (status, json) = status_and_json(submit(&changed, Some(&auth))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(json["code"], "input_mismatch");
    assert!(
        is_device_result(&conversation_id, &tool_call_id),
        "a refusal keeps the call"
    );

    let wrong_claim = result_body(
        &conversation_id,
        &tool_call_id,
        "not-the-claim",
        "frozen-hash",
        "ryu-device",
        &device,
        ok.clone(),
    );
    assert_eq!(
        submit(&wrong_claim, Some(&auth)).status(),
        StatusCode::NOT_FOUND
    );

    let (status, json) = status_and_json(submit(&body, Some(&auth))).await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["ok"], true);
    assert_eq!(events.try_recv().ok(), Some(CallEvent::Result(ok)));
    assert!(
        !is_device_result(&conversation_id, &tool_call_id),
        "single use"
    );

    let again = result_body(
        &conversation_id,
        &tool_call_id,
        claim_id,
        "frozen-hash",
        "ryu-device",
        &device,
        json!({ "ok": false }),
    );
    assert_eq!(submit(&again, Some(&auth)).status(), StatusCode::NOT_FOUND);
}
