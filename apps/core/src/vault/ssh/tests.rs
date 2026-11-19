//! Tests for the SSH certificate authority.

use super::*;
use ed25519_dalek::Verifier;

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
                allowed_principals: vec!["deploy".into(), "dev-*".into()],
                default_ttl_secs: 3600,
                max_ttl_secs: 7200,
                extensions: vec!["permit-pty".into(), "permit-agent-forwarding".into()],
            },
            &actor(),
        )
        .await
        .unwrap();
    store
}

fn public_line(key_type: &str, blob: &[u8]) -> String {
    format!("{key_type} {} fixture comment", B64.encode(blob))
}

#[tokio::test]
async fn injected_certificate_metadata_is_rejected_at_parser_and_signing_sink() {
    let line = user_key();
    let (_, mut blob) = parse_public_key(&line).unwrap();
    // A forged certificate header followed by a reserved string sized to
    // swallow all legitimate fields appended by the original signer.
    blob.extend_from_slice(&1_u64.to_be_bytes());
    blob.extend_from_slice(&CertType::User.code().to_be_bytes());
    put_string(&mut blob, b"attacker");
    let mut principals = Vec::new();
    put_string(&mut principals, b"root");
    put_string(&mut blob, &principals);
    blob.extend_from_slice(&0_u64.to_be_bytes());
    blob.extend_from_slice(&u64::MAX.to_be_bytes());
    put_string(&mut blob, &[]); // critical options
    put_string(&mut blob, &[]); // extensions
                                // Generated serial/type, key id, deploy principal, validity,
                                // critical options, two extensions, and reserved string.
    let generated_length = 8 + 4 + 4 + 7 + 4 + 4 + 6 + 16 + 4 + 4 + (4 + 23 + 4) + (4 + 10 + 4) + 4;
    blob.extend_from_slice(&(generated_length as u32).to_be_bytes());
    let malicious = public_line("ssh-ed25519", &blob);
    assert!(parse_public_key(&malicious).is_err());
    let ca = CaKey::Ed25519(ed25519_dalek::SigningKey::from_bytes(&[7; 32]));
    assert!(build_certificate(
        &ca,
        "ssh-ed25519",
        &blob,
        1,
        CertType::User,
        "fixture",
        &["deploy".into()],
        0,
        60,
        &[]
    )
    .is_err());
    let store = setup().await;
    assert!(store
        .ssh_sign(
            "dev",
            &malicious,
            &["deploy".into()],
            Some(60),
            Some("fixture"),
            &actor()
        )
        .await
        .is_err());
}

#[test]
fn malformed_algorithm_fields_and_trailing_data_are_rejected() {
    let (_, mut malformed_length) = parse_public_key(&user_key()).unwrap();
    let key_length_offset = 4 + b"ssh-ed25519".len();
    for length in [33_u32, u32::MAX] {
        malformed_length[key_length_offset..key_length_offset + 4]
            .copy_from_slice(&length.to_be_bytes());
        assert!(parse_public_key(&public_line("ssh-ed25519", &malformed_length)).is_err());
    }
    for length in [0, 1, 31, 33] {
        let mut blob = Vec::new();
        put_string(&mut blob, b"ssh-ed25519");
        put_string(&mut blob, &vec![7; length]);
        assert!(parse_public_key(&public_line("ssh-ed25519", &blob)).is_err());
    }
    for integer in [vec![], vec![0], vec![0x80], vec![0, 1]] {
        let mut blob = Vec::new();
        put_string(&mut blob, b"ssh-rsa");
        put_string(&mut blob, &integer);
        put_string(&mut blob, &[1, 2, 3]);
        assert!(parse_public_key(&public_line("ssh-rsa", &blob)).is_err());
    }
    for (curve, point) in [
        ("nistp384", vec![4; 65]),
        ("nistp256", vec![0; 65]),
        ("nistp256", vec![4; 64]),
        ("unknown", vec![4; 65]),
    ] {
        let mut blob = Vec::new();
        put_string(&mut blob, b"ecdsa-sha2-nistp256");
        put_string(&mut blob, curve.as_bytes());
        put_string(&mut blob, &point);
        assert!(parse_public_key(&public_line("ecdsa-sha2-nistp256", &blob)).is_err());
    }
    let (_, blob) = parse_public_key(&user_key()).unwrap();
    assert!(parse_public_key(&public_line("ssh-rsa", &blob)).is_err());
    for length in 0..blob.len() {
        assert!(parse_public_key(&public_line("ssh-ed25519", &blob[..length])).is_err());
    }
    let mut sk_blob = Vec::new();
    put_string(&mut sk_blob, b"sk-ssh-ed25519@openssh.com");
    put_string(&mut sk_blob, &[7; 32]);
    assert!(parse_public_key(&public_line("sk-ssh-ed25519@openssh.com", &sk_blob)).is_err());
    put_string(&mut sk_blob, b"ssh:fixture");
    let key_length_offset = 4 + b"sk-ssh-ed25519@openssh.com".len();
    sk_blob[key_length_offset..key_length_offset + 4].copy_from_slice(&33_u32.to_be_bytes());
    assert!(parse_public_key(&public_line("sk-ssh-ed25519@openssh.com", &sk_blob)).is_err());
}

