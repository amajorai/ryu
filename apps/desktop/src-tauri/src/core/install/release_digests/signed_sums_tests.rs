//! Tests for the signed `SHA256SUMS` runtime anchor (`signed_sums.rs`).

use super::*;
use ed25519_dalek::{Signer as _, SigningKey};

const CORE: &str = "ryu-core-linux-x86_64";
const GATEWAY: &str = "ryu-gateway-linux-x86_64";

fn hash(byte: char) -> String {
    byte.to_string().repeat(64)
}

fn manifest(tag: &str) -> String {
    format!(
        "# ryu-release {tag}\n# published 2026-11-01T00:00:00Z\n{}  {CORE}\n{}  {GATEWAY}\n",
        hash('a'),
        hash('b')
    )
}

fn sign(key: &SigningKey, text: &str) -> Vec<u8> {
    key.sign(text.as_bytes()).to_bytes().to_vec()
}

fn pair(name: &str, digest: &str) -> (String, String) {
    (name.to_owned(), digest.to_owned())
}

#[test]
fn the_shared_key_file_parses_and_blank_means_off() {
    parse_public_key(EMBEDDED_KEY_FILE).expect("release_signing.pub parses");
    assert!(parse_public_key("# not provisioned\n").unwrap().is_none());
    assert!(parse_public_key("not base64!").is_err());
    let mut weak = [0_u8; 32];
    weak[0] = 1;
    let encoded = base64::engine::general_purpose::STANDARD.encode(weak);
    assert!(parse_public_key(&encoded).is_err());
}

#[test]
fn a_pem_spki_key_verifies_a_signed_manifest() {
    let key = SigningKey::from_bytes(&[5; 32]);
    let mut der = ED25519_SPKI_PREFIX.to_vec();
    der.extend_from_slice(key.verifying_key().as_bytes());
    let pem = format!(
        "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
        base64::engine::general_purpose::STANDARD.encode(der)
    );
    let parsed = parse_public_key(&pem).unwrap().unwrap();
    let text = manifest("v0.5.1");
    let sums = SignedSums::verify(&parsed, text.as_bytes(), &sign(&key, &text), "v0.5.1").unwrap();
    sums.check(
        "v0.5.1",
        &[pair(CORE, &hash('a')), pair(GATEWAY, &hash('B'))],
    )
    .expect("signed digests match");
}

#[test]
fn tampered_sums_signatures_and_binaries_are_refused() {
    let key = SigningKey::from_bytes(&[5; 32]);
    let verifying = key.verifying_key();
    let text = manifest("v0.5.1");
    let signature = sign(&key, &text);

    let swapped = text.replace(&hash('a'), &hash('c'));
    assert!(SignedSums::verify(&verifying, swapped.as_bytes(), &signature, "v0.5.1").is_err());
    let mut flipped = signature.clone();
    flipped[0] ^= 0x80;
    assert!(SignedSums::verify(&verifying, text.as_bytes(), &flipped, "v0.5.1").is_err());
    let foreign = sign(&SigningKey::from_bytes(&[6; 32]), &text);
    assert!(SignedSums::verify(&verifying, text.as_bytes(), &foreign, "v0.5.1").is_err());
    assert!(SignedSums::verify(&verifying, text.as_bytes(), &signature, "v0.5.2").is_err());

    let sums = SignedSums::verify(&verifying, text.as_bytes(), &signature, "v0.5.1").unwrap();
    let mismatch = sums.check("v0.5.1", &[pair(CORE, &hash('c'))]).unwrap_err();
    assert!(mismatch.contains("does not match"), "{mismatch}");
    let unlisted = sums
        .check("v0.5.1", &[pair("ryu-cli-linux-x86_64", &hash('a'))])
        .unwrap_err();
    assert!(unlisted.contains("does not list"), "{unlisted}");
}

#[test]
fn signed_but_malformed_or_ambiguous_lines_are_refused() {
    let key = SigningKey::from_bytes(&[5; 32]);
    for body in [
        format!("{} {CORE}\n", hash('a')),
        format!("{}  {CORE}\n", hash('A')),
        format!("{}  ../{CORE}\n", hash('a')),
        format!("{}  {CORE}\n{}  {CORE}\n", hash('a'), hash('b')),
    ] {
        let text = format!("# ryu-release v0.5.1\n{body}");
        let verdict = SignedSums::verify(
            &key.verifying_key(),
            text.as_bytes(),
            &sign(&key, &text),
            "v0.5.1",
        );
        assert!(verdict.is_err(), "{body}");
    }
}

#[tokio::test]
async fn the_manifest_client_never_sends_a_plain_http_request() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!(
        "http://{}/download/v0.5.1/SHA256SUMS",
        listener.local_addr().unwrap()
    );
    listener.set_nonblocking(true).unwrap();
    let error = manifest_client()
        .unwrap()
        .get(&url)
        .send()
        .await
        .expect_err("an http:// URL is refused");
    assert!(error.is_builder(), "{error}");
    assert!(listener.accept().is_err());
}
