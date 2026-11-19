//! Tests for [`super::material`].

use super::tests::actor;
use super::*;

/// PKCS#8 keys from `openssl genpkey -algorithm EC -pkeyopt
/// ec_paramgen_curve:P-256|P-384`, with the public key and RFC 6979
/// signature that the p256/p384 0.13 code path produced for them. Stored
/// material from before the elliptic-curve 0.14 migration must load, export,
/// and sign byte-for-byte as it did.
const LEGACY_EC_KEYS: [(TransitKeyType, &str, &str, &str); 2] = [
    (
        TransitKeyType::EcdsaP256,
        "-----BEGIN PRIVATE KEY-----\n\
         MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgiTf9VvaRQ8zIeW4T\n\
         Jclc3u5TK30CSE8SNyo0nx03e/qhRANCAASvaRvYGkV/Jps0HZRD8X/c7VP4U+k7\n\
         /nEXNof6PHYI2ccnx5BkGU4cFwUaTHlGPhIAdILy6RJMFCCa3lFtiyXQ\n\
         -----END PRIVATE KEY-----\n",
        "-----BEGIN PUBLIC KEY-----\n\
         MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEr2kb2BpFfyabNB2UQ/F/3O1T+FPp\n\
         O/5xFzaH+jx2CNnHJ8eQZBlOHBcFGkx5Rj4SAHSC8ukSTBQgmt5RbYsl0A==\n\
         -----END PUBLIC KEY-----\n",
        "MEYCIQDH4RV3O4ZnA7ZRHu0G1fgOt/WvYAsA49UKYCitLP8THAIhAJ2Q16YS/Krct3IjH5O4+4DqMzZBQHG0aTLg3k0xbVEN",
    ),
    (
        TransitKeyType::EcdsaP384,
        "-----BEGIN PRIVATE KEY-----\n\
         MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDAJ2vAA4SUfcm7Pr8CL\n\
         daUBCcGk5CSNVUIqQBQR6vfCz8nCYlLTZHNplCOBhEkmoxihZANiAATiqRCU5Qq3\n\
         4aA7ZqLU7PFBgIWA3scqk1AzAcfXUd2m5l+UY3G3QsqmELxt3VVya8im7MgiuE+0\n\
         1Z/B10KHEncPIMlVZuAEkXT+qz+uAEylwwbBf4SePpMUN3eEZkxy2hg=\n\
         -----END PRIVATE KEY-----\n",
        "-----BEGIN PUBLIC KEY-----\n\
         MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE4qkQlOUKt+GgO2ai1OzxQYCFgN7HKpNQ\n\
         MwHH11HdpuZflGNxt0LKphC8bd1VcmvIpuzIIrhPtNWfwddChxJ3DyDJVWbgBJF0\n\
         /qs/rgBMpcMGwX+Enj6TFDd3hGZMctoY\n\
         -----END PUBLIC KEY-----\n",
        "MGQCMAMTaqiL3zjnHt/TPrBjJ/SWc8+hO7d4NAJ2z7Hg/CgeO7JuFwteMJF8wf7LTiEhQQIwWK2IhTrU8cBMSs2vbFYSJgELeQZiy64dlzxDEn4EoHvWA8LaH9jfRc7XnlhRaRwJ",
    ),
];

#[test]
fn legacy_ecdsa_pkcs8_keys_load_export_and_sign_unchanged() {
    let input = b"ryu transit p-curve regression";
    for (kind, private, public, signature) in LEGACY_EC_KEYS {
        let body: String = private
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        let der = B64.decode(body).unwrap();
        // Import normalization keeps the stored DER byte-identical.
        let material = normalize_import(kind, der.clone()).unwrap();
        assert_eq!(material, der, "{}", kind.as_str());
        assert_eq!(
            public_key_of(kind, &material).unwrap().as_deref(),
            Some(public),
            "{}",
            kind.as_str()
        );
        assert_eq!(private_pem(kind, &material).unwrap(), private);
        // RFC 6979 signing is deterministic, so the DER signature matches
        // what the previous code path produced.
        let signed = sign_material(kind, &material, input, None).unwrap();
        assert_eq!(B64.encode(&signed), signature, "{}", kind.as_str());
        let legacy = B64.decode(signature).unwrap();
        assert!(verify_material(kind, &material, input, &legacy, None).unwrap());
        assert!(!verify_material(kind, &material, b"forged", &legacy, None).unwrap());
    }
}

#[tokio::test]
async fn ecdsa_keys_sign_and_verify_and_export_public_keys() {
    let store = PluginSecretStore::in_memory().unwrap();
    for (name, kind) in [
        ("p256", TransitKeyType::EcdsaP256),
        ("p384", TransitKeyType::EcdsaP384),
    ] {
        let info = store.transit_create(name, kind, &actor()).await.unwrap();
        assert!(info.public_keys[0]
            .1
            .starts_with("-----BEGIN PUBLIC KEY-----"));
        let input = B64.encode(b"release manifest");
        let signature = store.transit_sign(name, &input, &actor()).await.unwrap();
        assert!(store
            .transit_verify(name, &input, &signature, &actor())
            .await
            .unwrap());
        assert!(!store
            .transit_verify(name, &B64.encode(b"forged"), &signature, &actor())
            .await
            .unwrap());
        let public = store
            .transit_export(name, TransitExportKind::PublicKey, None, &actor())
            .await
            .unwrap();
        assert_eq!(public.keys["1"], info.public_keys[0].1);
        // ECDSA keys cannot encrypt.
        assert!(store
            .transit_encrypt(name, &input, None, &actor())
            .await
            .is_err());
    }
}

#[tokio::test]
async fn rsa_keys_encrypt_and_sign_with_pss_and_pkcs1v15() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .transit_create("rsa", TransitKeyType::Rsa2048, &actor())
        .await
        .unwrap();
    let plain = B64.encode(b"wrapped secret");
    let ciphertext = store
        .transit_encrypt("rsa", &plain, None, &actor())
        .await
        .unwrap();
    assert_eq!(
        store
            .transit_decrypt("rsa", &ciphertext, None, &actor())
            .await
            .unwrap(),
        plain
    );
    for algorithm in ["pss", "pkcs1v15"] {
        let options = TransitOpOptions {
            signature_algorithm: Some(algorithm.into()),
            ..TransitOpOptions::default()
        };
        let signature = store
            .transit_sign_with("rsa", &plain, &options, &actor())
            .await
            .unwrap();
        assert!(store
            .transit_verify_with("rsa", &plain, &signature, &options, &actor())
            .await
            .unwrap());
    }
    let bad = TransitOpOptions {
        signature_algorithm: Some("md5".into()),
        ..TransitOpOptions::default()
    };
    assert!(store
        .transit_sign_with("rsa", &plain, &bad, &actor())
        .await
        .is_err());
}
