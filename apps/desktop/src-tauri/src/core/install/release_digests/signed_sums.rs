//! The publisher-signed `SHA256SUMS` manifest as a runtime trust anchor.
//!
//! Release CI signs each release's `SHA256SUMS` (a `# ryu-release <tag>` header,
//! then `<sha256>  <asset>` lines) with an Ed25519 key held only as a release
//! secret; `SHA256SUMS.sig` is the raw 64-byte signature. The public key is the
//! one Core's updater compiles in: the build-time `RYU_RELEASE_SIGNING_PUBKEY`
//! value, else the checked-in `apps/core/src/update/release_signing.pub`.
//! Without a key the runtime pin stays on GitHub's digests alone. With one, the
//! signed manifest is mandatory and, being signed, may come from the same
//! release base (mirror included) as the binaries.

use std::collections::BTreeMap;

use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};

/// The checked-in key shared with Core; `#` lines and PEM armour are ignored.
const EMBEDDED_KEY_FILE: &str =
    include_str!("../../../../../../../apps/core/src/update/release_signing.pub");

/// DER prefix of an Ed25519 `SubjectPublicKeyInfo` (RFC 8410).
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// A manifest or signature larger than this is refused rather than buffered.
const MANIFEST_LIMIT: usize = 1024 * 1024;

/// The compiled-in release signing key, or `None` while none is provisioned.
pub(super) fn release_signing_key() -> Result<Option<VerifyingKey>, String> {
    let configured = option_env!("RYU_RELEASE_SIGNING_PUBKEY").filter(|v| !v.trim().is_empty());
    parse_public_key(configured.unwrap_or(EMBEDDED_KEY_FILE))
        .map_err(|error| format!("the compiled-in release signing key is invalid: {error}"))
}

/// Parse a PEM / base64 Ed25519 `SubjectPublicKeyInfo`, or base64 of the raw 32
/// bytes. Blank or comment-only text is `None`; anything else malformed is an
/// error, never a disabled check.
pub(super) fn parse_public_key(text: &str) -> Result<Option<VerifyingKey>, String> {
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
        .map_err(|_| "the release signing key is not base64".to_owned())?;
    let raw = der.strip_prefix(&ED25519_SPKI_PREFIX[..]).unwrap_or(&der);
    let bytes: [u8; 32] = raw
        .try_into()
        .map_err(|_| "the release signing key is not an Ed25519 public key".to_owned())?;
    let key = VerifyingKey::from_bytes(&bytes)
        .map_err(|_| "the release signing key is not a valid Ed25519 point".to_owned())?;
    if key.is_weak() {
        return Err("the release signing key is a weak Ed25519 key".to_owned());
    }
    Ok(Some(key))
}

/// A `SHA256SUMS` whose signature verified and whose header names the release.
#[derive(Debug)]
pub(super) struct SignedSums {
    digests: BTreeMap<String, String>,
}

impl SignedSums {
    /// Verify `signature` over `manifest`, require the `# ryu-release <tag>`
    /// header, and parse every `<lowercase sha256>  <asset>` line.
    pub(super) fn verify(
        key: &VerifyingKey,
        manifest: &[u8],
        signature: &[u8],
        tag: &str,
    ) -> Result<Self, String> {
        let signature = Signature::from_slice(signature)
            .map_err(|_| "SHA256SUMS.sig is not a 64-byte Ed25519 signature".to_owned())?;
        key.verify_strict(manifest, &signature)
            .map_err(|_| "SHA256SUMS is not signed by the release signing key".to_owned())?;
        let text = std::str::from_utf8(manifest).map_err(|_| "SHA256SUMS is not UTF-8")?;
        let mut lines = text.lines();
        if lines.next() != Some(format!("# ryu-release {tag}").as_str()) {
            return Err(format!(
                "the signed SHA256SUMS describes another release than {tag}"
            ));
        }
        let mut digests = BTreeMap::new();
        for line in lines.filter(|line| !line.starts_with('#')) {
            let (hash, name) = line
                .split_once("  ")
                .ok_or_else(|| format!("malformed SHA256SUMS line {line:?}"))?;
            let valid_hash =
                hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
            let valid_name = !name.is_empty()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'));
            if !valid_hash || !valid_name {
                return Err(format!("malformed SHA256SUMS line {line:?}"));
            }
            if digests.insert(name.to_owned(), hash.to_owned()).is_some() {
                return Err(format!("SHA256SUMS lists {name} more than once"));
            }
        }
        Ok(Self { digests })
    }

    /// Every `(asset name, actual SHA-256)` pair must be listed and match.
    pub(super) fn check(&self, tag: &str, actual: &[(String, String)]) -> Result<(), String> {
        for (name, digest) in actual {
            let expected = self
                .digests
                .get(name)
                .ok_or_else(|| format!("the signed SHA256SUMS for {tag} does not list {name}"))?;
            if !digest.eq_ignore_ascii_case(expected) {
                return Err(format!(
                    "{name} does not match the signed SHA256SUMS for {tag}; refusing to run it"
                ));
            }
        }
        Ok(())
    }
}

/// Follow only HTTPS redirects (GitHub release downloads hop to its object
/// store), and only a few.
fn https_redirects_only(attempt: reqwest::redirect::Attempt) -> reqwest::redirect::Action {
    if attempt.url().scheme() != "https" {
        attempt.error("refusing a non-HTTPS redirect")
    } else if attempt.previous().len() >= 5 {
        attempt.error("too many redirects")
    } else {
        attempt.follow()
    }
}

/// The client that downloads the signed manifest: HTTPS only, HTTPS redirects.
pub(super) fn manifest_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::custom(https_redirects_only))
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(60))
        .user_agent("ryu-desktop-runtime-verifier")
        .build()
        .map_err(|error| format!("create release manifest client: {error}"))
}

async fn fetch_release_file(release_base: &str, tag: &str, name: &str) -> Result<Vec<u8>, String> {
    let url = format!(
        "{}/download/{tag}/{name}",
        release_base.trim_end_matches('/')
    );
    let mut response = manifest_client()?
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("download {name} for {tag}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "download {name} for {tag}: HTTP {}",
            response.status()
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("download {name} for {tag}: {error}"))?
    {
        if body.len() + chunk.len() > MANIFEST_LIMIT {
            return Err(format!("{name} exceeds its size limit"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Download `SHA256SUMS` and its signature from the release base and verify them.
pub(super) async fn fetch_signed_sums(
    key: &VerifyingKey,
    release_base: &str,
    tag: &str,
) -> Result<SignedSums, String> {
    let manifest = fetch_release_file(release_base, tag, "SHA256SUMS").await?;
    let signature = fetch_release_file(release_base, tag, "SHA256SUMS.sig").await?;
    SignedSums::verify(key, &manifest, &signature, tag)
}

#[cfg(test)]
#[path = "signed_sums_tests.rs"]
mod tests;
