//! Accounts and approval gating against the fake `bws` CLI.

use super::*;

// ── Accounts ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn tokens_are_sealed_and_never_returned() {
    assert!(crate::vault::ENCRYPTED_TABLES.contains(&"vault_pm_accounts"));
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    let account = add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    assert_eq!(account.state, AccountState::Connected);
    assert!(account
        .binary_path
        .as_deref()
        .unwrap()
        .ends_with(&fake_cli_file_name("bws")));
    let listed = serde_json::to_string(&store.pm_account_list().await.unwrap()).unwrap();
    assert!(!listed.contains(BWS_TOKEN));
    let conn = store.conn.lock().await;
    let ciphertext: Vec<u8> = conn
        .query_row(
            "SELECT ciphertext FROM vault_pm_accounts WHERE id = ?1",
            params![account.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!ciphertext
        .windows(BWS_TOKEN.len())
        .any(|window| window == BWS_TOKEN.as_bytes()));
    drop(conn);
    let audit = serde_json::to_string(&audit_rows(&store).await).unwrap();
    assert!(!audit.contains(BWS_TOKEN));
}

#[tokio::test]
async fn accounts_validate_their_shape() {
    let store = PluginSecretStore::in_memory().unwrap();
    let create = |body: Value| {
        let store = &store;
        async move {
            let input: AccountInput = serde_json::from_value(body).unwrap();
            store.pm_account_create(input, &actor()).await
        }
    };
    // Connect needs an address; a service account takes none.
    assert!(
        create(json!({ "name": "a", "provider": "1password-connect", "token": "t" }))
            .await
            .is_err()
    );
    // Link-local and metadata addresses are refused by the SSRF guard.
    assert!(create(json!({
        "name": "a", "provider": "1password-connect",
        "address": "https://169.254.169.254", "token": "t",
    }))
    .await
    .is_err());
    set_binary_for_test(Some(PathBuf::from("/definitely/not/op")));
    let missing = create(json!({
        "name": "a", "provider": "1password-service-account", "token": "t",
    }))
    .await;
    set_binary_for_test(None);
    assert!(missing.is_err());
    assert!(create(json!({
        "name": "a", "provider": "1password-service-account",
        "address": "https://x.example", "token": "t",
    }))
    .await
    .is_err());
    // Empty or multi-line tokens, bad names.
    for body in [
        json!({ "name": "a", "provider": "1password-connect", "address": "http://127.0.0.1:9", "token": " " }),
        json!({ "name": "a", "provider": "1password-connect", "address": "http://127.0.0.1:9", "token": "a\nb" }),
        json!({ "name": "Bad", "provider": "1password-connect", "address": "http://127.0.0.1:9", "token": "t" }),
    ] {
        assert!(create(body).await.is_err());
    }
    create(json!({
        "name": "a", "provider": "1password-connect", "address": "http://127.0.0.1:9", "token": "t",
    }))
    .await
    .unwrap();
    let duplicate = create(json!({
        "name": "a", "provider": "1password-connect", "address": "http://127.0.0.1:9", "token": "t",
    }))
    .await
    .unwrap_err();
    assert!(matches!(
        duplicate.downcast_ref::<VaultError>(),
        Some(VaultError::Conflict(_))
    ));
}

// ── Approval gating (Bitwarden) ───────────────────────────────────────────

#[tokio::test]
async fn first_use_waits_for_approval_without_calling_the_provider() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let reference = format!("bws://{SECRET_ID}");

    let request = pending(
        store
            .pm_resolve(&reference, &consumer("machine:m1"), &actor())
            .await
            .unwrap(),
    );
    let credential_use = request.credential_use.clone().unwrap();
    assert_eq!(credential_use.subject, "machine:m1");
    assert_eq!(credential_use.reference, format!("bws://team@{SECRET_ID}"));
    assert_eq!(credential_use.provider, "bitwarden-sm");
    assert_eq!(
        invocations(dir.path()),
        0,
        "the provider was contacted before approval"
    );
    // Retrying returns the same request.
    let again = pending(
        store
            .pm_resolve(&reference, &consumer("machine:m1"), &actor())
            .await
            .unwrap(),
    );
    assert_eq!(again.id, request.id);
    assert_eq!(invocations(dir.path()), 0);

    store
        .pm_approve(&request.id, GrantMode::Once, "ok", "user:alice", &actor())
        .await
        .unwrap();
    // Another consumer still needs its own approval.
    pending(
        store
            .pm_resolve(&reference, &consumer("machine:m2"), &actor())
            .await
            .unwrap(),
    );
    assert_eq!(invocations(dir.path()), 0);

    let resolved = value(
        store
            .pm_resolve(&reference, &consumer("machine:m1"), &actor())
            .await
            .unwrap(),
    );
    assert_eq!(resolved, "bw-secret-value");
    let log = calls(dir.path());
    assert_eq!(
        log.iter()
            .filter(|l| l.starts_with("argv:"))
            .collect::<Vec<_>>(),
        vec![&format!("argv:secret get {SECRET_ID} --output json")]
    );
    assert!(log.contains(&"token-in-argv:no".to_owned()));
    assert!(log.contains(&"env-token:yes".to_owned()));
    assert!(!log.iter().any(|l| l == "token-in-argv:yes"));

    // Approve-once is spent: the next use asks again, without a provider call.
    let next = pending(
        store
            .pm_resolve(&reference, &consumer("machine:m1"), &actor())
            .await
            .unwrap(),
    );
    assert_ne!(next.id, request.id);
    assert_eq!(invocations(dir.path()), 1);

    // Every resolution is audited with provider, account, and reference, but
    // never the value.
    let rows = audit_rows(&store).await;
    let resolves: Vec<_> = rows.iter().filter(|r| r.action == "pm.resolve").collect();
    assert!(resolves.iter().any(|r| r.outcome == "ok"));
    assert!(resolves.iter().any(|r| r.outcome == "pending"));
    let text = serde_json::to_string(&rows).unwrap();
    assert!(text.contains("bitwarden-sm") && text.contains(&format!("bws://team@{SECRET_ID}")));
    assert!(!text.contains("bw-secret-value"));
}

