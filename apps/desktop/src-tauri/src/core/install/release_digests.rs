//! Independent SHA-256 pins for the managed runtime binaries.
//!
//! The bundled installer checks each binary against the `.sha256` file served
//! beside it. That file comes from the same place as the binary, so whoever can
//! replace one (a compromised mirror, a hijacked redirect) can replace both.
//! Before Desktop runs a staged binary for the first time, it compares the
//! file's SHA-256 with the `sha256:` digest GitHub computed when the release
//! asset was uploaded, read from the release metadata over HTTPS with no
//! redirects. A missing digest, an unpublished asset, or a mismatch refuses the
//! whole stack; there is no fallback to an unchecked binary.
//!
//! When a publisher key is compiled in ([`signed_sums`]), the release's signed
//! `SHA256SUMS` becomes the anchor: every binary must be listed and match, and
//! GitHub's digests must still agree whenever the API answers. Only then is an
//! unreachable, rate-limited or failing `api.github.com` tolerated instead of
//! fatal; an answer that does not describe the release (`404`) still refuses.

use std::path::Path;

use super::binaries::{CLI, CORE, GATEWAY};
use super::stack::stack_digests;
use signed_sums::{fetch_signed_sums, release_signing_key, SignedSums};

mod signed_sums;

/// The repository whose releases publish the official runtime binaries.
pub(super) const OFFICIAL_RELEASE_REPOSITORY: &str = "amajorai/ryu";

/// Release metadata larger than this is refused rather than buffered.
const RELEASE_METADATA_LIMIT: usize = 2 * 1024 * 1024;

/// The `owner/repo` whose GitHub release metadata pins the runtime binaries.
///
/// A `https://github.com/<owner>/<repo>/releases` base pins against that
/// repository. Any other HTTPS base is a mirror of the official releases, so its
/// binaries must match the official release's digests.
pub(super) fn digest_repository(release_base: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(release_base)
        .map_err(|error| format!("invalid release base: {error}"))?;
    if url.scheme() != "https" {
        return Err("the release base must use HTTPS".to_owned());
    }
    if url.host_str() != Some("github.com") {
        return Ok(OFFICIAL_RELEASE_REPOSITORY.to_owned());
    }
    let segments: Vec<&str> = url
        .path_segments()
        .map(|segments| segments.filter(|segment| !segment.is_empty()).collect())
        .unwrap_or_default();
    match segments.as_slice() {
        [owner, repository, "releases"]
            if is_repository_segment(owner) && is_repository_segment(repository) =>
        {
            Ok(format!("{owner}/{repository}"))
        }
        _ => Err(
            "a GitHub release base must be https://github.com/<owner>/<repo>/releases".to_owned(),
        ),
    }
}

fn is_repository_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 100
        && segment != "."
        && segment != ".."
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// The release asset name the installer downloads for `bin` on this platform,
/// e.g. `ryu-core-windows-x86_64.exe` or `ryu-gateway-macos-aarch64`.
pub(super) fn platform_asset_name(bin: &str) -> String {
    format!(
        "{bin}-{}-{}{}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::env::consts::EXE_SUFFIX
    )
}

/// The lowercase hex SHA-256 GitHub published for the asset `name`.
fn published_digest(release: &serde_json::Value, name: &str) -> Result<String, String> {
    let entry = release
        .get("assets")
        .and_then(serde_json::Value::as_array)
        .and_then(|assets| {
            assets
                .iter()
                .find(|entry| entry.get("name").and_then(serde_json::Value::as_str) == Some(name))
        })
        .ok_or_else(|| format!("the release publishes no {name}"))?;
    entry
        .get("digest")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.strip_prefix("sha256:"))
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| format!("the release publishes no SHA-256 digest for {name}"))
}

/// Check every `(asset name, actual SHA-256)` pair against `release`, the
/// release metadata JSON for the tag the installer fetched.
pub(super) fn verify_against_release(
    release: &serde_json::Value,
    tag: &str,
    actual: &[(String, String)],
) -> Result<(), String> {
    if release.get("tag_name").and_then(serde_json::Value::as_str) != Some(tag) {
        return Err(format!("release metadata does not describe {tag}"));
    }
    for (name, digest) in actual {
        let expected = published_digest(release, name)?;
        if !digest.eq_ignore_ascii_case(&expected) {
            return Err(format!(
                "{name} does not match the SHA-256 digest published for {tag}; refusing to run it"
            ));
        }
    }
    Ok(())
}

