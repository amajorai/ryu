use super::*;
use crate::vault::pki::tests::{actor, setup};

#[tokio::test]
async fn intermediates_chain_under_a_root_and_issue_leaves() {
    let store = setup().await;
    let pending = store
        .pki_generate_intermediate("issuing", "Ryu Issuing CA", &actor())
        .await
        .unwrap();
    let csr = pending.csr.clone().unwrap();
    assert!(pending.certificate.is_empty());
    // A pending issuer cannot sign anything yet.
    store
        .pki_put_role(
            &PkiRole {
                name: "leaf".into(),
                issuer: "issuing".into(),
                allowed_domains: vec!["*.svc.local".into()],
                allow_ip_sans: false,
                default_ttl_secs: 3600,
                max_ttl_secs: 86_400,
                server_flag: true,
                client_flag: true,
            },
            &actor(),
        )
        .await
        .unwrap();
    assert!(store
        .pki_issue("leaf", "a.svc.local", &[], &[], None, &actor())
        .await
        .is_err());

    let signed = store
        .pki_sign_intermediate(
            "internal",
            &csr,
            "Ryu Issuing CA",
            Some(7 * 86_400),
            &actor(),
        )
        .await
        .unwrap();
    let roots = store.pki_list_issuers().await.unwrap();
    let root_pem = roots
        .iter()
        .find(|issuer| issuer.name == "internal")
        .unwrap()
        .certificate
        .clone();
    // A certificate for another key is refused; the chain must sign it.
    let stranger = store
        .pki_issue("web", "x.svc.local", &[], &[], None, &actor())
        .await
        .unwrap();
    assert!(store
        .pki_set_signed("issuing", &stranger.certificate, None, &actor())
        .await
        .is_err());
    assert!(store
        .pki_set_signed(
            "issuing",
            &signed.certificate,
            Some(&stranger.certificate),
            &actor()
        )
        .await
        .is_err());
    let info = store
        .pki_set_signed("issuing", &signed.certificate, Some(&root_pem), &actor())
        .await
        .unwrap();
    assert_eq!(info.kind, "intermediate");
    assert!(info.csr.is_none());
    assert_eq!(info.ca_chain, vec![root_pem.clone()]);
    assert!(store
        .pki_set_signed("issuing", &signed.certificate, None, &actor())
        .await
        .is_err());

    let leaf = store
        .pki_issue("leaf", "a.svc.local", &[], &[], None, &actor())
        .await
        .unwrap();
    assert_eq!(leaf.ca_chain.len(), 2);
    let parse = |pem: &str| {
        let (_, block) = x509_parser::pem::parse_x509_pem(pem.as_bytes()).unwrap();
        block
    };
    let leaf_block = parse(&leaf.certificate);
    let leaf_cert = leaf_block.parse_x509().unwrap();
    let mid_block = parse(&leaf.issuing_ca);
    let mid_cert = mid_block.parse_x509().unwrap();
    let root_block = parse(&root_pem);
    let root_cert = root_block.parse_x509().unwrap();
    assert_eq!(leaf_cert.issuer(), mid_cert.subject());
    leaf_cert
        .verify_signature(Some(mid_cert.public_key()))
        .unwrap();
    mid_cert
        .verify_signature(Some(root_cert.public_key()))
        .unwrap();
    let constraints = mid_cert.basic_constraints().unwrap().unwrap().value;
    assert!(constraints.ca);
    assert_eq!(constraints.path_len_constraint, Some(0));
    // Path length 0: the intermediate cannot sign further CAs.
    let other = store
        .pki_generate_intermediate("deeper", "Deeper CA", &actor())
        .await
        .unwrap();
    assert!(store
        .pki_sign_intermediate("issuing", &other.csr.unwrap(), "Deeper CA", None, &actor())
        .await
        .is_err());
    // CRLs from an intermediate are signed by it.
    store.pki_revoke(&leaf.serial, &actor()).await.unwrap();
    assert!(store.pki_crl("issuing").await.is_ok());
}

#[tokio::test]
async fn imported_issuers_must_match_their_key_and_tidy_forgets_expired() {
    let store = PluginSecretStore::in_memory().unwrap();
    let key = KeyPair::generate().unwrap();
    let now = OffsetDateTime::now_utc();
    let mut params = ca_params(
        "Corp Root",
        now - Duration::minutes(1),
        now + Duration::days(30),
    );
    params.serial_number = Some(fresh_serial().0);
    let certificate = params.self_signed(&key).unwrap().pem();
    let wrong = KeyPair::generate().unwrap();
    assert!(store
        .pki_import_issuer("corp", &certificate, &wrong.serialize_pem(), None, &actor())
        .await
        .is_err());
    let info = store
        .pki_import_issuer("corp", &certificate, &key.serialize_pem(), None, &actor())
        .await
        .unwrap();
    assert_eq!(info.kind, "imported");
    assert_eq!(info.common_name, "Corp Root");
    assert!(store
        .pki_import_issuer("corp", &certificate, &key.serialize_pem(), None, &actor())
        .await
        .is_err());
    store
        .pki_put_role(
            &PkiRole {
                name: "corp-web".into(),
                issuer: "corp".into(),
                allowed_domains: vec!["corp.local".into()],
                allow_ip_sans: false,
                default_ttl_secs: 3600,
                max_ttl_secs: 86_400,
                server_flag: true,
                client_flag: false,
            },
            &actor(),
        )
        .await
        .unwrap();
    let issued = store
        .pki_issue("corp-web", "corp.local", &[], &[], None, &actor())
        .await
        .unwrap();
    let (_, leaf) = x509_parser::pem::parse_x509_pem(issued.certificate.as_bytes()).unwrap();
    let leaf = leaf.parse_x509().unwrap();
    let (_, ca) = x509_parser::pem::parse_x509_pem(certificate.as_bytes()).unwrap();
    let ca = ca.parse_x509().unwrap();
    leaf.verify_signature(Some(ca.public_key())).unwrap();
    // A leaf (non-CA) certificate cannot be imported as an issuer.
    assert!(store
        .pki_import_issuer(
            "leafy",
            &issued.certificate,
            &key.serialize_pem(),
            None,
            &actor()
        )
        .await
        .is_err());

    assert_eq!(store.pki_tidy(0, &actor()).await.unwrap(), 0);
    // An oversized buffer is refused instead of wrapping into a future cutoff.
    assert!(store
        .pki_tidy(18_446_744_073_709_552, &actor())
        .await
        .is_err());
    assert!(store.pki_tidy(i64::MAX, &actor()).await.is_err());
    assert_eq!(store.pki_list_certs("corp").await.unwrap().len(), 1);
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_pki_certs SET not_after = ?1",
            params![now_millis() - 4 * 24 * 3600 * 1000],
        )
        .unwrap();
    }
    assert_eq!(
        store
            .pki_tidy(DEFAULT_TIDY_BUFFER_SECS, &actor())
            .await
            .unwrap(),
        1
    );
    assert!(store.pki_list_certs("corp").await.unwrap().is_empty());
}