#[tokio::test]
async fn ttl_grants_last_until_revoked_or_expired() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let reference = format!("bws://{SECRET_ID}");
    let request = pending(
        store
            .pm_resolve(&reference, &consumer("user:bob"), &actor())
            .await
            .unwrap(),
    );
    // The default approval is 30 days.
    let grant = store
        .pm_approve(&request.id, GrantMode::default(), "", "operator", &actor())
        .await
        .unwrap();
    assert_eq!(grant.mode, GrantMode::Month);
    assert_eq!(grant.uses_remaining, None);
    let days = (grant.expires_at - grant.created_at) / (24 * 3600 * 1000);
    assert_eq!(days, 30);
    // An approved request cannot be approved again.
    assert!(store
        .pm_approve(&request.id, GrantMode::Hour, "", "operator", &actor())
        .await
        .is_err());
    for _ in 0..3 {
        assert_eq!(
            value(
                store
                    .pm_resolve(&reference, &consumer("user:bob"), &actor())
                    .await
                    .unwrap()
            ),
            "bw-secret-value"
        );
    }
    assert_eq!(store.pm_grant_list(false).await.unwrap().len(), 1);

    store.pm_grant_revoke(&grant.id, &actor()).await.unwrap();
    assert!(store.pm_grant_list(false).await.unwrap().is_empty());
    assert_eq!(store.pm_grant_list(true).await.unwrap().len(), 1);
    let before = invocations(dir.path());
    pending(
        store
            .pm_resolve(&reference, &consumer("user:bob"), &actor())
            .await
            .unwrap(),
    );
    assert_eq!(invocations(dir.path()), before);

    // An expired grant no longer resolves.
    let request = pending(
        store
            .pm_resolve(&reference, &consumer("user:carol"), &actor())
            .await
            .unwrap(),
    );
    let grant = store
        .pm_approve(&request.id, GrantMode::Hour, "", "operator", &actor())
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_pm_grants SET expires_at = ?1 WHERE id = ?2",
            params![now_millis() - 1, grant.id],
        )
        .unwrap();
    }
    pending(
        store
            .pm_resolve(&reference, &consumer("user:carol"), &actor())
            .await
            .unwrap(),
    );
    assert_eq!(invocations(dir.path()), before);
}

#[tokio::test]
async fn rejected_requests_grant_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let reference = format!("bws://{SECRET_ID}");
    let request = pending(
        store
            .pm_resolve(&reference, &consumer("user:bob"), &actor())
            .await
            .unwrap(),
    );
    store
        .pm_reject(&request.id, "no", "operator", &actor())
        .await
        .unwrap();
    assert_eq!(
        store.pm_approval(&request.id).await.unwrap().status,
        ProposalStatus::Rejected
    );
    assert!(store
        .pm_approve(&request.id, GrantMode::Once, "", "operator", &actor())
        .await
        .is_err());
    pending(
        store
            .pm_resolve(&reference, &consumer("user:bob"), &actor())
            .await
            .unwrap(),
    );
    assert_eq!(invocations(dir.path()), 0);
}

#[tokio::test]
async fn fail_closed_audit_withholds_the_value_and_keeps_the_approval() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let reference = format!("bws://{SECRET_ID}");
    let request = pending(
        store
            .pm_resolve(&reference, &consumer("user:bob"), &actor())
            .await
            .unwrap(),
    );
    let grant = store
        .pm_approve(&request.id, GrantMode::Once, "", "operator", &actor())
        .await
        .unwrap();
    crate::vault::audit_devices::set_fail_closed_for_test(Some(true));
    let refused = store
        .pm_resolve(&reference, &consumer("user:bob"), &actor())
        .await;
    crate::vault::audit_devices::set_fail_closed_for_test(None);
    assert!(matches!(
        refused.unwrap_err().downcast_ref::<VaultError>(),
        Some(VaultError::AuditUnavailable)
    ));
    // The approve-once use was given back.
    assert_eq!(
        store.pm_grant(&grant.id).await.unwrap().uses_remaining,
        Some(1)
    );
    assert_eq!(
        value(
            store
                .pm_resolve(&reference, &consumer("user:bob"), &actor())
                .await
                .unwrap()
        ),
        "bw-secret-value"
    );
    assert_eq!(
        store.pm_grant(&grant.id).await.unwrap().uses_remaining,
        Some(0)
    );
}

