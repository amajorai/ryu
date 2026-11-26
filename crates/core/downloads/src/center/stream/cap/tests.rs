//! The cap decision and its refusals, with fake specs and a fake manifest. No
//! download. Whole transfers against a loopback origin are in `transfer_test`.

use super::*;

const GIB: u64 = 1024 * 1024 * 1024;

/// A well-formed pin: the SHA-256 of nothing in particular.
const PIN: &str = "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2";

/// Caps set by a test for one destination, as `(dest, no pin, pinned)`.
static LIMITS: std::sync::Mutex<Vec<(PathBuf, u64, u64)>> = std::sync::Mutex::new(Vec::new());

/// Shrink the caps for transfers to `dest`, so a few kilobytes can cross them.
pub(super) fn set_limits(dest: &Path, unpinned: u64, pinned: u64) {
    LIMITS
        .lock()
        .unwrap()
        .push((dest.to_path_buf(), unpinned, pinned));
}

/// The caps a test set for `dest`, if any (read by `limits` in the parent).
pub(super) fn limits_for(dest: &Path) -> Option<(u64, u64)> {
    LIMITS
        .lock()
        .unwrap()
        .iter()
        .find(|(path, _, _)| path == dest)
        .map(|(_, unpinned, pinned)| (*unpinned, *pinned))
}

pub(super) fn spec(dest: PathBuf, sha256: Option<&str>) -> DownloadSpec {
    DownloadSpec {
        kind: DownloadKind::Media,
        role: DownloadRole::ImageModel,
        label: "fake".to_string(),
        url: "https://downloads.invalid/fake.gguf".to_string(),
        dest,
        sha256: sha256.map(str::to_string),
        version_record: None,
    }
}

fn cap_of(sha256: Option<&str>) -> TransferCap {
    TransferCap::of(&spec(PathBuf::from("fake.gguf"), sha256))
}

/// The message of a refusal. A cap refusal must be terminal, never retried.
fn refused(result: std::result::Result<(), StreamErr>) -> String {
    match result {
        Ok(()) => panic!("expected a refusal"),
        Err(error) => message(error),
    }
}

fn message(error: StreamErr) -> String {
    match error {
        StreamErr::Io(message) => message,
        StreamErr::Network(message) => {
            panic!("a cap refusal must be terminal, not retried: {message}")
        }
    }
}

pub(super) fn scratch_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ryu-downloads-cap-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_download_without_a_valid_pin_keeps_the_4_gib_cap() {
    let upper = PIN.to_uppercase();
    let not_a_pin = [
        None,
        Some(""),
        Some("pin"),
        // 63 digits, and a digest `sha256_file` never produces.
        Some(&PIN[1..]),
        Some(upper.as_str()),
    ];
    for sha256 in not_a_pin {
        let cap = cap_of(sha256);
        assert_eq!(cap.bytes, 4 * GIB, "{sha256:?}");
        assert!(!cap.pinned, "{sha256:?}");
    }
}

#[test]
fn a_pinned_download_gets_the_16_gib_cap() {
    let cap = cap_of(Some(PIN));
    assert_eq!(cap.bytes, 16 * GIB);
    assert!(cap.pinned);
}

/// One file of an install, as a manifest carries it.
struct ManifestFile {
    bytes: u64,
    sha256: &'static str,
}

/// The four files of the Standard image tier in download order, with the sizes
/// and pins in `apps/core/src/sidecar/providers/sdcpp/downloader.rs`.
const IMAGE_TIER: [ManifestFile; 4] = [
    ManifestFile {
        bytes: 4_197_494_816,
        sha256: "29f9c83c249ff0292fb2943fceddfa2319b446601866c82a4f8be062abea72c2",
    },
    ManifestFile {
        bytes: 675_509_688,
        sha256: "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9",
    },
    ManifestFile {
        bytes: 5_027_784_800,
        sha256: "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2",
    },
    ManifestFile {
        bytes: 1_159_029_824,
        sha256: "ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38",
    },
];

#[tokio::test]
async fn every_file_of_the_image_tier_is_accepted_with_its_pin() {
    let part = scratch_dir("tier-pinned").join("absent.part");
    for file in &IMAGE_TIER {
        let cap = cap_of(Some(file.sha256));
        assert!(cap.pinned, "{} is a well-formed pin", file.sha256);
        assert!(
            cap.check_announced(&part, Some(file.bytes)).await.is_ok(),
            "{} bytes must fit the pinned cap",
            file.bytes
        );
    }
}

