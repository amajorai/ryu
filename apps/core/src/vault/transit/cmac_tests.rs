//! Tests for [`super::cmac`]: RFC 4493 / SP 800-38B vectors and the store
//! operations.

use super::cmac::aes_cmac;
use super::tests::actor;
use super::*;

fn unhex(value: &str) -> Vec<u8> {
    let digits: String = value.chars().filter(|c| !c.is_whitespace()).collect();
    hex::decode(digits).unwrap()
}

#[test]
fn aes_cmac_matches_rfc_4493_and_sp_800_38b_vectors() {
    // RFC 4493 §4, AES-128: empty, one block, 40 bytes, four blocks.
    let key = unhex("2b7e1516 28aed2a6 abf71588 09cf4f3c");
    let message = unhex(
        "6bc1bee2 2e409f96 e93d7e11 7393172a ae2d8a57 1e03ac9c 9eb76fac 45af8e51
         30c81c46 a35ce411 e5fbc119 1a0a52ef f69f2445 df4f9b17 ad2b417b e66c3710",
    );
    for (length, tag) in [
        (0, "bb1d6929 e9593728 7fa37d12 9b756746"),
        (16, "070a16b4 6b4d4144 f79bdd9d d04a287c"),
        (40, "dfa66747 de9ae630 30ca3261 1497c827"),
        (64, "51f0bebf 7e3b9d92 fc497417 79363cfe"),
    ] {
        assert_eq!(
            aes_cmac(&key, &message[..length]).unwrap().to_vec(),
            unhex(tag),
            "AES-128 length {length}"
        );
    }
    // NIST SP 800-38B D.3, AES-256: empty and one block.
    let key = unhex("603deb10 15ca71be 2b73aef0 857d7781 1f352c07 3b6108d7 2d9810a3 0914dff4");
    for (length, tag) in [
        (0, "028962f6 1b7bf89e fc6b551f 4667d983"),
        (16, "28a7023f 452e8f82 bd4bf28d 8c37c35c"),
    ] {
        assert_eq!(
            aes_cmac(&key, &message[..length]).unwrap().to_vec(),
            unhex(tag),
            "AES-256 length {length}"
        );
    }
    assert!(aes_cmac(&[0u8; 24], b"x").is_err());
}

#[tokio::test]
async fn cmac_keys_mac_verify_truncate_and_refuse_other_operations() {
    let store = PluginSecretStore::in_memory().unwrap();
    for (name, kind) in [
        ("c128", TransitKeyType::Aes128Cmac),
        ("c256", TransitKeyType::Aes256Cmac),
    ] {
        store.transit_create(name, kind, &actor()).await.unwrap();
        let input = B64.encode(b"message to authenticate");
        let tag = store
            .transit_cmac(name, &input, None, None, &actor())
            .await
            .unwrap();
        assert!(tag.starts_with("ryu:v1:"));
        assert_eq!(decode(&tag).unwrap().1.len(), 16);
        assert!(store
            .transit_verify_cmac(name, &input, &tag, &actor())
            .await
            .unwrap());
        assert!(!store
            .transit_verify_cmac(name, &B64.encode(b"tampered"), &tag, &actor())
            .await
            .unwrap());
        let short = store
            .transit_cmac(name, &input, None, Some(8), &actor())
            .await
            .unwrap();
        assert_eq!(decode(&short).unwrap().1.len(), 8);
        assert_eq!(decode(&short).unwrap().1, decode(&tag).unwrap().1[..8]);
        assert!(store
            .transit_verify_cmac(name, &input, &short, &actor())
            .await
            .unwrap());
        assert!(store
            .transit_cmac(name, &input, None, Some(17), &actor())
            .await
            .is_err());
        // CMAC keys only CMAC.
        assert!(store.transit_hmac(name, &input, &actor()).await.is_err());
        assert!(store
            .transit_encrypt(name, &input, None, &actor())
            .await
            .is_err());
        assert!(store.transit_sign(name, &input, &actor()).await.is_err());
        // A rotated key keeps verifying old tags and tags with the new version.
        store.transit_rotate(name, &actor()).await.unwrap();
        let v2 = store
            .transit_cmac(name, &input, None, None, &actor())
            .await
            .unwrap();
        assert!(v2.starts_with("ryu:v2:"));
        assert!(store
            .transit_verify_cmac(name, &input, &tag, &actor())
            .await
            .unwrap());
    }
    // Other key types cannot CMAC.
    store
        .transit_create("plain", TransitKeyType::Aes256Gcm96, &actor())
        .await
        .unwrap();
    assert!(store
        .transit_cmac("plain", &B64.encode(b"x"), None, None, &actor())
        .await
        .is_err());
}

#[tokio::test]
async fn cmac_tags_match_the_raw_algorithm_on_exported_material() {
    let store = PluginSecretStore::in_memory().unwrap();
    let options = TransitKeyOptions {
        exportable: true,
        ..TransitKeyOptions::default()
    };
    store
        .transit_create_with("exp", TransitKeyType::Aes128Cmac, &options, &actor())
        .await
        .unwrap();
    let exported = store
        .transit_export("exp", TransitExportKind::CmacKey, None, &actor())
        .await
        .unwrap();
    let key = B64.decode(&exported.keys["1"]).unwrap();
    assert_eq!(key.len(), 16);
    let tag = store
        .transit_cmac("exp", &B64.encode(b"abc"), None, None, &actor())
        .await
        .unwrap();
    assert_eq!(decode(&tag).unwrap().1, aes_cmac(&key, b"abc").unwrap());
    assert!(store
        .transit_export("exp", TransitExportKind::HmacKey, None, &actor())
        .await
        .is_err());
}
