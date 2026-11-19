use super::*;

/// An operator CA (certificate PEM, PKCS#8 key PEM).
fn operator_ca(ca: bool, days: i64) -> (String, String) {
    let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P384_SHA384).unwrap();
    let mut params = CertificateParams::default();
    params
        .distinguished_name
        .push(DnType::CommonName, "Acme Egress CA");
    params.is_ca = if ca {
        IsCa::Ca(BasicConstraints::Unconstrained)
    } else {
        IsCa::ExplicitNoCa
    };
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let now = OffsetDateTime::now_utc();
    params.not_before = now - Duration::hours(1);
    params.not_after = now + Duration::days(days);
    let certificate = params.self_signed(&key).unwrap();
    (certificate.pem(), key.serialize_pem())
}

fn actor() -> AuditActor {
    AuditActor::new("user", Some("admin"))
}

async fn audit_count(store: &PluginSecretStore, action: &str) -> i64 {
    let conn = store.conn.lock().await;
    conn.query_row(
        "SELECT COUNT(*) FROM vault_audit WHERE action = ?1",
        [action],
        |row| row.get(0),
    )
    .unwrap()
}

#[tokio::test]
async fn rotation_replaces_the_signing_ca_and_keeps_the_old_one_trusted() {
    let store = PluginSecretStore::in_memory().unwrap();
    assert!(info(&store).await.unwrap().is_none());
    let original = ensure(&store).await.unwrap();
    let before = info(&store).await.unwrap().unwrap();
    assert_eq!(before.source, "generated");
    assert!(before.previous.is_none());
    assert!(
        before.subject.contains("CN=Ryu Vault Broker CA"),
        "{}",
        before.subject
    );
    let generation_before = generation();

    let rotated = rotate(&store, &actor()).await.unwrap();
    assert_ne!(rotated.fingerprint_sha256, before.fingerprint_sha256);
    assert_eq!(
        rotated.previous.as_ref().unwrap().fingerprint_sha256,
        before.fingerprint_sha256
    );
    assert!(generation() > generation_before);
    // Leaves now chain to the new CA.
    let current = ensure(&store).await.unwrap();
    assert_ne!(current.certificate_pem, original.certificate_pem);
    let cache =
        LeafCache::new(&current, Arc::new(rustls::crypto::ring::default_provider())).unwrap();
    assert_eq!(cache.generation, generation());
    let leaf = cache.leaf("api.example.com").unwrap();
    assert_eq!(leaf.cert[1], pem_to_der(&current.certificate_pem).unwrap());
    // Agents trust both until the grace period ends.
    let trusted = certificate_pem(&store).await.unwrap();
    assert_eq!(trusted.matches("BEGIN CERTIFICATE").count(), 2);
    assert!(trusted.starts_with(current.certificate_pem.trim_end()));
    assert_eq!(
        existing_certificate_pem(&store).await.unwrap(),
        Some(trusted)
    );
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_broker_ca SET rotated_at = rotated_at - ?1",
            [PREVIOUS_GRACE_MILLIS + 1],
        )
        .unwrap();
    }
    assert_eq!(
        certificate_pem(&store)
            .await
            .unwrap()
            .matches("BEGIN CERTIFICATE")
            .count(),
        1
    );
    assert!(info(&store).await.unwrap().unwrap().previous.is_none());
    assert_eq!(audit_count(&store, "broker.ca.rotate").await, 1);
}

#[tokio::test]
async fn an_operator_ca_is_imported_sealed_and_issues_leaves() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (certificate, key) = operator_ca(true, 365);
    let imported = import(&store, &certificate.replace('\n', "\r\n"), &key, &actor())
        .await
        .unwrap();
    assert_eq!(imported.source, "imported");
    assert!(
        imported.subject.contains("CN=Acme Egress CA"),
        "{}",
        imported.subject
    );
    // No previous CA existed, so nothing extra is trusted.
    assert!(imported.previous.is_none());
    let material = ensure(&store).await.unwrap();
    assert!(!material.certificate_pem.contains('\r'));
    assert_eq!(
        pem_to_der(&material.certificate_pem).unwrap(),
        pem_to_der(&certificate).unwrap()
    );
    let cache = LeafCache::new(
        &material,
        Arc::new(rustls::crypto::ring::default_provider()),
    )
    .unwrap();
    assert!(cache.leaf("api.example.com").is_ok());
    // The key is sealed: its PEM body never appears in the row.
    let conn = store.conn.lock().await;
    let ciphertext: Vec<u8> = conn
        .query_row("SELECT ciphertext FROM vault_broker_ca", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_ne!(ciphertext, material.key_der);
    drop(conn);
    assert_eq!(audit_count(&store, "broker.ca.import").await, 1);
}

#[test]
fn imports_must_be_a_valid_matching_ca() {
    let (certificate, key) = operator_ca(true, 365);
    assert!(validate_import(&certificate, &key).is_ok());
    let (_, other_key) = operator_ca(true, 365);
    let (leaf, leaf_key) = operator_ca(false, 365);
    let (short, short_key) = operator_ca(true, 0);
    let chain = format!("{certificate}{certificate}");
    for (cert, key, why) in [
        (certificate.as_str(), other_key.as_str(), "mismatched key"),
        (leaf.as_str(), leaf_key.as_str(), "not a CA"),
        (short.as_str(), short_key.as_str(), "expires within a day"),
        (chain.as_str(), key.as_str(), "more than one certificate"),
        ("garbage", key.as_str(), "not PEM"),
        (certificate.as_str(), "garbage", "key not PEM"),
    ] {
        let error = validate_import(cert, key).unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<crate::vault::VaultError>()
                .map(crate::vault::VaultError::code),
            Some("vault_invalid_request"),
            "{why}"
        );
    }
}

#[tokio::test]
async fn a_sealed_vault_cannot_replace_the_ca() {
    let store = PluginSecretStore::in_memory().unwrap();
    store.keyring.seal();
    assert!(rotate(&store, &actor()).await.is_err());
    let (certificate, key) = operator_ca(true, 365);
    assert!(import(&store, &certificate, &key, &actor()).await.is_err());
}
