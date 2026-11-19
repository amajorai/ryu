//! Tests for [`super::keys`]: RSA and Ed25519 (and P-384) issuers issue
//! leaves that verify against them.

use x509_parser::prelude::*;

use super::keys::{key_type_of_pem, KeySpec, PkiKeyType};
use super::tests::actor;
use super::*;

fn first_der(pem: &str) -> Vec<u8> {
    pem_certificates(pem).unwrap().remove(0)
}

#[test]
fn key_specs_validate_type_and_size() {
    assert_eq!(KeySpec::new(PkiKeyType::Ec, None).unwrap().bits, 256);
    assert_eq!(KeySpec::new(PkiKeyType::Ec, Some(384)).unwrap().bits, 384);
    assert_eq!(KeySpec::new(PkiKeyType::Rsa, None).unwrap().bits, 2048);
    assert_eq!(
        KeySpec::new(PkiKeyType::Rsa, Some(4096)).unwrap().bits,
        4096
    );
    assert_eq!(KeySpec::new(PkiKeyType::Ed25519, Some(0)).unwrap().bits, 0);
    for (kind, bits) in [
        (PkiKeyType::Ec, 521),
        (PkiKeyType::Rsa, 1024),
        (PkiKeyType::Rsa, 2049),
        (PkiKeyType::Ed25519, 256),
    ] {
        assert!(KeySpec::new(kind, Some(bits)).is_err(), "{kind:?} {bits}");
    }
    let parsed: PkiKeyType = serde_json::from_str("\"ed25519\"").unwrap();
    assert_eq!(parsed, PkiKeyType::Ed25519);
    assert!(serde_json::from_str::<PkiKeyType>("\"dsa\"").is_err());
}

#[tokio::test]
async fn rsa_ed25519_and_p384_roots_issue_leaves_that_verify() {
    let store = PluginSecretStore::in_memory().unwrap();
    let cases = [
        (
            "rsa-root",
            KeySpec::new(PkiKeyType::Rsa, Some(2048)).unwrap(),
            "rsa",
            "1.2.840.113549.1.1.11",
        ),
        (
            "ed-root",
            KeySpec::new(PkiKeyType::Ed25519, None).unwrap(),
            "ed25519",
            "1.3.101.112",
        ),
        (
            "p384-root",
            KeySpec::new(PkiKeyType::Ec, Some(384)).unwrap(),
            "ec",
            "1.2.840.10045.4.3.3",
        ),
    ];
    let mut signed = Vec::new();
    for (name, spec, key_type, signature_oid) in cases {
        let root = store
            .pki_create_root_with(name, &format!("{name} CA"), 86_400, spec, &actor())
            .await
            .unwrap();
        assert_eq!(root.key_type, key_type, "{name}");
        assert_eq!(key_type_of_pem(&root.certificate), key_type);
        let listed = store.pki_list_issuers().await.unwrap();
        assert_eq!(
            listed
                .iter()
                .find(|issuer| issuer.name == name)
                .unwrap()
                .key_type,
            key_type
        );
        let role = format!("{name}-web");
        store
            .pki_put_role(
                &PkiRole {
                    name: role.clone(),
                    issuer: name.into(),
                    allowed_domains: vec!["*.svc.local".into()],
                    allow_ip_sans: false,
                    default_ttl_secs: 3600,
                    max_ttl_secs: 7200,
                    server_flag: true,
                    client_flag: false,
                },
                &actor(),
            )
            .await
            .unwrap();
        let issued = store
            .pki_issue(&role, "api.svc.local", &[], &[], None, &actor())
            .await
            .unwrap();
        let root_der = first_der(&root.certificate);
        let (_, root_cert) = parse_x509_certificate(&root_der).unwrap();
        // The root is self-signed with its own algorithm.
        assert_eq!(
            root_cert.signature_algorithm.algorithm.to_id_string(),
            signature_oid
        );
        root_cert.verify_signature(None).unwrap();
        let leaf_der = first_der(&issued.certificate);
        let (_, leaf) = parse_x509_certificate(&leaf_der).unwrap();
        assert_eq!(
            leaf.signature_algorithm.algorithm.to_id_string(),
            signature_oid
        );
        leaf.verify_signature(Some(root_cert.public_key())).unwrap();
        assert_eq!(leaf.issuer().to_string(), root_cert.subject().to_string());
        // The issuer key also signs this issuer's CRL.
        let crl = store.pki_crl(name).await.unwrap();
        assert!(crl.contains("BEGIN X509 CRL"));
        signed.push((root_der, leaf_der));
    }
    // No leaf verifies against another key type's root.
    for (index, (_, leaf_der)) in signed.iter().enumerate() {
        let (_, leaf) = parse_x509_certificate(leaf_der).unwrap();
        for (other, (root_der, _)) in signed.iter().enumerate() {
            if other != index {
                let (_, root) = parse_x509_certificate(root_der).unwrap();
                assert!(leaf.verify_signature(Some(root.public_key())).is_err());
            }
        }
    }
}

#[tokio::test]
async fn ed25519_intermediates_report_their_key_type_while_pending() {
    let store = PluginSecretStore::in_memory().unwrap();
    let pending = store
        .pki_generate_intermediate_with(
            "edge",
            "Edge Intermediate",
            KeySpec::new(PkiKeyType::Ed25519, None).unwrap(),
            &actor(),
        )
        .await
        .unwrap();
    assert!(pending.csr.is_some());
    assert_eq!(pending.key_type, "ed25519");
}
