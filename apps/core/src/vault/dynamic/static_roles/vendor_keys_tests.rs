//! Stripe and Cloudflare rotators against a scripted vendor API.

use std::sync::{Arc, Mutex};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use rsa::pkcs8::DecodePublicKey;
use rsa::RsaPublicKey;

use super::super::*;
use super::*;
use crate::plugin_secrets::{PluginSecretStore, SecretScope};
use crate::vault::audit::AuditActor;

const STRIPE_LIVE: &str = "rk_live_admin_key_for_tests";
const STRIPE_TEST: &str = "sk_test_admin_key_for_tests";
const CLOUDFLARE_ADMIN: &str = "cf-admin-token-for-tests";

fn target() -> SecretCoords {
    SecretCoords::root(SecretScope::Node, "local", None, "VENDOR_KEY")
}

#[derive(Default)]
struct Fake {
    /// (method, path, selected headers, body) per request.
    seen: Vec<(String, String, Vec<(String, String)>, Value)>,
    rotations: usize,
    fail: bool,
}

/// Seal `plaintext` for `pem` the way Stripe does (RSA-OAEP-256 / A256GCM).
fn jwe_for(pem: &str, plaintext: &str) -> String {
    let public = RsaPublicKey::from_public_key_pem(pem).unwrap();
    let cek = crate::vault::random_bytes(32);
    let iv = crate::vault::random_bytes(12);
    let header = B64URL.encode(br#"{"alg":"RSA-OAEP-256","enc":"A256GCM"}"#);
    let wrapped = public
        .encrypt(&mut OsRng, Oaep::new::<Sha256>(), &cek)
        .unwrap();
    let mut sealed = Aes256Gcm::new_from_slice(&cek)
        .unwrap()
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: plaintext.as_bytes(),
                aad: header.as_bytes(),
            },
        )
        .unwrap();
    let tag = sealed.split_off(sealed.len() - 16);
    [
        header,
        B64URL.encode(wrapped),
        B64URL.encode(iv),
        B64URL.encode(sealed),
        B64URL.encode(tag),
    ]
    .join(".")
}

async fn fake_vendor() -> Arc<Mutex<Fake>> {
    let fake = Arc::new(Mutex::new(Fake::default()));
    let state = fake.clone();
    let handler = move |method: Method, uri: Uri, headers: HeaderMap, body: String| {
        let state = state.clone();
        async move {
            let mut fake = state.lock().unwrap();
            let picked = ["authorization", "stripe-version", "stripe-context"]
                .iter()
                .filter_map(|name| {
                    headers
                        .get(*name)
                        .and_then(|value| value.to_str().ok())
                        .map(|value| ((*name).to_owned(), value.to_owned()))
                })
                .collect();
            let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let path = uri.path().to_owned();
            fake.seen
                .push((method.to_string(), path.clone(), picked, body.clone()));
            let reply = |status: StatusCode, body: Value| (status, axum::Json(body));
            if fake.fail {
                // Each vendor's own error shape, echoing the admin credential.
                let body = if path.starts_with("/v2/") {
                    json!({ "error": { "code": "permission_denied", "message": format!("leak {STRIPE_LIVE}") } })
                } else {
                    json!({ "success": false,
                            "errors": [{ "code": 9109, "message": format!("leak {CLOUDFLARE_ADMIN}") }] })
                };
                return reply(StatusCode::FORBIDDEN, body);
            }
            fake.rotations += 1;
            let n = fake.rotations;
            let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
            match (method.as_str(), segments.as_slice()) {
                ("POST", ["v2", "iam", "api_keys", _, "rotate"]) => {
                    let secret = match body
                        .pointer("/public_key/pem_key/data")
                        .and_then(Value::as_str)
                    {
                        Some(pem) => json!({ "encrypted_secret": {
                            "ciphertext": jwe_for(pem, &format!("rk_live_value_{n}")) } }),
                        None => json!({ "token": format!("rk_test_value_{n}") }),
                    };
                    reply(
                        StatusCode::OK,
                        json!({ "id": format!("rk_id_{n}"), "type": "secret_key", "secret_key": secret }),
                    )
                }
                ("PUT", [.., "tokens", _, "value"]) => reply(
                    StatusCode::OK,
                    json!({ "success": true, "errors": [], "result": format!("cf-rolled-{n}") }),
                ),
                _ => reply(StatusCode::NOT_FOUND, json!({})),
            }
        }
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, axum::Router::new().fallback(handler))
            .await
            .ok();
    });
    VENDOR_ENDPOINT.with(|cell| *cell.borrow_mut() = Some(format!("http://{addr}")));
    fake
}

fn input(provider: Value) -> StaticRoleInput {
    serde_json::from_value(json!({ "provider": provider, "rotationPeriodSecs": 86400 })).unwrap()
}

fn stripe(admin: &str) -> StaticRoleInput {
    input(
        json!({ "kind": "stripe", "adminApiKey": admin, "currentApiKeyId": "rk_id_0",
                  "stripeContext": "acct_123" }),
    )
}

