//! Identity token tests.

use jsonwebtoken::{decode, decode_header, DecodingKey, Validation};

use super::*;

fn actor() -> AuditActor {
    AuditActor::new("user", Some("u1"))
}

fn subject() -> IdentitySubject {
    IdentitySubject {
        kind: "machine".into(),
        id: "mid_1".into(),
        name: "ci \"runner\"".into(),
        policies: vec!["deploy".into()],
    }
}

async fn configured_store() -> PluginSecretStore {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .identity_set_config(
            &IdentityConfig {
                issuer: Some("https://node.example.com/api/vault/identity".into()),
                ..IdentityConfig::default()
            },
            &actor(),
        )
        .await
        .unwrap();
    store
}

fn verify(jwks: &Value, token: &str, audience: &str) -> Map<String, Value> {
    let kid = decode_header(token).unwrap().kid.unwrap();
    let jwk = jwks["keys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|key| key["kid"] == kid)
        .expect("kid is published");
    // The published JWK alone must verify the token, whatever its algorithm.
    let jwk_value: jsonwebtoken::jwk::Jwk = serde_json::from_value(jwk.clone()).unwrap();
    let key = DecodingKey::from_jwk(&jwk_value).unwrap();
    let algorithm: Algorithm = jwk["alg"].as_str().unwrap().parse().unwrap();
    assert_eq!(decode_header(token).unwrap().alg, algorithm);
    let mut validation = Validation::new(algorithm);
    validation.set_audience(&[audience]);
    validation.set_issuer(&["https://node.example.com/api/vault/identity"]);
    decode::<Map<String, Value>>(token, &key, &validation)
        .unwrap()
        .claims
}

#[tokio::test]
async fn tokens_verify_against_the_published_jwks() {
    let store = configured_store().await;
    store
        .identity_put_role(
            &IdentityRole {
                name: "aws".into(),
                audience: "sts.amazonaws.com".into(),
                ttl_secs: 900,
                template: Some(
                    r#"{"machine": "{{identity.name}}", "policies": {{identity.policies}}}"#.into(),
                ),
            },
            &actor(),
        )
        .await
        .unwrap();
    let issued = store
        .identity_token("aws", &subject(), &actor())
        .await
        .unwrap();
    let claims = verify(
        &store.identity_jwks().await.unwrap(),
        &issued.token,
        "sts.amazonaws.com",
    );
    assert_eq!(claims["sub"], "machine:mid_1");
    assert_eq!(claims["machine"], "ci \"runner\"");
    assert_eq!(claims["policies"], json!(["deploy"]));
    assert_eq!(
        claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap(),
        900
    );
    let discovery = store.identity_discovery().await.unwrap().unwrap();
    assert_eq!(
        discovery["jwks_uri"],
        "https://node.example.com/api/vault/identity/.well-known/keys"
    );
}

#[tokio::test]
async fn jwks_is_published_before_the_first_token() {
    let store = configured_store().await;
    assert_eq!(
        store.identity_jwks().await.unwrap()["keys"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn rotation_keeps_old_tokens_verifiable_and_prunes_later() {
    let store = configured_store().await;
    store
        .identity_put_role(
            &IdentityRole {
                name: "gcp".into(),
                audience: "gcp".into(),
                ttl_secs: 600,
                template: None,
            },
            &actor(),
        )
        .await
        .unwrap();
    let old = store
        .identity_token("gcp", &subject(), &actor())
        .await
        .unwrap();
    let new_kid = store.identity_rotate_key(&actor()).await.unwrap();
    let jwks = store.identity_jwks().await.unwrap();
    assert_eq!(jwks["keys"].as_array().unwrap().len(), 2);
    verify(&jwks, &old.token, "gcp");
    let fresh = store
        .identity_token("gcp", &subject(), &actor())
        .await
        .unwrap();
    assert_eq!(
        decode_header(&fresh.token).unwrap().kid.as_deref(),
        Some(new_kid.as_str())
    );
    // Not due yet; nothing pruned inside the window.
    assert_eq!(store.identity_maintain().await.unwrap(), (false, 0));
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_identity_keys SET retired_at = retired_at - ?1
             WHERE retired_at IS NOT NULL",
            params![MAX_TOKEN_TTL_SECS * 1000 + 1],
        )
        .unwrap();
    }
    assert_eq!(store.identity_maintain().await.unwrap(), (false, 1));
    assert_eq!(
        store.identity_jwks().await.unwrap()["keys"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn roles_and_config_are_validated() {
    let store = PluginSecretStore::in_memory().unwrap();
    let role = |template: &str| IdentityRole {
        name: "r".into(),
        audience: "a".into(),
        ttl_secs: 300,
        template: Some(template.into()),
    };
    assert!(store
        .identity_put_role(&role(r#"{"sub": "x"}"#), &actor())
        .await
        .is_err());
    assert!(store
        .identity_put_role(&role(r#"{"x": "{{identity.secret}}"}"#), &actor())
        .await
        .is_err());
    assert!(store
        .identity_put_role(&role(r#"["not", "an", "object"]"#), &actor())
        .await
        .is_err());
    assert!(store
        .identity_put_role(
            &IdentityRole {
                ttl_secs: MAX_TOKEN_TTL_SECS + 1,
                ..role("{}")
            },
            &actor()
        )
        .await
        .is_err());
    store
        .identity_put_role(&role("{}"), &actor())
        .await
        .unwrap();
    // No issuer: tokens are refused and discovery is absent.
    if std::env::var(ENV_ISSUER).is_err() {
        assert!(store
            .identity_token("r", &subject(), &actor())
            .await
            .is_err());
        assert!(store.identity_discovery().await.unwrap().is_none());
    }
    for bad in [
        "ftp://x",
        "https://x/",
        "https://x?y",
        "https://",
        "node.example.com",
    ] {
        assert!(
            store
                .identity_set_config(
                    &IdentityConfig {
                        issuer: Some(bad.into()),
                        ..IdentityConfig::default()
                    },
                    &actor()
                )
                .await
                .is_err(),
            "{bad}"
        );
    }
    assert!(store
        .identity_token("missing", &subject(), &actor())
        .await
        .is_err());
}

async fn token_for(store: &PluginSecretStore) -> String {
    store
        .identity_put_role(
            &IdentityRole {
                name: "fed".into(),
                audience: "fed".into(),
                ttl_secs: 300,
                template: None,
            },
            &actor(),
        )
        .await
        .unwrap();
    store
        .identity_token("fed", &subject(), &actor())
        .await
        .unwrap()
        .token
}

/// Write the config without a signing algorithm, as older clients do.
async fn configured_store_again(store: &PluginSecretStore) -> IdentityConfig {
    store
        .identity_set_config(
            &IdentityConfig {
                issuer: Some("https://node.example.com/api/vault/identity".into()),
                ..IdentityConfig::default()
            },
            &actor(),
        )
        .await
        .unwrap()
}

async fn set_algorithm(store: &PluginSecretStore, algorithm: IdentitySigningAlgorithm) {
    store
        .identity_set_config(
            &IdentityConfig {
                issuer: Some("https://node.example.com/api/vault/identity".into()),
                signing_algorithm: Some(algorithm),
                ..IdentityConfig::default()
            },
            &actor(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn rs256_and_eddsa_tokens_verify_against_their_published_keys() {
    for (algorithm, kty) in [
        (IdentitySigningAlgorithm::RS256, "RSA"),
        (IdentitySigningAlgorithm::EdDSA, "OKP"),
    ] {
        let store = PluginSecretStore::in_memory().unwrap();
        set_algorithm(&store, algorithm).await;
        let token = token_for(&store).await;
        let jwks = store.identity_jwks().await.unwrap();
        assert_eq!(jwks["keys"][0]["kty"], kty);
        assert_eq!(jwks["keys"][0]["alg"], algorithm.as_str());
        let claims = verify(&jwks, &token, "fed");
        assert_eq!(claims["sub"], "machine:mid_1");
        let discovery = store.identity_discovery().await.unwrap().unwrap();
        assert_eq!(
            discovery["id_token_signing_alg_values_supported"],
            json!([algorithm.as_str()])
        );
        assert_eq!(
            store.identity_config().await.unwrap().signing_algorithm,
            Some(algorithm)
        );
    }
}

#[tokio::test]
async fn changing_the_algorithm_rotates_and_keeps_old_tokens_verifiable() {
    let store = configured_store().await;
    let old = token_for(&store).await;
    set_algorithm(&store, IdentitySigningAlgorithm::EdDSA).await;
    let new = token_for(&store).await;
    assert_eq!(decode_header(&new).unwrap().alg, Algorithm::EdDSA);
    let jwks = store.identity_jwks().await.unwrap();
    assert_eq!(jwks["keys"].as_array().unwrap().len(), 2);
    verify(&jwks, &old, "fed");
    verify(&jwks, &new, "fed");
    let discovery = store.identity_discovery().await.unwrap().unwrap();
    assert_eq!(
        discovery["id_token_signing_alg_values_supported"],
        json!(["EdDSA", "ES256"])
    );
    // Setting the same algorithm again, or omitting it, does not rotate.
    set_algorithm(&store, IdentitySigningAlgorithm::EdDSA).await;
    let _ = configured_store_again(&store).await;
    assert_eq!(
        store.identity_config().await.unwrap().signing_algorithm,
        Some(IdentitySigningAlgorithm::EdDSA)
    );
    assert_eq!(
        store.identity_jwks().await.unwrap()["keys"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(
        serde_json::from_value::<IdentityConfig>(json!({ "signingAlgorithm": "HS256" })).is_err()
    );
}

#[test]
fn rows_written_before_algorithms_existed_publish_as_es256() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE vault_identity_keys (kid TEXT PRIMARY KEY, nonce BLOB NOT NULL,
             ciphertext BLOB NOT NULL, key_version INTEGER NOT NULL DEFAULT 0,
             x TEXT NOT NULL, y TEXT NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER);
         CREATE TABLE vault_identity_config (id INTEGER PRIMARY KEY CHECK (id = 1),
             issuer TEXT, rotation_period_secs INTEGER NOT NULL);
         INSERT INTO vault_identity_keys VALUES ('k1', x'00', x'00', 0, 'X', 'Y', 1, NULL);
         INSERT INTO vault_identity_config VALUES (1, NULL, 3600);",
    )
    .unwrap();
    init_schema(&conn).unwrap();
    init_schema(&conn).unwrap();
    let (alg, jwk): (String, Option<String>) = conn
        .query_row("SELECT alg, jwk FROM vault_identity_keys", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(alg, "ES256");
    let published = keys::published_jwk("k1".into(), &alg, "X".into(), "Y".into(), jwk);
    assert_eq!(
        published,
        json!({ "kty": "EC", "crv": "P-256", "x": "X", "y": "Y", "kid": "k1", "alg": "ES256", "use": "sig" })
    );
    assert_eq!(
        read_config(&conn).unwrap().signing_algorithm,
        Some(IdentitySigningAlgorithm::ES256)
    );
}
