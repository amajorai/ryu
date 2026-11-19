//! Share and request link flows against a fake Ryu Cloud.

use super::client::tests::{fake_cloud, Seen};
use super::*;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use hkdf::Hkdf;
use p256::elliptic_curve::group::Curve as _;
use p256::elliptic_curve::point::AffineCoordinates as _;
use rand::RngCore as _;
use sha2::Sha256;
use std::sync::{Arc, Mutex};

fn actor() -> AuditActor {
    AuditActor::new("user", Some("u1"))
}

/// What the recipient's browser does (`sealAnswer` in the web app).
pub(crate) fn browser_seal(public_key: &str, value: &str) -> crypto::SealedAnswer {
    let requester =
        p256::PublicKey::from_sec1_bytes(&URL_SAFE_NO_PAD.decode(public_key).unwrap()).unwrap();
    let ephemeral = loop {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        if let Ok(secret) = p256::SecretKey::from_slice(&bytes) {
            break secret;
        }
    };
    let shared = (requester.to_projective() * *ephemeral.to_nonzero_scalar())
        .to_affine()
        .x();
    let epk = ephemeral.public_key().to_sec1_bytes().to_vec();
    let mut salt = epk.clone();
    salt.extend_from_slice(&requester.to_sec1_bytes());
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), &shared)
        .expand(crypto::REQUEST_INFO, &mut key)
        .unwrap();
    let nonce = [9u8; 12];
    let ciphertext = aes_gcm::Aes256Gcm::new_from_slice(&key)
        .unwrap()
        .encrypt(
            aes_gcm::Nonce::from_slice(&nonce),
            Payload {
                msg: value.as_bytes(),
                aad: crypto::REQUEST_INFO,
            },
        )
        .unwrap();
    crypto::SealedAnswer {
        epk: URL_SAFE_NO_PAD.encode(epk),
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    }
}

fn created(id: &str, path: &str) -> (u16, Value) {
    (
        201,
        json!({ "id": id, "url": format!("https://ryu.example/{path}/TOKEN"), "expiresAt": "2026-11-10T00:00:00.000Z" }),
    )
}

#[tokio::test]
async fn a_share_uploads_only_ciphertext_and_returns_the_key_once() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (cloud, log) = fake_cloud(|_| created("vs_1", "secret")).await;
    let link = share(
        &store,
        &cloud,
        (Some("DB_PASSWORD"), json!("hunter2-but-long")),
        (Some("Staging DB"), Some(3600)),
        &actor(),
    )
    .await
    .unwrap();
    let (base, key) = link.url.split_once('#').unwrap();
    assert_eq!(base, "https://ryu.example/secret/TOKEN");
    let body: Seen = log.lock().unwrap()[0].clone();
    assert_eq!(body.body["kind"], "share");
    assert_eq!(body.body["ttlSecs"], 3600);
    assert!(!body.body.to_string().contains("hunter2"));
    assert!(!body.body.to_string().contains(key));
    // The fragment key opens the uploaded blob.
    let blob = URL_SAFE_NO_PAD
        .decode(body.body["ciphertext"].as_str().unwrap())
        .unwrap();
    let key = URL_SAFE_NO_PAD.decode(key).unwrap();
    let plain = aes_gcm::Aes256Gcm::new_from_slice(&key)
        .unwrap()
        .decrypt(
            aes_gcm::Nonce::from_slice(&blob[..12]),
            Payload {
                msg: &blob[12..],
                aad: crypto::SHARE_AAD,
            },
        )
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&plain).unwrap(),
        json!({ "name": "DB_PASSWORD", "value": "hunter2-but-long" })
    );
    let listed = store.share_link_list(Some("u1")).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].label.as_deref(), Some("Staging DB"));
    assert!(store
        .share_link_list(Some("someone-else"))
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn a_request_is_collected_once_and_survives_a_failed_write() {
    let store = PluginSecretStore::in_memory().unwrap();
    let public_key: Arc<Mutex<Option<String>>> = Arc::default();
    let shared_key = public_key.clone();
    let collects = Arc::new(Mutex::new(0));
    let counted = collects.clone();
    let (cloud, _) = fake_cloud(move |seen| match seen.method.as_str() {
        "POST" if seen.path.ends_with("/collect") => {
            *counted.lock().unwrap() += 1;
            let key = shared_key.lock().unwrap().clone().unwrap();
            (
                200,
                json!({ "response": browser_seal(&key, "sk_live_123") }),
            )
        }
        "POST" => {
            *shared_key.lock().unwrap() = seen.body["publicKey"].as_str().map(str::to_owned);
            created("vr_1", "secret-request")
        }
        _ => (200, json!({ "revoked": true })),
    })
    .await;
    let link = request(
        &store,
        &cloud,
        json!({ "name": "STRIPE_KEY", "environment": "prod" }),
        ("Your Stripe key", None),
        &actor(),
    )
    .await
    .unwrap();
    assert_eq!(link.url, "https://ryu.example/secret-request/TOKEN");
    let (info, answer) = collect_answer(&store, &cloud, "vr_1", &actor())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(answer.as_str(), "sk_live_123");
    assert_eq!(info.target.unwrap()["name"], "STRIPE_KEY");
    // A claim whose write failed retries from the sealed local copy; the
    // control plane is not asked again.
    let (_, again) = collect_answer(&store, &cloud, "vr_1", &actor())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(again.as_str(), "sk_live_123");
    assert_eq!(*collects.lock().unwrap(), 1);
    finish_claim(&store, "vr_1", &actor()).await.unwrap();
    let error = collect_answer(&store, &cloud, "vr_1", &actor())
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("already claimed"), "{error}");
    let (_, secrets) = store.share_link_get("vr_1").await.unwrap();
    assert!(secrets.request_key.is_none() && secrets.pending_answer.is_none());
}

#[tokio::test]
async fn revoking_and_validation() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (cloud, log) = fake_cloud(|seen| match seen.method.as_str() {
        "DELETE" => (200, json!({ "revoked": true })),
        _ => created("vs_9", "secret"),
    })
    .await;
    share(
        &store,
        &cloud,
        (None, json!({ "a": 1 })),
        (None, None),
        &actor(),
    )
    .await
    .unwrap();
    assert!(revoke(&store, &cloud, "vs_9", &actor()).await.unwrap());
    // Already revoked locally: no second call.
    assert!(!revoke(&store, &cloud, "vs_9", &actor()).await.unwrap());
    assert_eq!(log.lock().unwrap().len(), 2);
    for ttl in [Some(10), Some(MAX_TTL_SECS + 1)] {
        assert!(
            share(&store, &cloud, (None, json!(1)), (None, ttl), &actor())
                .await
                .is_err()
        );
    }
    assert!(request(&store, &cloud, json!({}), ("  ", None), &actor())
        .await
        .is_err());
    assert!(
        request(&store, &cloud, json!({}), ("bad\u{7}label", None), &actor())
            .await
            .is_err()
    );
}