/// Only a `200 OK` carries release metadata. With redirects disabled, a `3xx`
/// is refused here instead of being followed to another host or to HTTP.
pub(super) fn metadata_status(status: reqwest::StatusCode) -> Result<(), String> {
    if status == reqwest::StatusCode::OK {
        Ok(())
    } else {
        Err(format!("release metadata request returned HTTP {status}"))
    }
}

/// Statuses that mean GitHub gave no verdict on the release: rate limiting
/// (`403`/`429`) or a server-side failure. Any other non-`200` answer (a
/// redirect, `404` for a release that does not exist or was pulled) is a verdict.
pub(super) fn metadata_unreachable(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::FORBIDDEN
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

/// Why the release metadata could not be used.
#[derive(Debug)]
pub(super) enum MetadataError {
    /// GitHub could not be reached, cut the response off, rate-limited the
    /// request or failed server-side: it said nothing about the release.
    Unreachable(String),
    /// GitHub answered without usable metadata (no such release, a redirect,
    /// an oversized or invalid body), or the request could not be made at all.
    Refused(String),
}

impl std::fmt::Display for MetadataError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(error) | Self::Refused(error) => formatter.write_str(error),
        }
    }
}

/// The client that reads release metadata: HTTPS only, and no redirects, so a
/// response can never hand the request to plain HTTP.
pub(super) fn metadata_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(60))
        .user_agent("ryu-desktop-runtime-verifier")
        .build()
        .map_err(|error| format!("create release metadata client: {error}"))
}

async fn fetch_release_metadata(
    repository: &str,
    tag: &str,
) -> Result<serde_json::Value, MetadataError> {
    let url = format!("https://api.github.com/repos/{repository}/releases/tags/{tag}");
    let mut response = metadata_client()
        .map_err(MetadataError::Refused)?
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| {
            MetadataError::Unreachable(format!("read release metadata for {tag}: {error}"))
        })?;
    let status = response.status();
    metadata_status(status).map_err(|error| {
        if metadata_unreachable(status) {
            MetadataError::Unreachable(error)
        } else {
            MetadataError::Refused(error)
        }
    })?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        MetadataError::Unreachable(format!("read release metadata for {tag}: {error}"))
    })? {
        if body.len() + chunk.len() > RELEASE_METADATA_LIMIT {
            return Err(MetadataError::Refused(
                "release metadata exceeds its size limit".to_owned(),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|error| MetadataError::Refused(format!("invalid release metadata: {error}")))
}

/// Decide whether the staged `actual` digests may run. Without a signed
/// manifest this is exactly the GitHub digest check. With one, the signed hashes
/// must match, and GitHub's digests must too unless its API gave no verdict
/// (unreachable, rate-limited or failing). A release GitHub answers for but does
/// not describe (`404` for a pulled release, a redirect, an invalid body) is
/// refused even though the manifest is signed.
fn verify_runtime(
    signed: Option<&SignedSums>,
    release: Result<&serde_json::Value, &MetadataError>,
    tag: &str,
    actual: &[(String, String)],
) -> Result<(), String> {
    let Some(signed) = signed else {
        return verify_against_release(release.map_err(ToString::to_string)?, tag, actual);
    };
    signed.check(tag, actual)?;
    match release {
        Ok(release) => verify_against_release(release, tag, actual),
        Err(MetadataError::Unreachable(error)) => {
            tracing::warn!(%error, %tag, "release metadata unavailable; runtime pinned by the signed SHA256SUMS alone");
            Ok(())
        }
        Err(MetadataError::Refused(error)) => Err(format!(
            "GitHub does not vouch for {tag} ({error}); refusing the runtime despite its signed SHA256SUMS"
        )),
    }
}

/// Refuse a staged Core/Gateway/CLI set unless every binary matches the digest
/// its release published (and, once a publisher key is compiled in, its signed
/// `SHA256SUMS`). Runs before any staged binary is executed.
pub(super) async fn verify_staged_runtime(
    directory: &Path,
    release_base: &str,
    tag: &str,
) -> Result<(), String> {
    let repository = digest_repository(release_base)?;
    let digests = stack_digests(directory)?;
    let actual: Vec<(String, String)> = [&CORE, &GATEWAY, &CLI]
        .into_iter()
        .zip(digests)
        .map(|(spec, digest)| (platform_asset_name(spec.bin_name), digest))
        .collect();
    let signed = match release_signing_key()? {
        Some(key) => Some(fetch_signed_sums(&key, release_base, tag).await?),
        None => None,
    };
    let release = fetch_release_metadata(&repository, tag).await;
    verify_runtime(signed.as_ref(), release.as_ref(), tag, &actual)
}

#[cfg(test)]
mod tests;
