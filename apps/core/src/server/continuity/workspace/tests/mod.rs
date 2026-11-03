use super::errors::{coded_error, handoff_response};
use super::prepare::{same_remote, slug};
use super::routes::capabilities;
use super::storage::{read_blob, store_blob, write_sealed_blob, Roots, StoredBlob};
use super::validation::{guard_remote_url, validate_manifest};
use super::*;
use crate::server::conversations::Tenancy;
use std::process::Command;

const FIXTURE: &str =
    include_str!("../../../../../../../packages/protocol/fixtures/continuity-workspace-v0.json");

fn fixture() -> RnpWorkspaceManifestV0 {
    serde_json::from_str(FIXTURE).expect("fixture must deserialize")
}

/// The variables through which an inherited environment picks the repository,
/// index or object store a `git` call works on. A `git` hook exports
/// `GIT_INDEX_FILE` (the commit's temporary index), so a fixture `git add`
/// run under the pre-commit hook would otherwise write into the outer
/// repository's index and never into the fixture repository.
const INHERITED_GIT_REPOSITORY_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
];

/// A `git` command for a fixture repository at `dir`, isolated from any
/// repository the test process inherited through its environment.
fn git_command(dir: &FsPath, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command.args(args).current_dir(dir);
    for name in INHERITED_GIT_REPOSITORY_ENV {
        command.env_remove(name);
    }
    command
}

