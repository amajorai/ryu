use super::*;

#[test]
fn config_roundtrips_through_json() {
    let cfg = ExternalRuntimeConfig {
        kind: "python".to_owned(),
        entry: "ryu_tts".to_owned(),
        port_env: None,
        python_version: Some("3.11".to_owned()),
        requirements: vec!["fastapi".to_owned()],
        pyproject_extra: Some("kitten".to_owned()),
        assets: vec![AssetSpec {
            source: "hf:KittenML/kitten-tts".to_owned(),
            dest_under_runtime: "models/hf".to_owned(),
            sha256: None,
        }],
        model_snapshots: vec![],
        port: Some(8085),
        health_path: Some("/health".to_owned()),
        source: Some(SourceArchiveSpec {
            url: "https://example.com/pkg.tar.gz".to_owned(),
            sha256: None,
            format: "tar.gz".to_owned(),
            path: None,
        }),
        env: std::collections::BTreeMap::from([(
            "HF_HOME".to_owned(),
            "${RYU_MODELS_DIR}/hf".to_owned(),
        )]),
    };
    let json = serde_json::to_string(&cfg).expect("serialise");
    let back: ExternalRuntimeConfig = serde_json::from_str(&json).expect("deserialise");
    assert_eq!(cfg, back);
}

#[test]
fn config_defaults_minimal() {
    let json = r#"{ "kind": "python", "entry": "ryu_tts" }"#;
    let cfg: ExternalRuntimeConfig = serde_json::from_str(json).expect("deserialise minimal");
    assert_eq!(cfg.kind, "python");
    assert_eq!(cfg.entry, "ryu_tts");
    assert!(cfg.requirements.is_empty());
    assert!(cfg.pyproject_extra.is_none());
    assert!(cfg.assets.is_empty());
    assert!(cfg.model_snapshots.is_empty());
}

#[test]
fn venv_python_is_os_correct() {
    let dir = Path::new("/tmp/plugin");
    let p = venv_python(dir);
    let s = p.to_string_lossy();
    if cfg!(target_os = "windows") {
        assert!(s.contains(".venv"));
        assert!(s.ends_with("python.exe"));
        assert!(s.contains("Scripts"));
    } else {
        assert!(s.contains(".venv"));
        assert!(s.ends_with("python"));
        assert!(s.contains("bin"));
    }
}

#[test]
fn bootstrap_python_matches_platform() {
    let p = bootstrap_python();
    if cfg!(target_os = "windows") {
        assert_eq!(p, "python");
    } else {
        assert_eq!(p, "python3");
    }
}

#[tokio::test]
async fn source_extraction_is_noop_without_source() {
    // No `source` declared → returns Ok and touches nothing (no network).
    let cfg = ExternalRuntimeConfig {
        kind: "python".to_owned(),
        entry: "x".to_owned(),
        ..Default::default()
    };
    let downloads = crate::downloads::DownloadCenter::with_default_client();
    let tmp = std::env::temp_dir().join(format!("ryu-src-noop-{}", std::process::id()));
    fetch_and_extract_source(&cfg, &tmp, &downloads, &tmp)
        .await
        .expect("no-op with no source");
}

#[tokio::test]
async fn source_extraction_skips_when_marker_present() {
    // An already-extracted source (marker present) short-circuits BEFORE any
    // download/SSRF work, so a bogus URL is never touched.
    let dir = std::env::temp_dir().join(format!("ryu-src-skip-{}", std::process::id()));
    tokio::fs::create_dir_all(&dir).await.expect("mkdir");
    tokio::fs::write(dir.join(SOURCE_MARKER), b"[project]\n")
        .await
        .expect("write marker");
    let cfg = ExternalRuntimeConfig {
        kind: "python".to_owned(),
        entry: "x".to_owned(),
        source: Some(SourceArchiveSpec {
            url: "https://never.invalid/should-not-fetch.tar.gz".to_owned(),
            sha256: None,
            format: "tar.gz".to_owned(),
            path: None,
        }),
        ..Default::default()
    };
    let downloads = crate::downloads::DownloadCenter::with_default_client();
    fetch_and_extract_source(&cfg, &dir, &downloads, &dir)
        .await
        .expect("skips when marker present");
    let _ = tokio::fs::remove_dir_all(&dir).await;
}

#[tokio::test]
async fn provision_rejects_unsupported_kind() {
    let cfg = ExternalRuntimeConfig {
        kind: "node".to_owned(),
        entry: "x".to_owned(),
        ..Default::default()
    };
    // The kind check returns before any download work, so a default
    // DownloadCenter is never touched here.
    let downloads = crate::downloads::DownloadCenter::with_default_client();
    let err = provision(&cfg, Path::new("/tmp/does-not-matter"), &downloads)
        .await
        .unwrap_err();
    assert!(matches!(err, ProvisionError::UnsupportedKind(_)));
}

