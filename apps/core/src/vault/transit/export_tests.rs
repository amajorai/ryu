//! Tests for [`super::export`].

use rsa::pkcs8::DecodePublicKey;

use super::tests::actor;
use super::*;

#[tokio::test]
async fn export_and_backup_are_gated_and_round_trip() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .transit_create("bk", TransitKeyType::Aes256Gcm96, &actor())
        .await
        .unwrap();
    let plain = B64.encode(b"backup me");
    let ciphertext = store
        .transit_encrypt("bk", &plain, None, &actor())
        .await
        .unwrap();
    assert!(store
        .transit_export("bk", TransitExportKind::EncryptionKey, None, &actor())
        .await
        .is_err());
    assert!(store.transit_backup("bk", &actor()).await.is_err());
    store
        .transit_update_config(
            "bk",
            &TransitConfigUpdate {
                exportable: Some(true),
                allow_plaintext_backup: Some(true),
                ..TransitConfigUpdate::default()
            },
            &actor(),
        )
        .await
        .unwrap();
    // One-way switches.
    assert!(store
        .transit_update_config(
            "bk",
            &TransitConfigUpdate {
                exportable: Some(false),
                ..TransitConfigUpdate::default()
            },
            &actor(),
        )
        .await
        .is_err());
    let export = store
        .transit_export("bk", TransitExportKind::EncryptionKey, Some(1), &actor())
        .await
        .unwrap();
    let raw = B64.decode(&export.keys["1"]).unwrap();
    // The exported key decrypts the transit ciphertext locally.
    let (_, blob) = decode(&ciphertext).unwrap();
    let local = aead_decrypt(TransitKeyType::Aes256Gcm96, &raw, &blob, b"").unwrap();
    assert_eq!(B64.encode(local), plain);
    assert!(store
        .transit_export("bk", TransitExportKind::SigningKey, None, &actor())
        .await
        .is_err());

    let backup = store.transit_backup("bk", &actor()).await.unwrap();
    assert!(store
        .transit_restore(&backup, None, false, &actor())
        .await
        .is_err());
    let restored = store
        .transit_restore(&backup, Some("bk-copy"), false, &actor())
        .await
        .unwrap();
    assert!(restored.exportable && restored.allow_plaintext_backup);
    // Forced replacement honours deletion protection.
    assert!(store
        .transit_restore(&backup, None, true, &actor())
        .await
        .is_err());
    assert_eq!(
        store
            .transit_decrypt("bk-copy", &ciphertext, None, &actor())
            .await
            .unwrap(),
        plain
    );
}

#[tokio::test]
async fn byok_import_unwraps_material_the_caller_can_reproduce() {
    let store = PluginSecretStore::in_memory().unwrap();
    let pem = store.transit_wrapping_key().await.unwrap();
    assert_eq!(store.transit_wrapping_key().await.unwrap(), pem);
    assert!(store.transit_list().await.unwrap().is_empty());
    let public = RsaPublicKey::from_public_key_pem(&pem).unwrap();
    let wrap = |material: &[u8]| {
        let ephemeral = random_bytes(32);
        let mut blob = public
            .encrypt(&mut OsRng, Oaep::new::<Sha256>(), &ephemeral)
            .unwrap();
        blob.extend(kwp_wrap(&ephemeral, material).unwrap());
        B64.encode(blob)
    };
    let material = random_bytes(32);
    let info = store
        .transit_import(
            "byok",
            TransitKeyType::Aes256Gcm96,
            &wrap(&material),
            &TransitKeyOptions::default(),
            &actor(),
        )
        .await
        .unwrap();
    assert!(info.imported);
    let plain = B64.encode(b"customer data");
    let ciphertext = store
        .transit_encrypt("byok", &plain, None, &actor())
        .await
        .unwrap();
    let (_, blob) = decode(&ciphertext).unwrap();
    let local = aead_decrypt(TransitKeyType::Aes256Gcm96, &material, &blob, b"").unwrap();
    assert_eq!(B64.encode(local), plain);

    // A new imported version becomes the latest.
    let info = store
        .transit_import_version("byok", &wrap(&random_bytes(32)), &actor())
        .await
        .unwrap();
    assert_eq!(info.latest_version, 2);
    // Wrong-size material and garbage are rejected.
    assert!(store
        .transit_import_version("byok", &wrap(&random_bytes(16)), &actor())
        .await
        .is_err());
    assert!(store
        .transit_import(
            "junk",
            TransitKeyType::Aes256Gcm96,
            &B64.encode(random_bytes(600)),
            &TransitKeyOptions::default(),
            &actor(),
        )
        .await
        .is_err());
    // Ed25519 accepts a PKCS#8 seed.
    let seed: [u8; 32] = random_bytes(32).try_into().unwrap();
    let mut pkcs8 = ED25519_PKCS8_PREFIX.to_vec();
    pkcs8.extend(seed);
    let info = store
        .transit_import(
            "signer",
            TransitKeyType::Ed25519,
            &wrap(&pkcs8),
            &TransitKeyOptions::default(),
            &actor(),
        )
        .await
        .unwrap();
    let expected = ed25519_dalek::SigningKey::from_bytes(&seed);
    assert_eq!(
        info.public_keys[0].1,
        B64.encode(expected.verifying_key().to_bytes())
    );
}
