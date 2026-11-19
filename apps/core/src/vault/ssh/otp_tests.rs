//! Tests for [`super::otp`]: role validation, issuance bounds, and single use.

use super::otp::{SshOtpVerification, MAX_OTP_TTL_SECS};
use super::*;

fn actor() -> AuditActor {
    AuditActor::new("user", Some("alice"))
}

fn role() -> SshOtpRole {
    SshOtpRole {
        name: "hosts".into(),
        default_user: "deploy".into(),
        allowed_users: vec!["ops-*".into()],
        cidr_list: vec!["10.0.0.0/24".into()],
        exclude_cidr_list: vec!["10.0.0.128/25".into()],
        port: 2222,
        ttl_secs: 300,
    }
}

async fn setup() -> PluginSecretStore {
    let store = PluginSecretStore::in_memory().unwrap();
    store.ssh_put_otp_role(&role(), &actor()).await.unwrap();
    store
}

#[tokio::test]
async fn an_otp_verifies_exactly_once_for_its_host_and_user() {
    let store = setup().await;
    let credential = store
        .ssh_create_otp("hosts", "10.0.0.7", None, &actor())
        .await
        .unwrap();
    assert_eq!(credential.key_type, "otp");
    assert_eq!(credential.username, "deploy");
    assert_eq!(credential.port, 2222);
    assert_eq!(credential.key.len(), 36);
    // Only the hash is stored.
    let stored: String = {
        let conn = store.conn.lock().await;
        conn.query_row("SELECT otp_hash FROM vault_ssh_otps", [], |row| row.get(0))
            .unwrap()
    };
    assert_ne!(stored, credential.key);
    assert!(!stored.contains(&credential.key));

    let verified = store
        .ssh_verify_otp(&credential.key, &actor())
        .await
        .unwrap();
    assert_eq!(
        verified,
        SshOtpVerification {
            username: "deploy".into(),
            ip: "10.0.0.7".into(),
            role_name: "hosts".into(),
            port: 2222,
        }
    );
    // Single use: the second verify fails.
    let again = store
        .ssh_verify_otp(&credential.key, &actor())
        .await
        .unwrap_err();
    assert!(again.to_string().contains("OTP not found"));
    assert!(store.ssh_verify_otp("", &actor()).await.is_err());
    assert!(store
        .ssh_verify_otp("00000000-0000-0000-0000-000000000000", &actor())
        .await
        .is_err());
}

#[tokio::test]
async fn otps_are_bounded_by_the_role_hosts_and_users() {
    let store = setup().await;
    let named = store
        .ssh_create_otp("hosts", "10.0.0.9", Some("ops-alice"), &actor())
        .await
        .unwrap();
    assert_eq!(named.username, "ops-alice");
    for (ip, user) in [
        ("10.0.1.1", None),            // outside cidrList
        ("10.0.0.200", None),          // inside excludeCidrList
        ("10.0.0.9", Some("root")),    // not an allowed user
        ("10.0.0.9", Some("Ops-Bad")), // not a login name
        ("not-an-ip", None),
    ] {
        assert!(
            store
                .ssh_create_otp("hosts", ip, user, &actor())
                .await
                .is_err(),
            "{ip} {user:?}"
        );
    }
    assert!(store
        .ssh_create_otp("missing", "10.0.0.9", None, &actor())
        .await
        .is_err());
    // Two OTPs for the same host are independent.
    let first = store
        .ssh_create_otp("hosts", "10.0.0.9", None, &actor())
        .await
        .unwrap();
    let second = store
        .ssh_create_otp("hosts", "10.0.0.9", None, &actor())
        .await
        .unwrap();
    assert_ne!(first.key, second.key);
    store.ssh_verify_otp(&second.key, &actor()).await.unwrap();
    store.ssh_verify_otp(&first.key, &actor()).await.unwrap();
}

#[tokio::test]
async fn expired_otps_and_deleted_roles_no_longer_verify() {
    let store = setup().await;
    let credential = store
        .ssh_create_otp("hosts", "10.0.0.7", None, &actor())
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute("UPDATE vault_ssh_otps SET expires_at = 1", [])
            .unwrap();
    }
    assert!(store
        .ssh_verify_otp(&credential.key, &actor())
        .await
        .is_err());
    let pending = store
        .ssh_create_otp("hosts", "10.0.0.7", None, &actor())
        .await
        .unwrap();
    assert!(store.ssh_delete_otp_role("hosts", &actor()).await.unwrap());
    assert!(store.ssh_verify_otp(&pending.key, &actor()).await.is_err());
    assert!(store.ssh_list_otp_roles().await.unwrap().is_empty());
}

#[tokio::test]
async fn otp_roles_are_validated_and_normalized() {
    let store = PluginSecretStore::in_memory().unwrap();
    let saved = store
        .ssh_put_otp_role(
            &SshOtpRole {
                cidr_list: vec!["10.0.0.7/24".into()],
                ..role()
            },
            &actor(),
        )
        .await
        .unwrap();
    assert_eq!(saved.cidr_list, vec!["10.0.0.0/24".to_owned()]);
    let bad = [
        SshOtpRole {
            name: "Bad Name".into(),
            ..role()
        },
        SshOtpRole {
            default_user: "Root!".into(),
            ..role()
        },
        SshOtpRole {
            cidr_list: vec![],
            ..role()
        },
        SshOtpRole {
            cidr_list: vec!["10.0.0.0/33".into()],
            ..role()
        },
        SshOtpRole { port: 0, ..role() },
        SshOtpRole {
            ttl_secs: 30,
            ..role()
        },
        SshOtpRole {
            ttl_secs: MAX_OTP_TTL_SECS + 1,
            ..role()
        },
    ];
    for role in bad {
        assert!(
            store.ssh_put_otp_role(&role, &actor()).await.is_err(),
            "{role:?}"
        );
    }
    assert_eq!(store.ssh_list_otp_roles().await.unwrap(), vec![saved]);
}
