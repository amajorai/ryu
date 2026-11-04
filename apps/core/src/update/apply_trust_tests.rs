//! Tests for the update trust decision (`apply_trust.rs`).

use super::*;
use ed25519_dalek::{Signer as _, SigningKey};
use serde_json::json;

const TAG: &str = "v0.6.0";
const NAME: &str = "ryu-core-linux-x86_64";

fn hash(byte: char) -> String {
    byte.to_string().repeat(64)
}

fn asset() -> ReleaseAsset {
    ReleaseAsset {
        name: NAME.to_owned(),
        url: format!(
            "https://github.com/{}/releases/download/{TAG}/{NAME}",
            super::super::super::RYU_REPO
        ),
        kind: "exe".to_owned(),
        size: 42,
    }
}

fn signed(entries: &[(&str, String)]) -> SignedSums {
    let key = SigningKey::from_bytes(&[3; 32]);
    let mut text = format!("# ryu-release {TAG}\n");
    for (name, digest) in entries {
        text.push_str(&format!("{digest}  {name}\n"));
    }
    let signature = key.sign(text.as_bytes()).to_bytes();
    SignedSums::verify(&key.verifying_key(), text.as_bytes(), &signature, TAG).unwrap()
}

fn metadata(digest: &str) -> Result<serde_json::Value> {
    let asset = asset();
    Ok(json!({"tag_name": TAG, "draft": false, "assets": [{
        "name": asset.name, "browser_download_url": asset.url, "size": 42,
        "digest": format!("sha256:{digest}"),
    }]}))
}

/// The error `fetch_release_metadata` returns for an HTTP `status` answer.
fn status_error(status: u16) -> anyhow::Error {
    let response = axum::http::Response::builder()
        .status(status)
        .body(Vec::<u8>::new())
        .unwrap();
    anyhow::Error::from(
        reqwest::Response::from(response)
            .error_for_status()
            .unwrap_err(),
    )
}

fn unreachable() -> Result<serde_json::Value> {
    Err(status_error(403))
}

fn pulled() -> Result<serde_json::Value> {
    Err(status_error(404))
}

#[test]
fn without_a_key_the_published_github_digest_is_the_pin_as_before() {
    let trust = ReleaseTrust::new(TAG, None, metadata(&hash('a')));
    assert_eq!(trust.digest_for(&asset()).unwrap(), hash('a'));
    let offline = ReleaseTrust::new(TAG, None, unreachable());
    assert!(offline.digest_for(&asset()).is_err());
    assert!(offline.asset_named("ryu-gateway-linux-x86_64").is_err());
}

#[test]
fn with_a_key_the_signed_hash_pins_even_when_github_is_unreachable() {
    let trust = ReleaseTrust::new(TAG, Some(signed(&[(NAME, hash('b'))])), unreachable());
    assert_eq!(trust.digest_for(&asset()).unwrap(), hash('b'));
    let gateway = trust.asset_named("ryu-gateway-linux-x86_64").unwrap();
    assert_eq!(
        gateway.url,
        format!(
            "https://github.com/{}/releases/download/{TAG}/ryu-gateway-linux-x86_64",
            super::super::super::RYU_REPO
        )
    );
}

#[test]
fn with_a_key_a_reachable_github_digest_must_agree() {
    let agreeing = ReleaseTrust::new(
        TAG,
        Some(signed(&[(NAME, hash('c'))])),
        metadata(&hash('c')),
    );
    assert_eq!(agreeing.digest_for(&asset()).unwrap(), hash('c'));
    let disagreeing = ReleaseTrust::new(
        TAG,
        Some(signed(&[(NAME, hash('c'))])),
        metadata(&hash('d')),
    );
    let error = disagreeing.digest_for(&asset()).unwrap_err();
    assert!(error.to_string().contains("differs"), "{error}");
}

#[test]
fn with_a_key_an_asset_missing_from_the_signed_manifest_is_refused() {
    // GitHub still lists it, but the publisher never signed its hash.
    let trust = ReleaseTrust::new(
        TAG,
        Some(signed(&[("ryu-gateway-linux-x86_64", hash('e'))])),
        metadata(&hash('e')),
    );
    let error = trust.digest_for(&asset()).unwrap_err();
    assert!(error.to_string().contains("does not list"), "{error}");
}

#[test]
fn a_staged_file_must_match_its_verified_digest_before_the_swap() {
    use sha2::{Digest, Sha256};
    let dir = tempfile::tempdir().unwrap();
    let staged = dir.path().join("ryu-core");
    std::fs::write(&staged, b"verified bytes").unwrap();
    let digest = hex::encode(Sha256::digest(b"verified bytes"));
    ensure_staged_digest(&staged, &digest).unwrap();
    ensure_staged_digest(&staged, &digest.to_ascii_uppercase()).unwrap();
    std::fs::write(&staged, b"tampered bytes").unwrap();
    assert!(ensure_staged_digest(&staged, &digest).is_err());
    assert!(ensure_staged_digest(&dir.path().join("missing"), &digest).is_err());
}

#[test]
fn with_a_key_github_answering_that_the_release_does_not_exist_is_refused() {
    // A 404 (or an unreadable body) is GitHub's answer, not an outage, so the
    // signed manifest cannot outvote it.
    let trust = ReleaseTrust::new(TAG, Some(signed(&[(NAME, hash('f'))])), pulled());
    let error = trust.digest_for(&asset()).unwrap_err();
    assert!(error.to_string().contains("does not vouch"), "{error}");
    assert!(trust.asset_named("ryu-gateway-linux-x86_64").is_err());
    let garbled = ReleaseTrust::new(
        TAG,
        Some(signed(&[(NAME, hash('f'))])),
        Err(anyhow!("expected value at line 1 column 1")),
    );
    assert!(garbled.digest_for(&asset()).is_err());
}
