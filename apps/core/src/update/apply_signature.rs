//! The publisher signature over a release's `SHA256SUMS` manifest.
//!
//! Release CI writes `SHA256SUMS` (a `# ryu-release <tag>` header, then
//! `<sha256>  <asset>` lines) and signs it with an Ed25519 key that exists only
//! as a release-environment secret; `SHA256SUMS.sig` is the raw 64-byte
//! signature (`scripts/release/sign-sha256sums.sh`). The matching public key is
//! compiled in: the build-time `RYU_RELEASE_SIGNING_PUBKEY` value when set,
//! otherwise `release_signing.pub` beside this file.
//!
//! An empty key keeps the check off and the updater on GitHub's per-asset digest
//! alone (unchanged behaviour). Once a key is present it is mandatory: a missing,
//! unverifiable or foreign manifest refuses the update, as does an asset the
//! manifest does not list. A malformed compiled-in key refuses too, rather than
//! quietly switching the check off.

use std::collections::BTreeMap;

use anyhow::{anyhow, ensure, Context, Result};
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};

/// The checked-in public key; comment lines (`#`) and PEM armour are ignored, so
/// a file holding only comments means "no key".
const EMBEDDED_KEY_FILE: &str = include_str!("release_signing.pub");

/// DER prefix of an Ed25519 `SubjectPublicKeyInfo` (RFC 8410), the body of the
/// PEM `openssl pkey -pubout` writes.
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// A manifest or signature larger than this is refused rather than buffered.
pub(super) const MANIFEST_LIMIT: usize = 1024 * 1024;

/// The compiled-in release signing key, or `None` while none is provisioned.
pub(super) fn release_signing_key() -> Result<Option<VerifyingKey>> {
    let configured = option_env!("RYU_RELEASE_SIGNING_PUBKEY").filter(|v| !v.trim().is_empty());
    parse_public_key(configured.unwrap_or(EMBEDDED_KEY_FILE))
        .context("the compiled-in release signing key is invalid; refusing to update")
}

/// Parse an Ed25519 public key from a PEM / base64 `SubjectPublicKeyInfo` (the
/// form `infra/install.sh` pins) or base64 of the raw 32 bytes. Blank or
/// comment-only text is `None`.
pub(super) fn parse_public_key(text: &str) -> Result<Option<VerifyingKey>> {
    let body: String = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("-----"))
        .collect();
    if body.is_empty() {
        return Ok(None);
    }
    let der = base64::engine::general_purpose::STANDARD
        .decode(body.as_bytes())
        .context("the release signing key is not base64")?;
    let raw = der.strip_prefix(&ED25519_SPKI_PREFIX[..]).unwrap_or(&der);
    let bytes: [u8; 32] = raw
        .try_into()
        .map_err(|_| anyhow!("the release signing key is not an Ed25519 public key"))?;
    let key = VerifyingKey::from_bytes(&bytes)
        .map_err(|_| anyhow!("the release signing key is not a valid Ed25519 point"))?;
    ensure!(
        !key.is_weak(),
        "the release signing key is a weak Ed25519 key"
    );
    Ok(Some(key))
}

/// A `SHA256SUMS` manifest whose signature verified and whose header names the
/// release it was fetched from.
#[derive(Debug)]
pub(super) struct SignedSums {
    digests: BTreeMap<String, String>,
}

impl SignedSums {
    /// Verify `signature` over `manifest` with `key`, then parse the manifest.
    /// The first line must be `# ryu-release <tag>`, binding the manifest to the
    /// release it came from; every other line is a `#` comment or
    /// `<lowercase sha256>  <asset>`.
    pub(super) fn verify(
        key: &VerifyingKey,
        manifest: &[u8],
        signature: &[u8],
        tag: &str,
    ) -> Result<Self> {
        let signature = Signature::from_slice(signature)
            .map_err(|_| anyhow!("SHA256SUMS.sig is not a 64-byte Ed25519 signature"))?;
        key.verify_strict(manifest, &signature)
            .map_err(|_| anyhow!("SHA256SUMS is not signed by the release signing key"))?;
        let text = std::str::from_utf8(manifest).context("SHA256SUMS is not UTF-8")?;
        let mut lines = text.lines();
        ensure!(
            lines.next() == Some(format!("# ryu-release {tag}").as_str()),
            "the signed SHA256SUMS describes another release than {tag}"
        );
        let mut digests = BTreeMap::new();
        for line in lines {
            if line.starts_with('#') {
                continue;
            }
            let (hash, name) = line
                .split_once("  ")
                .with_context(|| format!("malformed SHA256SUMS line {line:?}"))?;
            ensure!(
                hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
                "malformed SHA256SUMS digest for {name:?}"
            );
            ensure!(
                !name.is_empty()
                    && name.bytes().all(
                        |b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-')
                    ),
                "malformed SHA256SUMS asset name {name:?}"
            );
            ensure!(
                digests.insert(name.to_owned(), hash.to_owned()).is_none(),
                "SHA256SUMS lists {name} more than once"
            );
        }
        Ok(Self { digests })
    }

    /// The signed SHA-256 for `name`; an unlisted asset is an error, never a skip.
    pub(super) fn digest_for(&self, name: &str) -> Result<&str> {
        self.digests
            .get(name)
            .map(String::as_str)
            .with_context(|| format!("the signed SHA256SUMS does not list {name}"))
    }
}

/// Fetch `SHA256SUMS` and `SHA256SUMS.sig` from release `tag` and verify them.
pub(super) async fn fetch_signed_sums(key: &VerifyingKey, tag: &str) -> Result<SignedSums> {
    let manifest = fetch_release_file(tag, "SHA256SUMS").await?;
    let signature = fetch_release_file(tag, "SHA256SUMS.sig").await?;
    SignedSums::verify(key, &manifest, &signature, tag)
}

/// Follow only HTTPS redirects (a release download hops to GitHub's object
/// store), and only a few of them.
fn https_redirects_only(attempt: reqwest::redirect::Attempt) -> reqwest::redirect::Action {
    if attempt.url().scheme() != "https" {
        attempt.error("refusing a non-HTTPS redirect")
    } else if attempt.previous().len() >= 5 {
        attempt.error("too many redirects")
    } else {
        attempt.follow()
    }
}

async fn fetch_release_file(tag: &str, name: &str) -> Result<Vec<u8>> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::custom(https_redirects_only))
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("ryu-update-verifier")
        .build()?;
    let url = format!(
        "https://github.com/{}/releases/download/{tag}/{name}",
        super::super::RYU_REPO
    );
    let mut response = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("downloading {name}"))?
        .error_for_status()
        .with_context(|| format!("downloading {name}"))?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            body.len() + chunk.len() <= MANIFEST_LIMIT,
            "{name} exceeds its size limit"
        );
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
#[path = "apply_signature_tests.rs"]
mod tests;
