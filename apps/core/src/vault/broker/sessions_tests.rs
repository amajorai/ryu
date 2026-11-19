use super::*;

fn request(subject: &str) -> MintRequest {
    MintRequest {
        environment: "default".into(),
        services: vec!["openai".into(), "github".into(), "openai".into()],
        label: "agent".into(),
        ttl_secs: None,
        minted_by: subject.into(),
        not_after: None,
        minted_token: None,
        minter_scope: None,
    }
}

#[tokio::test]
async fn sessions_mint_lookup_and_revoke() {
    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    let conn = store.conn.lock().await;
    let (token, session) = mint(&conn, request("user:u1")).unwrap();
    assert!(token.starts_with(TOKEN_PREFIX));
    assert_eq!(session.services, vec!["github", "openai"]);
    assert_eq!(session.user_id(), Some("u1"));
    let stored: String = conn
        .query_row("SELECT token_hash FROM vault_broker_sessions", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_ne!(stored, token);
    assert_eq!(lookup(&conn, &token, None).unwrap().unwrap().id, session.id);
    assert!(lookup(&conn, "rvb_wrong", None).unwrap().is_none());
    assert!(lookup(&conn, "rvt_other", None).unwrap().is_none());
    assert!(revoke(&conn, &session.id).unwrap());
    assert!(lookup(&conn, &token, None).unwrap().is_none());
    // Revoked sessions stay as history; prune trims only past the cap.
    assert_eq!(prune(&conn, now_millis()).unwrap(), 0);
    assert!(get(&conn, &session.id)
        .unwrap()
        .unwrap()
        .revoked_at
        .is_some());
}

#[tokio::test]
async fn minting_enforces_ttl_caps_and_limits() {
    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    let conn = store.conn.lock().await;
    let mut bad = request("operator");
    bad.ttl_secs = Some(10);
    assert!(mint(&conn, bad).is_err());
    let mut bad = request("operator");
    bad.services.clear();
    assert!(mint(&conn, bad).is_err());
    let mut capped = request("machine:m1");
    capped.not_after = Some(now_millis() + 5_000);
    let (_, session) = mint(&conn, capped).unwrap();
    assert!(session.expires_at <= now_millis() + 5_000);
    for _ in 1..MAX_ACTIVE_PER_SUBJECT {
        mint(&conn, request("machine:m1")).unwrap();
    }
    let error = mint(&conn, request("machine:m1")).unwrap_err();
    assert_eq!(
        error.downcast_ref::<VaultError>().unwrap().code(),
        "vault_conflict"
    );
    assert!(mint(&conn, request("machine:m2")).is_ok());
}

#[tokio::test]
async fn machine_minted_sessions_end_with_their_token() {
    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    let issued = crate::vault::broker::test_machine_token(&store, "ci", Vec::new()).await;
    let (token, session) = {
        let conn = store.conn.lock().await;
        let mut minted = request(&format!("machine:{}", issued.identity_id));
        minted.minted_token = Some(issued.accessor.clone());
        minted.not_after = Some(issued.expires_at);
        mint(&conn, minted).unwrap()
    };
    assert_eq!(
        session.minted_token.as_deref(),
        Some(issued.accessor.as_str())
    );
    {
        let conn = store.conn.lock().await;
        assert!(lookup(&conn, &token, None).unwrap().is_some());
        assert!(live(&conn, &session.id).unwrap().is_some());
        assert_eq!(list(&conn).unwrap().len(), 1);
    }
    store
        .token_revoke(&issued.accessor, &crate::vault::audit::AuditActor::system())
        .await
        .unwrap();
    let conn = store.conn.lock().await;
    assert!(lookup(&conn, &token, None).unwrap().is_none());
    assert!(live(&conn, &session.id).unwrap().is_none());
    assert!(list(&conn).unwrap().is_empty());
    // The row itself is untouched; only liveness follows the token.
    assert!(get(&conn, &session.id)
        .unwrap()
        .unwrap()
        .revoked_at
        .is_none());
}

#[tokio::test]
async fn sessions_of_a_dead_minting_token_free_their_slots() {
    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    let issued = crate::vault::broker::test_machine_token(&store, "ci", Vec::new()).await;
    let subject = format!("machine:{}", issued.identity_id);
    let minted_with = |accessor: &str, expires_at: i64| {
        let mut minted = request(&subject);
        minted.minted_token = Some(accessor.to_owned());
        minted.not_after = Some(expires_at);
        minted
    };
    {
        let conn = store.conn.lock().await;
        for _ in 0..MAX_ACTIVE_PER_SUBJECT {
            mint(&conn, minted_with(&issued.accessor, issued.expires_at)).unwrap();
        }
        assert!(mint(&conn, minted_with(&issued.accessor, issued.expires_at)).is_err());
    }
    store
        .token_revoke(&issued.accessor, &crate::vault::audit::AuditActor::system())
        .await
        .unwrap();
    // A fresh login (any live token) mints again: the dead token's
    // sessions no longer count toward the subject's limit.
    let fresh = crate::vault::broker::test_machine_token(&store, "ci-2", Vec::new()).await;
    let conn = store.conn.lock().await;
    assert!(mint(&conn, minted_with(&fresh.accessor, fresh.expires_at)).is_ok());
}

#[tokio::test]
async fn machine_minted_sessions_keep_their_token_cidr_binding() {
    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    let issued = crate::vault::broker::test_machine_token(&store, "ci", Vec::new()).await;
    let conn = store.conn.lock().await;
    conn.execute(
        "UPDATE vault_tokens SET bound_cidrs = ?1 WHERE accessor = ?2",
        params![r#"["10.0.0.0/8"]"#, issued.accessor],
    )
    .unwrap();
    let mut minted = request(&format!("machine:{}", issued.identity_id));
    minted.minted_token = Some(issued.accessor.clone());
    minted.not_after = Some(issued.expires_at);
    let (token, session) = mint(&conn, minted).unwrap();
    let inside: IpAddr = "10.1.2.3".parse().unwrap();
    let outside: IpAddr = "127.0.0.1".parse().unwrap();
    assert_eq!(
        lookup(&conn, &token, Some(inside)).unwrap().unwrap().id,
        session.id
    );
    assert!(lookup(&conn, &token, Some(outside)).unwrap().is_none());
    assert!(lookup(&conn, &token, None).unwrap().is_none());
    // Sessions a human minted carry no token binding.
    let (human, _) = mint(&conn, request("user:u1")).unwrap();
    assert!(lookup(&conn, &human, Some(outside)).unwrap().is_some());
}

#[tokio::test]
async fn use_limited_tokens_cannot_mint_sessions() {
    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    let issued = crate::vault::broker::test_machine_token(&store, "ci", Vec::new()).await;
    let conn = store.conn.lock().await;
    check_minting_token(&conn, &issued.accessor).unwrap();
    conn.execute(
        "UPDATE vault_tokens SET num_uses = 3 WHERE accessor = ?1",
        params![issued.accessor],
    )
    .unwrap();
    let error = check_minting_token(&conn, &issued.accessor).unwrap_err();
    assert_eq!(
        error.downcast_ref::<VaultError>().unwrap().code(),
        "vault_denied"
    );
}

#[tokio::test]
async fn live_rechecks_revocation_by_id() {
    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    let conn = store.conn.lock().await;
    let (_, session) = mint(&conn, request("operator")).unwrap();
    assert!(live(&conn, &session.id).unwrap().is_some());
    revoke(&conn, &session.id).unwrap();
    assert!(live(&conn, &session.id).unwrap().is_none());
    assert!(live(&conn, "bvs_missing").unwrap().is_none());
}

#[test]
fn authorization_values_parse_every_form() {
    let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
    assert_eq!(
        parse_authorization("Bearer rvb_abc").as_deref(),
        Some("rvb_abc")
    );
    assert_eq!(
        parse_authorization(&format!("Basic {}", b64("rvb_abc"))).as_deref(),
        Some("rvb_abc")
    );
    assert_eq!(
        parse_authorization(&format!("basic {}", b64("rvb:rvb_abc"))).as_deref(),
        Some("rvb_abc")
    );
    assert_eq!(
        parse_authorization(&format!("Basic {}", b64("rvb_abc:prod"))).as_deref(),
        Some("rvb_abc")
    );
    assert_eq!(parse_authorization("Bearer rvt_machine"), None);
    assert_eq!(parse_authorization("Basic !!!"), None);
    assert_eq!(parse_authorization("Digest x"), None);
}
