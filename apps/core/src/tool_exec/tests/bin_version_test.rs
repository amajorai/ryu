//! Binary-version probe: parsing, range enforcement, fail-closed refusals,
//! cache invalidation on a replaced binary, and the probe timeout.
use super::*;
use std::os::unix::fs::PermissionsExt;

fn spec(requirement: &str) -> CommandBinVersion {
    serde_json::from_value(serde_json::json!({
        "pattern": "spider_cli {version}",
        "requirement": requirement,
        "install_hint": "cargo install spider_cli --version 2.53.9 --locked",
    }))
    .unwrap()
}

/// Write an executable shell script that answers the probe with `body`.
fn stand_in(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path
}

fn env() -> BTreeMap<String, String> {
    crate::sidecar::env_scrub::scrub_child_env(std::env::vars(), &[])
        .into_iter()
        .collect()
}

#[tokio::test]
async fn in_range_version_passes_and_reads_stderr_too() {
    let dir = tempfile::tempdir().unwrap();
    let ok = stand_in(dir.path(), "spider", "echo 'spider_cli 2.53.9'");
    let version = check_bin_version(
        "spider",
        &ok,
        &spec("=2.53.9"),
        &env(),
        BIN_VERSION_PROBE_TIMEOUT,
    )
    .await
    .unwrap();
    assert_eq!(version, semver::Version::new(2, 53, 9));
    // Some CLIs print their version on stderr.
    let on_stderr = stand_in(dir.path(), "stderr-spider", "echo 'spider_cli 2.60.1' >&2");
    let version = check_bin_version(
        "spider",
        &on_stderr,
        &spec(">=2.53.9, <3.0.0"),
        &env(),
        BIN_VERSION_PROBE_TIMEOUT,
    )
    .await
    .unwrap();
    assert_eq!(version, semver::Version::new(2, 60, 1));
}

#[tokio::test]
async fn out_of_range_versions_are_refused_with_actionable_error() {
    let dir = tempfile::tempdir().unwrap();
    for (name, reported) in [("old", "2.53.8"), ("new", "2.54.0"), ("pre", "2.53.9-rc.1")] {
        let bin = stand_in(dir.path(), name, &format!("echo 'spider_cli {reported}'"));
        let err = check_bin_version(
            "spider",
            &bin,
            &spec("=2.53.9"),
            &env(),
            BIN_VERSION_PROBE_TIMEOUT,
        )
        .await
        .unwrap_err();
        assert!(err.starts_with(BIN_VERSION_REFUSAL), "{err}");
        assert!(err.contains(&format!("is version {reported}")), "{err}");
        assert!(err.contains("'=2.53.9'"), "{err}");
        assert!(
            err.contains(
                "install a supported version: cargo install spider_cli --version 2.53.9 --locked"
            ),
            "{err}"
        );
    }
}

#[tokio::test]
async fn unparsable_or_failed_probe_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    for (name, body) in [
        ("other-name", "echo 'spider 2.53.9'"),
        ("not-semver", "echo 'spider_cli 2.53'"),
        ("silent", "exit 0"),
        ("crash", "echo boom >&2; exit 2"),
    ] {
        let bin = stand_in(dir.path(), name, body);
        let err = check_bin_version(
            "spider",
            &bin,
            &spec("=2.53.9"),
            &env(),
            BIN_VERSION_PROBE_TIMEOUT,
        )
        .await
        .unwrap_err();
        assert!(err.starts_with(BIN_VERSION_REFUSAL), "{name}: {err}");
        assert!(err.contains("could not read the version"), "{name}: {err}");
        assert!(err.contains("'spider_cli {version}'"), "{name}: {err}");
    }
    // A probe that cannot start (not executable) is refused, not skipped.
    let not_exec = dir.path().join("plain");
    std::fs::write(&not_exec, "spider_cli 2.53.9\n").unwrap();
    let err = check_bin_version(
        "spider",
        &not_exec,
        &spec("=2.53.9"),
        &env(),
        BIN_VERSION_PROBE_TIMEOUT,
    )
    .await
    .unwrap_err();
    assert!(err.contains("could not start the version probe"), "{err}");
}

#[tokio::test]
async fn cache_reuses_probe_until_the_binary_changes() {
    let dir = tempfile::tempdir().unwrap();
    let runs = dir.path().join("runs");
    let probe = |version: &str| {
        format!(
            "printf x >> '{}'\necho 'spider_cli {version}'",
            runs.display()
        )
    };
    let bin = stand_in(dir.path(), "spider", &probe("2.53.9"));
    let requirement = spec("=2.53.9");
    for _ in 0..3 {
        check_bin_version(
            "spider",
            &bin,
            &requirement,
            &env(),
            BIN_VERSION_PROBE_TIMEOUT,
        )
        .await
        .unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(&runs).unwrap(),
        "x",
        "probed once, then cached"
    );
    // Replacing the binary (new size and mtime) forces a fresh probe, which
    // now reports an unsupported version.
    let replaced = stand_in(dir.path(), "spider", &probe("2.9.0"));
    assert_eq!(replaced, bin);
    std::fs::File::options()
        .write(true)
        .open(&bin)
        .unwrap()
        .set_modified(SystemTime::now() + Duration::from_secs(5))
        .unwrap();
    let err = check_bin_version(
        "spider",
        &bin,
        &requirement,
        &env(),
        BIN_VERSION_PROBE_TIMEOUT,
    )
    .await
    .unwrap_err();
    assert!(err.contains("is version 2.9.0"), "{err}");
    assert_eq!(std::fs::read_to_string(&runs).unwrap(), "xx");
    // Only one cache entry is kept per binary path + probe argv.
    let entries = PROBE_CACHE
        .lock()
        .unwrap()
        .keys()
        .filter(|key| key.path == bin)
        .count();
    assert_eq!(entries, 1);
}

#[tokio::test]
async fn probe_timeout_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let hang = stand_in(dir.path(), "hang", "exec sleep 30");
    let started = std::time::Instant::now();
    let err = check_bin_version(
        "spider",
        &hang,
        &spec("=2.53.9"),
        &env(),
        Duration::from_millis(300),
    )
    .await
    .unwrap_err();
    assert!(err.starts_with(BIN_VERSION_REFUSAL), "{err}");
    assert!(err.contains("timed out"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(10));
}
