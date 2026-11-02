//! The hoisted sibling-`.sha256` pair. Moved here verbatim (tests included) from
//! the Ghost downloader (now `tools/satellite_downloader.rs`), which asked for the hoist.
//!
//! These exercise the PURE half only, deliberately. A test that performed a live
//! GET against a publisher would be green whenever that publisher is up and says
//! nothing about whether we parse what it really emits.

use super::super::build_http_client;
use super::*;

#[test]
fn sums_manifest_finds_the_named_asset_only() {
    let a = "a".repeat(64);
    let b = "B".repeat(64);
    let body = format!("{a}  ollama-linux-amd64.tgz\n{b} *ollama-windows-amd64.zip\n");
    assert_eq!(
        parse_sums_manifest(&body, "ollama-windows-amd64.zip"),
        Some("b".repeat(64))
    );
    assert_eq!(
        parse_sums_manifest(&body, "ollama-linux-amd64.tgz"),
        Some(a.clone())
    );
    assert_eq!(parse_sums_manifest(&body, "ollama-darwin.tgz"), None);
    assert_eq!(parse_sums_manifest("not a digest  x.tgz", "x.tgz"), None);
}

#[test]
fn release_asset_digest_reads_githubs_per_asset_sha256() {
    let hex = "c".repeat(64);
    let release = serde_json::json!({"assets": [
        {"name": "other.zip", "digest": format!("sha256:{}", "d".repeat(64))},
        {"name": "yt-dlp", "digest": format!("sha256:{hex}")},
        {"name": "nodigest.zip", "digest": null},
    ]});
    assert_eq!(release_asset_digest(&release, "yt-dlp"), Some(hex));
    assert_eq!(release_asset_digest(&release, "nodigest.zip"), None);
    assert_eq!(release_asset_digest(&release, "missing"), None);
}

#[test]
fn sha256_sibling_url_is_the_asset_plus_the_suffix() {
    // An exact sibling, not a separate SHASUMS manifest. If this ever drifts,
    // every download silently falls back to unverified.
    assert_eq!(
        sha256_sibling_url("https://example.test/ghost-macos-aarch64.tar.gz"),
        "https://example.test/ghost-macos-aarch64.tar.gz.sha256"
    );
}

#[test]
fn parse_sha256_digest_reads_the_two_column_shasum_form() {
    // The exact bytes `sha256sum` / `shasum -a 256` write, which is what
    // `.github/workflows/release.yml` and `scripts/release/release-local.sh`
    // both redirect into the `.sha256` file.
    let hex = "a".repeat(64);
    assert_eq!(
        parse_sha256_digest(&format!("{hex}  ghost-macos-aarch64.tar.gz\n")),
        Some(hex.clone())
    );
    // BSD `shasum` on some hosts emits a single space; and a bare digest is
    // what hand-rolled mirrors — and pkgs.tailscale.com — produce.
    assert_eq!(
        parse_sha256_digest(&format!("{hex} ghost.tar.gz")),
        Some(hex.clone())
    );
    assert_eq!(parse_sha256_digest(&hex), Some(hex.clone()));
    assert_eq!(parse_sha256_digest(&format!("  \n {hex}\n")), Some(hex));
}

#[test]
fn parse_sha256_digest_lowercases() {
    // `DownloadCenter` compares against `hex::encode`'s lowercase output, so an
    // uppercase digest would fail every transfer as a "checksum mismatch" —
    // a corrupt-download diagnosis for a perfectly good file.
    let upper = "A1B2C3D4".repeat(8);
    assert_eq!(upper.len(), 64);
    assert_eq!(
        parse_sha256_digest(&upper),
        Some("a1b2c3d4".repeat(8)),
        "digest must be normalised to lowercase"
    );
}

#[test]
fn parse_sha256_digest_rejects_anything_that_is_not_a_digest() {
    // Rejection matters more than acceptance: a `None` lets the caller decide
    // (refuse, or warn + download unverified), whereas a bogus non-digest would
    // abort the transfer and blame the archive. GitHub answers a missing asset
    // with an HTML page.
    assert_eq!(parse_sha256_digest(""), None);
    assert_eq!(parse_sha256_digest("   \n\t "), None);
    assert_eq!(parse_sha256_digest("<!DOCTYPE html><html>Not Found"), None);
    assert_eq!(parse_sha256_digest(&"a".repeat(63)), None, "too short");
    assert_eq!(parse_sha256_digest(&"a".repeat(65)), None, "too long");
    // 64 chars but not hex — `g` is the classic off-by-one past `f`.
    assert_eq!(parse_sha256_digest(&"g".repeat(64)), None);
    // A trailing filename must not be mistaken for the digest when the digest
    // column itself is malformed.
    assert_eq!(parse_sha256_digest("sha256 ghost.tar.gz"), None);
}

#[tokio::test]
async fn fetch_sibling_sha256_refuses_non_https_urls() {
    // Several callers build the archive URL from operator input. Over plaintext
    // the checksum is rewritable by whoever rewrote the archive, so we decline
    // rather than perform verification theatre. No network is touched here: the
    // scheme check returns before any request is built.
    let c = build_http_client();
    assert_eq!(
        fetch_sibling_sha256(&c, "http://mirror.test/g.tar.gz").await,
        None
    );
    assert_eq!(
        fetch_sibling_sha256(&c, "file:///tmp/ghost.tar.gz").await,
        None
    );
    assert_eq!(fetch_sibling_sha256(&c, "/tmp/ghost.tar.gz").await, None);
}
