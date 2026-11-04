use super::*;

#[tokio::test]
async fn sealed_blobs_reach_parsers_only_as_private_temporary_copies() {
    let bytes = b"quarterly figures for the parser".to_vec();
    let sha: String = {
        use sha2::{Digest, Sha256};
        Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    };
    let path = blob_input_path(&sha).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let cipher = ryu_crypto::content_cipher(ryu_spaces::BLOB_STORE).unwrap();
    let context = ryu_crypto::content::ContentContext::for_id("blob", &sha);
    let mut writer = ryu_crypto::SealedFileWriter::create(&path, &cipher, &context).unwrap();
    writer.write_plain(&bytes).unwrap();
    writer.finish().unwrap();

    // The floor reads decrypted, verified bytes.
    assert_eq!(read_blob_bytes(&sha).await.unwrap(), bytes);
    // A provider gets an owner-only copy that disappears with the job.
    let input = decrypt_blob_input(&sha, "report.PDF").await.unwrap();
    assert!(input
        .path
        .starts_with(crate::paths::tmp_dir_for(PARSE_TMP_OWNER)));
    assert_eq!(input.path.extension().and_then(|e| e.to_str()), Some("pdf"));
    assert_eq!(std::fs::read(&input.path).unwrap(), bytes);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&input.path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let copy = input.path.clone();
    drop(input);
    assert!(
        !copy.exists(),
        "the decrypted copy is removed after the job"
    );
    // A missing blob is BlobUnavailable, not a missing parser.
    let missing = "b".repeat(64);
    let err = read_blob_bytes(&missing).await.unwrap_err();
    assert_eq!(err.reason, ParseFailureReason::BlobUnavailable);
}

#[test]
fn a_missing_blob_is_not_reported_as_a_missing_parser() {
    // An empty `sha256` column used to fail as `Unsupported`, which
    // `space_file_index` records as `skipped` — whose remedy text is "install a
    // `document.parse` app". Nothing about a broken storage row is fixed by
    // installing a parser.
    let err = blob_input_path("").expect_err("an empty address is not a blob");
    assert_eq!(err.reason, ParseFailureReason::BlobUnavailable);
    assert_eq!(err.reason.code(), "blob_unavailable");
    assert_ne!(err.reason, ParseFailureReason::Unsupported);
    assert!(
        err.message.contains("no stored blob"),
        "the message must say what actually happened: {}",
        err.message
    );
}

#[test]
fn blob_addresses_that_are_not_plain_hex_are_refused_before_any_join() {
    for bad in [
        "../../etc/passwd",
        "/etc/passwd",
        "ABCD",
        "",
        &"g".repeat(64),
        &"a".repeat(63),
    ] {
        assert!(
            blob_input_path(bad).is_err(),
            "accepted a bad blob address: {bad}"
        );
    }
    let good = "a".repeat(64);
    let path = blob_input_path(&good).expect("64 lowercase hex is the whole alphabet");
    // Component-wise, not a literal separator — this crate builds on Windows too.
    assert!(path.ends_with(std::path::Path::new("blobs").join("aa").join(&good)));
}

#[test]
fn truncation_is_reported_and_lands_on_a_char_boundary() {
    let text = "é".repeat(MAX_MARKDOWN_BYTES);
    let (out, truncated) = truncate_markdown(&text);
    assert!(truncated);
    assert!(out.len() <= MAX_MARKDOWN_BYTES);
    // Round-trips as valid UTF-8 — the cut did not split a code point.
    assert!(out.chars().all(|c| c == 'é'));
}

#[test]
fn succeeded_with_no_markdown_normalizes_to_failed() {
    let snap = json!({ "status": "succeeded", "job_id": "j1", "result": {} });
    let out = normalize_job(&snap);
    assert_eq!(out["status"], "failed");
    assert!(out["error"].is_string(), "a caller must get a reason");
}

#[test]
fn succeeded_with_markdown_passes_through_with_missing_deps() {
    let snap = json!({
        "status": "succeeded",
        "job_id": "j1",
        "filename": "a.pdf",
        "missing_dependencies": ["tesseract"],
        "result": { "markdown": "# Hi", "truncated": false },
    });
    let out = normalize_job(&snap);
    assert_eq!(out["status"], "succeeded");
    assert_eq!(out["markdown"], "# Hi");
    assert_eq!(out["missing_dependencies"][0], "tesseract");
}

#[test]
fn provider_truncation_flag_survives_normalization() {
    let snap = json!({
        "status": "succeeded",
        "result": { "markdown": "short", "truncated": true },
    });
    assert_eq!(normalize_job(&snap)["truncated"], true);
}
