//! Tests for the release manifest signature (`apply_signature.rs`).

use super::*;
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signer as _, SigningKey};

const CORE_HASH: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const GATEWAY_HASH: &str = "2222222222222222222222222222222222222222222222222222222222222222";

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn manifest(tag: &str) -> String {
    format!(
        "# ryu-release {tag}\n# published 2026-11-01T00:00:00Z\n\
         {CORE_HASH}  ryu-core-linux-x86_64\n{GATEWAY_HASH}  ryu-gateway-linux-x86_64\n"
    )
}

fn sign(key: &SigningKey, manifest: &str) -> Vec<u8> {
    key.sign(manifest.as_bytes()).to_bytes().to_vec()
}

fn spki_pem(key: &SigningKey) -> String {
    let mut der = ED25519_SPKI_PREFIX.to_vec();
    der.extend_from_slice(key.verifying_key().as_bytes());
    format!(
        "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
        STANDARD.encode(der)
    )
}

#[test]
fn a_blank_or_comment_only_key_leaves_the_check_off() {
    assert!(parse_public_key("").unwrap().is_none());
    assert!(parse_public_key("\n  \n").unwrap().is_none());
    assert!(parse_public_key("# no key provisioned yet\n")
        .unwrap()
        .is_none());
}

#[test]
fn the_checked_in_key_file_parses_and_an_unset_build_key_changes_nothing() {
    // A malformed checked-in key must fail here, not on a user's update.
    let embedded = parse_public_key(EMBEDDED_KEY_FILE).expect("release_signing.pub parses");
    if option_env!("RYU_RELEASE_SIGNING_PUBKEY").is_none() {
        assert_eq!(
            release_signing_key().unwrap().map(|key| key.to_bytes()),
            embedded.map(|key| key.to_bytes())
        );
    }
}

#[test]
fn spki_pem_bare_spki_and_raw_keys_parse_to_the_same_key() {
    let key = signing_key(7);
    let expected = key.verifying_key().to_bytes();
    let pem = spki_pem(&key);
    assert_eq!(
        parse_public_key(&pem).unwrap().unwrap().to_bytes(),
        expected
    );
    let bare: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    assert!(bare.starts_with("MCowBQYDK2VwAyEA"), "{bare}");
    assert_eq!(
        parse_public_key(&bare).unwrap().unwrap().to_bytes(),
        expected
    );
    let raw = STANDARD.encode(expected);
    assert_eq!(
        parse_public_key(&raw).unwrap().unwrap().to_bytes(),
        expected
    );
}

#[test]
fn a_malformed_key_is_an_error_not_a_disabled_check() {
    for text in ["not base64 at all!", "AAAA"] {
        assert!(parse_public_key(text).is_err(), "{text}");
    }
    // A 48-byte PKCS#8 private-key body (all-zero seed) is not a public key.
    let mut pkcs8 = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    pkcs8.extend_from_slice(&[0_u8; 32]);
    assert!(parse_public_key(&STANDARD.encode(pkcs8)).is_err());
    // The identity point is a weak key.
    let mut weak = [0_u8; 32];
    weak[0] = 1;
    assert!(parse_public_key(&STANDARD.encode(weak)).is_err());
}

#[test]
fn a_valid_signature_yields_the_signed_digests() {
    let key = signing_key(7);
    let text = manifest("v0.6.0");
    let sums = SignedSums::verify(
        &key.verifying_key(),
        text.as_bytes(),
        &sign(&key, &text),
        "v0.6.0",
    )
    .expect("valid manifest verifies");
    assert_eq!(sums.digest_for("ryu-core-linux-x86_64").unwrap(), CORE_HASH);
    assert_eq!(
        sums.digest_for("ryu-gateway-linux-x86_64").unwrap(),
        GATEWAY_HASH
    );
    let missing = sums.digest_for("ryu-core-windows-x86_64.exe").unwrap_err();
    assert!(missing.to_string().contains("does not list"), "{missing}");
}

#[test]
fn tampered_sums_or_signatures_are_refused() {
    let key = signing_key(7);
    let verifying = key.verifying_key();
    let text = manifest("v0.6.0");
    let signature = sign(&key, &text);

    let tampered = text.replace(CORE_HASH, GATEWAY_HASH);
    assert!(SignedSums::verify(&verifying, tampered.as_bytes(), &signature, "v0.6.0").is_err());

    let mut flipped = signature.clone();
    flipped[10] ^= 0x01;
    assert!(SignedSums::verify(&verifying, text.as_bytes(), &flipped, "v0.6.0").is_err());

    let foreign = sign(&signing_key(9), &text);
    assert!(SignedSums::verify(&verifying, text.as_bytes(), &foreign, "v0.6.0").is_err());

    assert!(SignedSums::verify(&verifying, text.as_bytes(), &signature[..63], "v0.6.0").is_err());
    assert!(SignedSums::verify(&verifying, text.as_bytes(), b"", "v0.6.0").is_err());
}

#[test]
fn a_manifest_signed_for_another_release_is_refused() {
    let key = signing_key(7);
    let text = manifest("v0.5.9");
    let error = SignedSums::verify(
        &key.verifying_key(),
        text.as_bytes(),
        &sign(&key, &text),
        "v0.6.0",
    )
    .unwrap_err();
    assert!(error.to_string().contains("another release"), "{error}");
    let headless = text.lines().skip(1).collect::<Vec<_>>().join("\n");
    assert!(SignedSums::verify(
        &key.verifying_key(),
        headless.as_bytes(),
        &sign(&key, &headless),
        "v0.6.0"
    )
    .is_err());
}

#[test]
fn signed_but_malformed_or_ambiguous_manifests_are_refused() {
    let key = signing_key(7);
    let header = "# ryu-release v0.6.0\n";
    for body in [
        format!("{CORE_HASH} ryu-core-linux-x86_64\n"),
        // Uppercase hex: sha256sum always writes lowercase.
        format!("{}  ryu-core-linux-x86_64\n", "AB".repeat(32)),
        format!("{}  ryu-core-linux-x86_64\n", &CORE_HASH[..63]),
        format!("{CORE_HASH}  ../ryu-core\n"),
        format!("{CORE_HASH}  ryu-core\n{GATEWAY_HASH}  ryu-core\n"),
    ] {
        let text = format!("{header}{body}");
        assert!(
            SignedSums::verify(
                &key.verifying_key(),
                text.as_bytes(),
                &sign(&key, &text),
                "v0.6.0"
            )
            .is_err(),
            "{body}"
        );
    }
}
