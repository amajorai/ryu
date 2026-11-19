//! Tests for [`super`]: AppRole and JWT logins.

use super::*;

/// A throwaway P-256 key generated per test run, so no private key is
/// committed to the repository.
static TEST_KEY: std::sync::LazyLock<rcgen::KeyPair> =
    std::sync::LazyLock::new(|| rcgen::KeyPair::generate().unwrap());

#[tokio::test]
async fn approle_login_issues_scoped_tokens_and_honors_single_use() {
    let store = PluginSecretStore::in_memory().unwrap();
    let admin = AuditActor::new("user", Some("admin"));
    let identity = store
        .machine_create(
            "ci",
            AuthMethod::AppRole {
                role_id: String::new(),
            },
            vec!["ci-read".into()],
            Some(600),
            &admin,
        )
        .await
        .unwrap();
    let AuthMethod::AppRole { role_id } = &identity.auth else {
        panic!("approle")
    };
    let (secret, _) = store
        .machine_issue_secret_id("ci", None, Some(1), &admin)
        .await
        .unwrap();
    assert!(store.approle_login(role_id, "sid_wrong").await.is_err());
    let token = store.approle_login(role_id, &secret).await.unwrap();
    assert_eq!(token.policies, vec!["ci-read".to_owned()]);
    // Single use: the second login with the same secret id fails.
    assert!(store.approle_login(role_id, &secret).await.is_err());
    let principal = store.token_lookup(&token.token).await.unwrap().unwrap();
    assert_eq!(principal.identity_name, "ci");
    store
        .token_revoke(&principal.accessor, &admin)
        .await
        .unwrap();
    assert!(store.token_lookup(&token.token).await.unwrap().is_none());
}

fn sign(claims: Value) -> String {
    let key = jsonwebtoken::EncodingKey::from_ec_pem(TEST_KEY.serialize_pem().as_bytes()).unwrap();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256),
        &claims,
        &key,
    )
    .unwrap()
}

#[tokio::test]
async fn jwt_login_checks_issuer_audience_and_bound_claims() {
    let store = PluginSecretStore::in_memory().unwrap();
    let config = JwtConfig {
        issuer: "https://token.actions.githubusercontent.com".into(),
        jwks_url: None,
        public_key_pem: Some(TEST_KEY.public_key_pem()),
        audiences: vec!["ryu".into()],
        bound_claims: BTreeMap::from([("repository".into(), vec!["acme/*".into()])]),
    };
    store
        .machine_create(
            "gha",
            AuthMethod::Jwt(config),
            vec!["deploy".into()],
            None,
            &AuditActor::system(),
        )
        .await
        .unwrap();
    let exp = chrono::Utc::now().timestamp() + 300;
    let good = sign(json!({
        "iss": "https://token.actions.githubusercontent.com", "aud": "ryu",
        "repository": "acme/api", "exp": exp
    }));
    let token = store.jwt_login("gha", &good).await.unwrap();
    assert_eq!(token.policies, vec!["deploy".to_owned()]);
    let wrong_repo = sign(json!({
        "iss": "https://token.actions.githubusercontent.com", "aud": "ryu",
        "repository": "evil/api", "exp": exp
    }));
    assert!(store.jwt_login("gha", &wrong_repo).await.is_err());
    let wrong_aud = sign(json!({
        "iss": "https://token.actions.githubusercontent.com", "aud": "other",
        "repository": "acme/api", "exp": exp
    }));
    assert!(store.jwt_login("gha", &wrong_aud).await.is_err());
}
