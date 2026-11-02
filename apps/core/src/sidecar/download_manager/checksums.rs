//! Release checksum discovery for the downloaders: the sibling `<asset>.sha256`,
//! GitHub's per-asset digest, and upstream `SHA256SUMS`-style manifests.

use anyhow::{Context, Result};

use super::METADATA_FETCH_TIMEOUT;

// ── Sibling `.sha256` verification ────────────────────────────────────────────
//
// Publishers of release archives — this repo's own `.github/workflows/release.yml`
// staging loop, and third parties like `pkgs.tailscale.com` — emit a `<asset>.sha256`
// next to every asset. Verifying against it is what stops `DownloadCenter` from
// executing bytes nobody checked, and this is the shared implementation every
// downloader must use.
//
// This pair was duplicated byte-for-byte in the Ghost and Shadow downloaders
// (now `tools/satellite_downloader.rs`), whose section comment asked for this hoist
// ("When `sidecar/download_manager.rs` is next opened, hoist this pair … into it").
// `manifest_sidecar::fetch_release_sha256` deliberately stays separate: it is
// `#[cfg(not(debug_assertions))]` (its download is release-only) and screens URLs
// through that module's private `screen_https`, so folding it in here would either
// drop a guard or drag a module-private SSRF screen into shared code.
//
// FAIL-CLOSED vs BEST-EFFORT is the CALLER's decision, not this helper's: it
// returns `None` for "no usable digest" and says nothing about whether that is
// tolerable. A caller fetching from a publisher that ALWAYS emits a digest (the
// hub release, pkgs.tailscale.com) should abort on `None`; a caller whose URL may
// come from an operator env knob pointing at a self-built archive should warn and
// continue, because failing closed there makes the documented override unusable.

/// The sibling checksum URL for a release archive — an exact `<asset>.sha256`
/// sibling, not a separate SHASUMS manifest.
pub(crate) fn sha256_sibling_url(archive_url: &str) -> String {
    format!("{archive_url}.sha256")
}

/// Parse a published `.sha256` body into a lowercase 64-char hex digest.
///
/// Both `sha256sum` and `shasum -a 256` write the two-column `<hex>  <filename>`
/// form, which is what the release workflow and `scripts/release/release-local.sh`
/// produce; a bare hex line is accepted too because hand-made mirrors (and
/// `pkgs.tailscale.com`) emit that single-column form.
///
/// Anything that is not exactly 64 hex characters is rejected rather than passed
/// on, because `DownloadCenter` compares the value verbatim — a truncated or
/// HTML-error-page "digest" would fail every transfer with a checksum mismatch
/// and misdiagnose a missing file as a corrupt download.
///
/// Pure so it can be tested against the real published format without a network
/// call; the fetch wrapper around it is [`fetch_sibling_sha256`].
pub(crate) fn parse_sha256_digest(body: &str) -> Option<String> {
    let hex = body.split_whitespace().next()?;
    if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}

/// Fetch the archive's sibling `<url>.sha256`, for
/// [`crate::downloads::DownloadSpec::sha256`] to verify the downloaded bytes
/// against. `None` when the checksum is absent, unreachable or malformed.
///
/// Only `https` URLs are followed. Several callers build the archive URL from an
/// operator env knob, and a plaintext checksum fetched over `http` could be
/// rewritten by whoever rewrote the archive — verification theatre rather than
/// verification. A non-https URL therefore yields `None` (and the caller decides
/// whether to refuse or to download unverified, loudly) instead of pretending.
pub(crate) async fn fetch_sibling_sha256(
    client: &reqwest::Client,
    archive_url: &str,
) -> Option<String> {
    if !archive_url.starts_with("https://") {
        return None;
    }
    let body = client
        .get(sha256_sibling_url(archive_url))
        .timeout(METADATA_FETCH_TIMEOUT)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()?;
    parse_sha256_digest(&body)
}

/// Common names of the checksum manifest an upstream GitHub release publishes
/// alongside its assets (`<hex>  <filename>` per line).
pub(crate) const RELEASE_SUMS_MANIFESTS: &[&str] = &[
    "sha256sum.txt",
    "sha256sums.txt",
    "SHA256SUMS",
    "SHA256SUMS.txt",
    "SHA2-256SUMS",
    "checksums.txt",
];

