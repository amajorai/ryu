//! Fail-closed audit devices, rolled-back audit rows, and value-free audits of
//! mutations and resolutions. Split from `kv_tests.rs`.

use super::tests::{actor, coords, ctx, write};
use super::*;

fn audit_unavailable<T: std::fmt::Debug>(result: Result<T>) -> bool {
    matches!(
        result
            .unwrap_err()
            .downcast_ref::<crate::vault::VaultError>(),
        Some(crate::vault::VaultError::AuditUnavailable)
    )
}

/// Restores the thread's fail-closed override even if an assert fails.
struct FailClosed;

impl FailClosed {
    fn on() -> Self {
        crate::vault::audit_devices::set_fail_closed_for_test(Some(true));
        Self
    }
}

impl Drop for FailClosed {
    fn drop(&mut self) {
        crate::vault::audit_devices::set_fail_closed_for_test(None);
    }
}

#[tokio::test]
async fn fail_closed_blocks_value_handouts_until_a_device_accepts() {
    use crate::vault::identity_tokens::{IdentityConfig, IdentityRole, IdentitySubject};
    use crate::vault::items::{ItemCoords, ItemPut, PutAccess};
    use crate::vault::machine::AuthMethod;
    use crate::vault::password_policy::{CharsetRule, PasswordPolicySpec};
    use crate::vault::ssh::{CertType, SshRole};
    use crate::vault::tokens::TokenRequest;
    use crate::vault::totp::TotpCreateRequest;
    use crate::vault::transit::{TransitConfigUpdate, TransitExportKind, TransitKeyType};
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    write(&store, c.clone(), "one").await;
    store
        .transit_create("payments", TransitKeyType::Aes256Gcm96, &actor())
        .await
        .unwrap();
    let ciphertext = store
        .transit_encrypt("payments", "aGVsbG8=", None, &actor())
        .await
        .unwrap();
    store
        .transit_update_config(
            "payments",
            &TransitConfigUpdate {
                exportable: Some(true),
                allow_plaintext_backup: Some(true),
                ..TransitConfigUpdate::default()
            },
            &actor(),
        )
        .await
        .unwrap();
    store
        .transit_create("signer", TransitKeyType::Ed25519, &actor())
        .await
        .unwrap();
    let item: ItemPut = serde_json::from_value(serde_json::json!({
        "kind": "login",
        "fields": [{ "name": "password", "type": "password", "required": true }],
        "values": { "password": "hunter2" },
    }))
    .unwrap();
    store
        .item_put("github", item, &actor(), PutAccess::FULL)
        .await
        .unwrap();
    let item_coords = ItemCoords::new(None, None, "github").unwrap();
    let totp_request = |name: &str| TotpCreateRequest {
        name: name.into(),
        generate: true,
        issuer: Some("GitHub".into()),
        account: Some("bot@example.com".into()),
        ..Default::default()
    };
    store
        .totp_create(&totp_request("existing"), &actor())
        .await
        .unwrap();
    let wrapped = store
        .wrap_response(b"{\"v\":1}", 120, "/p", &actor())
        .await
        .unwrap()
        .token
        .unwrap();
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
        .identity_put_role(
            &IdentityRole {
                name: "aws".into(),
                audience: "sts.amazonaws.com".into(),
                ttl_secs: 900,
                template: None,
            },
            &actor(),
        )
        .await
        .unwrap();
    let subject = IdentitySubject {
        kind: "machine".into(),
        id: "mid_1".into(),
        name: "ci".into(),
        policies: vec![],
    };
    let machine = store
        .machine_create(
            "ci",
            AuthMethod::AppRole {
                role_id: String::new(),
            },
            vec![],
            None,
            &actor(),
        )
        .await
        .unwrap();
    let AuthMethod::AppRole { role_id } = &machine.auth else {
        panic!("approle")
    };
    let (secret_id, _) = store
        .machine_issue_secret_id("ci", None, None, &actor())
        .await
        .unwrap();
    let machine_token = store.approle_login(role_id, &secret_id).await.unwrap();
    store
        .cubbyhole_put(
            &machine_token.accessor,
            "note",
            &serde_json::json!("private"),
            &actor(),
        )
        .await
        .unwrap();
    let token_rows = || async {
        let conn = store.conn.lock().await;
        conn.query_row("SELECT COUNT(*) FROM vault_tokens", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap()
    };
    let secret_id_rows = || async {
        let conn = store.conn.lock().await;
        conn.query_row("SELECT COUNT(*) FROM vault_approle_secret_ids", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap()
    };
    // The CA's own public line doubles as a well-formed key to sign.
    let ssh_key = store.ssh_create_ca("ops", &actor()).await.unwrap();
    store
        .ssh_put_role(
            &SshRole {
                name: "dev".into(),
                ca: "ops".into(),
                cert_type: CertType::User,
                allowed_principals: vec!["deploy".into()],
                default_ttl_secs: 3600,
                max_ttl_secs: 7200,
                extensions: vec![],
            },
            &actor(),
        )
        .await
        .unwrap();
    let sign = || async {
        store
            .ssh_sign(
                "dev",
                &ssh_key,
                &["deploy".to_owned()],
                None,
                None,
                &actor(),
            )
            .await
    };
    store
        .password_policy_put(
            "db",
            &PasswordPolicySpec {
                description: String::new(),
                length: 16,
                rules: vec![CharsetRule {
                    charset: "abcdefghijklmnopqrstuvwxyz0123456789".into(),
                    min_chars: 1,
                }],
            },
            &actor(),
        )
        .await
        .unwrap();
    // Fail-closed off: everything is handed out without any device.
    assert_eq!(store.reveal(&c, None, &actor()).await.unwrap(), "one");

    let guard = FailClosed::on();
    assert!(audit_unavailable(store.reveal(&c, None, &actor()).await));
    assert!(audit_unavailable(
        store.resolve_vault_secret("API_KEY", &ctx()).await
    ));
    assert!(audit_unavailable(
        store
            .transit_decrypt("payments", &ciphertext, None, &actor())
            .await
    ));
    assert!(audit_unavailable(
        store
            .snapshot_export(
                &ListFilter::default(),
                |_| true,
                "a long enough passphrase",
                &actor()
            )
            .await
    ));
    assert!(audit_unavailable(
        store.item_reveal(&item_coords, "password", &actor()).await
    ));
    assert!(audit_unavailable(
        store.totp_code("existing", &actor()).await
    ));
    // An exported create withholds the seed and leaves no key behind.
    assert!(audit_unavailable(
        store.totp_create(&totp_request("fresh"), &actor()).await
    ));
    assert!(store.totp_info("fresh").await.is_err());
    for kind in [TransitExportKind::EncryptionKey, TransitExportKind::HmacKey] {
        assert!(audit_unavailable(
            store.transit_export("payments", kind, None, &actor()).await
        ));
    }
    assert!(audit_unavailable(
        store.transit_backup("payments", &actor()).await
    ));
    assert!(audit_unavailable(
        store.transit_datakey("payments", &actor()).await
    ));
    assert!(audit_unavailable(
        store.transit_sign("signer", "aGVsbG8=", &actor()).await
    ));
    assert!(audit_unavailable(
        store.transit_hmac("payments", "aGVsbG8=", &actor()).await
    ));
    assert!(audit_unavailable(
        store
            .cubbyhole_get(&machine_token.accessor, "note", &actor())
            .await
    ));
    assert!(audit_unavailable(
        store.identity_token("aws", &subject, &actor()).await
    ));
    // Refused token issuance leaves no usable token row behind.
    let tokens_before = token_rows().await;
    assert!(audit_unavailable(
        store.approle_login(role_id, &secret_id).await
    ));
    assert!(audit_unavailable(
        store
            .token_create_for_identity("ci", TokenRequest::default(), &actor())
            .await
    ));
    assert_eq!(token_rows().await, tokens_before);
    // A refused AppRole secret id leaves no usable row behind.
    let secret_ids_before = secret_id_rows().await;
    assert!(audit_unavailable(
        store
            .machine_issue_secret_id("ci", None, None, &actor())
            .await
    ));
    assert_eq!(secret_id_rows().await, secret_ids_before);
    assert!(audit_unavailable(sign().await));
    assert!(audit_unavailable(
        store.password_policy_generate("db", &actor()).await
    ));
    // Unwrap audits after its commit, so the verdict is real; a refused
    // unwrap restores the wrapped response, so retries keep failing
    // closed instead of reporting the token as already used.
    assert!(audit_unavailable(store.wrap_unwrap(&wrapped).await));
    assert!(audit_unavailable(store.wrap_unwrap(&wrapped).await));
    // Encryption hands out nothing and still goes through.
    store
        .transit_encrypt("payments", "aGVsbG8=", None, &actor())
        .await
        .unwrap();
    // Writes, which hand out nothing, still go through.
    write(&store, c.clone(), "two").await;

    // A working synchronous device satisfies fail-closed.
    let dir = tempfile::tempdir().unwrap();
    crate::vault::audit_devices::allow_audit_dir_for_test(dir.path());
    {
        let conn = store.conn.lock().await;
        crate::vault::audit_devices::put(
            &conn,
            &crate::vault::audit_devices::AuditDevice {
                id: "local".into(),
                kind: crate::vault::audit_devices::DeviceKind::File,
                enabled: true,
                description: String::new(),
                hmac_fields: true,
                options: serde_json::json!({
                    "path": dir.path().join("audit.jsonl").to_string_lossy(),
                }),
                source: "api".into(),
            },
        )
        .unwrap();
    }
    assert_eq!(store.reveal(&c, None, &actor()).await.unwrap(), "two");
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("two")
    );
    assert_eq!(
        store
            .transit_decrypt("payments", &ciphertext, None, &actor())
            .await
            .unwrap(),
        "aGVsbG8="
    );
    assert_eq!(
        store
            .item_reveal(&item_coords, "password", &actor())
            .await
            .unwrap(),
        "hunter2"
    );
    store.totp_code("existing", &actor()).await.unwrap();
    store.transit_backup("payments", &actor()).await.unwrap();
    store
        .transit_sign("signer", "aGVsbG8=", &actor())
        .await
        .unwrap();
    store.transit_datakey("payments", &actor()).await.unwrap();
    store
        .identity_token("aws", &subject, &actor())
        .await
        .unwrap();
    assert_eq!(
        store
            .cubbyhole_get(&machine_token.accessor, "note", &actor())
            .await
            .unwrap(),
        serde_json::json!("private")
    );
    store.approle_login(role_id, &secret_id).await.unwrap();
    store
        .machine_issue_secret_id("ci", None, None, &actor())
        .await
        .unwrap();
    sign().await.unwrap();
    assert_eq!(
        store
            .password_policy_generate("db", &actor())
            .await
            .unwrap()
            .len(),
        16
    );
    // The wrapped response survived the outage and unwraps exactly once.
    assert_eq!(store.wrap_unwrap(&wrapped).await.unwrap(), b"{\"v\":1}");
    assert!(store.wrap_unwrap(&wrapped).await.is_err());
    let rewrapped = store
        .wrap_response(b"{\"v\":2}", 120, "/p", &actor())
        .await
        .unwrap()
        .token
        .unwrap();
    assert_eq!(store.wrap_unwrap(&rewrapped).await.unwrap(), b"{\"v\":2}");
    drop(guard);
}

#[tokio::test]
async fn rolled_back_audit_rows_never_reach_devices_or_subscribers() {
    let store = PluginSecretStore::in_memory().unwrap();
    let mut rx = crate::vault::events::subscribe();
    let entry = |name: &str| {
        AuditEntry::new(&actor(), "secret.update", "ok")
            .secret("node", "node-1", "default", "/", name)
    };
    {
        let conn = store.conn.lock().await;
        let tx = conn.unchecked_transaction().unwrap();
        assert!(store.audit_locked(&tx, &entry("ROLLED_BACK_ROW")));
        drop(tx);
        assert!(store.audit_locked(&conn, &entry("COMMITTED_ROW_A")));
        let tx = conn.unchecked_transaction().unwrap();
        assert!(store.audit_locked(&tx, &entry("COMMITTED_ROW_B")));
        tx.commit().unwrap();
        store.flush_audit(&conn);
    }
    let mut seen = Vec::new();
    while let Ok(event) = rx.try_recv() {
        if let Some(name) = event.name {
            if name.contains("_ROW") {
                seen.push(name);
            }
        }
    }
    assert_eq!(seen, vec!["COMMITTED_ROW_A", "COMMITTED_ROW_B"]);
}

#[tokio::test]
async fn mutations_and_resolutions_are_audited_without_values() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(
        &store,
        coords("default", "/", "API_KEY"),
        "super-secret-value",
    )
    .await;
    store.resolve_vault_secret("API_KEY", &ctx()).await.unwrap();
    store.resolve_vault_secret("MISSING", &ctx()).await.unwrap();
    let conn = store.conn.lock().await;
    let rows = crate::vault::audit::list(
        &conn,
        &crate::vault::audit::AuditFilter {
            limit: 50,
            ..Default::default()
        },
    )
    .unwrap();
    let actions: Vec<(&str, &str)> = rows
        .iter()
        .map(|row| (row.action.as_str(), row.outcome.as_str()))
        .collect();
    assert!(actions.contains(&("secret.create", "ok")));
    assert!(actions.contains(&("secret.use", "ok")));
    assert!(actions.contains(&("secret.use", "not_found")));
    let serialized = serde_json::to_string(&rows).unwrap();
    assert!(!serialized.contains("super-secret-value"));
    assert!(
        crate::vault::audit::verify(&conn, &store.audit_key)
            .unwrap()
            .ok
    );
}
