//! Tests for the shared download helpers in [`super`].

use super::*;

#[tokio::test]
async fn compute_sha256_matches_known_vector() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("f");
    // SHA-256 of "abc".
    std::fs::write(&path, b"abc").unwrap();
    let got = compute_sha256(&path).await.unwrap();
    assert_eq!(
        got,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[tokio::test]
async fn compute_sha256_missing_file_errors() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(compute_sha256(&tmp.path().join("nope")).await.is_err());
}

#[tokio::test]
async fn retry_download_succeeds_first_try() {
    let calls = std::sync::atomic::AtomicU32::new(0);
    let out: i32 = retry_download("t", 3, || {
        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        async { Ok(42) }
    })
    .await
    .unwrap();
    assert_eq!(out, 42);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn retry_download_single_attempt_no_retry() {
    let calls = std::sync::atomic::AtomicU32::new(0);
    let res: anyhow::Result<i32> = retry_download("t", 1, || {
        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        async { anyhow::bail!("boom") }
    })
    .await;
    assert!(res.is_err());
    // max_attempts=1 → exactly one call, no backoff sleep.
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn retry_download_retries_then_succeeds() {
    // One transient failure then success. `max_attempts=2` means a single
    // 1s backoff between the two calls (test-util virtual time is not enabled
    // in this crate, so this is a real — but bounded to one — 1s wait).
    let calls = std::sync::atomic::AtomicU32::new(0);
    let out: i32 = retry_download("t", 2, || {
        let n = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        async move {
            if n < 1 {
                anyhow::bail!("transient")
            } else {
                Ok(7)
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(out, 7);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
}

/// Core once carried a `BuildDependency` installer that had PowerShell download
/// the rustup installer into the user's temp directory and run it straight
/// from there: an unpinned toolchain download into a directory any local
/// process can write, and exactly the drop-then-run shape a planted binary or
/// DLL rides on. It had
/// no callers and was deleted with the other unverified `SidecarManifest`
/// installers; every executable Core fetches now goes through `DownloadCenter`
/// with a SHA-256 pin. Keep the pattern from coming back anywhere in Core.
#[test]
fn core_sources_never_stage_executables_in_the_shared_temp_directory() {
    // Built from parts so this guard does not match itself.
    let forbidden = [concat!("rustup", "-init.exe"), concat!("$env", ":TEMP")];
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut pending = vec![root.clone()];
    let mut scanned = 0_usize;
    let mut offenders = Vec::new();
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).expect("read Core source directory") {
            let path = entry.expect("Core source entry").path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).expect("read Core source file");
            scanned += 1;
            for needle in forbidden {
                if source
                    .to_ascii_lowercase()
                    .contains(&needle.to_ascii_lowercase())
                {
                    offenders.push(format!("{} contains {needle}", path.display()));
                }
            }
        }
    }
    assert!(
        scanned > 100,
        "scanned only {scanned} Core source files under {}",
        root.display()
    );
    assert!(
        offenders.is_empty(),
        "unverified temp-dir installer pattern: {offenders:?}"
    );
}