fn git(dir: &FsPath, args: &[&str]) -> String {
    let output = git_command(dir, args).output().expect("git");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn roots(base: &FsPath) -> Roots {
    Roots {
        rnp: base.join("rnp"),
        handoffs: base.join("home/Documents/Ryu/handoffs"),
        home: base.join("home"),
    }
}

fn file(path: &str) -> RnpWorkspaceFileV0 {
    RnpWorkspaceFileV0 {
        path: path.to_owned(),
        status: "added".to_owned(),
        bytes: Some(1),
        binary: false,
        sensitive: false,
    }
}

fn status(response: Response) -> StatusCode {
    response.status()
}

mod round_trip;

#[test]
fn shared_fixture_parses_and_validates() {
    let manifest = fixture();
    validate_manifest(&manifest).expect("fixture must satisfy Rust limits");
    assert_eq!(manifest.diff.as_ref().unwrap().files.len(), 4);
    assert_eq!(manifest.untracked[0].path, "notes/todo.txt");
}

#[test]
fn validation_rejects_unsafe_paths_collisions_and_oversize_values() {
    for path in [
        "/etc/passwd",
        "C:/Windows",
        "\\\\server\\share",
        "a\\b",
        "a/../b",
        "./a",
        "a//b",
        ".git/config",
        "x/.GIT/hooks",
        "GIT~1/x",
        "trailing./x",
        "space /x",
        "nul\u{0}",
    ] {
        let mut manifest = fixture();
        manifest.untracked.clear();
        manifest.diff.as_mut().unwrap().files = vec![file(path)];
        assert!(validate_manifest(&manifest).is_err(), "{path:?}");
    }
    let mut duplicate = fixture();
    duplicate.untracked.clear();
    duplicate.diff.as_mut().unwrap().files = vec![file("a.txt"), file("A.TXT")];
    assert!(validate_manifest(&duplicate).is_err());
    let mut nfc = fixture();
    nfc.untracked.clear();
    nfc.diff.as_mut().unwrap().files = vec![file("caf\u{e9}"), file("cafe\u{301}")];
    assert!(validate_manifest(&nfc).is_err());

    let mut big_bundle = fixture();
    big_bundle.commits.as_mut().unwrap().blob.bytes = handoff::MAX_BUNDLE_BYTES + 1;
    assert_eq!(
        validate_manifest(&big_bundle).unwrap_err().status,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let mut big_diff = fixture();
    big_diff.diff.as_mut().unwrap().blob.bytes = handoff::MAX_DIFF_BYTES + 1;
    assert!(validate_manifest(&big_diff).is_err());

    let mut many = fixture();
    let files: Vec<_> = (0..=handoff::MAX_UNTRACKED_COUNT)
        .map(|index| file(&format!("n/{index}.txt")))
        .collect();
    many.diff.as_mut().unwrap().files = files.clone();
    many.untracked = files;
    assert_eq!(
        validate_manifest(&many).unwrap_err().status,
        StatusCode::PAYLOAD_TOO_LARGE
    );

    let mut big_untracked = fixture();
    big_untracked.untracked[0].bytes = Some(handoff::MAX_UNTRACKED_FILE_BYTES + 1);
    assert!(validate_manifest(&big_untracked).is_err());

    // Remotes carrying userinfo are assembled at run time so secret scanners do
    // not read the fixture as a committed credential.
    let with_token = format!("https://{}@github.com/org/repo.git", "token");
    let with_password = format!("https://{}:{}@github.com/org/repo.git", "user", "pw");
    for url in [
        with_token.as_str(),
        with_password.as_str(),
        "ssh://alice@example.com/org/repo.git",
        "http://github.com/org/repo.git",
        "file:///srv/repo.git",
    ] {
        let mut manifest = fixture();
        manifest.repo.remote_url = Some(url.to_owned());
        assert!(validate_manifest(&manifest).is_err(), "{url}");
    }
    let mut tip = fixture();
    tip.commits.as_mut().unwrap().tip = "3".repeat(40);
    assert!(validate_manifest(&tip).is_err());
}

#[tokio::test]
async fn remote_guard_rejects_private_hosts_and_other_schemes() {
    for url in [
        "https://127.0.0.1/org/repo.git",
        "https://localhost/org/repo.git",
        "https://169.254.169.254/org/repo.git",
        "https://10.0.0.8/org/repo.git",
        "https://[::1]/org/repo.git",
        "git@127.0.0.1:org/repo.git",
        "http://github.com/org/repo.git",
        "file:///srv/repo.git",
        "ftp://example.com/org/repo.git",
    ] {
        assert!(guard_remote_url(url).await.is_err(), "{url}");
    }
}

#[test]
fn blob_store_checks_digest_is_idempotent_and_leaves_no_partial_file() {
    crate::crypto_host::install();
    let temp = tempfile::tempdir().unwrap();
    let roots = roots(temp.path());
    let bytes = b"bundle bytes";
    let sha = sha256_hex(bytes);
    assert_eq!(
        status(store_blob(&roots, &"0".repeat(64), bytes).unwrap_err()),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        status(store_blob(&roots, "not-a-digest", bytes).unwrap_err()),
        StatusCode::BAD_REQUEST
    );
    assert!(!roots.blobs().exists() || std::fs::read_dir(roots.blobs()).unwrap().next().is_none());
    assert_eq!(
        store_blob(&roots, &sha, bytes).unwrap(),
        StoredBlob::Created
    );
    assert_eq!(
        store_blob(&roots, &sha, bytes).unwrap(),
        StoredBlob::Unchanged
    );
    let names: Vec<_> = std::fs::read_dir(roots.blobs())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec![sha.clone()]);
    // Sealed on disk; the plaintext comes back only through `read_blob`.
    let stored = std::fs::read(roots.blobs().join(&sha)).unwrap();
    assert!(stored.starts_with(SEALED_BLOB_MAGIC));
    assert!(!stored.windows(bytes.len()).any(|window| window == bytes));
    assert_eq!(read_blob(&roots.blobs().join(&sha), &sha).unwrap(), bytes);
}

#[test]
fn handoff_blobs_read_legacy_plaintext_and_reject_tampering() {
    crate::crypto_host::install();
    let temp = tempfile::tempdir().unwrap();
    let roots = roots(temp.path());
    let bytes = b"diff --git a/.env b/.env\n+TOKEN=sk-live-handoff-secret\n";
    let sha = sha256_hex(bytes);
    // A blob an older build wrote in the clear still opens.
    std::fs::create_dir_all(roots.blobs()).unwrap();
    std::fs::write(roots.blobs().join(&sha), bytes).unwrap();
    assert_eq!(read_blob(&roots.blobs().join(&sha), &sha).unwrap(), bytes);
    // A sealed blob with a flipped byte, or under the wrong name, fails.
    let sealed_path = temp.path().join("sealed");
    write_sealed_blob(&sealed_path, bytes).unwrap();
    assert!(read_blob(&sealed_path, &"0".repeat(64)).is_err());
    let mut damaged = std::fs::read(&sealed_path).unwrap();
    let last = damaged.len() - 1;
    damaged[last] ^= 1;
    std::fs::write(&sealed_path, damaged).unwrap();
    assert!(read_blob(&sealed_path, &sha).is_err());
    // Resume opens a received blob into a private scratch file that is
    // gone once the handle drops.
    std::fs::remove_file(roots.blobs().join(&sha)).unwrap();
    store_blob(&roots, &sha, bytes).unwrap();
    let reference = RnpBlobRefV0 {
        sha256: sha.clone(),
        bytes: bytes.len() as u64,
        media_type: "text/x-diff".to_owned(),
    };
    let opened = received_blob(&roots, &reference).unwrap();
    assert_eq!(std::fs::read(&opened).unwrap(), bytes);
    let opened_path = opened.to_path_buf();
    drop(opened);
    assert!(!opened_path.exists());
}

#[test]
fn fixture_git_ignores_an_inherited_repository_environment() {
    let command = git_command(FsPath::new("."), &["status"]);
    let removed: BTreeSet<String> = command
        .get_envs()
        .filter(|(_, value)| value.is_none())
        .map(|(name, _)| name.to_string_lossy().into_owned())
        .collect();
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
    ] {
        assert!(removed.contains(name), "{name} must not reach fixture git");
    }
}

#[tokio::test]
async fn capabilities_advertise_the_workspace_feature() {
    let Json(capabilities) = capabilities().await;
    assert_eq!(capabilities.version, VERSION);
    assert_eq!(capabilities.features, vec![FEATURE_WORKSPACE.to_owned()]);
}

#[test]
fn folder_slugs_and_remote_matching_are_normalized() {
    assert_eq!(slug("Fix: the bug!", 64), "Fix--the-bug");
    assert_eq!(slug("abcdef", 3), "abc");
    assert_eq!(slug("!!!", 64), "thread");
    assert!(same_remote(
        "https://github.com/acme/app.git/",
        " https://GitHub.com/acme/app "
    ));
    assert!(!same_remote(
        "https://github.com/acme/app",
        "https://github.com/acme/other"
    ));
}

#[test]
fn error_responses_carry_a_status_and_a_stable_code() {
    assert_eq!(
        coded_error(StatusCode::CONFLICT, "head-moved", "moved").status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        handoff_response(HandoffError::NotAGitRepository).status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        handoff_response(HandoffError::TooLarge("bundle".to_owned())).status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
}
