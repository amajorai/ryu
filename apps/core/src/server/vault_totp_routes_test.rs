//! TOTP key read and code validation over the shipping human vault router:
//! metadata never carries the seed, the current code is accepted exactly once,
//! stale and wrong codes are refused, unknown keys are 404, and a caller
//! without a grant on `sys/totp/<key>` is refused before the store is read.
//!
//! The handlers resolve the process vault store; an in-memory one is published
//! (first set wins, as in the other vault route tests) and key names are unique.
use super::*;
use crate::identity_verify::OrgRole;
use crate::plugin_secrets::PluginSecretStore;
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use crate::vault::totp::{base32_encode, totp_at, TotpParams};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::Value;
use tower::ServiceExt;

const SEED: &[u8] = b"route-test-seed-0123456789";

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

async fn send(
    caller: Option<VerifiedCaller>,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, String) {
    crate::plugin_secrets::set_global(PluginSecretStore::in_memory().unwrap());
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let mut request = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = routes()
        .layer(axum::Extension(caller))
        .with_state(state)
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

async fn import_key() -> String {
    let name = format!("route-{}", uuid::Uuid::new_v4().simple());
    let (status, body) = send(
        None,
        "POST",
        "/api/vault/totp/keys",
        Some(json!({
            "name": name,
            "secret": base32_encode(SEED),
            "issuer": "Example",
            "account": "ops@example.com",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    name
}

async fn validate(name: &str, code: &str) -> (StatusCode, Value) {
    let (status, body) = send(
        None,
        "POST",
        &format!("/api/vault/totp/validate/{name}"),
        Some(json!({ "code": code })),
    )
    .await;
    (status, serde_json::from_str(&body).unwrap_or(Value::Null))
}

#[tokio::test]
async fn key_metadata_never_carries_the_seed_and_unknown_keys_are_404() {
    with_test_node_binding(false, None, async {
        let name = import_key().await;
        let (status, body) = send(None, "GET", &format!("/api/vault/totp/keys/{name}"), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let key: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(key["key"]["name"], name.as_str());
        assert_eq!(key["key"]["issuer"], "Example");
        assert_eq!(key["key"]["digits"], 6);
        assert_eq!(key["key"]["generated"], false);
        assert!(!body.contains(&base32_encode(SEED)), "{body}");
        assert!(!body.contains("route-test-seed"), "{body}");
        assert!(!body.contains("otpauth://"), "{body}");

        let (status, _) = send(None, "GET", "/api/vault/totp/keys/route-missing", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = validate("route-missing", "123456").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    })
    .await;
}

#[tokio::test]
async fn the_current_code_is_accepted_once_and_stale_or_wrong_codes_are_refused() {
    with_test_node_binding(false, None, async {
        let name = import_key().await;
        let params = TotpParams::default();
        let now = unix_now();
        let current = totp_at(&params, SEED, now);
        let window: Vec<String> = [now - 30, now, now + 30]
            .iter()
            .map(|at| totp_at(&params, SEED, *at))
            .collect();
        let stale = totp_at(&params, SEED, now - 30 * 10);
        assert!(!window.contains(&stale), "pick another stale step");
        let wrong = (0..1_000_000u32)
            .map(|n| format!("{n:06}"))
            .find(|code| !window.contains(code))
            .unwrap();

        assert_eq!(
            validate(&name, &wrong).await,
            (StatusCode::OK, json!({ "valid": false }))
        );
        assert_eq!(
            validate(&name, &stale).await,
            (StatusCode::OK, json!({ "valid": false }))
        );
        assert_eq!(
            validate(&name, "12ab56").await,
            (StatusCode::OK, json!({ "valid": false }))
        );
        assert_eq!(
            validate(&name, &format!(" {current} ")).await,
            (StatusCode::OK, json!({ "valid": true }))
        );
        // A code is accepted once: the same code again is a replay.
        assert_eq!(
            validate(&name, &current).await,
            (StatusCode::OK, json!({ "valid": false }))
        );
    })
    .await;
}

#[tokio::test]
async fn a_member_without_a_grant_cannot_read_or_validate_a_key() {
    let name = with_test_node_binding(false, None, import_key()).await;
    let node = RegisteredNode {
        org: RegisteredOrg {
            id: "org-v".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-v".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    };
    with_test_node_binding(false, Some(node), async {
        let member = Some(VerifiedCaller {
            user_id: "member".to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org-v".to_owned()),
            role: OrgRole::Member,
            teams: Vec::new(),
        });
        let current = totp_at(&TotpParams::default(), SEED, unix_now());
        let (status, body) = send(
            member.clone(),
            "GET",
            &format!("/api/vault/totp/keys/{name}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        let (status, body) = send(
            member,
            "POST",
            &format!("/api/vault/totp/validate/{name}"),
            Some(json!({ "code": current })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    })
    .await;
    // The refused attempt did not consume the code for the owner.
    with_test_node_binding(false, None, async {
        let current = totp_at(&TotpParams::default(), SEED, unix_now());
        assert_eq!(
            validate(&name, &current).await,
            (StatusCode::OK, json!({ "valid": true }))
        );
    })
    .await;
}
