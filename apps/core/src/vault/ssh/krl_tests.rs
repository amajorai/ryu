//! Tests for [`super::krl`]: revocation by serial and key ID, the KRL's
//! encoding, and `ssh-keygen -Q` against it.

use super::*;

fn actor() -> AuditActor {
    AuditActor::new("user", Some("alice"))
}

fn user_key() -> String {
    let seed: [u8; 32] = random_bytes(32).try_into().unwrap();
    let key = ed25519_dalek::SigningKey::from_bytes(&seed);
    openssh_public_line(&key.verifying_key().to_bytes(), "alice@laptop")
}

async fn setup() -> PluginSecretStore {
    let store = PluginSecretStore::in_memory().unwrap();
    store.ssh_create_ca("ops", &actor()).await.unwrap();
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
    store
}

async fn sign(store: &PluginSecretStore, key_id: &str) -> SignedCertificate {
    store
        .ssh_sign(
            "dev",
            &user_key(),
            &["deploy".into()],
            None,
            Some(key_id),
            &actor(),
        )
        .await
        .unwrap()
}

/// The revoked serials a KRL lists, after checking its header and binding.
fn krl_serials(krl: &[u8], ca_key: &[u8]) -> Vec<u64> {
    assert_eq!(&krl[..8], b"SSHKRL\n\0");
    assert_eq!(u32::from_be_bytes(krl[8..12].try_into().unwrap()), 1);
    let mut rest = &krl[36..]; // magic, version, krl_version, date, flags
    assert!(read_string(&mut rest).unwrap().is_empty()); // reserved
    assert_eq!(read_string(&mut rest).unwrap(), b"ryu-ssh-ca-ops");
    if rest.is_empty() {
        return Vec::new();
    }
    assert_eq!(rest[0], 1, "certificates section");
    rest = &rest[1..];
    let mut section = read_string(&mut rest).unwrap();
    assert!(rest.is_empty());
    assert_eq!(read_string(&mut section).unwrap(), ca_key);
    assert!(read_string(&mut section).unwrap().is_empty());
    assert_eq!(section[0], 0x20, "serial list");
    section = &section[1..];
    let list = read_string(&mut section).unwrap();
    assert!(section.is_empty());
    list.chunks(8)
        .map(|chunk| u64::from_be_bytes(chunk.try_into().unwrap()))
        .collect()
}

#[tokio::test]
async fn the_krl_lists_serials_revoked_by_serial_or_key_id() {
    let store = setup().await;
    let ca_line = store.ssh_list_cas().await.unwrap().remove(0).1;
    let (_, ca_key) = parse_public_key(&ca_line).unwrap();
    assert!(krl_serials(&store.ssh_krl("ops").await.unwrap(), &ca_key).is_empty());
    let kept = sign(&store, "kept").await;
    let by_serial = sign(&store, "one").await;
    let by_id_a = sign(&store, "compromised").await;
    let by_id_b = sign(&store, "compromised").await;
    let revoked = store
        .ssh_revoke("ops", &SshRevocation::Serial(by_serial.serial), &actor())
        .await
        .unwrap();
    assert_eq!(revoked[0].serial, by_serial.serial.to_string());
    assert!(revoked[0].revoked_at.is_some());
    let revoked = store
        .ssh_revoke("ops", &SshRevocation::KeyId("compromised".into()), &actor())
        .await
        .unwrap();
    assert_eq!(revoked.len(), 2);
    let mut expected = vec![by_serial.serial, by_id_a.serial, by_id_b.serial];
    expected.sort_unstable();
    let listed = krl_serials(&store.ssh_krl("ops").await.unwrap(), &ca_key);
    assert_eq!(listed, expected);
    assert!(!listed.contains(&kept.serial));
    // Unknown serials, key IDs, and CAs are refused; nothing else changes.
    assert!(store
        .ssh_revoke("ops", &SshRevocation::Serial(kept.serial ^ 1), &actor())
        .await
        .is_err());
    assert!(store
        .ssh_revoke("ops", &SshRevocation::KeyId("nobody".into()), &actor())
        .await
        .is_err());
    assert!(store
        .ssh_revoke("nope", &SshRevocation::Serial(kept.serial), &actor())
        .await
        .is_err());
    assert!(store.ssh_krl("nope").await.is_err());
    let records = store.ssh_list_certs("ops").await.unwrap();
    assert_eq!(records.len(), 4);
    assert_eq!(
        records
            .iter()
            .filter(|record| record.revoked_at.is_some())
            .count(),
        3
    );
    // Expired certificates drop out of the KRL.
    {
        let conn = store.conn.lock().await;
        conn.execute("UPDATE vault_ssh_certs SET valid_before = 1", [])
            .unwrap();
    }
    assert!(krl_serials(&store.ssh_krl("ops").await.unwrap(), &ca_key).is_empty());
}

#[tokio::test]
async fn ssh_keygen_reports_revoked_certificates_from_the_krl_when_available() {
    if std::process::Command::new("ssh-keygen")
        .arg("-?")
        .output()
        .is_err()
    {
        return;
    }
    let store = setup().await;
    let kept = sign(&store, "kept").await;
    let gone = sign(&store, "gone").await;
    store
        .ssh_revoke("ops", &SshRevocation::Serial(gone.serial), &actor())
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let krl = dir.path().join("revoked.krl");
    std::fs::write(&krl, store.ssh_krl("ops").await.unwrap()).unwrap();
    for (cert, revoked) in [(&kept, false), (&gone, true)] {
        let path = dir.path().join(format!("{}-cert.pub", cert.serial));
        std::fs::write(&path, &cert.certificate).unwrap();
        let output = std::process::Command::new("ssh-keygen")
            .arg("-Q")
            .arg("-f")
            .arg(&krl)
            .arg(&path)
            .output()
            .unwrap();
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(text.contains("REVOKED"), revoked, "{text}");
        assert_eq!(output.status.success(), !revoked, "{text}");
    }
}

#[test]
fn an_empty_krl_is_a_bare_header() {
    let krl = krl::build_krl(b"ca", &[], 0, 1_700_000_000, "c");
    assert_eq!(krl.len(), 8 + 4 + 8 + 8 + 8 + 4 + 4 + 1);
    let with = krl::build_krl(b"ca", &[3, 1, 3], 7, 1_700_000_000, "c");
    // Serials are sorted and deduplicated: two 8-byte entries.
    assert!(with.ends_with(&[0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 3]));
    assert_eq!(u64::from_be_bytes(with[12..20].try_into().unwrap()), 7);
}
