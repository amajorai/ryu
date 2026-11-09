//! `/api/device-tools/*` admission and the catalog, host approval and pairing
//! input checks, driven through the handlers in `routes`.

use super::routes::{
    device_tools_approve_pair, device_tools_catalog, device_tools_pair, parse_body,
    require_enabled, PAIR_ROUTE,
};
use super::tests::{lane_state, owner_auth, signed, status_and_json};
use crate::device_tools::identity::DevicePrincipal;
use crate::device_tools::identity_tests::test_key;
use crate::server::*;

async fn catalog_for(
    state: &ServerState,
    auth: Option<Extension<ResolvedAuthorization>>,
) -> (StatusCode, Value) {
    status_and_json(
        device_tools_catalog(
            State(state.clone()),
            Extension(None),
            Extension(VerifiedUserJwt(None)),
            auth,
        )
        .await,
    )
    .await
}

#[tokio::test]
async fn the_catalog_reports_the_flag_the_principal_and_the_closed_tool_list() {
    let (_directory, on) = lane_state(true).await;
    let (status, body) = catalog_for(&on, owner_auth()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["enabled"], true);
    assert_eq!(body["principal_id"], "owner:local");
    assert_eq!(body["catalog"]["version"], 1);
    let tools = body["catalog"]["tools"].as_array().expect("tools");
    assert!(tools
        .iter()
        .any(|tool| tool["id"] == "device.calendar.search"));
    assert_eq!(
        body["caps"],
        crate::device_tools::caps::DeviceToolCaps::none().to_json(),
        "a personal node has no caps"
    );

    // The catalog stays readable while the lane is dark, and says so.
    let (_directory, off) = lane_state(false).await;
    let (status, body) = catalog_for(&off, owner_auth()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"], false);

    let (status, body) = catalog_for(&on, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "device_not_paired");
}

#[tokio::test]
async fn require_enabled_refuses_with_admin_blocked_while_the_lane_is_dark() {
    let (_directory, on) = lane_state(true).await;
    assert!(require_enabled(&on, &DevicePrincipal::LocalOwner, None)
        .await
        .is_ok());

    let (_directory, off) = lane_state(false).await;
    let refused = require_enabled(&off, &DevicePrincipal::LocalOwner, None)
        .await
        .expect_err("flag off");
    let (status, body) = status_and_json(refused).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "admin_blocked");

    // A user principal without a verifiable token fails closed.
    let refused = require_enabled(&on, &DevicePrincipal::User("u1".into()), None)
        .await
        .expect_err("no token");
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn host_approval_is_local_only_and_never_invents_a_device() {
    let unknown = uuid::Uuid::new_v4().to_string();
    let approve = |local: bool| {
        REQUEST_PEER_IS_LOCAL.scope(
            local,
            device_tools_approve_pair(Path(unknown.clone()), Extension(None), owner_auth()),
        )
    };
    let (status, body) = status_and_json(approve(false).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "device_not_paired");
    let (status, body) = status_and_json(approve(true).await).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "not_found");
}

#[tokio::test]
async fn pairing_refuses_unknown_apps_platforms_and_a_reused_confirmation_key() {
    let (_directory, state) = lane_state(true).await;
    let (key, spki) = test_key(71);
    let store = crate::device_tools::registry::store().expect("device store");
    for (app, platform, confirm) in [
        ("desktop", "ios", None),
        ("ryu-bot", "windows", None),
        ("ryu-bot", "ios", Some(spki.as_str())),
        ("ryu-bot", "ios", Some("not-a-key")),
    ] {
        let device = uuid::Uuid::new_v4().to_string();
        let mut request = json!({
            "device_id": &device, "app": app, "platform": platform, "public_key_spki": &spki,
        });
        if let Some(confirm) = confirm {
            request["confirm_public_key_spki"] = json!(confirm);
        }
        let body = serde_json::to_vec(&request).unwrap();
        let (status, json) = status_and_json(
            device_tools_pair(
                State(state.clone()),
                signed(PAIR_ROUTE, &device, &body, &key),
                Extension(None),
                Extension(VerifiedUserJwt(None)),
                owner_auth(),
                body.into(),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{request}");
        assert_eq!(json["code"], "invalid_input", "{request}");
        assert!(
            store.device("owner:local", &device).unwrap().is_none(),
            "a refused pairing writes nothing"
        );
    }
}

#[test]
fn bodies_that_are_not_json_are_invalid_input() {
    let parsed: Value = parse_body(br#"{"device_id":"d"}"#).expect("json body");
    assert_eq!(parsed["device_id"], "d");
    let refused = parse_body::<Value>(b"not json").expect_err("not json");
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
}
