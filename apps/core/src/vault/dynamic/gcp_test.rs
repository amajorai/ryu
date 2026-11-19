//! GCP provider tests against a scripted Google API.

use super::*;
use crate::vault::dynamic::http::tests::fake_api;
use std::sync::OnceLock;

/// One RSA key for every test (generation is slow in debug builds).
fn private_key_pem() -> &'static str {
    static PEM: OnceLock<String> = OnceLock::new();
    PEM.get_or_init(|| {
        use rsa::pkcs8::EncodePrivateKey;
        let key = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap();
        key.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
            .unwrap()
            .to_string()
    })
}

fn config(base: &str, secret_type: GcpSecretType) -> GcpConfig {
    GcpConfig {
        credentials: json!({
            "type": "service_account",
            "client_email": "ryu-admin@proj.iam.gserviceaccount.com",
            "private_key": private_key_pem(),
            "private_key_id": "kid-1",
            "token_uri": "https://oauth2.googleapis.com/token",
        })
        .to_string(),
        service_account_email: "app@proj.iam.gserviceaccount.com".into(),
        secret_type,
        token_scopes: vec![],
        egress: TargetEgress::Trusted,
        endpoints: GcpEndpoints {
            token: Some(format!("{base}/token")),
            iam: Some(base.to_owned()),
            iam_credentials: Some(base.to_owned()),
        },
    }
}

fn google(seen: &crate::vault::dynamic::http::tests::Seen) -> (u16, Value) {
    match (seen.method.as_str(), seen.path.as_str()) {
        ("POST", "/token") => (
            200,
            json!({ "access_token": "admin-at", "expires_in": 3600 }),
        ),
        ("POST", path) if path.ends_with("/keys") => (
            200,
            json!({
                "name": "projects/proj/serviceAccounts/app@proj.iam.gserviceaccount.com/keys/abc123",
                "privateKeyData": base64::engine::general_purpose::STANDARD.encode(br#"{"type":"service_account"}"#),
            }),
        ),
        ("POST", path) if path.ends_with(":generateAccessToken") => (
            200,
            json!({ "accessToken": "ya29.minted", "expireTime": "2026-11-09T12:00:00Z" }),
        ),
        ("DELETE", _) => (200, json!({})),
        _ => (404, json!({ "error": { "message": "unexpected" } })),
    }
}

#[test]
fn validation_pins_google_token_endpoints() {
    let mut config = config("http://127.0.0.1:1", GcpSecretType::ServiceAccountKey);
    config.validate().unwrap();
    let summary = config.summary().to_string();
    assert!(summary.contains("ryu-admin@proj.iam.gserviceaccount.com"));
    assert!(!summary.contains("PRIVATE KEY"), "{summary}");
    let mut key: Value = serde_json::from_str(&config.credentials).unwrap();
    key["token_uri"] = json!("https://attacker.example/token");
    config.credentials = key.to_string();
    assert!(config.validate().is_err());
    key["token_uri"] = json!("https://oauth2.googleapis.com/token");
    key["private_key"] = json!("not a key");
    config.credentials = key.to_string();
    assert!(config.validate().is_err());
    let mut bad_target = self::config("http://127.0.0.1:1", GcpSecretType::AccessToken);
    bad_target.service_account_email = "app/../../x".into();
    assert!(bad_target.validate().is_err());
    // Endpoint overrides never come from a role body.
    let parsed: GcpConfig = serde_json::from_value(json!({
        "credentials": "{}", "serviceAccountEmail": "a@b.c", "endpoints": { "iam": "http://x" }
    }))
    .unwrap();
    assert_eq!(parsed.endpoints, GcpEndpoints::default());
}

#[tokio::test]
async fn keys_are_created_with_a_signed_grant_and_deleted_on_revoke() {
    let (base, log) = fake_api(google).await;
    let config = config(&base, GcpSecretType::ServiceAccountKey);
    let issued = issue(&config, 3600).await.unwrap();
    assert_eq!(issued.data["credentials"], r#"{"type":"service_account"}"#);
    assert_eq!(issued.data["keyId"], "abc123");
    assert_eq!(issued.ttl_cap_secs, None);
    revoke(&config, &issued.revoke_data).await.unwrap();
    let log = log.lock().unwrap().clone();
    let grant: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(log[0].body.as_bytes())
            .into_owned()
            .collect();
    assert_eq!(
        grant["grant_type"],
        "urn:ietf:params:oauth:grant-type:jwt-bearer"
    );
    // The assertion verifies with the key's public half and names Google.
    let public = rsa::RsaPublicKey::from(
        <rsa::RsaPrivateKey as rsa::pkcs8::DecodePrivateKey>::from_pkcs8_pem(private_key_pem())
            .unwrap(),
    );
    let public_pem =
        rsa::pkcs8::EncodePublicKey::to_public_key_pem(&public, rsa::pkcs8::LineEnding::LF)
            .unwrap();
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&["https://oauth2.googleapis.com/token"]);
    let claims = jsonwebtoken::decode::<Value>(
        &grant["assertion"],
        &jsonwebtoken::DecodingKey::from_rsa_pem(public_pem.as_bytes()).unwrap(),
        &validation,
    )
    .unwrap()
    .claims;
    assert_eq!(claims["iss"], "ryu-admin@proj.iam.gserviceaccount.com");
    assert_eq!(
        log[1].path,
        "/v1/projects/-/serviceAccounts/app@proj.iam.gserviceaccount.com/keys"
    );
    assert_eq!(log[1].authorization.as_deref(), Some("Bearer admin-at"));
    assert_eq!(log[3].method, "DELETE");
    assert_eq!(
        log[3].path,
        "/v1/projects/proj/serviceAccounts/app@proj.iam.gserviceaccount.com/keys/abc123"
    );
}

#[tokio::test]
async fn access_tokens_are_capped_at_one_hour_and_not_revoked_upstream() {
    let (base, log) = fake_api(google).await;
    let mut config = config(&base, GcpSecretType::AccessToken);
    config.token_scopes = vec!["https://www.googleapis.com/auth/devstorage.read_only".into()];
    assert!(!config.renewable());
    let issued = issue(&config, 7200).await.unwrap();
    assert_eq!(issued.data["accessToken"], "ya29.minted");
    assert_eq!(issued.ttl_cap_secs, Some(3600));
    revoke(&config, &issued.revoke_data).await.unwrap();
    let log = log.lock().unwrap().clone();
    assert_eq!(log.len(), 2);
    assert_eq!(log[1].json()["lifetime"], "3600s");
    assert_eq!(
        log[1].json()["scope"],
        json!(["https://www.googleapis.com/auth/devstorage.read_only"])
    );
}

#[tokio::test]
async fn forged_key_names_are_never_deleted() {
    let (base, log) = fake_api(google).await;
    let config = config(&base, GcpSecretType::ServiceAccountKey);
    for name in ["projects/p/serviceAccounts/a/keys/../../x", "v1/other"] {
        assert!(revoke(&config, &json!({ "keyName": name })).await.is_err());
    }
    assert!(log.lock().unwrap().is_empty());
}
