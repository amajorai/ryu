//! `/v1/transit/*`: Vault wire shapes, policy refusals, sealed refusal, and
//! agreement with the native transit routes.

use super::fixture_test::*;
use crate::server::vault_engines_api::{machine_who, transit_op, TransitOpBody, Who};
use crate::vault::transit::TransitKeyType;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;

/// A fixture whose `ci` policy grants `use` on `app-key` and `sig-key` and
/// `admin` on `sig-key`, with those keys created (AES-GCM and Ed25519).
async fn transit_fixture() -> (Fixture, String) {
    let fixture = fixture(vec![
        rule("sys/transit/app-key", &[Capability::Use], false),
        rule(
            "sys/transit/sig-key",
            &[Capability::Use, Capability::Admin],
            false,
        ),
    ])
    .await;
    let admin = AuditActor::new("user", Some("admin"));
    for (name, kind) in [
        ("app-key", TransitKeyType::Aes256Gcm96),
        ("sig-key", TransitKeyType::Ed25519),
    ] {
        fixture
            .store
            .transit_create(name, kind, &admin)
            .await
            .unwrap();
    }
    let token = login(&fixture).await;
    (fixture, token)
}

async fn post(app: &Router, token: &str, uri: &str, body: Value) -> (StatusCode, Value) {
    call(app, "POST", uri, Some(token), Some(body)).await
}