#[tokio::test]
async fn a_rejected_token_marks_the_account_for_reconnect() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    let account = add_cli_account(&store, dir.path(), "team", "bitwarden-sm", "wrong-token").await;
    let failure = store
        .pm_account_test(&account.id, &actor())
        .await
        .unwrap_err();
    let failure = failure.downcast_ref::<ProviderFailure>().unwrap();
    assert_eq!(failure.kind, FailureKind::Auth);
    // The sanitized error never echoes provider output.
    assert!(!failure.message.contains("Unauthorized"));
    let account = store.pm_account(&account.id).await.unwrap();
    assert_eq!(account.state, AccountState::ReconnectRequired);
    assert!(account.last_error.is_some());
    let account = store
        .pm_account_set_token(&account.id, BWS_TOKEN.to_owned(), &actor())
        .await
        .unwrap();
    assert_eq!(account.state, AccountState::Connected);
    store.pm_account_test(&account.id, &actor()).await.unwrap();
    assert!(calls(dir.path()).contains(&"argv:project list --output json".to_owned()));
}

#[tokio::test]
async fn machine_sessions_need_use_on_the_account() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let reference = format!("bws://{SECRET_ID}");
    let mut machine = consumer("machine:m1");
    machine.machine_policies = Some(Vec::new());
    let denied = store
        .pm_resolve(&reference, &machine, &actor())
        .await
        .unwrap_err();
    assert!(matches!(
        denied.downcast_ref::<VaultError>(),
        Some(VaultError::Denied(_))
    ));
    assert!(store
        .pm_approvals(Some(ProposalStatus::Pending))
        .await
        .unwrap()
        .is_empty());
    machine.machine_policies = Some(vec![Policy {
        name: "pm".into(),
        description: String::new(),
        rules: vec![crate::vault::policy::PolicyRule {
            path: "sys/password-managers/team".into(),
            capabilities: vec![Capability::Use],
            ..Default::default()
        }],
    }]);
    pending(
        store
            .pm_resolve(&reference, &machine, &actor())
            .await
            .unwrap(),
    );
    assert_eq!(invocations(dir.path()), 0);
}

#[tokio::test]
async fn removing_an_account_drops_its_grants_and_requests() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    let account = add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let reference = format!("bws://{SECRET_ID}");
    let first = pending(
        store
            .pm_resolve(&reference, &consumer("user:a"), &actor())
            .await
            .unwrap(),
    );
    store
        .pm_approve(&first.id, GrantMode::Day, "", "operator", &actor())
        .await
        .unwrap();
    let open = pending(
        store
            .pm_resolve(&reference, &consumer("user:b"), &actor())
            .await
            .unwrap(),
    );
    store
        .pm_account_delete(&account.id, &actor())
        .await
        .unwrap();
    assert!(store.pm_grant_list(true).await.unwrap().is_empty());
    assert_eq!(
        store.pm_approval(&open.id).await.unwrap().status,
        ProposalStatus::Rejected
    );
    let missing = store
        .pm_resolve(&reference, &consumer("user:a"), &actor())
        .await
        .unwrap_err();
    assert!(matches!(
        missing.downcast_ref::<VaultError>(),
        Some(VaultError::NotFound(_))
    ));
}

#[tokio::test]
async fn several_accounts_of_a_family_need_a_qualified_reference() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    add_cli_account(&store, dir.path(), "ops", "bitwarden-sm", BWS_TOKEN).await;
    let ambiguous = store
        .pm_resolve(&format!("bws://{SECRET_ID}"), &consumer("user:a"), &actor())
        .await
        .unwrap_err();
    assert!(matches!(
        ambiguous.downcast_ref::<VaultError>(),
        Some(VaultError::Invalid(_))
    ));
    let request = pending(
        store
            .pm_resolve(
                &format!("bws://ops@{SECRET_ID}"),
                &consumer("user:a"),
                &actor(),
            )
            .await
            .unwrap(),
    );
    assert_eq!(request.credential_use.unwrap().account, "ops");
    // A 1Password reference does not match a Bitwarden account.
    let none = store
        .pm_resolve("op://dev/GitHub/token", &consumer("user:a"), &actor())
        .await
        .unwrap_err();
    assert!(matches!(
        none.downcast_ref::<VaultError>(),
        Some(VaultError::NotFound(_))
    ));
}
