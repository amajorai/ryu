//! Tests for [`super::meta`].

use super::tests::actor;
use super::*;

#[tokio::test]
async fn min_versions_and_trim_bound_usable_versions() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .transit_create("v", TransitKeyType::Aes256Gcm96, &actor())
        .await
        .unwrap();
    let plain = B64.encode(b"p");
    let v1 = store
        .transit_encrypt("v", &plain, None, &actor())
        .await
        .unwrap();
    store.transit_rotate("v", &actor()).await.unwrap();
    store.transit_rotate("v", &actor()).await.unwrap();
    let pinned = TransitOpOptions {
        key_version: Some(2),
        ..TransitOpOptions::default()
    };
    assert!(store
        .transit_encrypt_with("v", &plain, &pinned, &actor())
        .await
        .unwrap()
        .starts_with("ryu:v2:"));
    store
        .transit_update_config(
            "v",
            &TransitConfigUpdate {
                min_encryption_version: Some(3),
                min_decryption_version: Some(2),
                ..TransitConfigUpdate::default()
            },
            &actor(),
        )
        .await
        .unwrap();
    assert!(store
        .transit_encrypt_with("v", &plain, &pinned, &actor())
        .await
        .is_err());
    // Trim cannot pass minDecryptionVersion.
    assert!(store.transit_trim("v", 3, &actor()).await.is_err());
    let info = store.transit_trim("v", 2, &actor()).await.unwrap();
    assert_eq!(info.min_available_version, 2);
    assert!(store
        .transit_decrypt("v", &v1, None, &actor())
        .await
        .is_err());
    // Trim never goes backwards; minDecryptionVersion cannot drop below it.
    assert!(store.transit_trim("v", 1, &actor()).await.is_err());
    assert!(store
        .transit_configure("v", Some(1), None, &actor())
        .await
        .is_err());
}

#[tokio::test]
async fn never_encrypts_below_the_decryption_floor() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .transit_create("floor", TransitKeyType::Aes256Gcm96, &actor())
        .await
        .unwrap();
    store.transit_rotate("floor", &actor()).await.unwrap();
    store.transit_rotate("floor", &actor()).await.unwrap();
    store
        .transit_update_config(
            "floor",
            &TransitConfigUpdate {
                min_decryption_version: Some(3),
                ..TransitConfigUpdate::default()
            },
            &actor(),
        )
        .await
        .unwrap();
    let pinned = TransitOpOptions {
        key_version: Some(1),
        ..TransitOpOptions::default()
    };
    let plain = B64.encode(b"p");
    assert!(store
        .transit_encrypt_with("floor", &plain, &pinned, &actor())
        .await
        .is_err());
    // minEncryptionVersion may not sit below minDecryptionVersion.
    assert!(store
        .transit_update_config(
            "floor",
            &TransitConfigUpdate {
                min_encryption_version: Some(2),
                ..TransitConfigUpdate::default()
            },
            &actor(),
        )
        .await
        .is_err());
    // Generated keys refuse import_version.
    assert!(store
        .transit_import_version("floor", "AAAA", &actor())
        .await
        .is_err());
}