// ── provisioning gate (may_provision) ─────────────────────────────────────

#[test]
fn core_tier_always_provisions() {
    use crate::plugin_manifest::PluginTier;
    assert!(may_provision(PluginTier::Core, &[]));
    assert!(may_provision(
        PluginTier::Core,
        &["something:else".to_owned()]
    ));
}

#[test]
fn community_tier_needs_approved_grant() {
    use crate::plugin_manifest::PluginTier;
    // No grant → denied (fail-closed).
    assert!(!may_provision(PluginTier::Community, &[]));
    // Unrelated grant → still denied.
    assert!(!may_provision(
        PluginTier::Community,
        &["mcp:web_search".to_owned()]
    ));
    // The external-runtime grant (Gateway-approved) → allowed.
    assert!(may_provision(
        PluginTier::Community,
        &[GRANT_EXTERNAL_RUNTIME.to_owned()]
    ));
}

// ── asset source resolution ───────────────────────────────────────────────

#[test]
fn resolve_hf_ref_with_file_path() {
    let url = resolve_asset_url("hf:KittenML/kitten-tts/model.onnx").unwrap();
    assert_eq!(
        url,
        "https://huggingface.co/KittenML/kitten-tts/resolve/main/model.onnx"
    );
}

#[test]
fn resolve_hf_ref_with_nested_file_path() {
    let url = resolve_asset_url("hf:owner/repo/sub/dir/weights.bin").unwrap();
    assert_eq!(
        url,
        "https://huggingface.co/owner/repo/resolve/main/sub/dir/weights.bin"
    );
}

#[test]
fn resolve_hf_repo_only_ref_is_rejected() {
    let err = resolve_asset_url("hf:KittenML/kitten-tts").unwrap_err();
    assert!(matches!(err, ProvisionError::UnsupportedAssetSource(_)));
}

#[test]
fn model_snapshot_source_requires_one_hf_repository() {
    assert_eq!(
        parse_model_source("hf:convaiinnovations/laya").unwrap(),
        ("convaiinnovations".to_owned(), "laya".to_owned())
    );
    for source in [
        "https://huggingface.co/convaiinnovations/laya",
        "hf:convaiinnovations/laya/extra",
        "hf:../laya",
    ] {
        assert!(
            parse_model_source(source).is_err(),
            "model source should be rejected: {source}"
        );
    }
}

#[test]
fn model_snapshot_tree_listing_uses_a_bounded_page_size() {
    let url = model_snapshot_tree_url("Cactus-Compute", "needle3", "b274efc");
    assert!(url.ends_with("?recursive=true&expand=true&limit=100"));
}

#[test]
fn model_snapshot_tree_pagination_stays_on_the_hugging_face_endpoint() {
    let path = "/api/models/owner/repo/tree/revision";
    let link_header = concat!(
        "<https://huggingface.co/api/models/owner/repo/tree/revision?cursor=next>; rel=\"next\", ",
        "<https://huggingface.co/api/models/owner/repo/tree/revision?cursor=previous>; rel=\"prev\""
    );
    let next = next_hf_tree_page_url(link_header, path)
        .expect("valid next link")
        .expect("next link exists");
    assert_eq!(next.host_str(), Some("huggingface.co"));
    assert_eq!(next.path(), path);
    assert_eq!(
        next.query_pairs()
            .find(|(key, _)| key == "cursor")
            .map(|(_, value)| value.into_owned()),
        Some("next".to_owned())
    );
    assert!(next_hf_tree_page_url(
        "<https://evil.example/api/models/owner/repo/tree/revision?cursor=next>; rel=\"next\"",
        path
    )
    .is_err());
    assert!(next_hf_tree_page_url(
        "<https://huggingface.co/api/models/owner/other/tree/revision?cursor=next>; rel=\"next\"",
        path
    )
    .is_err());
}

#[test]
fn plugin_model_snapshot_download_uses_the_local_model_role() {
    let snapshot = ModelSnapshotSpec {
        source: "hf:Cactus-Compute/needle3".to_owned(),
        revision: "b274efcb211a9eef48c9a88da4b43bd569696a39".to_owned(),
        dest_under_runtime: "models/needle3".to_owned(),
        files: vec!["needle3.cact".to_owned()],
    };
    let spec = model_snapshot_download_spec(
        &snapshot,
        ("Cactus-Compute", "needle3"),
        "needle3.cact",
        PathBuf::from("runtime/models/needle3/needle3.cact"),
        Some("c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38".to_owned()),
    );

    assert_eq!(
        serde_json::to_value(spec.role).expect("serialize role"),
        "plugin_model"
    );
    assert_eq!(spec.kind, crate::downloads::DownloadKind::Model);
    assert_eq!(
        spec.url,
        "https://huggingface.co/Cactus-Compute/needle3/resolve/b274efcb211a9eef48c9a88da4b43bd569696a39/needle3.cact"
    );
    assert_eq!(
        spec.sha256.as_deref(),
        Some("c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38")
    );
}

