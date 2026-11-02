use super::*;
use crate::test_support::*;

#[test]
fn strip_front_matter_removes_yaml() {
    let md = "---\nlicense: mit\ntags:\n- text-generation\n---\n# Hello\nbody";
    assert_eq!(strip_front_matter(md), "# Hello\nbody");
}

#[test]
fn strip_front_matter_keeps_plain_markdown() {
    let md = "# Title\nno front matter";
    assert_eq!(strip_front_matter(md), md);
}

#[test]
fn snapshot_fit_conservative_labels() {
    let gib = 1024u64 * 1024 * 1024;
    let big = dev(Some(64 * gib), Some(48 * gib));

    // Unknown total → "size unknown".
    let (fit, label) = snapshot_fit(None, &big, false);
    assert_eq!(fit, "unknown");
    assert!(label.to_lowercase().contains("unknown"));

    // A tiny repo fits comfortably → great/ok passes through verbatim.
    let (fit, _) = snapshot_fit(Some(gib), &big, false);
    assert!(fit == "great" || fit == "ok");

    // A repo far larger than any memory → blocked too_big with numbers.
    let (fit, label) = snapshot_fit(Some(500 * gib), &big, false);
    assert_eq!(fit, "too_big");
    assert!(label.contains("won't fit"), "{label}");

    // Spills past VRAM but fits RAM → slow, not blocked.
    let (fit, label) = snapshot_fit(Some(50 * gib), &big, false);
    assert_eq!(fit, "partial");
    assert!(label.contains("may be slow"), "{label}");

    // No device memory at all → estimate is Unknown → conservative unknown.
    let (fit, _) = snapshot_fit(Some(gib), &dev(None, None), false);
    assert_eq!(fit, "unknown");
}

#[test]
fn snapshot_fit_reports_no_space_with_numbers_unless_installed() {
    let gib = 1024u64 * 1024 * 1024;
    let tight_disk = with_disk(dev(Some(64 * gib), Some(48 * gib)), 3 * gib);

    let (fit, label) = snapshot_fit(Some(4 * gib), &tight_disk, false);
    assert_eq!(fit, "no_space");
    assert_eq!(
        label,
        "Not enough free disk space — this 4.0 GB model needs 6.0 GB free, only 3.0 GB is free."
    );

    // Already on disk: only memory matters, so the same repo fits.
    let (fit, _) = snapshot_fit(Some(4 * gib), &tight_disk, true);
    assert!(fit == "great" || fit == "ok", "{fit}");
}

#[tokio::test]
async fn model_detail_builds_gguf_file_list_and_readme() {
    ensure_test_host();
    let addr = spawn_http(|path| {
        if path.contains("/tree/") {
            let body = serde_json::json!([
                { "path": "model-Q4_K_M.gguf", "size": 0, "lfs": { "oid": "abc", "size": 4000 } },
                { "path": "model-Q8_0.gguf", "size": 8000 },
                { "path": "mmproj-f16.gguf", "size": 500 },
                { "path": "imatrix_unsloth.gguf", "size": 13000000 },
                { "path": "README.md", "size": 10 }
            ])
            .to_string()
            .into_bytes();
            (200, vec![], body)
        } else if path.contains("/raw/") && path.contains("README") {
            (
                200,
                vec![],
                b"---\nlicense: mit\n---\n# Hello\nBody text".to_vec(),
            )
        } else if path.contains("/api/models/") {
            let body = serde_json::json!({
                "id": "acme/widget-detail-model",
                "downloads": 5, "likes": 1,
                "tags": ["text-generation"],
                "pipeline_tag": "text-generation",
                "gated": false,
                "createdAt": "2024-01-01", "lastModified": "2024-02-01",
                "gguf": { "context_length": 4096, "architecture": "llama", "total": 4_000_000_000u64 },
                "siblings": [
                    { "rfilename": "model-Q4_K_M.gguf" },
                    { "rfilename": "model-Q8_0.gguf" },
                    { "rfilename": "mmproj-f16.gguf" },
                    { "rfilename": "imatrix_unsloth.gguf" },
                    { "rfilename": "README.md" }
                ]
            })
            .to_string()
            .into_bytes();
            (200, vec![], body)
        } else {
            (404, vec![], b"no".to_vec())
        }
    });
    let endpoint = HfEndpoint {
        api_base: format!("http://{addr}/api"),
        host: format!("http://{addr}"),
    };
    let detail = model_detail(
        &test_client(),
        &endpoint,
        "acme/widget-detail-model",
        ModelFormat::Gguf,
    )
    .await
    .unwrap();

    assert_eq!(detail.card.id, "acme/widget-detail-model");
    assert_eq!(detail.card.context_length, Some(4096));
    assert!(detail.vision, "repo ships an mmproj projector ⇒ vision");
    // mmproj + imatrix + README excluded → exactly the two selectable quants.
    assert_eq!(detail.files.len(), 2);
    // Smallest-first (both un-installed): Q4 (4000) before Q8 (8000).
    assert_eq!(detail.files[0].filename, "model-Q4_K_M.gguf");
    assert_eq!(detail.files[0].quant.as_deref(), Some("Q4_K_M"));
    assert_eq!(detail.files[0].size_bytes, Some(4000));
    assert_eq!(detail.files[0].sha256.as_deref(), Some("abc"));
    assert_eq!(detail.files[1].filename, "model-Q8_0.gguf");
    assert_eq!(detail.files[1].sha256, None);
    // Front-matter stripped from the README.
    assert_eq!(detail.readme.as_deref(), Some("# Hello\nBody text"));
    // GGUF leaves the snapshot repo-level fields empty.
    assert!(detail.repo_fit.is_empty());
    assert!(detail.repo_size_bytes.is_none());
}

#[tokio::test]
async fn cached_json_wrappers_serve_from_cache() {
    ensure_test_host();
    let addr = spawn_http(|path| {
        if path.contains("/api/models?") {
            (200, vec![], b"[]".to_vec())
        } else {
            (404, vec![], b"no".to_vec())
        }
    });
    let endpoint = HfEndpoint {
        api_base: format!("http://{addr}/api"),
        host: format!("http://{addr}"),
    };
    let first = search_models_json(
        &test_client(),
        &endpoint,
        "cache-probe-unique-h1",
        CatalogSort::Recent,
        ModelFormat::Gguf,
        20,
        false,
        "",
        "",
        None,
    )
    .await
    .unwrap();
    assert!(first.get("models").is_some());
    // Second call with the same key is served from the in-process cache.
    let second = search_models_json(
        &test_client(),
        &endpoint,
        "cache-probe-unique-h1",
        CatalogSort::Recent,
        ModelFormat::Gguf,
        20,
        false,
        "",
        "",
        None,
    )
    .await
    .unwrap();
    assert_eq!(first, second);
}