#[tokio::test]
async fn every_supported_key_signs_only_the_role_fields_and_rejects_trailing_bytes() {
    let store = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let mut lines = vec![user_key()];
    for (kind, bits) in [
        ("rsa", "2048"),
        ("ecdsa", "256"),
        ("ecdsa", "384"),
        ("ecdsa", "521"),
    ] {
        let path = dir.path().join(format!("key-{kind}-{bits}"));
        let output = std::process::Command::new("ssh-keygen")
            .args(["-q", "-t", kind, "-b", bits, "-N", "", "-f"])
            .arg(&path)
            .output()
            .expect("OpenSSH is required for key interoperability proof");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        lines.push(std::fs::read_to_string(path.with_extension("pub")).unwrap());
    }
    let (_, ed_blob) = parse_public_key(&lines[0]).unwrap();
    let mut cursor = ed_blob.as_slice();
    read_string(&mut cursor).unwrap();
    let mut sk_blob = Vec::new();
    put_string(&mut sk_blob, b"sk-ssh-ed25519@openssh.com");
    put_string(&mut sk_blob, read_string(&mut cursor).unwrap());
    put_string(&mut sk_blob, b"ssh:fixture");
    lines.push(public_line("sk-ssh-ed25519@openssh.com", &sk_blob));
    for (index, line) in lines.iter().enumerate() {
        let (kind, blob) = parse_public_key(line).unwrap();
        assert_eq!(
            parse_public_key(&format!("  {}  comment\n", line.trim()))
                .unwrap()
                .1,
            blob
        );
        for suffix in [
            &[0_u8][..],
            &[0, 0, 0, 0][..],
            &[0xff, 0xff, 0xff, 0xff][..],
        ] {
            let mut malformed = blob.clone();
            malformed.extend_from_slice(suffix);
            let malformed_line = public_line(&kind, &malformed);
            assert!(parse_public_key(&malformed_line).is_err(), "{kind}");
            assert!(
                store
                    .ssh_sign(
                        "dev",
                        &malformed_line,
                        &["deploy".into()],
                        Some(60),
                        Some("fixture"),
                        &actor()
                    )
                    .await
                    .is_err(),
                "{kind}"
            );
        }
        let cert = store
            .ssh_sign(
                "dev",
                line,
                &["deploy".into()],
                Some(60),
                Some("fixture"),
                &actor(),
            )
            .await
            .unwrap();
        let cert_path = dir.path().join(format!("certificate-{index}.pub"));
        std::fs::write(&cert_path, &cert.certificate).unwrap();
        let output = std::process::Command::new("ssh-keygen")
            .args(["-L", "-f"])
            .arg(cert_path)
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{kind}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(text.contains("user certificate"), "{text}");
        assert!(text.contains("deploy"), "{text}");
        assert!(
            !text.contains("forever") && !text.contains("root"),
            "{text}"
        );
        assert_eq!(cert.valid_before - cert.valid_after, 120);
    }
}

