//! Tests for RSA and ECDSA SSH CAs.

use p256::ecdsa::signature::Verifier as _;
use rsa::signature::Verifier as _;

use super::ca_keys::*;
use super::*;

fn actor() -> AuditActor {
    AuditActor::new("user", Some("alice"))
}

fn user_key() -> String {
    let seed: [u8; 32] = random_bytes(32).try_into().unwrap();
    let key = ed25519_dalek::SigningKey::from_bytes(&seed);
    openssh_public_line(&key.verifying_key().to_bytes(), "alice@laptop")
}

fn strings(mut input: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    while !input.is_empty() {
        out.push(read_string(&mut input).unwrap().to_vec());
    }
    out
}

/// Pad an SSH mpint back to a fixed-size scalar.
fn scalar(mpint: &[u8], len: usize) -> Vec<u8> {
    let trimmed = &mpint[mpint.len().saturating_sub(len)..];
    let mut out = vec![0; len - trimmed.len()];
    out.extend_from_slice(trimmed);
    out
}

/// Verify `signature_blob` over `data` with the CA public `key_blob`.
fn verify(key_blob: &[u8], data: &[u8], signature_blob: &[u8]) -> bool {
    let key = strings(key_blob);
    let signature = strings(signature_blob);
    match (key[0].as_slice(), signature[0].as_slice()) {
        (b"ssh-rsa", b"rsa-sha2-512") => {
            let public = rsa::RsaPublicKey::new(
                rsa::BigUint::from_bytes_be(&key[2]),
                rsa::BigUint::from_bytes_be(&key[1]),
            )
            .unwrap();
            let verifier = rsa::pkcs1v15::VerifyingKey::<sha2::Sha512>::new(public);
            rsa::pkcs1v15::Signature::try_from(signature[1].as_slice())
                .is_ok_and(|sig| verifier.verify(data, &sig).is_ok())
        }
        (b"ecdsa-sha2-nistp256", b"ecdsa-sha2-nistp256") => {
            let rs = strings(&signature[1]);
            let mut bytes = scalar(&rs[0], 32);
            bytes.extend(scalar(&rs[1], 32));
            let sig = p256::ecdsa::Signature::from_slice(&bytes).unwrap();
            p256::ecdsa::VerifyingKey::from_sec1_bytes(&key[2])
                .unwrap()
                .verify(data, &sig)
                .is_ok()
        }
        (b"ecdsa-sha2-nistp384", b"ecdsa-sha2-nistp384") => {
            let rs = strings(&signature[1]);
            let mut bytes = scalar(&rs[0], 48);
            bytes.extend(scalar(&rs[1], 48));
            let sig = p384::ecdsa::Signature::from_slice(&bytes).unwrap();
            p384::ecdsa::VerifyingKey::from_sec1_bytes(&key[2])
                .unwrap()
                .verify(data, &sig)
                .is_ok()
        }
        _ => false,
    }
}

#[tokio::test]
async fn rsa_and_ecdsa_cas_sign_certificates_their_public_keys_verify() {
    for (name, key_type, bits, public_type) in [
        ("rsa-ca", SshCaKeyType::Rsa, Some(2048), "ssh-rsa"),
        ("p256-ca", SshCaKeyType::Ecdsa, None, "ecdsa-sha2-nistp256"),
        (
            "p384-ca",
            SshCaKeyType::Ecdsa,
            Some(384),
            "ecdsa-sha2-nistp384",
        ),
    ] {
        let store = PluginSecretStore::in_memory().unwrap();
        let line = store
            .ssh_create_ca_with(name, key_type, bits, &actor())
            .await
            .unwrap();
        assert!(line.starts_with(&format!("{public_type} ")), "{line}");
        // The CA line is a canonical OpenSSH public key.
        let parsed = ssh_key::PublicKey::from_openssh(&line).unwrap();
        let (_, ca_blob) = parse_public_key(&line).unwrap();
        assert_eq!(parsed.to_bytes().unwrap(), ca_blob);

        store
            .ssh_put_role(
                &SshRole {
                    name: "dev".into(),
                    ca: name.into(),
                    cert_type: CertType::User,
                    allowed_principals: vec!["deploy".into()],
                    default_ttl_secs: 3600,
                    max_ttl_secs: 7200,
                    extensions: vec!["permit-pty".into()],
                },
                &actor(),
            )
            .await
            .unwrap();
        let signed = store
            .ssh_sign("dev", &user_key(), &["deploy".into()], None, None, &actor())
            .await
            .unwrap();
        let cert = ssh_key::Certificate::from_openssh(&signed.certificate).unwrap();
        assert_eq!(cert.valid_principals(), ["deploy"]);
        assert_eq!(
            ssh_key::PublicKey::from(cert.signature_key().clone())
                .to_bytes()
                .unwrap(),
            ca_blob,
            "the certificate names the CA"
        );
        // Everything before the trailing signature string is signed.
        let body = B64
            .decode(signed.certificate.split_whitespace().nth(1).unwrap())
            .unwrap();
        let signature_start = (0..body.len() - 4)
            .rev()
            .find(|&at| {
                let len = u32::from_be_bytes(body[at..at + 4].try_into().unwrap()) as usize;
                let mut inner = &body[at + 4..];
                len == body.len() - at - 4
                    && read_string(&mut inner).is_ok_and(|alg| {
                        [
                            &b"rsa-sha2-512"[..],
                            b"ecdsa-sha2-nistp256",
                            b"ecdsa-sha2-nistp384",
                        ]
                        .contains(&alg)
                    })
            })
            .unwrap();
        let mut tail = &body[signature_start..];
        let signature = read_string(&mut tail).unwrap();
        assert!(
            verify(&ca_blob, &body[..signature_start], signature),
            "{name} signature verifies"
        );
        let mut tampered = body[..signature_start].to_vec();
        tampered[20] ^= 1;
        assert!(
            !verify(&ca_blob, &tampered, signature),
            "{name} tamper fails"
        );
    }
}

#[test]
fn sealed_keys_round_trip_and_bad_sizes_are_refused() {
    for (key_type, bits) in [
        (SshCaKeyType::Ed25519, None),
        (SshCaKeyType::Ecdsa, Some(256)),
        (SshCaKeyType::Ecdsa, Some(384)),
    ] {
        let key = CaKey::generate(key_type, bits).unwrap();
        let reloaded = CaKey::from_sealed(&key.to_sealed().unwrap()).unwrap();
        assert_eq!(reloaded.public_blob().unwrap(), key.public_blob().unwrap());
    }
    // Ed25519 CAs created before other types existed are a bare seed.
    let legacy = CaKey::from_sealed(&[7; 32]).unwrap();
    assert!(legacy.public_line("x").unwrap().starts_with("ssh-ed25519 "));
    assert!(CaKey::generate(SshCaKeyType::Rsa, Some(1024)).is_err());
    assert!(CaKey::generate(SshCaKeyType::Ecdsa, Some(521)).is_err());
    assert!(CaKey::generate(SshCaKeyType::Ed25519, Some(256)).is_err());
    assert!(CaKey::from_sealed(b"not a key").is_err());
    assert_eq!(
        serde_json::from_str::<SshCaKeyType>("\"rsa\"").unwrap(),
        SshCaKeyType::Rsa
    );
}
