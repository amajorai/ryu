use super::*;
use crate::test_support::*;

#[test]
fn is_mmproj_matches_projector_names() {
    assert!(is_mmproj_filename("mmproj-F16.gguf"));
    assert!(is_mmproj_filename("mmproj-model-f16.gguf"));
    assert!(is_mmproj_filename("MMPROJ-BF16.GGUF"));
    // A normal weight quant is never a projector.
    assert!(!is_mmproj_filename("gemma-4-E2B-it-Q4_K_M.gguf"));
}

#[test]
fn is_imatrix_rejects_quantization_inputs_but_not_normal_weights() {
    assert!(is_imatrix_filename("imatrix_unsloth.gguf"));
    assert!(is_imatrix_filename("model-imatrix.gguf"));
    assert!(is_imatrix_filename("IMATRIX.GGUF"));
    assert!(!is_imatrix_filename("gemma-4-E2B-it-Q4_K_M.gguf"));
    // A non-token substring is not enough to classify a normal filename.
    assert!(!is_imatrix_filename("myimatrix-model-Q4_K_M.gguf"));
}

#[test]
fn pick_mmproj_prefers_f16_then_smallest() {
    use std::collections::HashMap;
    let mut tree: HashMap<String, (Option<u64>, Option<String>)> = HashMap::new();
    // A model quant (ignored) plus several projector precisions.
    tree.insert("gemma-Q4_K_M.gguf".into(), (Some(3_000), None));
    tree.insert("mmproj-Q8_0.gguf".into(), (Some(400), Some("sha8".into())));
    tree.insert("mmproj-F16.gguf".into(), (Some(900), Some("sha16".into())));
    tree.insert("mmproj-F32.gguf".into(), (Some(1_800), None));

    // Default preference is f16, even though Q8 is smaller.
    let (name, _size, sha) = pick_mmproj(&tree).expect("a projector is found");
    assert_eq!(name, "mmproj-F16.gguf");
    assert_eq!(sha.as_deref(), Some("sha16"));
}

#[test]
fn pick_mmproj_none_for_text_only_repo() {
    use std::collections::HashMap;
    let mut tree: HashMap<String, (Option<u64>, Option<String>)> = HashMap::new();
    tree.insert("model-Q4_K_M.gguf".into(), (Some(3_000), None));
    tree.insert("model-Q8_0.gguf".into(), (Some(6_000), None));
    assert!(pick_mmproj(&tree).is_none());
}

#[test]
fn pick_mmproj_falls_back_to_smallest_without_f16() {
    use std::collections::HashMap;
    let mut tree: HashMap<String, (Option<u64>, Option<String>)> = HashMap::new();
    tree.insert("mmproj-Q8_0.gguf".into(), (Some(900), None));
    tree.insert("mmproj-Q4_0.gguf".into(), (Some(400), None));
    // No f16 candidate and no env override → smallest remaining wins.
    let (name, _size, _sha) = pick_mmproj(&tree).expect("a projector is found");
    assert_eq!(name, "mmproj-Q4_0.gguf");
}

#[test]
fn planned_install_bytes_counts_the_projector_and_whole_snapshots() {
    let vision = tree(&[
        ("model-Q4_K_M.gguf", Some(4000)),
        ("mmproj-f16.gguf", Some(500)),
        ("mmproj-q8_0.gguf", Some(400)),
    ]);
    // The f16 projector install_file picks is added to the quant.
    assert_eq!(
        planned_install_bytes(&vision, "model-Q4_K_M.gguf", ModelFormat::Gguf),
        Some(4500)
    );
    // An unlisted file, or one without a size, is unknown — never a refusal.
    assert_eq!(
        planned_install_bytes(&vision, "other.gguf", ModelFormat::Gguf),
        None
    );
    let no_size = tree(&[("model-Q4_K_M.gguf", None)]);
    assert_eq!(
        planned_install_bytes(&no_size, "model-Q4_K_M.gguf", ModelFormat::Gguf),
        None
    );
    let text_only = tree(&[("model-Q4_K_M.gguf", Some(4000))]);
    assert_eq!(
        planned_install_bytes(&text_only, "model-Q4_K_M.gguf", ModelFormat::Gguf),
        Some(4000)
    );

    let snapshot = tree(&[
        ("model-00001-of-00002.safetensors", Some(3000)),
        ("model-00002-of-00002.safetensors", Some(2000)),
        ("config.json", None),
    ]);
    assert_eq!(
        planned_install_bytes(&snapshot, "", ModelFormat::Safetensors),
        Some(5000)
    );
    assert_eq!(
        planned_install_bytes(&tree(&[]), "", ModelFormat::Safetensors),
        None
    );
}

