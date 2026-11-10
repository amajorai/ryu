use super::*;
use crate::vault::pki::tests::{actor, setup};

#[tokio::test]
async fn fail_closed_withholds_issued_private_keys() {
    let store = setup().await;
    crate::vault::audit_devices::set_fail_closed_for_test(Some(true));
    let issued = store
        .pki_issue("web", "api.svc.local", &[], &[], None, &actor())
        .await;
    crate::vault::audit_devices::set_fail_closed_for_test(None);
    assert!(matches!(
        issued.unwrap_err().downcast_ref::<VaultError>(),
        Some(VaultError::AuditUnavailable)
    ));
}

#[tokio::test]
async fn issued_certificates_chain_to_the_root_and_respect_the_role() {
    let store = setup().await;
    let issued = store
        .pki_issue(
            "web",
            "api.svc.local",
            &["svc.local".into()],
            &["10.0.0.5".into()],
            None,
            &actor(),
        )
        .await
        .unwrap();
    assert!(issued
        .certificate
        .starts_with("-----BEGIN CERTIFICATE-----"));
    assert!(issued
        .private_key
        .as_deref()
        .unwrap()
        .contains("PRIVATE KEY"));

    // Verify the leaf signature against the issuer with x509-parser.
    let (_, leaf_pem) = x509_parser::pem::parse_x509_pem(issued.certificate.as_bytes()).unwrap();
    let leaf = leaf_pem.parse_x509().unwrap();
    let (_, ca_pem) = x509_parser::pem::parse_x509_pem(issued.issuing_ca.as_bytes()).unwrap();
    let ca = ca_pem.parse_x509().unwrap();
    assert_eq!(leaf.issuer(), ca.subject());
    leaf.verify_signature(Some(ca.public_key())).unwrap();
    assert_eq!(hex::encode(leaf.raw_serial()), issued.serial);

    assert!(store
        .pki_issue("web", "api.other.local", &[], &[], None, &actor())
        .await
        .is_err());
    assert!(store
        .pki_issue(
            "web",
            "api.svc.local",
            &[],
            &[],
            Some(10 * 86_400),
            &actor()
        )
        .await
        .is_err());
}

#[test]
fn an_expired_issuer_cannot_issue() {
    let role = PkiRole {
        name: "web".into(),
        issuer: "internal".into(),
        allowed_domains: vec!["svc.local".into()],
        allow_ip_sans: false,
        default_ttl_secs: 3600,
        max_ttl_secs: 86_400,
        server_flag: true,
        client_flag: false,
    };
    let expired = (OffsetDateTime::now_utc() - Duration::days(1)).unix_timestamp() * 1000;
    assert!(PluginSecretStore::leaf_params(&role, "svc.local", &[], &[], None, expired).is_err());
    let valid = (OffsetDateTime::now_utc() + Duration::days(1)).unix_timestamp() * 1000;
    assert!(PluginSecretStore::leaf_params(&role, "svc.local", &[], &[], None, valid).is_ok());
}

#[tokio::test]
async fn csr_signing_uses_only_the_request_public_key() {
    let store = setup().await;
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(vec!["evil.example.com".to_owned()]).unwrap();
    params
        .distinguished_name
        .push(DnType::CommonName, "evil.example.com");
    let csr = params.serialize_request(&key).unwrap().pem().unwrap();
    let signed = store
        .pki_sign_csr("web", &csr, "db.svc.local", &[], &[], None, &actor())
        .await
        .unwrap();
    assert!(signed.private_key.is_none());
    let (_, pem) = x509_parser::pem::parse_x509_pem(signed.certificate.as_bytes()).unwrap();
    let cert = pem.parse_x509().unwrap();
    let names: Vec<String> = cert
        .subject_alternative_name()
        .unwrap()
        .unwrap()
        .value
        .general_names
        .iter()
        .map(|name| name.to_string())
        .collect();
    assert_eq!(names, vec!["DNSName(db.svc.local)".to_owned()]);
    assert_eq!(
        cert.public_key().raw,
        rcgen::PublicKeyData::subject_public_key_info(&key).as_slice()
    );
}

#[tokio::test]
async fn revocations_appear_in_the_crl() {
    let store = setup().await;
    let issued = store
        .pki_issue("web", "api.svc.local", &[], &[], None, &actor())
        .await
        .unwrap();
    let revoked = store.pki_revoke(&issued.serial, &actor()).await.unwrap();
    assert!(revoked.revoked_at.is_some());
    let crl_pem = store.pki_crl("internal").await.unwrap();
    let (_, pem) = x509_parser::pem::parse_x509_pem(crl_pem.as_bytes()).unwrap();
    let (_, crl) = <x509_parser::revocation_list::CertificateRevocationList as x509_parser::prelude::FromDer<_>>::from_der(&pem.contents).unwrap();
    let serials: Vec<String> = crl
        .iter_revoked_certificates()
        .map(|entry| hex::encode(entry.raw_serial()))
        .collect();
    assert_eq!(serials, vec![issued.serial]);
}

/// Every PEM Core returns uses LF line endings on every platform (rcgen's own
/// encoder switches to CRLF on Windows), including rows stored with CRLF.
#[tokio::test]
async fn pem_output_uses_lf_line_endings_everywhere() {
    let store = setup().await;
    let no_cr = |label: &str, pem: &str| {
        assert!(pem.starts_with("-----BEGIN "), "{label}: {pem}");
        assert!(!pem.contains('\r'), "{label} has CR line endings");
    };
    let pending = store
        .pki_generate_intermediate("issuing", "Ryu Issuing CA", &actor())
        .await
        .unwrap();
    no_cr("csr", pending.csr.as_deref().unwrap());
    let signed = store
        .pki_sign_intermediate(
            "internal",
            pending.csr.as_deref().unwrap(),
            "Ryu Issuing CA",
            None,
            &actor(),
        )
        .await
        .unwrap();
    no_cr("intermediate", &signed.certificate);
    let issued = store
        .pki_issue("web", "api.svc.local", &[], &[], None, &actor())
        .await
        .unwrap();
    no_cr("leaf", &issued.certificate);
    no_cr("key", issued.private_key.as_deref().unwrap());
    no_cr("issuing ca", &issued.issuing_ca);
    for pem in &issued.ca_chain {
        no_cr("chain", pem);
    }
    no_cr("crl", &store.pki_crl("internal").await.unwrap());

    // A root stored with CRLF (written on Windows before normalization) is
    // returned with LF, and leaves under it still verify.
    {
        let conn = store.conn.lock().await;
        let stored: String = conn
            .query_row(
                "SELECT certificate FROM vault_pki_issuers WHERE name = 'internal'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        conn.execute(
            "UPDATE vault_pki_issuers SET certificate = ?1 WHERE name = 'internal'",
            params![stored.replace('\n', "\r\n")],
        )
        .unwrap();
    }
    for info in store.pki_list_issuers().await.unwrap() {
        if !info.certificate.is_empty() {
            no_cr("issuer", &info.certificate);
        }
    }
    let issued = store
        .pki_issue("web", "api.svc.local", &[], &[], None, &actor())
        .await
        .unwrap();
    no_cr("issuing ca", &issued.issuing_ca);
    let (_, leaf) = x509_parser::pem::parse_x509_pem(issued.certificate.as_bytes()).unwrap();
    let (_, ca) = x509_parser::pem::parse_x509_pem(issued.issuing_ca.as_bytes()).unwrap();
    leaf.parse_x509()
        .unwrap()
        .verify_signature(Some(ca.parse_x509().unwrap().public_key()))
        .unwrap();
}
