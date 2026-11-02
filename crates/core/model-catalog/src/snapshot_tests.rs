use super::*;
use crate::test_support::*;

#[test]
fn validate_snapshot_path_guards_traversal() {
    use ModelFormat::Safetensors as ST;
    assert!(validate_snapshot_path("model.safetensors", ST).is_ok());
    assert!(validate_snapshot_path("sub/dir/model.safetensors", ST).is_ok());
    assert!(validate_snapshot_path("config.json", ST).is_ok());
    assert!(validate_snapshot_path("tokenizer.model", ST).is_ok());

    assert!(validate_snapshot_path("../evil.safetensors", ST).is_err());
    assert!(validate_snapshot_path("dir\\evil.safetensors", ST).is_err());
    assert!(validate_snapshot_path("/abs/model.safetensors", ST).is_err());
    assert!(validate_snapshot_path(".hidden/model.safetensors", ST).is_err());
    assert!(validate_snapshot_path("weights.gguf", ST).is_err()); // wrong ext
    assert!(validate_snapshot_path("", ST).is_err());
}

#[tokio::test]
async fn install_snapshot_rejects_loopback_fixture() {
    ensure_test_host();
    ensure_downloads_host();
    let addr = spawn_http(|path| {
        if path.contains("/tree/") {
            let body = serde_json::json!([
                { "path": "model.safetensors", "size": 100 },
                { "path": "config.json", "size": 20 }
            ])
            .to_string()
            .into_bytes();
            (200, vec![], body)
        } else if path.contains("/resolve/") {
            (200, vec![], b"SNAPSHOT-SHARD-BYTES".to_vec())
        } else {
            (404, vec![], b"no".to_vec())
        }
    });
    let endpoint = HfEndpoint {
        api_base: format!("http://{addr}/api"),
        // Downloads are HTTPS-only, so point the resolve host at https: the
        // loopback refusal (not the scheme check) is what this test pins.
        host: format!("https://{addr}"),
    };
    let dc = ryu_downloads::DownloadCenter::with_default_client();
    let repo = "acme/snap-c3";
    let err = install_snapshot(
        &test_client(),
        &endpoint,
        repo,
        ModelFormat::Safetensors,
        &dc,
    )
    .await
    .expect_err("the shared egress guard must refuse a loopback fixture");
    let message = format!("{err:#}");
    assert!(
        message.contains("private/loopback host is not allowed"),
        "unexpected error: {message}"
    );

    // A single-file format is rejected by install_snapshot.
    assert!(
        install_snapshot(&test_client(), &endpoint, repo, ModelFormat::Gguf, &dc)
            .await
            .is_err()
    );
}
