//! Device-lane admission and the signed pairing / presence / claim routes,
//! driven through the handlers with the test's isolated data dir.

use super::auth::principal_for;
use super::*;
use crate::authorization::{AuthorizationContext, CredentialKind, Principal};
use crate::device_tools::identity::{canonical_string, DevicePrincipal};
use crate::device_tools::identity_tests::{sign_b64, test_key};
use crate::server::*;
use axum::response::Response;

fn caller(user: &str) -> crate::identity_verify::VerifiedCaller {
    crate::identity_verify::VerifiedCaller {
        user_id: user.to_owned(),
        email: None,
        email_verified: false,
        org_id: None,
        role: crate::identity_verify::OrgRole::Member,
        teams: Vec::new(),
    }
}

fn context(credential: CredentialKind, principal: Principal) -> AuthorizationContext {
    AuthorizationContext {
        credential,
        principal,
        ..AuthorizationContext::owner(0)
    }
}

#[test]
fn only_the_users_own_app_session_reaches_the_device_lane() {
    let owner = AuthorizationContext::owner(0);
    assert_eq!(
        principal_for(&owner, None, false),
        Some(DevicePrincipal::LocalOwner)
    );
    assert_eq!(
        principal_for(&owner, Some(&caller("u1")), true),
        Some(DevicePrincipal::User("u1".into()))
    );
    assert_eq!(
        principal_for(&owner, None, true),
        None,
        "a bound node needs a verified user"
    );
    let member = context(
        CredentialKind::ManagedUserJwt,
        Principal::User {
            subject_id: "u1".into(),
        },
    );
    assert_eq!(
        principal_for(&member, Some(&caller("u1")), true),
        Some(DevicePrincipal::User("u1".into()))
    );
    for refused in [
        context(
            CredentialKind::PairedCapability {
                grant_id: "api-key".into(),
            },
            Principal::PairedClient {
                client_id: "c".into(),
                subject_id: Some("u1".into()),
            },
        ),
        context(
            CredentialKind::HostedOAuth,
            Principal::User {
                subject_id: "u1".into(),
            },
        ),
        context(
            CredentialKind::PluginHostGrant,
            Principal::Plugin {
                plugin_id: "p".into(),
            },
        ),
        context(
            CredentialKind::NodeWorkload,
            Principal::Node {
                node_id: "n".into(),
            },
        ),
    ] {
        assert_eq!(
            principal_for(&refused, Some(&caller("u1")), false),
            None,
            "{refused:?}"
        );
        assert_eq!(
            principal_for(&refused, Some(&caller("u1")), true),
            None,
            "{refused:?}"
        );
    }
}

/// A handler state with the local `device-tools-enabled` preference set, so
/// the tests do not depend on the profile default.
pub(super) async fn lane_state(enabled: bool) -> (tempfile::TempDir, ServerState) {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::workflow_version_revision_tests::handler_state(directory.path());
    state
        .preferences
        .set(
            crate::device_tools::flag::LOCAL_PREF_KEY,
            if enabled { "true" } else { "false" },
        )
        .await
        .unwrap();
    (directory, state)
}

pub(super) fn owner_auth() -> Option<Extension<ResolvedAuthorization>> {
    Some(Extension(ResolvedAuthorization {
        context: AuthorizationContext::owner(0),
        bindings: Default::default(),
        caller: None,
        verified_user_jwt: None,
    }))
}

pub(super) fn signed(
    route: &str,
    device: &str,
    body: &[u8],
    key: &p256::ecdsa::SigningKey,
) -> axum::http::HeaderMap {
    let ts = crate::device_tools::now_ms();
    let sig = sign_b64(
        key,
        &canonical_string("POST", route, "owner:local", device, ts, body),
    );
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-ryu-client-id", device.parse().unwrap());
    headers.insert("x-ryu-device-ts", ts.to_string().parse().unwrap());
    headers.insert("x-ryu-device-sig", sig.parse().unwrap());
    headers
}

pub(super) async fn status_and_json(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_default())
}

async fn pair(
    device: &str,
    key: &p256::ecdsa::SigningKey,
    spki: &str,
    header_device: &str,
) -> (StatusCode, Value) {
    let (_directory, state) = lane_state(true).await;
    pair_with(&state, device, key, spki, header_device, None).await
}

pub(super) async fn pair_with(
    state: &ServerState,
    device: &str,
    key: &p256::ecdsa::SigningKey,
    spki: &str,
    header_device: &str,
    user_jwt: Option<&str>,
) -> (StatusCode, Value) {
    let body = serde_json::to_vec(&json!({
        "device_id": device, "app": "ryu-bot", "platform": "ios", "label": "Alex's iPhone", "public_key_spki": spki,
    }))
    .unwrap();
    let headers = signed(PAIR_ROUTE, header_device, &body, key);
    status_and_json(
        device_tools_pair(
            State(state.clone()),
            headers,
            Extension(None),
            Extension(VerifiedUserJwt(user_jwt.map(str::to_owned))),
            owner_auth(),
            body.into(),
        )
        .await,
    )
    .await
}