/// The fault: before the pinned cap, the third file was refused after the
/// first two were downloaded. Without its pin it still is, and the message
/// names its size, the cap and the rule.
#[tokio::test]
async fn the_third_file_of_the_image_tier_never_fitted_the_4_gib_cap() {
    let part = scratch_dir("tier-unpinned").join("absent.part");
    let cap = cap_of(None);
    let accepted: Vec<bool> = {
        let mut accepted = Vec::new();
        for file in &IMAGE_TIER {
            accepted.push(cap.check_announced(&part, Some(file.bytes)).await.is_ok());
        }
        accepted
    };
    assert_eq!(accepted, [true, true, false, true]);
    assert_eq!(
        refused(cap.check_announced(&part, Some(IMAGE_TIER[2].bytes)).await),
        "download is 5027784800 bytes; the transfer cap is 4294967296 bytes \
         for a download with no valid SHA-256 pin"
    );
}

#[tokio::test]
async fn an_announced_size_is_refused_from_one_byte_over_the_cap() {
    let dir = scratch_dir("announced");
    let part = dir.join("model.gguf.part");
    let cap = cap_of(Some(PIN));

    std::fs::write(&part, b"kept").unwrap();
    assert!(cap.check_announced(&part, Some(16 * GIB)).await.is_ok());
    assert!(cap.check_announced(&part, None).await.is_ok());
    assert!(part.exists(), "an accepted transfer keeps its .part");

    assert_eq!(
        refused(cap.check_announced(&part, Some(16 * GIB + 1)).await),
        "download is 17179869185 bytes; the transfer cap is 17179869184 bytes \
         for a download pinned by a SHA-256"
    );
    assert!(!part.exists(), "the .part of a refused transfer is removed");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_part_over_the_cap_is_refused_and_removed() {
    let dir = scratch_dir("part");
    let part = dir.join("model.gguf.part");
    let cap = cap_of(None);

    std::fs::write(&part, b"kept").unwrap();
    assert!(cap.check_part(&part, 4 * GIB).await.is_ok());
    assert!(part.exists(), "a .part at the cap is kept for the resume");

    assert_eq!(
        refused(cap.check_part(&part, 4 * GIB + 1).await),
        "partial download is 4294967297 bytes; the transfer cap is 4294967296 bytes \
         for a download with no valid SHA-256 pin"
    );
    assert!(!part.exists(), "a .part over the cap is removed");
    // Nothing left to remove is not a second error.
    refused(cap.check_part(&part, 4 * GIB + 1).await);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_streamed_count_passes_the_cap_only_beyond_it() {
    let cap = cap_of(None);
    assert!(!cap.passed_by(0, 1));
    assert!(!cap.passed_by(4 * GIB - 1, 1), "the last byte fits");
    assert!(cap.passed_by(4 * GIB, 1));
    assert!(cap.passed_by(4 * GIB - 1, 2));
    assert!(cap.passed_by(u64::MAX, 1), "the count cannot wrap");
}

#[tokio::test]
async fn a_refused_stream_closes_and_removes_its_open_part() {
    let dir = scratch_dir("stream");
    let part = dir.join("model.gguf.part");
    let file = tokio::fs::File::create(&part).await.unwrap();
    let mut file = tokio::io::BufWriter::with_capacity(8, file);
    // More than the buffer, so bytes reached the file before the refusal.
    file.write_all(b"bytes that can never complete")
        .await
        .unwrap();

    let text = message(cap_of(Some(PIN)).refuse_stream(file, &part).await);

    assert_eq!(
        text,
        "download did not end at the cap; the transfer cap is 17179869184 bytes \
         for a download pinned by a SHA-256"
    );
    assert!(!part.exists(), "the open .part is closed and removed");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_limits_apply_to_their_destination_only() {
    let dest = scratch_dir("limits").join("small.gguf");
    set_limits(&dest, 1_000, 4_000);

    assert_eq!(TransferCap::of(&spec(dest.clone(), None)).bytes, 1_000);
    assert_eq!(TransferCap::of(&spec(dest, Some(PIN))).bytes, 4_000);
    assert_eq!(cap_of(None).bytes, MAX_TRANSFER_BYTES);
    assert_eq!(cap_of(Some(PIN)).bytes, PINNED_TRANSFER_BYTES);
}