/// The SHA-256 of `asset` in a `sha256sum`-style manifest: one `<hex>  <name>`
/// line per file, the name optionally prefixed with `*` (binary mode) or `./`.
pub(crate) fn parse_sums_manifest(body: &str, asset: &str) -> Option<String> {
    body.lines().find_map(|line| {
        let mut columns = line.split_whitespace();
        let digest = parse_sha256_digest(columns.next()?)?;
        let name = columns.next()?.trim_start_matches('*');
        let name = name.trim_start_matches("./");
        (name == asset).then_some(digest)
    })
}

/// The digest GitHub records for a release asset (`"digest": "sha256:<hex>"`
/// in the releases API), when the release JSON carries one.
pub(crate) fn release_asset_digest(release: &serde_json::Value, asset: &str) -> Option<String> {
    release
        .get("assets")?
        .as_array()?
        .iter()
        .find(|entry| entry.get("name").and_then(serde_json::Value::as_str) == Some(asset))?
        .get("digest")?
        .as_str()?
        .strip_prefix("sha256:")
        .and_then(parse_sha256_digest)
}

/// The published SHA-256 of `asset` in an upstream GitHub release.
///
/// Engines, agents and tools are executed, so `DownloadCenter` refuses them
/// without a checksum. Third-party releases Ryu does not build publish their
/// digest one of two ways: GitHub's own per-asset `digest`, or a checksum
/// manifest asset. Either is read from the release the asset came from, over
/// https. `None` when neither is available — the caller then fails closed.
pub(crate) async fn github_release_asset_sha256(
    client: &reqwest::Client,
    release: &serde_json::Value,
    asset: &str,
) -> Option<String> {
    if let Some(digest) = release_asset_digest(release, asset) {
        return Some(digest);
    }
    let assets = release.get("assets")?.as_array()?;
    for manifest in RELEASE_SUMS_MANIFESTS {
        let Some(url) = assets.iter().find_map(|entry| {
            (entry.get("name").and_then(serde_json::Value::as_str) == Some(*manifest))
                .then(|| entry.get("browser_download_url")?.as_str())
                .flatten()
        }) else {
            continue;
        };
        if !url.starts_with("https://") {
            continue;
        }
        // Bounded (see METADATA_FETCH_TIMEOUT): this runs before any
        // DownloadCenter deadline applies, so a stalled manifest host would
        // otherwise hang the install.
        let Ok(response) = client.get(url).timeout(METADATA_FETCH_TIMEOUT).send().await else {
            continue;
        };
        let Ok(body) = response.error_for_status().map(|r| r.text()) else {
            continue;
        };
        if let Some(digest) = body.await.ok().and_then(|b| parse_sums_manifest(&b, asset)) {
            return Some(digest);
        }
    }
    None
}

/// Fetch one GitHub release's JSON (`tag` = `None` for `releases/latest`).
pub(crate) async fn fetch_github_release(
    client: &reqwest::Client,
    repo: &str,
    tag: Option<&str>,
) -> Result<serde_json::Value> {
    let url = match tag {
        Some(tag) => format!("https://api.github.com/repos/{repo}/releases/tags/{tag}"),
        None => format!("https://api.github.com/repos/{repo}/releases/latest"),
    };
    client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .timeout(METADATA_FETCH_TIMEOUT)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?
        .error_for_status()
        .with_context(|| format!("HTTP error fetching {url}"))?
        .json::<serde_json::Value>()
        .await
        .with_context(|| format!("parsing release JSON from {url}"))
}

/// [`github_release_asset_sha256`] as a hard requirement, with an error that
/// names the asset rather than the generic "requires a SHA-256 checksum".
pub(crate) async fn require_release_asset_sha256(
    client: &reqwest::Client,
    release: &serde_json::Value,
    asset: &str,
) -> Result<String> {
    github_release_asset_sha256(client, release, asset)
        .await
        .with_context(|| {
            format!("the upstream release publishes no SHA-256 for {asset}; refusing to install it unverified")
        })
}

#[cfg(test)]
#[path = "checksums_tests.rs"]
mod tests;
