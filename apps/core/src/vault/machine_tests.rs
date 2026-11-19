//! Tests for [`super`] (machine identities, bindings and token lifecycle).

use super::*;

#[tokio::test]
async fn expired_bindings_stop_granting_to_already_issued_tokens() {
    let store = PluginSecretStore::in_memory().unwrap();
    let admin = AuditActor::new("user", Some("admin"));
    let identity = store
        .machine_create(
            "deploy",
            AuthMethod::AppRole {
                role_id: String::new(),
            },
            vec![],
            Some(600),
            &admin,
        )
        .await
        .unwrap();
    let token = {
        let conn = store.conn.lock().await;
        super::super::policy::put_policy(
            &conn,
            &super::super::policy::Policy {
                name: "temp".into(),
                description: String::new(),
                rules: vec![super::super::policy::PolicyRule {
                    path: "default/**".into(),
                    capabilities: vec![super::super::policy::Capability::Read],
                    deny: false,
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        let subject = format!("machine:{}", identity.id);
        super::super::policy::bind(&conn, "temp", &subject, Some(now_millis() + 60_000), None)
            .unwrap();
        store.issue_token_locked(&conn, &identity, None).unwrap()
    };
    assert!(token.policies.contains(&"temp".to_owned()));
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_policy_bindings SET expires_at = ?1",
            params![now_millis() - 1],
        )
        .unwrap();
    }
    let principal = store.token_lookup(&token.token).await.unwrap().unwrap();
    assert!(!principal.policies.contains(&"temp".to_owned()));
}

#[tokio::test]
async fn disabling_an_identity_revokes_its_tokens() {
    let store = PluginSecretStore::in_memory().unwrap();
    let admin = AuditActor::system();
    let identity = store
        .machine_create(
            "svc",
            AuthMethod::AppRole {
                role_id: String::new(),
            },
            vec![],
            None,
            &admin,
        )
        .await
        .unwrap();
    let AuthMethod::AppRole { role_id } = identity.auth.clone() else {
        panic!("approle")
    };
    let (secret, _) = store
        .machine_issue_secret_id("svc", Some(60), None, &admin)
        .await
        .unwrap();
    let token = store.approle_login(&role_id, &secret).await.unwrap();
    store
        .machine_update("svc", None, None, Some(true), &admin)
        .await
        .unwrap();
    assert!(store.token_lookup(&token.token).await.unwrap().is_none());
    store.machine_delete("svc", &admin).await.unwrap();
    assert!(store.machine_list().await.unwrap().is_empty());
}

#[test]
fn jwt_configs_must_narrow_the_issuer() {
    let config = JwtConfig {
        issuer: "https://issuer".into(),
        jwks_url: Some("https://issuer/jwks".into()),
        public_key_pem: None,
        audiences: vec![],
        bound_claims: BTreeMap::new(),
    };
    assert!(config.validate().is_err());
}
