use super::*;

#[test]
fn repo_from_hf_url_extracts_repo() {
    assert_eq!(
        repo_from_hf_url(
            "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf"
        )
        .as_deref(),
        Some("unsloth/gemma-4-E2B-it-GGUF")
    );
    assert_eq!(repo_from_hf_url("https://example.com/foo.gguf"), None);
}

#[test]
fn on_disk_stems_exclude_mmproj_and_models_dir_has() {
    ensure_test_host();
    let stem = "ondisk-unique-f1";
    let models = installed::chat_models_dir();
    std::fs::create_dir_all(&models).unwrap();
    std::fs::write(models.join(format!("{stem}.gguf")), b"x").unwrap();
    std::fs::write(models.join(format!("{stem}.mmproj.gguf")), b"p").unwrap();
    std::fs::write(models.join("imatrix_unsloth.gguf"), b"matrix").unwrap();

    assert!(models_dir_has(stem));
    assert!(!models_dir_has("ondisk-nope-f1"));

    let stems = on_disk_gguf_stems();
    assert!(stems.contains(&stem.to_string()));
    assert!(
        !stems.contains(&format!("{stem}.mmproj")),
        "the vision adapter must never surface as its own stem"
    );
    assert!(
        !stems.contains(&"imatrix_unsloth".to_string()),
        "an importance matrix must never surface as its own stem"
    );

    let _ = std::fs::remove_file(models.join(format!("{stem}.gguf")));
    let _ = std::fs::remove_file(models.join(format!("{stem}.mmproj.gguf")));
    let _ = std::fs::remove_file(models.join("imatrix_unsloth.gguf"));
}

#[test]
fn on_disk_stems_ignore_other_modalities() {
    ensure_test_host();
    let root = ryu_dir();
    // A TTS GGUF (e.g. OuteTTS / WavTokenizer) lives in its own modality
    // folder and must never surface as an installed chat card.
    let tts = layout::models_dir(&root, Modality::TextToSpeech).join("outetts");
    std::fs::create_dir_all(&tts).unwrap();
    let tts_stem = "tts-scan-unique-h1";
    std::fs::write(tts.join(format!("{tts_stem}.gguf")), b"x").unwrap();
    let tts_flat = layout::models_dir(&root, Modality::TextToSpeech);
    let tts_flat_stem = "tts-scan-flat-unique-h1";
    std::fs::write(tts_flat.join(format!("{tts_flat_stem}.gguf")), b"x").unwrap();
    // Image weights (the diffusion text encoder) likewise.
    let image = layout::models_dir(&root, Modality::Image);
    std::fs::create_dir_all(&image).unwrap();
    let image_stem = "image-scan-unique-h1";
    std::fs::write(image.join(format!("{image_stem}.gguf")), b"x").unwrap();
    // The bundled embedding default is intentionally listed.
    let embedding = layout::models_dir(&root, Modality::Embedding);
    std::fs::create_dir_all(&embedding).unwrap();
    let embed_stem = "embed-scan-unique-h1";
    std::fs::write(embedding.join(format!("{embed_stem}.gguf")), b"x").unwrap();

    let stems = on_disk_gguf_stems();
    assert!(!stems.contains(&tts_stem.to_string()));
    assert!(!stems.contains(&tts_flat_stem.to_string()));
    assert!(!stems.contains(&image_stem.to_string()));
    assert!(!models_dir_has(tts_flat_stem));
    assert!(stems.contains(&embed_stem.to_string()));
    assert_eq!(
        installed::model_file_path(embed_stem),
        embedding.join(format!("{embed_stem}.gguf"))
    );

    let _ = std::fs::remove_file(tts.join(format!("{tts_stem}.gguf")));
    let _ = std::fs::remove_file(tts_flat.join(format!("{tts_flat_stem}.gguf")));
    let _ = std::fs::remove_file(image.join(format!("{image_stem}.gguf")));
    let _ = std::fs::remove_file(embedding.join(format!("{embed_stem}.gguf")));
}

#[test]
fn record_default_download_derives_repo_and_filename() {
    ensure_test_host();
    let stem = "default-dl-unique-d1";
    let models = installed::chat_models_dir();
    std::fs::create_dir_all(&models).unwrap();
    std::fs::write(models.join(format!("{stem}.gguf")), b"x").unwrap();
    record_default_download(
        stem,
        "https://huggingface.co/acme/default-dl-repo/resolve/main/default-dl-unique-d1.gguf?download=true",
        Some(1),
        None,
    )
    .unwrap();
    // Provenance resolves the on-disk stem back to the derived HF repo.
    assert_eq!(
        installed::repo_for_stem(stem).as_deref(),
        Some("acme/default-dl-repo")
    );

    let _ = installed::remove(stem);
    let _ = std::fs::remove_file(models.join(format!("{stem}.gguf")));
}

#[tokio::test]
async fn uninstall_file_removes_weights_adapter_and_record() {
    ensure_test_host();
    let stem = "uninstall-unique-e1";
    let filename = "uninstall-unique-e1.gguf";
    let models = installed::chat_models_dir();
    std::fs::create_dir_all(&models).unwrap();
    let path = models.join(format!("{stem}.gguf"));
    std::fs::write(&path, b"x").unwrap();
    let mm = installed::mmproj_file_path(stem);
    std::fs::write(&mm, b"p").unwrap();
    installed::record(installed::InstalledModel {
        repo_id: "acme/uninst".into(),
        filename: filename.into(),
        stem: stem.into(),
        size_bytes: Some(1),
        format: ModelFormat::Gguf,
        mmproj: Some("mmproj-f16.gguf".into()),
        finetune_base: None,
    })
    .unwrap();

    uninstall_file("acme/uninst", filename).unwrap();
    assert!(!path.exists(), "weights removed");
    assert!(!mm.exists(), "bound vision adapter removed too");
    assert!(installed::load_present().iter().all(|m| m.stem != stem));

    // Idempotent: uninstalling an already-gone file still succeeds.
    uninstall_file("acme/uninst", filename).unwrap();
    // Path traversal is rejected before touching the filesystem.
    assert!(uninstall_file("acme/uninst", "../evil.gguf").is_err());
}
