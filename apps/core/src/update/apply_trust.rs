//! What a downloaded update must hash to before it may replace a binary.
//!
//! Two anchors exist. GitHub's per-asset `sha256:` digest (release API) is the
//! only one while no publisher key is compiled in, so the updater behaves as it
//! always has. With a key ([`super::signature`]), the signed `SHA256SUMS` of the
//! same release is mandatory and its hash is the pin; GitHub's digest is still
//! required to agree whenever the API answers, and only an unreachable,
//! rate-limited or failing API is tolerated: an answer that does not describe
//! the release (`404`, an invalid body) refuses. Either way the staged bytes are
//! re-hashed immediately before the swap.

use std::path::Path;

use anyhow::{anyhow, ensure, Context, Result};

use super::super::ReleaseAsset;
use super::release::{
    fetch_release_metadata, github_gave_no_verdict, release_asset_named, release_digest,
};
use super::signature::{fetch_signed_sums, release_signing_key, SignedSums};

/// The trust material for one release, fetched once per apply and shared by the
/// Core asset and the Gateway updated alongside it.
pub(super) struct ReleaseTrust {
    tag: String,
    signed: Option<SignedSums>,
    metadata: Result<serde_json::Value>,
    /// The metadata read failed without GitHub saying anything about the
    /// release (see [`github_gave_no_verdict`]).
    github_silent: bool,
}

impl ReleaseTrust {
    /// Load the signed manifest (when a key is compiled in) and the release
    /// metadata for `tag`. A provisioned key whose manifest cannot be fetched or
    /// verified refuses here; an unreachable API is recorded, not fatal yet.
    pub(super) async fn load(tag: &str) -> Result<Self> {
        let signed = match release_signing_key()? {
            Some(key) => Some(
                fetch_signed_sums(&key, tag)
                    .await
                    .with_context(|| format!("verifying the signed SHA256SUMS of {tag}"))?,
            ),
            None => None,
        };
        let metadata = fetch_release_metadata(tag)
            .await
            .with_context(|| format!("reading release {tag}"));
        Ok(Self::new(tag, signed, metadata))
    }

    pub(super) fn new(
        tag: &str,
        signed: Option<SignedSums>,
        metadata: Result<serde_json::Value>,
    ) -> Self {
        let github_silent = metadata.as_ref().is_err_and(github_gave_no_verdict);
        Self {
            tag: tag.to_owned(),
            signed,
            metadata,
            github_silent,
        }
    }

    /// The lowercase SHA-256 `asset` must match.
    pub(super) fn digest_for(&self, asset: &ReleaseAsset) -> Result<String> {
        let published = self
            .metadata
            .as_ref()
            .map(|release| release_digest(asset, &self.tag, release));
        let Some(signed) = &self.signed else {
            return match published {
                Ok(digest) => digest,
                Err(error) => Err(anyhow!("{error:#}")),
            };
        };
        let pinned = signed.digest_for(&asset.name)?.to_owned();
        match published {
            Err(error) if !self.github_silent => Err(anyhow!(
                "GitHub does not vouch for release {} ({error:#}); refusing {} despite its signed SHA256SUMS",
                self.tag,
                asset.name
            )),
            Err(error) => {
                tracing::warn!(
                    "update: GitHub release metadata unavailable ({error:#}); \
                     {} is pinned by the signed SHA256SUMS alone",
                    asset.name
                );
                Ok(pinned)
            }
            Ok(published) => {
                ensure!(
                    published? == pinned,
                    "{} differs between the signed SHA256SUMS and GitHub's published digest",
                    asset.name
                );
                Ok(pinned)
            }
        }
    }

    /// The release asset `name` from the same release. Without metadata it is
    /// only derivable when a signed manifest will pin its bytes and GitHub was
    /// merely unreachable.
    pub(super) fn asset_named(&self, name: &str) -> Result<ReleaseAsset> {
        match &self.metadata {
            Ok(release) => release_asset_named(release, name)
                .with_context(|| format!("release {} publishes no {name}", self.tag)),
            Err(_) if self.signed.is_some() && self.github_silent => Ok(ReleaseAsset {
                name: name.to_owned(),
                url: format!(
                    "https://github.com/{}/releases/download/{}/{name}",
                    super::super::RYU_REPO,
                    self.tag
                ),
                kind: "exe".to_owned(),
                size: 0,
            }),
            Err(error) => Err(anyhow!("{error:#}")),
        }
    }
}

/// Refuse a staged file whose bytes do not hash to `expected`. Runs right before
/// a binary is swapped in, so nothing that changed the file after download (or
/// a download cache that skipped verification) can reach the live slot.
pub(super) fn ensure_staged_digest(path: &Path, expected: &str) -> Result<()> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file =
        std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    ensure!(
        hex::encode(hash.finalize()).eq_ignore_ascii_case(expected),
        "{} does not match its verified SHA-256; refusing to install it",
        path.display()
    );
    Ok(())
}

#[cfg(test)]
#[path = "apply_trust_tests.rs"]
mod tests;
