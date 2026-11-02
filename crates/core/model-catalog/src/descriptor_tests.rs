use super::*;
use crate::test_support::*;
use std::sync::atomic::{AtomicUsize, Ordering};

/// A well-formed (but arbitrary) 64-hex pin for fixtures that must get past the
/// pin check and reach the download path.
const VALID_PIN: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

#[tokio::test]
async fn install_from_descriptor_rejects_loopback_fixture() {
    ensure_test_host();
    ensure_downloads_host();
    let addr = spawn_http(|path| {
        if path.contains("/resolve/") {
            (200, vec![], b"FAKE-GGUF-DESCRIPTOR-BYTES".to_vec())
        } else {
            (404, vec![], b"no".to_vec())
        }
    });
    let dc = ryu_downloads::DownloadCenter::with_default_client();
    std::fs::create_dir_all(installed::chat_models_dir()).unwrap();
    let stem = "install-desc-unique-c1";
    // Downloads are HTTPS-only, so the loopback refusal (not the scheme check)
    // is what this fixture pins.
    let url = format!("https://{addr}/acme/desc-repo/resolve/main/{stem}.gguf");
    let matrix_error = install_from_descriptor(
        "acme/desc-repo",
        &url,
        Some(VALID_PIN),
        "imatrix_unsloth.gguf",
        &dc,
    )
    .await
    .expect_err("importance matrices must never be installed as models");
    assert!(matrix_error
        .to_string()
        .contains("not runnable model weights"));
    let err = install_from_descriptor(
        "acme/desc-repo",
        &url,
        Some(VALID_PIN),
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
}

#[tokio::test]
async fn install_from_descriptor_refuses_a_missing_or_malformed_pin_before_fetching() {
    ensure_test_host();
    ensure_downloads_host();
    let hits = std::sync::Arc::new(AtomicUsize::new(0));
    let seen = hits.clone();
    let addr = spawn_http(move |_path| {
        seen.fetch_add(1, Ordering::SeqCst);
        (200, vec![], b"ATTACKER-CHOSEN-BYTES".to_vec())
    });
    let dc = ryu_downloads::DownloadCenter::with_default_client();
    std::fs::create_dir_all(installed::chat_models_dir()).unwrap();
    let stem = "install-desc-unpinned-c2";
    let url = format!("https://{addr}/acme/desc-repo/resolve/main/{stem}.gguf");
    let short = &VALID_PIN[..63];
    let long = format!("{VALID_PIN}0");
    let non_hex = format!("{}g", &VALID_PIN[..63]);
    let spaced = format!("{} {}", &VALID_PIN[..32], &VALID_PIN[32..63]);
    let pins: [Option<&str>; 7] = [
        None,
        Some(""),
        Some("   "),
        Some(short),
        Some(&long),
        Some(&non_hex),
        Some(&spaced),
    ];
    for pin in pins {
        let err =
            install_from_descriptor("acme/desc-repo", &url, pin, &format!("{stem}.gguf"), &dc)
                .await
                .expect_err("an unpinned descriptor must never be downloaded");
        let message = format!("{err:#}");
        assert!(
            message.contains("sha256 pin"),
            "pin {pin:?} must be refused by the pin check, got: {message}"
        );
        assert!(
            !message.contains("downloading"),
            "pin {pin:?} reached the download path: {message}"
        );
    }
    assert_eq!(hits.load(Ordering::SeqCst), 0, "no request may be made");
    assert!(!installed::model_file_path(stem).exists());
}

#[test]
fn require_sha256_pin_normalises_case_and_whitespace() {
    let upper = VALID_PIN.to_ascii_uppercase();
    assert_eq!(require_sha256_pin(Some(&upper)).unwrap(), VALID_PIN);
    let padded = format!("  {VALID_PIN}\n");
    assert_eq!(require_sha256_pin(Some(&padded)).unwrap(), VALID_PIN);
    assert!(require_sha256_pin(None).is_err());
    assert!(require_sha256_pin(Some("sha256:abc")).is_err());
}
