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

use std::path::Path;

use super::binaries::{CLI, CORE, GATEWAY};
use super::stack::stack_digests;

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

async fn fetch_release_metadata(repository: &str, tag: &str) -> Result<serde_json::Value, String> {
    let url = format!("https://api.github.com/repos/{repository}/releases/tags/{tag}");
    let mut response = metadata_client()?
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("read release metadata for {tag}: {error}"))?;
    metadata_status(response.status())?;
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("read release metadata for {tag}: {error}"))?
    {
        if body.len() + chunk.len() > RELEASE_METADATA_LIMIT {
            return Err("release metadata exceeds its size limit".to_owned());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|error| format!("invalid release metadata: {error}"))
}

/// Refuse a staged Core/Gateway/CLI set unless every binary matches the digest
/// its release published. Runs before any staged binary is executed.
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
    let release = fetch_release_metadata(&repository, tag).await?;
    verify_against_release(&release, tag, &actual)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CORE_DIGEST: &str = "aa00000000000000000000000000000000000000000000000000000000000001";
    const GATEWAY_DIGEST: &str = "bb00000000000000000000000000000000000000000000000000000000000002";

    fn release(assets: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "tag_name": "v0.5.1", "assets": assets })
    }

    fn published() -> serde_json::Value {
        release(serde_json::json!([
            { "name": "ryu-core-linux-x86_64", "digest": format!("sha256:{}", CORE_DIGEST.to_ascii_uppercase()) },
            { "name": "ryu-core-linux-x86_64.sha256", "digest": format!("sha256:{GATEWAY_DIGEST}") },
            { "name": "ryu-gateway-linux-x86_64", "digest": format!("sha256:{GATEWAY_DIGEST}") },
            { "name": "ryu-cli-linux-x86_64", "digest": null },
        ]))
    }

    fn pair(name: &str, digest: &str) -> (String, String) {
        (name.to_owned(), digest.to_owned())
    }

    #[test]
    fn binaries_matching_their_published_digests_pass() {
        verify_against_release(
            &published(),
            "v0.5.1",
            &[
                pair("ryu-core-linux-x86_64", CORE_DIGEST),
                pair("ryu-gateway-linux-x86_64", GATEWAY_DIGEST),
            ],
        )
        .expect("matching digests verify");
    }

    #[test]
    fn a_binary_that_differs_from_its_published_digest_is_refused() {
        // The same-origin `.sha256` side file carries the gateway hash; only the
        // digest GitHub recorded for the binary asset itself counts.
        let error = verify_against_release(
            &published(),
            "v0.5.1",
            &[pair("ryu-core-linux-x86_64", GATEWAY_DIGEST)],
        )
        .unwrap_err();
        assert!(error.contains("does not match"), "{error}");
    }

    #[test]
    fn a_missing_digest_or_asset_is_refused_rather_than_skipped() {
        let no_digest = verify_against_release(
            &published(),
            "v0.5.1",
            &[pair("ryu-cli-linux-x86_64", CORE_DIGEST)],
        )
        .unwrap_err();
        assert!(no_digest.contains("no SHA-256 digest"), "{no_digest}");
        let unpublished = verify_against_release(
            &published(),
            "v0.5.1",
            &[pair("ryu-core-windows-x86_64.exe", CORE_DIGEST)],
        )
        .unwrap_err();
        assert!(unpublished.contains("publishes no"), "{unpublished}");
        let malformed = release(serde_json::json!([
            { "name": "ryu-core-linux-x86_64", "digest": "sha256:abc" },
        ]));
        assert!(verify_against_release(
            &malformed,
            "v0.5.1",
            &[pair("ryu-core-linux-x86_64", "abc")]
        )
        .is_err());
    }

    #[test]
    fn metadata_for_another_release_is_refused() {
        let error = verify_against_release(
            &published(),
            "v0.5.2",
            &[pair("ryu-core-linux-x86_64", CORE_DIGEST)],
        )
        .unwrap_err();
        assert!(error.contains("does not describe v0.5.2"), "{error}");
    }

    #[test]
    fn digests_come_from_the_release_base_repository_or_the_official_one() {
        assert_eq!(
            digest_repository("https://github.com/amajorai/ryu/releases").unwrap(),
            "amajorai/ryu"
        );
        assert_eq!(
            digest_repository("https://github.com/acme/ryu-fork/releases/").unwrap(),
            "acme/ryu-fork"
        );
        assert_eq!(
            digest_repository("https://releases.example.com/ryu").unwrap(),
            OFFICIAL_RELEASE_REPOSITORY
        );
        assert!(digest_repository("http://github.com/amajorai/ryu/releases").is_err());
        assert!(digest_repository("http://releases.example.com/ryu").is_err());
        assert!(digest_repository("https://github.com/amajorai/ryu").is_err());
        assert!(digest_repository("https://github.com/../ryu/releases").is_err());
    }

    #[test]
    fn asset_names_follow_the_installer_platform_suffix() {
        let name = platform_asset_name("ryu-core");
        assert!(name.starts_with("ryu-core-"), "{name}");
        if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            assert_eq!(name, "ryu-core-linux-x86_64");
        }
        if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            assert_eq!(name, "ryu-core-windows-x86_64.exe");
        }
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert_eq!(name, "ryu-core-macos-aarch64");
        }
    }

    #[test]
    fn only_a_direct_ok_response_carries_metadata() {
        assert!(metadata_status(reqwest::StatusCode::OK).is_ok());
        for status in [
            reqwest::StatusCode::MOVED_PERMANENTLY,
            reqwest::StatusCode::FOUND,
            reqwest::StatusCode::TEMPORARY_REDIRECT,
            reqwest::StatusCode::FORBIDDEN,
            reqwest::StatusCode::NOT_FOUND,
        ] {
            assert!(metadata_status(status).is_err(), "{status} must be refused");
        }
    }

    #[tokio::test]
    async fn the_metadata_client_never_sends_a_plain_http_request() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!(
            "http://{}/repos/amajorai/ryu/releases/tags/v0.5.1",
            listener.local_addr().unwrap()
        );
        listener.set_nonblocking(true).unwrap();
        let error = metadata_client()
            .unwrap()
            .get(&url)
            .send()
            .await
            .expect_err("an http:// URL is refused");
        assert!(error.is_builder(), "{error}");
        assert!(
            listener.accept().is_err(),
            "the client must not connect to an http:// URL"
        );
    }

    #[tokio::test]
    async fn a_staged_stack_from_a_plain_http_base_is_refused_before_any_request() {
        let directory = tempfile::tempdir().unwrap();
        let error = verify_staged_runtime(
            directory.path(),
            "http://releases.example.com/ryu",
            "v0.5.1",
        )
        .await
        .unwrap_err();
        assert!(error.contains("HTTPS"), "{error}");
    }
}
