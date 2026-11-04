//! Tests for the runtime release digest pins (`release_digests.rs`).

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

fn signed_sums(entries: &[(&str, &str)]) -> signed_sums::SignedSums {
    use ed25519_dalek::{Signer as _, SigningKey};
    let key = SigningKey::from_bytes(&[4; 32]);
    let mut text = "# ryu-release v0.5.1\n".to_owned();
    for (name, digest) in entries {
        text.push_str(&format!("{digest}  {name}\n"));
    }
    let signature = key.sign(text.as_bytes()).to_bytes();
    signed_sums::SignedSums::verify(&key.verifying_key(), text.as_bytes(), &signature, "v0.5.1")
        .unwrap()
}

#[test]
fn without_a_signed_manifest_github_stays_the_only_anchor() {
    let actual = [pair("ryu-core-linux-x86_64", CORE_DIGEST)];
    verify_runtime(None, Ok(&published()), "v0.5.1", &actual).expect("matching digest passes");
    let offline =
        MetadataError::Unreachable("read release metadata for v0.5.1: connection refused".into());
    let error = verify_runtime(None, Err(&offline), "v0.5.1", &actual).unwrap_err();
    assert!(error.contains("connection refused"), "{error}");
}

#[test]
fn a_signed_manifest_pins_the_runtime_when_github_is_unreachable() {
    let signed = signed_sums(&[("ryu-core-linux-x86_64", CORE_DIGEST)]);
    let offline =
        MetadataError::Unreachable("release metadata request returned HTTP 403 Forbidden".into());
    let actual = [pair("ryu-core-linux-x86_64", CORE_DIGEST)];
    verify_runtime(Some(&signed), Err(&offline), "v0.5.1", &actual).expect("signed pin suffices");
    let tampered = [pair("ryu-core-linux-x86_64", GATEWAY_DIGEST)];
    let error = verify_runtime(Some(&signed), Err(&offline), "v0.5.1", &tampered).unwrap_err();
    assert!(error.contains("signed SHA256SUMS"), "{error}");
    let unlisted = [pair("ryu-cli-linux-x86_64", CORE_DIGEST)];
    assert!(verify_runtime(Some(&signed), Err(&offline), "v0.5.1", &unlisted).is_err());
}

#[test]
fn a_reachable_github_digest_must_agree_with_the_signed_manifest() {
    // Signed and staged agree, but GitHub published another digest for the asset.
    let signed = signed_sums(&[("ryu-core-linux-x86_64", GATEWAY_DIGEST)]);
    let actual = [pair("ryu-core-linux-x86_64", GATEWAY_DIGEST)];
    let error = verify_runtime(Some(&signed), Ok(&published()), "v0.5.1", &actual).unwrap_err();
    assert!(error.contains("does not match"), "{error}");
    let both = signed_sums(&[("ryu-core-linux-x86_64", CORE_DIGEST)]);
    let actual = [pair("ryu-core-linux-x86_64", CORE_DIGEST)];
    verify_runtime(Some(&both), Ok(&published()), "v0.5.1", &actual).expect("all anchors agree");
}

#[test]
fn only_rate_limits_and_server_failures_mean_github_gave_no_verdict() {
    for status in [
        reqwest::StatusCode::FORBIDDEN,
        reqwest::StatusCode::TOO_MANY_REQUESTS,
        reqwest::StatusCode::INTERNAL_SERVER_ERROR,
        reqwest::StatusCode::BAD_GATEWAY,
        reqwest::StatusCode::SERVICE_UNAVAILABLE,
    ] {
        assert!(metadata_unreachable(status), "{status} gives no verdict");
    }
    for status in [
        reqwest::StatusCode::NOT_FOUND,
        reqwest::StatusCode::GONE,
        reqwest::StatusCode::MOVED_PERMANENTLY,
        reqwest::StatusCode::FOUND,
        reqwest::StatusCode::UNAUTHORIZED,
    ] {
        assert!(!metadata_unreachable(status), "{status} is a verdict");
    }
}

#[test]
fn a_signed_manifest_cannot_outvote_github_saying_the_release_does_not_exist() {
    // A mirror keeps serving a signed release GitHub has pulled: the API
    // answers 404, which is a verdict, not an outage.
    let signed = signed_sums(&[("ryu-core-linux-x86_64", CORE_DIGEST)]);
    let actual = [pair("ryu-core-linux-x86_64", CORE_DIGEST)];
    let pulled =
        MetadataError::Refused("release metadata request returned HTTP 404 Not Found".into());
    let error = verify_runtime(Some(&signed), Err(&pulled), "v0.5.1", &actual).unwrap_err();
    assert!(error.contains("does not vouch"), "{error}");
    let garbled = MetadataError::Refused("invalid release metadata: EOF".into());
    assert!(verify_runtime(Some(&signed), Err(&garbled), "v0.5.1", &actual).is_err());
    let error = verify_runtime(None, Err(&pulled), "v0.5.1", &actual).unwrap_err();
    assert!(error.contains("404"), "{error}");
}
