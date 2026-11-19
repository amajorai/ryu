//! Tests for [`super::ops`].

use super::tests::{actor, opts};
use super::*;

#[tokio::test]
async fn encrypt_decrypt_rotate_and_rewrap() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .transit_create("orders", TransitKeyType::Aes256Gcm96, &actor())
        .await
        .unwrap();
    let plain = B64.encode(b"card 4242");
    let context = B64.encode(b"tenant-1");
    let v1 = store
        .transit_encrypt("orders", &plain, Some(&context), &actor())
        .await
        .unwrap();
    assert!(v1.starts_with("ryu:v1:"));
    assert_eq!(
        store
            .transit_decrypt("orders", &v1, Some(&context), &actor())
            .await
            .unwrap(),
        plain
    );
    // A different context fails authentication.
    assert!(store
        .transit_decrypt("orders", &v1, Some(&B64.encode(b"tenant-2")), &actor())
        .await
        .is_err());

    store.transit_rotate("orders", &actor()).await.unwrap();
    let v2 = store
        .transit_rewrap("orders", &v1, Some(&context), &actor())
        .await
        .unwrap();
    assert!(v2.starts_with("ryu:v2:"));
    store
        .transit_configure("orders", Some(2), None, &actor())
        .await
        .unwrap();
    assert!(store
        .transit_decrypt("orders", &v1, Some(&context), &actor())
        .await
        .is_err());
    assert_eq!(
        store
            .transit_decrypt("orders", &v2, Some(&context), &actor())
            .await
            .unwrap(),
        plain
    );
}

#[tokio::test]
async fn sign_verify_and_hmac() {
    let store = PluginSecretStore::in_memory().unwrap();
    let info = store
        .transit_create("release", TransitKeyType::Ed25519, &actor())
        .await
        .unwrap();
    assert_eq!(info.public_keys.len(), 1);
    let input = B64.encode(b"artifact digest");
    let signature = store
        .transit_sign("release", &input, &actor())
        .await
        .unwrap();
    assert!(store
        .transit_verify("release", &input, &signature, &actor())
        .await
        .unwrap());
    assert!(!store
        .transit_verify("release", &B64.encode(b"tampered"), &signature, &actor())
        .await
        .unwrap());
    assert!(store
        .transit_encrypt("release", &input, None, &actor())
        .await
        .is_err());
    let a = store
        .transit_hmac("release", &input, &actor())
        .await
        .unwrap();
    let b = store
        .transit_hmac("release", &input, &actor())
        .await
        .unwrap();
    assert_eq!(a, b);
    assert!(store
        .transit_verify_hmac("release", &input, &a, &actor())
        .await
        .unwrap());
    assert!(!store
        .transit_verify_hmac("release", &B64.encode(b"other"), &a, &actor())
        .await
        .unwrap());
}

#[tokio::test]
async fn datakeys_unwrap_to_the_returned_plaintext_and_deletion_is_guarded() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .transit_create("env", TransitKeyType::Aes256Gcm96, &actor())
        .await
        .unwrap();
    let (plain, wrapped) = store.transit_datakey("env", &actor()).await.unwrap();
    assert_eq!(
        store
            .transit_decrypt("env", &wrapped, None, &actor())
            .await
            .unwrap(),
        plain
    );
    assert!(store.transit_delete("env", &actor()).await.is_err());
    store
        .transit_configure("env", None, Some(true), &actor())
        .await
        .unwrap();
    store.transit_delete("env", &actor()).await.unwrap();
    assert!(store.transit_list().await.unwrap().is_empty());
    assert!(store
        .transit_create("Bad Name", TransitKeyType::Ed25519, &actor())
        .await
        .is_err());
}

