use super::*;
#[test]
fn sealed_bootstrap_keeps_generated_keys_off_disk_and_reseals_legacy_files() {
    let directory = std::env::temp_dir().join(format!("gateway-sealed-{}", uuid::Uuid::new_v4()));
    let sealer = ryu_crypto::ComponentCipher::from_subkey_b64(
        ryu_crypto::components::GATEWAY,
        "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=",
    )
    .unwrap();
    // A legacy plaintext admin key from an older build.
    let legacy_admin =
        ryu_gw_credentials::load_or_create(&directory.join(ADMIN_KEY_FILE), "gwadm_").unwrap();
    let mut first = AuthConfig::default();
    first.bootstrap_with(&directory, Some(&sealer)).unwrap();
    assert_eq!(first.master_key.as_deref(), Some(legacy_admin.as_str()));
    let relay = first.api_keys[0].key.clone();
    for (file, secret) in [(ADMIN_KEY_FILE, &legacy_admin), (RELAY_KEY_FILE, &relay)] {
        let raw = std::fs::read_to_string(directory.join(file)).unwrap();
        assert!(raw.starts_with("encc:v1:"), "{file} must be sealed");
        assert!(!raw.contains(secret.as_str()), "{file} holds the raw key");
    }
    let mut restarted = AuthConfig::default();
    restarted.bootstrap_with(&directory, Some(&sealer)).unwrap();
    assert_eq!(restarted.master_key, first.master_key);
    assert_eq!(restarted.api_keys[0].key, relay);
    // Without the key a sealed file is an error, never a fresh key.
    let mut keyless = AuthConfig::default();
    assert!(keyless.bootstrap_with(&directory, None).is_err());
    std::fs::remove_dir_all(directory).unwrap();
}
#[test]
fn existing_system_relay_survives_bootstrap_with_user_client_keys() {
    let temporary_root = std::env::temp_dir().canonicalize().unwrap();
    let directory =
        temporary_root.join(format!("gateway-client-bootstrap-{}", uuid::Uuid::new_v4()));
    let mut first = AuthConfig::default();
    first.bootstrap(&directory).unwrap();
    let relay = first.api_keys[0].clone();
    let mut client = relay.clone();
    client.name = "coding-cli".to_owned();
    client.key = "gwclient_0123456789abcdef0123456789abcdef".to_owned();
    let mut restarted = AuthConfig {
        master_key: first.master_key,
        api_keys: vec![client.clone()],
        require_auth: true,
    };
    restarted.bootstrap(&directory).unwrap();
    assert!(restarted
        .api_keys
        .iter()
        .any(|key| key.key == relay.key && key.is_system_relay()));
    assert!(restarted
        .api_keys
        .iter()
        .any(|key| key.key == client.key && !key.is_system_relay()));
    restarted.bootstrap(&directory).unwrap();
    assert_eq!(restarted.api_keys.len(), 2);
    assert!(directory
        .canonicalize()
        .unwrap()
        .starts_with(&temporary_root));
    std::fs::remove_dir_all(directory).unwrap();
}
#[test]
fn default_auth_bootstraps_distinct_persistent_roles() {
    let directory =
        std::env::temp_dir().join(format!("gateway-bootstrap-{}", uuid::Uuid::new_v4()));
    let mut first = AuthConfig::default();
    assert!(first.require_auth);
    first.bootstrap(&directory).unwrap();
    assert!(first.master_key.is_some());
    assert_eq!(first.api_keys.len(), 1);
    assert!(!first.api_keys[0].trusted_forwarder);
    assert_ne!(
        first.master_key.as_deref(),
        Some(first.api_keys[0].key.as_str())
    );
    let mut second = AuthConfig::default();
    second.bootstrap(&directory).unwrap();
    assert_eq!(first.master_key, second.master_key);
    assert_eq!(first.api_keys[0].key, second.api_keys[0].key);
    std::fs::remove_dir_all(directory).unwrap();
}
#[test]
fn rejects_shared_admin_relay_and_invalid_explicit_master() {
    let mut config = AuthConfig::default();
    config.master_key = Some("gwadm_0123456789abcdef0123456789abcdef".into());
    assert!(config
        .add_relay(config.master_key.clone().unwrap(), "relay", false)
        .is_err());
    config.master_key = Some("".into());
    assert!(config.bootstrap(std::path::Path::new("/unused")).is_err());
}
