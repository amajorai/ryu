use super::*;
use ed25519_dalek::{Signer, SigningKey};

const ISSUER: &str = "https://cp.example";
const NOW: i64 = 1_791_473_400;

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn mint(key: &SigningKey, header: serde_json::Value, claims: serde_json::Value) -> String {
    let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap());
    let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
    let input = format!("{header}.{claims}");
    let signature = key.sign(input.as_bytes());
    format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

fn claims() -> serde_json::Value {
    serde_json::json!({
        "id": "user-1",
        "iss": ISSUER,
        "aud": ISSUER,
        "exp": NOW + 600,
        "orgs": [{ "id": "org-a", "role": "member" }, { "id": "org-b", "role": "owner" }],
        "teams": [
            { "id": "team-1", "org": "org-a", "role": "member" },
            { "id": "team-x", "org": "org-b", "role": "owner" }
        ]
    })
}

async fn verifier() -> (UserJwtVerifier, SigningKey) {
    let verifier = UserJwtVerifier::new("https://cp.example/api/auth/jwks".into(), ISSUER.into());
    let key = signing_key(7);
    verifier.install_key("k1", key.verifying_key()).await;
    (verifier, key)
}

#[tokio::test]
async fn valid_token_yields_user_and_org_scoped_teams() {
    let (verifier, key) = verifier().await;
    let token = mint(
        &key,
        serde_json::json!({ "alg": "EdDSA", "kid": "k1" }),
        claims(),
    );
    let user = verifier.verify_at(&token, "org-a", NOW).await.unwrap();
    assert_eq!(user.user_id, "user-1");
    assert_eq!(user.team_ids, vec!["team-1".to_owned()]);
}

#[tokio::test]
async fn token_for_another_org_is_rejected() {
    let (verifier, key) = verifier().await;
    let token = mint(
        &key,
        serde_json::json!({ "alg": "EdDSA", "kid": "k1" }),
        claims(),
    );
    assert_eq!(
        verifier.verify_at(&token, "org-c", NOW).await,
        Err(JwtError::NotInOrg)
    );
}

#[tokio::test]
async fn rejects_forged_expired_wrong_issuer_audience_and_alg() {
    let (verifier, key) = verifier().await;
    let header = serde_json::json!({ "alg": "EdDSA", "kid": "k1" });

    let forged = mint(&signing_key(9), header.clone(), claims());
    assert_eq!(
        verifier.verify_at(&forged, "org-a", NOW).await,
        Err(JwtError::InvalidSignature)
    );

    let mut expired = claims();
    expired["exp"] = serde_json::json!(NOW - 3_600);
    let token = mint(&key, header.clone(), expired);
    assert_eq!(
        verifier.verify_at(&token, "org-a", NOW).await,
        Err(JwtError::Expired)
    );

    let mut issuer = claims();
    issuer["iss"] = serde_json::json!("https://evil.example");
    let token = mint(&key, header.clone(), issuer);
    assert_eq!(
        verifier.verify_at(&token, "org-a", NOW).await,
        Err(JwtError::InvalidIssuer)
    );

    let mut audience = claims();
    audience["aud"] = serde_json::json!(["https://other.example"]);
    let token = mint(&key, header.clone(), audience);
    assert_eq!(
        verifier.verify_at(&token, "org-a", NOW).await,
        Err(JwtError::InvalidAudience)
    );

    let token = mint(
        &key,
        serde_json::json!({ "alg": "none", "kid": "k1" }),
        claims(),
    );
    assert_eq!(
        verifier.verify_at(&token, "org-a", NOW).await,
        Err(JwtError::UnsupportedAlg)
    );

    let token = mint(&key, serde_json::json!({ "alg": "EdDSA" }), claims());
    assert_eq!(
        verifier.verify_at(&token, "org-a", NOW).await,
        Err(JwtError::MissingKid)
    );

    // A tampered payload under a valid signature fails verification.
    let good = mint(&key, header, claims());
    let mut segments: Vec<&str> = good.split('.').collect();
    let mut tampered_claims = claims();
    tampered_claims["id"] = serde_json::json!("admin");
    let tampered = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&tampered_claims).unwrap());
    segments[1] = &tampered;
    assert_eq!(
        verifier.verify_at(&segments.join("."), "org-a", NOW).await,
        Err(JwtError::InvalidSignature)
    );
    assert_eq!(
        verifier.verify_at("a.b", "org-a", NOW).await,
        Err(JwtError::Malformed)
    );
}

#[tokio::test]
async fn unknown_kid_is_throttled_without_network() {
    let (verifier, key) = verifier().await;
    let token = mint(
        &key,
        serde_json::json!({ "alg": "EdDSA", "kid": "k2" }),
        claims(),
    );
    // `install_key` stamped a recent attempt, so no fetch is made.
    assert_eq!(
        verifier.verify_at(&token, "org-a", NOW).await,
        Err(JwtError::UnknownKid)
    );
}

#[test]
fn jwks_parsing_keeps_only_ed25519_keys() {
    let key = signing_key(3).verifying_key();
    let set: JwkSet = serde_json::from_value(serde_json::json!({
        "keys": [
            { "kty": "OKP", "crv": "Ed25519", "kid": "good", "x": URL_SAFE_NO_PAD.encode(key.as_bytes()) },
            { "kty": "RSA", "kid": "rsa", "n": "abc", "e": "AQAB" },
            { "kty": "OKP", "crv": "Ed25519", "x": URL_SAFE_NO_PAD.encode(key.as_bytes()) },
            { "kty": "OKP", "crv": "Ed25519", "kid": "short", "x": "AAAA" }
        ]
    }))
    .unwrap();
    let keys = parse_keys(set);
    assert_eq!(keys.len(), 1);
    assert!(keys.contains_key("good"));
}

#[tokio::test]
async fn insecure_remote_jwks_url_is_refused() {
    let verifier = UserJwtVerifier::new("http://cp.example/api/auth/jwks".into(), ISSUER.into());
    assert_eq!(
        verifier.fetch_keys().await.err(),
        Some(JwtError::InsecureJwksUrl)
    );
}