#[test]
fn vendor_providers_validate_their_configuration() {
    stripe(STRIPE_TEST).provider.validate().unwrap();
    input(json!({ "kind": "cloudflare", "adminApiToken": "t", "tokenId": "abc123" }))
        .provider
        .validate()
        .unwrap();
    for bad in [
        json!({ "kind": "stripe", "adminApiKey": "pk_live_x", "currentApiKeyId": "rk_1" }),
        json!({ "kind": "stripe", "adminApiKey": STRIPE_TEST }),
        json!({ "kind": "stripe", "adminApiKey": STRIPE_TEST, "currentApiKeyId": "../x" }),
        json!({ "kind": "cloudflare", "adminApiToken": "", "tokenId": "abc" }),
        json!({ "kind": "cloudflare", "adminApiToken": "t", "tokenId": "a/b" }),
        json!({ "kind": "cloudflare", "adminApiToken": "t", "tokenId": "a", "accountId": "x y" }),
    ] {
        let provider: StaticProvider = serde_json::from_value(bad.clone()).unwrap();
        assert!(provider.validate().is_err(), "{bad}");
    }
    let summary = stripe(STRIPE_LIVE).provider.summary().to_string();
    assert!(!summary.contains(STRIPE_LIVE), "{summary}");
}

#[tokio::test]
async fn stripe_test_mode_rotations_follow_the_new_key_id() {
    let fake = fake_vendor().await;
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    store
        .static_put_role("stripe", &stripe(STRIPE_TEST), target(), &actor)
        .await
        .unwrap();
    store.static_rotate("stripe", &actor).await.unwrap();
    assert_eq!(
        store.reveal(&target(), None, &actor).await.unwrap(),
        "rk_test_value_1"
    );
    store.static_rotate("stripe", &actor).await.unwrap();
    assert_eq!(
        store.reveal(&target(), None, &actor).await.unwrap(),
        "rk_test_value_2"
    );
    let (_, state) = store.static_state("stripe").await.unwrap();
    assert_eq!(state.provider.current_key_id().as_deref(), Some("rk_id_2"));
    assert!(state.retired_access_keys.is_empty());

    let fake = fake.lock().unwrap();
    assert_eq!(fake.seen[0].1, "/v2/iam/api_keys/rk_id_0/rotate");
    assert_eq!(fake.seen[1].1, "/v2/iam/api_keys/rk_id_1/rotate");
    let headers = &fake.seen[0].2;
    assert!(headers.contains(&("stripe-context".into(), "acct_123".into())));
    assert!(headers.contains(&("stripe-version".into(), DEFAULT_STRIPE_VERSION.into())));
    assert!(headers.contains(&("authorization".into(), format!("Bearer {STRIPE_TEST}"))));
    assert!(
        fake.seen[0].3.get("public_key").is_none(),
        "test mode sends no public key"
    );
}

#[tokio::test]
async fn stripe_live_keys_arrive_encrypted_to_a_one_time_rsa_key() {
    let fake = fake_vendor().await;
    let minted = stripe_rotate(STRIPE_LIVE, "rk_id_0", None, DEFAULT_STRIPE_VERSION)
        .await
        .unwrap();
    assert_eq!(minted.id, "rk_id_1");
    assert_eq!(minted.value, "rk_live_value_1");
    let fake = fake.lock().unwrap();
    let pem = fake.seen[0].3["public_key"]["pem_key"]["data"]
        .as_str()
        .unwrap();
    assert!(pem.starts_with("-----BEGIN PUBLIC KEY-----"));

    // A JWE sealed to another key, or with a changed header, does not open.
    let other = RsaPrivateKey::new(&mut OsRng, 2048).unwrap();
    let other_pem = other
        .to_public_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let sealed = jwe_for(&other_pem, "secret");
    assert_eq!(open_jwe(&sealed, &other).unwrap(), "secret");
    let mut parts: Vec<String> = sealed.split('.').map(str::to_owned).collect();
    parts[0] = B64URL.encode(br#"{"alg":"RSA-OAEP-256","enc":"A256GCM","x":1}"#);
    assert!(
        open_jwe(&parts.join("."), &other).is_err(),
        "header is authenticated"
    );
    parts[0] = B64URL.encode(br#"{"alg":"RSA1_5","enc":"A256GCM"}"#);
    assert!(
        open_jwe(&parts.join("."), &other).is_err(),
        "only RSA-OAEP-256"
    );
}

#[tokio::test]
async fn cloudflare_rotations_roll_the_token_value() {
    let fake = fake_vendor().await;
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let role = input(
        json!({ "kind": "cloudflare", "adminApiToken": CLOUDFLARE_ADMIN,
                             "tokenId": "tok123", "accountId": "acc456" }),
    );
    store
        .static_put_role("cf", &role, target(), &actor)
        .await
        .unwrap();
    store.static_rotate("cf", &actor).await.unwrap();
    assert_eq!(
        store.reveal(&target(), None, &actor).await.unwrap(),
        "cf-rolled-1"
    );
    store.static_rotate("cf", &actor).await.unwrap();
    assert_eq!(
        store.reveal(&target(), None, &actor).await.unwrap(),
        "cf-rolled-2"
    );
    let (_, state) = store.static_state("cf").await.unwrap();
    assert!(state.retired_access_keys.is_empty());
    {
        let fake = fake.lock().unwrap();
        assert_eq!(fake.seen[0].0, "PUT");
        assert_eq!(fake.seen[0].1, "/accounts/acc456/tokens/tok123/value");
    }

    // Failures carry the status and code, never the vendor's message.
    fake.lock().unwrap().fail = true;
    let error = store
        .static_rotate("cf", &actor)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("403") && error.contains("9109"), "{error}");
    assert!(!error.contains(CLOUDFLARE_ADMIN), "{error}");
    assert_eq!(
        store.reveal(&target(), None, &actor).await.unwrap(),
        "cf-rolled-2"
    );
    let user = cloudflare_roll(CLOUDFLARE_ADMIN, "tok123", None).await;
    assert!(user.is_err());
    assert_eq!(
        fake.lock().unwrap().seen.last().unwrap().1,
        "/user/tokens/tok123/value"
    );
}