#[tokio::test]
async fn signed_certificates_verify_against_the_ca_key() {
    let store = setup().await;
    let cert = store
        .ssh_sign(
            "dev",
            &user_key(),
            &["deploy".into(), "dev-alice".into()],
            None,
            None,
            &actor(),
        )
        .await
        .unwrap();
    assert!(cert
        .certificate
        .starts_with("ssh-ed25519-cert-v01@openssh.com "));
    assert_eq!(cert.valid_before - cert.valid_after, 3600 + 60);

    // Parse back and verify the CA signature over the signed body.
    let blob = B64
        .decode(cert.certificate.split_whitespace().nth(1).unwrap())
        .unwrap();
    let mut cursor = blob.as_slice();
    // Walk to the signature: type, nonce, pk, serial, type, keyid, principals,
    // after, before, critical, extensions, reserved, signature key.
    read_string(&mut cursor).unwrap();
    read_string(&mut cursor).unwrap();
    read_string(&mut cursor).unwrap(); // ed25519 public key
    cursor = &cursor[8 + 4..];
    assert_eq!(read_string(&mut cursor).unwrap(), cert.key_id.as_bytes());
    read_string(&mut cursor).unwrap();
    cursor = &cursor[16..];
    read_string(&mut cursor).unwrap();
    let extensions = read_string(&mut cursor).unwrap();
    let mut ext_cursor = extensions;
    assert_eq!(
        read_string(&mut ext_cursor).unwrap(),
        b"permit-agent-forwarding"
    );
    read_string(&mut cursor).unwrap();
    let ca_blob = read_string(&mut cursor).unwrap();
    let signed_len = blob.len() - cursor.len();
    let signature_blob = read_string(&mut cursor).unwrap();
    assert!(cursor.is_empty());
    let mut ca_cursor = ca_blob;
    read_string(&mut ca_cursor).unwrap();
    let ca_public: [u8; 32] = read_string(&mut ca_cursor).unwrap().try_into().unwrap();
    let mut sig_cursor = signature_blob;
    assert_eq!(read_string(&mut sig_cursor).unwrap(), b"ssh-ed25519");
    let signature =
        ed25519_dalek::Signature::from_slice(read_string(&mut sig_cursor).unwrap()).unwrap();
    ed25519_dalek::VerifyingKey::from_bytes(&ca_public)
        .unwrap()
        .verify(&blob[..signed_len], &signature)
        .unwrap();

    let cas = store.ssh_list_cas().await.unwrap();
    let ca_line_blob = B64
        .decode(cas[0].1.split_whitespace().nth(1).unwrap())
        .unwrap();
    assert_eq!(ca_line_blob, ca_blob);
}

#[tokio::test]
async fn ssh_keygen_accepts_the_certificate_when_available() {
    if std::process::Command::new("ssh-keygen")
        .arg("-?")
        .output()
        .is_err()
    {
        return;
    }
    let store = setup().await;
    let cert = store
        .ssh_sign(
            "dev",
            &user_key(),
            &["deploy".into()],
            Some(600),
            None,
            &actor(),
        )
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("id-cert.pub");
    std::fs::write(&path, &cert.certificate).unwrap();
    let output = std::process::Command::new("ssh-keygen")
        .arg("-L")
        .arg("-f")
        .arg(&path)
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(text.contains("user certificate"), "{text}");
    assert!(text.contains("deploy"), "{text}");
    assert!(text.contains("permit-pty"), "{text}");
}

#[tokio::test]
async fn principals_and_ttls_are_bounded_by_the_role() {
    let store = setup().await;
    assert!(store
        .ssh_sign("dev", &user_key(), &["root".into()], None, None, &actor())
        .await
        .is_err());
    assert!(store
        .ssh_sign(
            "dev",
            &user_key(),
            &["deploy".into()],
            Some(99_999),
            None,
            &actor()
        )
        .await
        .is_err());
    assert!(store
        .ssh_sign(
            "dev",
            "ssh-dss AAAA",
            &["deploy".into()],
            None,
            None,
            &actor()
        )
        .await
        .is_err());
    assert!(store
        .ssh_put_role(
            &SshRole {
                name: "bad".into(),
                ca: "missing".into(),
                cert_type: CertType::User,
                allowed_principals: vec!["x".into()],
                default_ttl_secs: 60,
                max_ttl_secs: 60,
                extensions: vec![],
            },
            &actor(),
        )
        .await
        .is_err());
}