#[tokio::test]
#[ignore = "live Hugging Face smoke; downloads the pinned 35 MB public Needle 3 snapshot"]
async fn live_needle_snapshot_downloads_through_the_core_download_center() {
    use sha2::{Digest, Sha256};

    crate::downloads::install();
    let runtime_dir = std::env::temp_dir().join(format!(
        "ryu-hf-live-needle-snapshot-{}",
        std::process::id()
    ));
    assert!(
        !runtime_dir.exists(),
        "refusing to reuse the live smoke directory: {}",
        runtime_dir.display()
    );
    tokio::fs::create_dir_all(&runtime_dir)
        .await
        .expect("create isolated runtime directory");

    let cfg = ExternalRuntimeConfig {
        model_snapshots: vec![ModelSnapshotSpec {
            source: "hf:Cactus-Compute/needle3".to_owned(),
            revision: "b274efcb211a9eef48c9a88da4b43bd569696a39".to_owned(),
            dest_under_runtime: "models/needle3".to_owned(),
            files: vec!["LICENSE".to_owned(), "needle3.cact".to_owned()],
        }],
        ..Default::default()
    };
    let downloads = crate::downloads::DownloadCenter::with_default_client();
    let fetch_result = fetch_model_snapshots(&cfg, &runtime_dir, &downloads).await;
    let weights_path = runtime_dir.join("models/needle3/needle3.cact");
    let actual_digest = tokio::fs::read(&weights_path)
        .await
        .map(|bytes| hex::encode(Sha256::digest(bytes)));
    let cleanup_result = tokio::fs::remove_dir_all(&runtime_dir).await;

    fetch_result.expect("Ryu should provision the pinned Needle 3 snapshot");
    cleanup_result.expect("remove the isolated live-smoke runtime");
    assert_eq!(
        actual_digest.expect("read downloaded Needle 3 weights"),
        "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38"
    );
}

#[test]
fn model_snapshot_paths_reject_traversal_and_hidden_files() {
    assert!(is_safe_model_path("tokenizer/tokenizer.json"));
    assert!(is_safe_model_path("LICENSE"));
    assert!(is_safe_model_path("licenses/LICENSE.md"));
    assert!(is_safe_model_path("needle3.cact"));
    assert!(!is_safe_model_path("README.md"));
    assert!(!is_safe_model_path("LICENSE.py"));
    for path in [
        "../model.safetensors",
        ".gitattributes",
        "/model.safetensors",
        "a\\b",
        "server.py",
    ] {
        assert!(
            !is_safe_model_path(path),
            "unsafe model path accepted: {path}"
        );
    }
}

#[test]
fn model_revision_is_bounded_and_url_safe() {
    assert!(validate_model_revision(
        "1c5edc17a7acd8701df6fc341c0d179f1c62c982"
    ));
    assert!(validate_model_revision("main"));
    assert!(!validate_model_revision("refs/heads/main"));
    assert!(!validate_model_revision("../main"));
}

#[test]
fn resolve_https_url_passes_through() {
    let url = resolve_asset_url("https://example.com/a/model.gguf").unwrap();
    assert_eq!(url, "https://example.com/a/model.gguf");
}

#[test]
fn resolve_http_url_is_rejected() {
    let err = resolve_asset_url("http://example.com/x.bin").unwrap_err();
    assert!(matches!(err, ProvisionError::UnsupportedAssetSource(_)));
}

// ── asset destination (traversal safety) ──────────────────────────────────

#[test]
fn asset_dest_joins_dir_and_filename() {
    let base = Path::new("/ryu/plugins/example/runtime");
    let dest = asset_dest(base, "models/hf", "https://example.com/a/model.gguf").unwrap();
    assert_eq!(
        dest,
        Path::new("/ryu/plugins/example/runtime").join("assets/models/hf/model.gguf")
    );
    assert!(dest.starts_with(base.join("assets")));
}

#[test]
fn asset_dest_rejects_parent_traversal() {
    let base = Path::new("/ryu");
    let err = asset_dest(base, "../../etc", "https://example.com/x.bin").unwrap_err();
    assert!(matches!(err, ProvisionError::UnsafeAssetPath(_)));
}

#[test]
fn asset_dest_rejects_absolute_dest() {
    let base = Path::new("/ryu");
    let err = asset_dest(base, "/etc", "https://example.com/x.bin").unwrap_err();
    assert!(matches!(err, ProvisionError::UnsafeAssetPath(_)));
}

#[test]
fn asset_dest_rejects_directory_url_with_no_filename() {
    let base = Path::new("/ryu");
    let err = asset_dest(base, "models", "https://example.com/dir/").unwrap_err();
    assert!(matches!(err, ProvisionError::UnsafeAssetPath(_)));
}