#[test]
fn install_block_codes_memory_and_disk_refusals_and_never_unknowns() {
    let gib = 1024u64 * 1024 * 1024;
    // 8 GB of RAM, no GPU, plenty of disk: a 20 GB model cannot load.
    let small = with_disk(dev(Some(8 * gib), None), 500 * gib);
    let block = install_block_for(Some(20 * gib), &small, false).expect("too big");
    assert_eq!(block.code, "model_too_large");
    assert_eq!(block.verdict, "too_big");
    assert_eq!(block.size_bytes, 20 * gib);
    assert!(block.message.starts_with("Too large for this device"));

    // Fits memory but not the disk: refused as a disk problem first.
    let full = with_disk(dev(Some(64 * gib), Some(48 * gib)), 3 * gib);
    let block = install_block_for(Some(4 * gib), &full, false).expect("no space");
    assert_eq!(block.code, "insufficient_disk");
    assert_eq!(block.verdict, "no_space");
    assert_eq!(
        serde_json::to_value(&block).unwrap(),
        serde_json::json!({
            "code": "insufficient_disk",
            "verdict": "no_space",
            "message": block.message,
            "sizeBytes": 4 * gib,
        })
    );

    // Already installed: the disk no longer matters (a re-install is
    // skipped), but memory still does.
    assert_eq!(install_block_for(Some(4 * gib), &full, true), None);
    assert_eq!(
        install_block_for(Some(20 * gib), &small, true).map(|block| block.code),
        Some("model_too_large")
    );

    // Runs (slowly, on the CPU) and fits the disk: allowed.
    assert_eq!(install_block_for(Some(2 * gib), &small, false), None);
    // Unknown size or unknown hardware never refuses.
    assert_eq!(install_block_for(None, &small, false), None);
    assert_eq!(
        install_block_for(Some(500 * gib), &dev(None, None), false),
        None
    );
}

#[test]
fn gguf_download_spec_shape() {
    ensure_test_host();
    let spec = gguf_download_spec(
        "my-stem",
        "https://hf/x.gguf",
        "deadbeef",
        "a label",
        ryu_downloads::DownloadRole::ChatModel,
    );
    assert_eq!(spec.url, "https://hf/x.gguf");
    assert_eq!(spec.sha256.as_deref(), Some("deadbeef"));
    assert!(spec
        .dest
        .ends_with(std::path::Path::new("models/chat/my-stem.gguf")));
    // Registry defaults of other roles land in their own modality folders.
    for (role, dir) in [
        (ryu_downloads::DownloadRole::EmbeddingModel, "embedding"),
        (ryu_downloads::DownloadRole::RerankerModel, "rerank"),
        (ryu_downloads::DownloadRole::ClassifierModel, "classifier"),
        (ryu_downloads::DownloadRole::SpeechModel, "chat"),
    ] {
        let spec = gguf_download_spec("r", "u", "", "l", role);
        assert!(
            spec.dest
                .ends_with(std::path::Path::new("models").join(dir).join("r.gguf")),
            "{role:?} → {}",
            spec.dest.display()
        );
    }
    assert_eq!(
        spec.version_record.as_ref().unwrap().store_key,
        "gguf:my-stem"
    );
    // Empty sha → no checksum on the spec.
    let spec2 = gguf_download_spec("s2", "u", "", "l", ryu_downloads::DownloadRole::ChatModel);
    assert!(spec2.sha256.is_none());
}

#[tokio::test]
async fn install_file_rejects_loopback_fixture() {
    ensure_test_host();
    ensure_downloads_host();
    let addr = spawn_http(|path| {
        if path.contains("/tree/") {
            (200, vec![], b"[]".to_vec()) // empty tree → no sha, no mmproj
        } else if path.contains("/resolve/") {
            (200, vec![], b"FAKE-GGUF-INSTALL-FILE".to_vec())
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
    std::fs::create_dir_all(installed::chat_models_dir()).unwrap();
    let stem = "install-file-unique-c2";
    let err = install_file(
        &test_client(),
        &endpoint,
        "acme/inst-file-c2",
        &format!("{stem}.gguf"),
        &dc,
    )
    .await
    .expect_err("the shared egress guard must refuse a loopback fixture");
    let message = format!("{err:#}");
    assert!(
        message.contains("private/loopback host is not allowed"),
        "unexpected error: {message}"
    );

    // Path-traversal + bad-repo guards fire before any network.
    assert!(
        install_file(&test_client(), &endpoint, "acme/x", "../evil.gguf", &dc)
            .await
            .is_err()
    );
    assert!(
        install_file(&test_client(), &endpoint, "no-slash", "ok.gguf", &dc)
            .await
            .is_err()
    );
    let matrix_error = install_file(
        &test_client(),
        &endpoint,
        "acme/x",
        "imatrix_unsloth.gguf",
        &dc,
    )
    .await
    .expect_err("importance matrices must never be installed as models");
    assert!(matrix_error
        .to_string()
        .contains("not runnable model weights"));
}
