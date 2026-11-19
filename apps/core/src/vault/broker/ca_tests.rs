use super::*;

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

#[tokio::test]
async fn the_ca_is_created_once_and_sealed() {
    let store = PluginSecretStore::in_memory().unwrap();
    let first = certificate_pem(&store).await.unwrap();
    let second = certificate_pem(&store).await.unwrap();
    assert_eq!(first, second);
    assert!(first.starts_with("-----BEGIN CERTIFICATE-----"));
    let conn = store.conn.lock().await;
    let ciphertext: Vec<u8> = conn
        .query_row("SELECT ciphertext FROM vault_broker_ca", [], |row| {
            row.get(0)
        })
        .unwrap();
    let material = load_locked(&store, &conn).unwrap().unwrap();
    assert_ne!(ciphertext, material.key_der);
}

#[tokio::test]
async fn the_public_read_never_creates_the_ca() {
    let store = PluginSecretStore::in_memory().unwrap();
    assert!(existing_certificate_pem(&store).await.unwrap().is_none());
    let created = certificate_pem(&store).await.unwrap();
    assert_eq!(
        existing_certificate_pem(&store).await.unwrap(),
        Some(created.clone())
    );
    store.keyring.seal();
    // The certificate is public: reading it needs no unsealed key.
    assert_eq!(
        existing_certificate_pem(&store).await.unwrap(),
        Some(created)
    );
}

#[test]
fn the_combined_bundle_keeps_system_roots_and_adds_the_broker_ca() {
    let system = CertificateDer::from(vec![1u8, 2, 3, 4]);
    let bundle = combined_bundle(
        &[system],
        "-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n",
    );
    assert_eq!(bundle.matches("-----BEGIN CERTIFICATE-----").count(), 2);
    assert!(bundle.starts_with("-----BEGIN CERTIFICATE-----\nAQIDBA==\n"));
    assert!(bundle.ends_with("QUJD\n-----END CERTIFICATE-----\n"));
}

#[tokio::test]
async fn a_sealed_vault_cannot_load_the_ca_key() {
    let store = PluginSecretStore::in_memory().unwrap();
    ensure(&store).await.unwrap();
    store.keyring.seal();
    assert!(ensure(&store).await.is_err());
}

#[tokio::test]
async fn leaves_chain_to_the_ca_and_are_cached() {
    let store = PluginSecretStore::in_memory().unwrap();
    let material = ensure(&store).await.unwrap();
    let cache = LeafCache::new(&material, provider()).unwrap();
    let first = cache.leaf("api.example.com").unwrap();
    let again = cache.leaf("API.example.com").unwrap();
    assert!(Arc::ptr_eq(&first, &again));
    assert_eq!(first.cert.len(), 2);
    assert_eq!(
        first.cert[1],
        pem_to_der(&material.certificate_pem).unwrap()
    );
    let ip = cache.leaf("127.0.0.1").unwrap();
    assert!(!Arc::ptr_eq(&first, &ip));
    assert!(cache.leaf("bad host").is_err());
}

#[tokio::test]
async fn the_cache_evicts_the_least_recently_used_leaf() {
    let store = PluginSecretStore::in_memory().unwrap();
    let material = ensure(&store).await.unwrap();
    let mut cache = LeafCache::new(&material, provider()).unwrap();
    cache.capacity = 2;
    let a = cache.leaf("a.example.com").unwrap();
    cache.leaf("b.example.com").unwrap();
    cache.leaf("a.example.com").unwrap();
    cache.leaf("c.example.com").unwrap();
    assert_eq!(cache.len(), 2);
    assert!(Arc::ptr_eq(&a, &cache.leaf("a.example.com").unwrap()));
}

#[path = "ca_manage_tests.rs"]
mod manage;
