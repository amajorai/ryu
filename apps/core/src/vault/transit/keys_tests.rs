//! Tests for [`super::keys`].

use super::tests::actor;
use super::*;

#[tokio::test]
async fn soft_delete_hides_the_key_until_recovered_or_purged() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .transit_create("tmp", TransitKeyType::Chacha20Poly1305, &actor())
        .await
        .unwrap();
    let ciphertext = store
        .transit_encrypt("tmp", &B64.encode(b"x"), None, &actor())
        .await
        .unwrap();
    store
        .transit_configure("tmp", None, Some(true), &actor())
        .await
        .unwrap();
    store.transit_delete("tmp", &actor()).await.unwrap();
    assert!(store
        .transit_decrypt("tmp", &ciphertext, None, &actor())
        .await
        .is_err());
    assert_eq!(store.transit_list_deleted().await.unwrap().len(), 1);
    // The name stays reserved while soft-deleted.
    assert!(store
        .transit_create("tmp", TransitKeyType::Aes256Gcm96, &actor())
        .await
        .is_err());
    store.transit_recover("tmp", &actor()).await.unwrap();
    assert_eq!(
        store
            .transit_decrypt("tmp", &ciphertext, None, &actor())
            .await
            .unwrap(),
        B64.encode(b"x")
    );
    // Inside the window nothing is purged.
    store.transit_delete("tmp", &actor()).await.unwrap();
    assert_eq!(store.transit_purge_expired().await.unwrap(), 0);
    store.transit_purge("tmp", &actor()).await.unwrap();
    assert!(store.transit_list_deleted().await.unwrap().is_empty());
    assert!(store.transit_recover("tmp", &actor()).await.is_err());
}

#[tokio::test]
async fn auto_rotation_is_due_only_after_the_period() {
    let store = PluginSecretStore::in_memory().unwrap();
    let options = TransitKeyOptions {
        auto_rotate_period_secs: 3600,
        ..TransitKeyOptions::default()
    };
    store
        .transit_create_with("auto", TransitKeyType::Hmac, &options, &actor())
        .await
        .unwrap();
    assert!(store.transit_due_rotations().await.unwrap().is_empty());
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_transit_keys SET created_at = created_at - 3601000 WHERE name = 'auto'",
            [],
        )
        .unwrap();
    }
    assert_eq!(store.transit_due_rotations().await.unwrap(), vec!["auto"]);
    assert!(store
        .transit_create_with(
            "fast",
            TransitKeyType::Hmac,
            &TransitKeyOptions {
                auto_rotate_period_secs: 60,
                ..TransitKeyOptions::default()
            },
            &actor(),
        )
        .await
        .is_err());
    // HMAC keys only HMAC.
    assert!(store
        .transit_encrypt("auto", &B64.encode(b"x"), None, &actor())
        .await
        .is_err());
    assert!(store
        .transit_hmac("auto", &B64.encode(b"x"), &actor())
        .await
        .is_ok());
}