#[tokio::test]
async fn derived_and_convergent_keys_bind_the_context() {
    let store = PluginSecretStore::in_memory().unwrap();
    let options = TransitKeyOptions {
        derived: true,
        convergent: true,
        ..TransitKeyOptions::default()
    };
    store
        .transit_create_with("pii", TransitKeyType::Aes256Gcm96, &options, &actor())
        .await
        .unwrap();
    let plain = B64.encode(b"alice@example.com");
    // Derived keys require a context.
    assert!(store
        .transit_encrypt_with("pii", &plain, &opts(None), &actor())
        .await
        .is_err());
    let a = store
        .transit_encrypt_with("pii", &plain, &opts(Some(b"tenant-1")), &actor())
        .await
        .unwrap();
    let b = store
        .transit_encrypt_with("pii", &plain, &opts(Some(b"tenant-1")), &actor())
        .await
        .unwrap();
    let c = store
        .transit_encrypt_with("pii", &plain, &opts(Some(b"tenant-2")), &actor())
        .await
        .unwrap();
    assert_eq!(a, b, "convergent encryption is deterministic");
    assert_ne!(a, c, "contexts derive different keys");
    assert_eq!(
        store
            .transit_decrypt_with("pii", &c, &opts(Some(b"tenant-2")), &actor())
            .await
            .unwrap(),
        plain
    );
    assert!(store
        .transit_decrypt_with("pii", &c, &opts(Some(b"tenant-1")), &actor())
        .await
        .is_err());
    // Convergent without derived, or derivation on a signing key, is refused.
    let bad = TransitKeyOptions {
        convergent: true,
        ..TransitKeyOptions::default()
    };
    assert!(store
        .transit_create_with("bad", TransitKeyType::Aes256Gcm96, &bad, &actor())
        .await
        .is_err());
    let bad = TransitKeyOptions {
        derived: true,
        ..TransitKeyOptions::default()
    };
    assert!(store
        .transit_create_with("bad", TransitKeyType::Ed25519, &bad, &actor())
        .await
        .is_err());
}

#[tokio::test]
async fn associated_data_is_authenticated() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .transit_create("ad", TransitKeyType::Chacha20Poly1305, &actor())
        .await
        .unwrap();
    let with_ad = |ad: &[u8]| TransitOpOptions {
        associated_data: Some(B64.encode(ad)),
        ..TransitOpOptions::default()
    };
    let ciphertext = store
        .transit_encrypt_with("ad", &B64.encode(b"m"), &with_ad(b"row-7"), &actor())
        .await
        .unwrap();
    assert!(store
        .transit_decrypt_with("ad", &ciphertext, &with_ad(b"row-8"), &actor())
        .await
        .is_err());
    assert!(store
        .transit_decrypt_with("ad", &ciphertext, &with_ad(b"row-7"), &actor())
        .await
        .is_ok());
}

#[tokio::test]
async fn aes128_gcm96_keys_encrypt_with_16_byte_material() {
    let store = PluginSecretStore::in_memory().unwrap();
    let info = store
        .transit_create("small", TransitKeyType::Aes128Gcm96, &actor())
        .await
        .unwrap();
    assert_eq!(info.key_type.as_str(), "aes128-gcm96");
    assert_eq!(
        TransitKeyType::parse("aes128-gcm96"),
        Some(TransitKeyType::Aes128Gcm96)
    );
    let plain = B64.encode(b"pan 4111");
    let sealed = store
        .transit_encrypt("small", &plain, None, &actor())
        .await
        .unwrap();
    assert_eq!(
        store
            .transit_decrypt("small", &sealed, None, &actor())
            .await
            .unwrap(),
        plain
    );
    // Stored material is a 16-byte AES-128 key; 32 bytes is refused.
    let key = random_bytes(16);
    let blob = aead_encrypt(TransitKeyType::Aes128Gcm96, &key, b"x", b"", None).unwrap();
    assert_eq!(
        aead_decrypt(TransitKeyType::Aes128Gcm96, &key, &blob, b"").unwrap(),
        b"x"
    );
    assert!(aead_encrypt(
        TransitKeyType::Aes128Gcm96,
        &random_bytes(32),
        b"x",
        b"",
        None
    )
    .is_err());
    assert!(public_key_of(TransitKeyType::Aes128Gcm96, &random_bytes(32)).is_err());

    // Derivation yields 16-byte subkeys, so derived keys work too.
    let options = TransitKeyOptions {
        derived: true,
        ..TransitKeyOptions::default()
    };
    store
        .transit_create_with(
            "small-derived",
            TransitKeyType::Aes128Gcm96,
            &options,
            &actor(),
        )
        .await
        .unwrap();
    let sealed = store
        .transit_encrypt_with("small-derived", &plain, &opts(Some(b"t1")), &actor())
        .await
        .unwrap();
    assert_eq!(
        store
            .transit_decrypt_with("small-derived", &sealed, &opts(Some(b"t1")), &actor())
            .await
            .unwrap(),
        plain
    );
    assert!(store
        .transit_decrypt_with("small-derived", &sealed, &opts(Some(b"t2")), &actor())
        .await
        .is_err());
}