#[tokio::test]
async fn encrypt_decrypt_rewrap_and_datakey_use_vault_wire_shapes() {
    let (fixture, token) = transit_fixture().await;
    let app = &fixture.app;
    let plaintext = B64.encode("hello vault");

    let (status, body) = post(
        app,
        &token,
        "/v1/transit/encrypt/app-key",
        json!({ "plaintext": plaintext }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let ciphertext = body["data"]["ciphertext"].as_str().unwrap().to_owned();
    assert!(ciphertext.starts_with("vault:v1:"), "{ciphertext}");
    assert_eq!(body["data"]["key_version"], 1);
    assert_eq!(body["lease_id"], "");
    assert!(body["auth"].is_null());

    let (status, body) = post(
        app,
        &token,
        "/v1/transit/decrypt/app-key",
        json!({ "ciphertext": ciphertext }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"], json!({ "plaintext": plaintext }));

    let (status, body) = post(
        app,
        &token,
        "/v1/transit/rewrap/app-key",
        json!({ "ciphertext": ciphertext }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["data"]["ciphertext"]
        .as_str()
        .unwrap()
        .starts_with("vault:v1:"));

    let (status, body) = post(
        app,
        &token,
        "/v1/transit/datakey/plaintext/app-key",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["data"]["plaintext"].is_string());
    assert!(body["data"]["ciphertext"]
        .as_str()
        .unwrap()
        .starts_with("vault:v1:"));
    let (status, body) = post(
        app,
        &token,
        "/v1/transit/datakey/wrapped/app-key",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["data"].get("plaintext").is_none(), "{body}");
    assert_eq!(body["data"]["key_version"], 1);

    let (status, body) = post(app, &token, "/v1/transit/datakey/bogus/app-key", json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "errors": ["invalid type"] }));
}

#[tokio::test]
async fn sign_verify_hmac_and_rotate() {
    let (fixture, token) = transit_fixture().await;
    let app = &fixture.app;
    let input = B64.encode("release-1.2.3");

    let (status, body) = post(
        app,
        &token,
        "/v1/transit/sign/sig-key",
        json!({ "input": input }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let signature = body["data"]["signature"].as_str().unwrap().to_owned();
    assert!(signature.starts_with("vault:v1:"), "{signature}");
    for (input, valid) in [(input.clone(), true), (B64.encode("tampered"), false)] {
        let (status, body) = post(
            app,
            &token,
            "/v1/transit/verify/sig-key",
            json!({ "input": input, "signature": signature }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"], json!({ "valid": valid }));
    }

    for uri in [
        "/v1/transit/hmac/sig-key",
        "/v1/transit/hmac/sig-key/sha2-256",
    ] {
        let (status, body) = post(app, &token, uri, json!({ "input": input })).await;
        assert_eq!(status, StatusCode::OK, "{uri}: {body}");
        let hmac = body["data"]["hmac"].as_str().unwrap().to_owned();
        assert!(hmac.starts_with("vault:v1:"), "{hmac}");
        let (_, body) = post(
            app,
            &token,
            "/v1/transit/verify/sig-key",
            json!({ "input": input, "hmac": hmac }),
        )
        .await;
        assert_eq!(body["data"]["valid"], true, "{body}");
    }

    let (status, body) = post(app, &token, "/v1/transit/keys/sig-key/rotate", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["name"], "sig-key");
    assert_eq!(body["data"]["type"], "ed25519");
    assert_eq!(body["data"]["latest_version"], 2);
    let (_, body) = post(
        app,
        &token,
        "/v1/transit/sign/sig-key",
        json!({ "input": input }),
    )
    .await;
    assert_eq!(body["data"]["key_version"], 2, "{body}");
}

#[tokio::test]
async fn transit_refuses_missing_grants_tokens_and_unsupported_parameters() {
    let (fixture, token) = transit_fixture().await;
    let app = &fixture.app;
    let plaintext = json!({ "plaintext": B64.encode("x") });

    let (status, body) = call(
        app,
        "POST",
        "/v1/transit/encrypt/app-key",
        None,
        Some(plaintext.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, json!({ "errors": ["permission denied"] }));
    // `use` alone cannot rotate, and a key outside the policy is refused
    // whether or not it exists.
    for uri in [
        "/v1/transit/keys/app-key/rotate",
        "/v1/transit/encrypt/other-key",
        "/v1/transit/encrypt/missing-key",
    ] {
        let (status, body) = post(app, &token, uri, plaintext.clone()).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
        assert_eq!(body, json!({ "errors": ["permission denied"] }));
    }

    let unsupported = [
        ("/v1/transit/encrypt/app-key", json!({ "batch_input": [] })),
        (
            "/v1/transit/encrypt/app-key",
            json!({ "plaintext": "eA==", "nonce": "AA==" }),
        ),
        (
            "/v1/transit/sign/sig-key/sha2-512",
            json!({ "input": "eA==" }),
        ),
        (
            "/v1/transit/sign/sig-key",
            json!({ "input": "eA==", "hash_algorithm": "sha2-256" }),
        ),
        (
            "/v1/transit/sign/sig-key",
            json!({ "input": "eA==", "prehashed": true }),
        ),
        (
            "/v1/transit/hmac/sig-key/sha2-512",
            json!({ "input": "eA==" }),
        ),
        (
            "/v1/transit/datakey/plaintext/app-key",
            json!({ "bits": 512 }),
        ),
    ];
    for (uri, body) in unsupported {
        let (status, reply) = post(app, &token, uri, body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}: {reply}");
        assert!(reply["errors"][0].is_string(), "{reply}");
    }
    let (status, body) = post(app, &token, "/v1/transit/encrypt/app-key", json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "errors": ["missing plaintext"] }));
}

#[tokio::test]
async fn a_missing_key_with_a_grant_is_a_vault_400() {
    let fixture = fixture(vec![rule("sys/transit/*", &[Capability::Use], false)]).await;
    let token = login(&fixture).await;
    let (status, body) = post(
        &fixture.app,
        &token,
        "/v1/transit/encrypt/nope",
        json!({ "plaintext": "eA==" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body, json!({ "errors": ["encryption key not found"] }));
}

async fn native_who(store: &'static PluginSecretStore, token: &str) -> Who {
    let principal = store.token_lookup(token).await.unwrap().unwrap();
    match machine_who(store, principal).await {
        Ok(who) => who,
        Err(_) => panic!("a machine caller"),
    }
}

async fn native(who: &Who, op: &str, name: &str, body: TransitOpBody) -> (StatusCode, Value) {
    let response = transit_op(who, op, name, body).await;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

/// Compat and native transit are one implementation: each opens the other's
/// ciphertext, and they refuse the same caller and a sealed vault alike.
#[tokio::test]
async fn compat_and_native_transit_agree() {
    let (fixture, token) = transit_fixture().await;
    let app = &fixture.app;
    let who = native_who(fixture.store, &token).await;
    let plaintext = B64.encode("shared");

    let (_, body) = post(
        app,
        &token,
        "/v1/transit/encrypt/app-key",
        json!({ "plaintext": plaintext }),
    )
    .await;
    let compat_ciphertext = body["data"]["ciphertext"].as_str().unwrap().to_owned();
    let (status, body) = native(
        &who,
        "decrypt",
        "app-key",
        TransitOpBody {
            ciphertext: Some(compat_ciphertext.replacen("vault:v", "ryu:v", 1)),
            ..TransitOpBody::default()
        },
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["plaintext"], plaintext);

    let (status, body) = native(
        &who,
        "encrypt",
        "app-key",
        TransitOpBody {
            plaintext: Some(plaintext.clone()),
            ..TransitOpBody::default()
        },
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let native_ciphertext = body["ciphertext"].as_str().unwrap().to_owned();
    assert!(native_ciphertext.starts_with("ryu:v1:"));
    for ciphertext in [
        native_ciphertext.clone(),
        native_ciphertext.replacen("ryu:v", "vault:v", 1),
    ] {
        let (status, body) = post(
            app,
            &token,
            "/v1/transit/decrypt/app-key",
            json!({ "ciphertext": ciphertext }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["plaintext"], plaintext);
    }

    // The same caller is refused on both surfaces for a key it has no grant on.
    let (status, _) = native(&who, "encrypt", "other-key", TransitOpBody::default()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = post(app, &token, "/v1/transit/encrypt/other-key", json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Sealed: both surfaces refuse with 503.
    seal(&fixture);
    let (status, body) = native(
        &who,
        "encrypt",
        "app-key",
        TransitOpBody {
            plaintext: Some(plaintext.clone()),
            ..TransitOpBody::default()
        },
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    let (status, body) = post(
        app,
        &token,
        "/v1/transit/encrypt/app-key",
        json!({ "plaintext": plaintext }),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body, json!({ "errors": ["Vault is sealed"] }));
    unseal(&fixture).await;
    let (status, _) = post(
        app,
        &token,
        "/v1/transit/encrypt/app-key",
        json!({ "plaintext": plaintext }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}
