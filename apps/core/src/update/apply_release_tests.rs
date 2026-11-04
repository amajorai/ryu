//! Tests for the release metadata checks (`apply_release.rs`).

use super::*;
use serde_json::json;

fn asset() -> ReleaseAsset {
    ReleaseAsset {
        name: "ryu-core.zip".into(),
        url: format!(
            "https://github.com/{}/releases/download/v0.3.0/ryu-core.zip",
            super::super::super::RYU_REPO
        ),
        kind: "archive".into(),
        size: 123,
    }
}

#[test]
fn refuses_untrusted_update_paths_and_origins() {
    assert_eq!(release_tag(&asset()).unwrap(), "v0.3.0");
    for name in [
        "../ryu-core.zip",
        "/tmp/ryu-core.zip",
        "..\\ryu-core.zip",
        "ryu-core.zip?x",
        "ryu-core.zip#x",
    ] {
        let mut value = asset();
        value.name = name.into();
        assert!(release_tag(&value).is_err());
    }
    for url in [
        "http://github.com/other/file.zip",
        "https://evil.example/ryu-core.zip",
        "https://github.com/other/repo/releases/download/v0.3.0/ryu-core.zip",
    ] {
        let mut value = asset();
        value.url = url.into();
        assert!(release_tag(&value).is_err());
    }
}

#[test]
fn gateway_asset_is_read_from_the_same_release_and_verified_alike() {
    let hex = "cd".repeat(32);
    let name = "ryu-gateway-linux-x86_64";
    let url = format!(
        "https://github.com/{}/releases/download/v0.3.0/{name}",
        super::super::super::RYU_REPO
    );
    let release = json!({"tag_name":"v0.3.0","draft":false,"assets":[
        {"name":"ryu-core-linux-x86_64","browser_download_url":"x","size":1},
        {"name":name,"browser_download_url":url,"size":42,"digest":format!("sha256:{hex}")}
    ]});
    let asset = release_asset_named(&release, name).expect("gateway asset listed");
    assert_eq!(asset.url, url);
    assert_eq!(asset.size, 42);
    assert_eq!(release_digest(&asset, "v0.3.0", &release).unwrap(), hex);
    assert!(release_asset_named(&release, "ryu-gateway-windows-x86_64.exe").is_none());
}

#[test]
fn requires_matching_published_metadata_and_sha256() {
    let asset = asset();
    let digest = "ab".repeat(32);
    let mut release = json!({"tag_name":"v0.3.0", "draft":false, "assets":[{"name":asset.name,"browser_download_url":asset.url,"size":123,"digest":format!("sha256:{digest}")}]});
    assert_eq!(release_digest(&asset, "v0.3.0", &release).unwrap(), digest);
    for invalid in [
        serde_json::Value::Null,
        json!("sha256:bad"),
        json!("md5:abc"),
    ] {
        release["assets"][0]["digest"] = invalid;
        assert!(release_digest(&asset, "v0.3.0", &release).is_err());
    }
    release["assets"][0]["digest"] = json!(format!("sha256:{digest}"));
    release["draft"] = json!(true);
    assert!(release_digest(&asset, "v0.3.0", &release).is_err());
    release["draft"] = json!(false);
    release["assets"][0]["size"] = json!(124);
    assert!(release_digest(&asset, "v0.3.0", &release).is_err());
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

#[test]
fn only_rate_limits_and_server_failures_mean_github_gave_no_verdict() {
    for status in [403, 429, 500, 502, 503] {
        assert!(github_gave_no_verdict(&status_error(status)), "{status}");
        let wrapped = status_error(status).context("reading release v0.3.0");
        assert!(github_gave_no_verdict(&wrapped), "wrapped {status}");
    }
    for status in [404, 410, 401, 400] {
        assert!(!github_gave_no_verdict(&status_error(status)), "{status}");
    }
    let invalid =
        anyhow::Error::from(serde_json::from_slice::<serde_json::Value>(b"<html>").unwrap_err());
    assert!(!github_gave_no_verdict(&invalid));
    assert!(!github_gave_no_verdict(&anyhow::anyhow!(
        "release metadata exceeds size limit"
    )));
}

#[tokio::test]
async fn a_refused_connection_means_github_gave_no_verdict() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let error = reqwest::Client::new()
        .get(format!("http://{address}/"))
        .send()
        .await
        .unwrap_err();
    assert!(github_gave_no_verdict(&anyhow::Error::from(error)));
}