#[tokio::test]
async fn token_only_pairing_is_pending_until_approved_on_the_host() {
    let (_directory, state) = lane_state(true).await;
    let (key, spki) = test_key(21);
    let device = uuid::Uuid::new_v4().to_string();
    let other = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        pair(&device, &key, &spki, &other).await.0,
        StatusCode::BAD_REQUEST,
        "header/body mismatch"
    );
    let (status, body) = pair(&device, &key, &spki, &device).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["state"], "pending");
    assert_eq!(body["principal_id"], "owner:local");

    // A pending device cannot sign presence.
    let presence = serde_json::to_vec(&json!({
        "device_id": device, "app": "ryu-bot", "platform": "ios", "foreground": true, "catalog_version": 1, "tools": [],
    }))
    .unwrap();
    let send_presence = |headers| {
        device_tools_presence(
            State(state.clone()),
            headers,
            Extension(None),
            Extension(VerifiedUserJwt(None)),
            owner_auth(),
            presence.clone().into(),
        )
    };
    let (status, _) =
        status_and_json(send_presence(signed(PRESENCE_ROUTE, &device, &presence, &key)).await)
            .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let approve = |local: bool| {
        REQUEST_PEER_IS_LOCAL.scope(
            local,
            device_tools_approve_pair(Path(device.clone()), Extension(None), owner_auth()),
        )
    };
    assert_eq!(
        approve(false).await.status(),
        StatusCode::FORBIDDEN,
        "a remote phone cannot approve itself"
    );
    assert_eq!(approve(true).await.status(), StatusCode::OK);

    let headers = signed(PRESENCE_ROUTE, &device, &presence, &key);
    let (status, body) = status_and_json(send_presence(headers.clone()).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = status_and_json(send_presence(headers).await).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "a replayed signature is refused"
    );
    let (status, _) = status_and_json(send_presence(axum::http::HeaderMap::new()).await).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "unsigned requests are refused"
    );

    // A claim for a call that does not exist is a 404, never a leak.
    let claim = serde_json::to_vec(
        &json!({ "conversation_id": "c", "tool_call_id": "t", "device_id": device }),
    )
    .unwrap();
    let response = device_tools_claim(
        State(state.clone()),
        signed(CLAIM_ROUTE, &device, &claim, &key),
        Extension(None),
        Extension(VerifiedUserJwt(None)),
        owner_auth(),
        claim.into(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn api_keys_cannot_pair() {
    let (key, spki) = test_key(22);
    let device = uuid::Uuid::new_v4().to_string();
    let body = serde_json::to_vec(&json!({
        "device_id": device, "app": "ryu-bot", "platform": "ios", "public_key_spki": spki,
    }))
    .unwrap();
    let auth = Some(Extension(ResolvedAuthorization {
        context: context(
            CredentialKind::PairedCapability {
                grant_id: "k".into(),
            },
            Principal::PairedClient {
                client_id: "c".into(),
                subject_id: None,
            },
        ),
        bindings: Default::default(),
        caller: None,
        verified_user_jwt: None,
    }));
    let headers = signed(PAIR_ROUTE, &device, &body, &key);
    let (_directory, state) = lane_state(true).await;
    let response = device_tools_pair(
        State(state),
        headers,
        Extension(None),
        Extension(VerifiedUserJwt(None)),
        auth,
        body.into(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

pub(super) fn signed_get(
    route: &str,
    device: &str,
    key: &p256::ecdsa::SigningKey,
) -> axum::http::HeaderMap {
    let ts = crate::device_tools::now_ms();
    let sig = sign_b64(
        key,
        &canonical_string("GET", route, "owner:local", device, ts, b""),
    );
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-ryu-client-id", device.parse().unwrap());
    headers.insert("x-ryu-device-ts", ts.to_string().parse().unwrap());
    headers.insert("x-ryu-device-sig", sig.parse().unwrap());
    headers
}

#[tokio::test]
async fn the_device_stream_needs_a_signed_get_from_an_active_device() {
    use crate::device_tools::device_stream;
    let (_directory, state) = lane_state(true).await;
    let stream = |headers| {
        device_tools_stream(
            State(state.clone()),
            headers,
            Extension(None),
            Extension(VerifiedUserJwt(None)),
            owner_auth(),
        )
    };
    let (key, spki) = test_key(23);
    let device = uuid::Uuid::new_v4().to_string();
    assert_eq!(pair(&device, &key, &spki, &device).await.0, StatusCode::OK);
    // Pending (token-only pairing): refused.
    let pending = stream(signed_get(STREAM_ROUTE, &device, &key)).await;
    assert_eq!(pending.status(), StatusCode::FORBIDDEN);
    let approved = REQUEST_PEER_IS_LOCAL
        .scope(
            true,
            device_tools_approve_pair(Path(device.clone()), Extension(None), owner_auth()),
        )
        .await;
    assert_eq!(approved.status(), StatusCode::OK);
    // A POST signature does not open a GET stream.
    let wrong_method = stream(signed(STREAM_ROUTE, &device, b"", &key)).await;
    assert_eq!(wrong_method.status(), StatusCode::UNAUTHORIZED);
    let unsigned = stream(axum::http::HeaderMap::new()).await;
    assert_eq!(unsigned.status(), StatusCode::UNAUTHORIZED);

    let open = stream(signed_get(STREAM_ROUTE, &device, &key)).await;
    assert_eq!(open.status(), StatusCode::OK);
    assert_eq!(open.headers()["content-type"], "text/event-stream");
    assert!(device_stream::is_connected("owner:local", &device));
    let frame = crate::device_tools::frames::status_frame(
        "call-s",
        crate::device_tools::frames::DeviceStatus::Claimed,
    );
    assert!(device_stream::send("owner:local", &device, frame));
    let mut body = open.into_body().into_data_stream();
    let mut seen = String::new();
    while !seen.contains("devstat-call-s") {
        let chunk = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            futures_util::StreamExt::next(&mut body),
        )
        .await
        .expect("frame")
        .expect("open")
        .unwrap();
        seen.push_str(&String::from_utf8_lossy(&chunk));
    }
    assert!(
        seen.contains("\"type\":\"data-device-tool-status\""),
        "{seen}"
    );
    drop(body);
    assert!(
        !device_stream::is_connected("owner:local", &device),
        "closing the body releases the slot"
    );
}
