//! Release metadata for the update apply path: which official release an asset
//! belongs to, and the digest GitHub published for it.

use anyhow::{ensure, Context, Result};

use super::super::ReleaseAsset;

/// The caller selects an official asset; it cannot select a filesystem path or
/// a download origin. Resolve its digest independently from the release API.
pub(super) fn release_tag(asset: &ReleaseAsset) -> Result<String> {
    ensure!(
        !asset.name.is_empty()
            && asset.name != "."
            && asset.name != ".."
            && asset
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')),
        "invalid update asset filename"
    );
    ensure!(
        super::super::asset_kind(&asset.name) == asset.kind && asset.kind != "unknown",
        "invalid update asset kind"
    );
    let prefix = format!(
        "https://github.com/{}/releases/download/",
        super::super::RYU_REPO
    );
    let suffix = asset
        .url
        .strip_prefix(&prefix)
        .context("update must come from the official release repository")?;
    let (tag, name) = suffix
        .split_once('/')
        .context("invalid release asset URL")?;
    ensure!(
        !tag.is_empty()
            && tag
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')),
        "invalid release tag"
    );
    ensure!(
        name == asset.name,
        "update asset URL and filename do not match"
    );
    Ok(tag.to_owned())
}

pub(super) fn release_digest(
    asset: &ReleaseAsset,
    tag: &str,
    release: &serde_json::Value,
) -> Result<String> {
    ensure!(
        release.get("draft").and_then(serde_json::Value::as_bool) == Some(false),
        "update release is not published"
    );
    ensure!(
        release.get("tag_name").and_then(serde_json::Value::as_str) == Some(tag),
        "update release tag mismatch"
    );
    let entry = release
        .get("assets")
        .and_then(serde_json::Value::as_array)
        .and_then(|assets| {
            assets.iter().find(|entry| {
                entry.get("name").and_then(serde_json::Value::as_str) == Some(asset.name.as_str())
                    && entry
                        .get("browser_download_url")
                        .and_then(serde_json::Value::as_str)
                        == Some(asset.url.as_str())
            })
        })
        .context("update asset is not in the published release")?;
    ensure!(
        entry.get("size").and_then(serde_json::Value::as_u64) == Some(asset.size) && asset.size > 0,
        "update asset size mismatch"
    );
    let digest = entry
        .get("digest")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.strip_prefix("sha256:"))
        .filter(|value| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
        .context("published update has no valid SHA-256 digest")?;
    Ok(digest.to_ascii_lowercase())
}

/// The published release `tag`, from the releases API (bounded, https only, no
/// redirects).
pub(super) async fn fetch_release_metadata(tag: &str) -> Result<serde_json::Value> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("ryu-update-verifier")
        .build()?;
    let mut response = client
        .get(format!(
            "https://api.github.com/repos/{}/releases/tags/{tag}",
            super::super::RYU_REPO
        ))
        .send()
        .await?
        .error_for_status()?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            body.len() + chunk.len() <= 2 * 1024 * 1024,
            "release metadata exceeds size limit"
        );
        body.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&body)?)
}

/// Whether reading the release metadata failed without GitHub giving a verdict
/// on the release: the request never completed or was cut off, was
/// rate-limited (`403`/`429`), or failed server-side. Anything else (a `404` for
/// a release that does not exist or was pulled, a redirect, an invalid or
/// oversized body) is an answer, not an outage.
pub(super) fn github_gave_no_verdict(error: &anyhow::Error) -> bool {
    let Some(error) = error.downcast_ref::<reqwest::Error>() else {
        return false;
    };
    match error.status() {
        Some(status) => {
            status == reqwest::StatusCode::FORBIDDEN
                || status == reqwest::StatusCode::TOO_MANY_REQUESTS
                || status.is_server_error()
        }
        None => error.is_connect() || error.is_timeout() || error.is_request() || error.is_body(),
    }
}

/// The release asset named `name` in `release`, in [`ReleaseAsset`] form.
pub(super) fn release_asset_named(release: &serde_json::Value, name: &str) -> Option<ReleaseAsset> {
    let entry = release
        .get("assets")?
        .as_array()?
        .iter()
        .find(|entry| entry.get("name").and_then(serde_json::Value::as_str) == Some(name))?;
    Some(ReleaseAsset {
        name: name.to_owned(),
        url: entry.get("browser_download_url")?.as_str()?.to_owned(),
        kind: "exe".to_owned(),
        size: entry.get("size")?.as_u64()?,
    })
}

#[cfg(test)]
#[path = "apply_release_tests.rs"]
mod tests;
