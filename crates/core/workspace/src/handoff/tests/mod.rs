use super::*;
use tempfile::TempDir;

mod support;
use support::*;

#[test]
fn safe_paths_reject_every_escape_form() {
    for path in [
        "src/main.rs",
        "a/b/c.txt",
        ".env",
        "dir/.gitignore",
        "x.git/y",
    ] {
        assert!(is_safe_repo_relative_path(path), "{path}");
    }
    for path in [
        "",
        "/etc/passwd",
        "\\server\\share",
        "a\\b",
        "C:/Windows",
        "c:evil",
        "a/../b",
        "./a",
        "a//b",
        "a/",
        ".git/config",
        "sub/.GIT/hooks/pre-commit",
        "GIT~1/config",
        "dir./file",
        "dir /file",
        "a\u{0}b",
        "a\nb",
    ] {
        assert!(!is_safe_repo_relative_path(path), "{path:?}");
    }
    assert!(!is_safe_repo_relative_path(&"a".repeat(MAX_PATH_BYTES + 1)));
}

#[test]
fn case_and_normalization_collisions_are_found() {
    assert_eq!(first_path_collision(["a.txt", "b.txt"]), None);
    assert_eq!(
        first_path_collision(["README.md", "readme.md"]),
        Some("readme.md")
    );
    assert_eq!(
        first_path_collision(["caf\u{e9}.txt", "cafe\u{301}.txt"]),
        Some("cafe\u{301}.txt")
    );
    assert_eq!(first_path_collision(["x", "x"]), Some("x"));
}

#[test]
fn remote_urls_lose_credentials_or_are_omitted() {
    assert_eq!(
        clean_remote_url("https://x-access-token:secret@github.com/org/repo.git").as_deref(),
        Some("https://github.com/org/repo.git")
    );
    assert_eq!(
        clean_remote_url("git@github.com:org/repo.git").as_deref(),
        Some("git@github.com:org/repo.git")
    );
    assert_eq!(
        clean_remote_url("ssh://git@example.com/org/repo.git").as_deref(),
        Some("ssh://git@example.com/org/repo.git")
    );
    assert_eq!(
        clean_remote_url("ssh://alice:pw@example.com/org/repo.git"),
        None
    );
    assert_eq!(clean_remote_url("/srv/git/repo.git"), None);
    assert_eq!(clean_remote_url("file:///srv/git/repo.git"), None);
    assert_eq!(clean_remote_url("http://example.com/repo.git"), None);
}

#[test]
fn sensitive_names_are_flagged() {
    for path in [
        ".env",
        "app/.env.local",
        "certs/server.pem",
        "id_ed25519",
        ".npmrc",
        "credentials.json",
        "a/tls.KEY",
    ] {
        assert!(is_sensitive_path(path), "{path}");
    }
    for path in ["src/env.rs", "README.md", "keys/notes.txt"] {
        assert!(!is_sensitive_path(path), "{path}");
    }
}

#[test]
fn non_git_folder_is_reported() {
    let temp = TempDir::new().unwrap();
    assert_eq!(
        inspect_workspace(temp.path()).unwrap_err(),
        HandoffError::NotAGitRepository
    );
}

#[test]
fn no_unpushed_commits_gives_no_bundle() {
    let fixture = fixture();
    let inspection = inspect_workspace(&fixture.source).unwrap();
    assert_eq!(inspection.branch.as_deref(), Some("main"));
    assert_eq!(inspection.upstream_ref.as_deref(), Some("origin/main"));
    // A local path remote cannot be reached from another machine, so the
    // whole history counts as unpushed.
    assert_eq!(inspection.remote_url, None);
    assert_eq!(inspection.unpushed_commits, 1);
    let out = fixture.root.join("out");
    // With no network remote the whole history ships; force the remote-relative
    // path by pointing origin at an https URL that is never contacted.
    git(
        &fixture.source,
        &[
            "remote",
            "set-url",
            "origin",
            "https://example.invalid/org/repo.git",
        ],
    );
    let inspection = inspect_workspace(&fixture.source).unwrap();
    assert_eq!(
        inspection.remote_url.as_deref(),
        Some("https://example.invalid/org/repo.git")
    );
    assert_eq!(inspection.name, "repo");
    assert_eq!(inspection.unpushed_commits, 0);
    let exported = export_workspace(&fixture.source, &inspection.head, &[], &out).unwrap();
    assert!(exported.commits.is_none());
    assert!(exported.diff.is_none());
}

#[test]
fn local_commits_bundle_with_the_remote_tip_as_prerequisite() {
    let fixture = fixture();
    git(
        &fixture.source,
        &[
            "remote",
            "set-url",
            "origin",
            "https://example.invalid/org/repo.git",
        ],
    );
    let remote_tip = git(&fixture.source, &["rev-parse", "origin/main"]);
    commit_file(&fixture.source, "one.txt", "1\n");
    commit_file(&fixture.source, "two.txt", "2\n");
    let inspection = inspect_workspace(&fixture.source).unwrap();
    assert_eq!(inspection.unpushed_commits, 2);
    let exported = export_workspace(
        &fixture.source,
        &inspection.head,
        &[],
        &fixture.root.join("out"),
    )
    .unwrap();
    let commits = exported.commits.expect("bundle");
    assert_eq!(commits.count, 2);
    assert_eq!(commits.prerequisites, vec![remote_tip]);
    assert_eq!(commits.tip, inspection.head);
}

#[test]
fn copied_index_keeps_its_mtime_and_is_writable_from_a_read_only_source() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("index");
    std::fs::write(&source, b"DIRC index bytes").unwrap();
    let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    std::fs::File::options()
        .write(true)
        .open(&source)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let mut permissions = std::fs::metadata(&source).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&source, permissions).unwrap();

    let copy = temp.path().join("handoff.index");
    copy_index_keeping_mtime(&source, &copy).unwrap();

    let copied = std::fs::metadata(&copy).unwrap();
    assert_eq!(copied.modified().unwrap(), old);
    assert!(!copied.permissions().readonly());
    assert_eq!(std::fs::read(&copy).unwrap(), b"DIRC index bytes");
}

#[test]
fn head_moved_after_review_is_refused() {
    let fixture = fixture();
    let inspection = inspect_workspace(&fixture.source).unwrap();
    commit_file(&fixture.source, "late.txt", "late\n");
    let error = export_workspace(
        &fixture.source,
        &inspection.head,
        &[],
        &fixture.root.join("out"),
    )
    .unwrap_err();
    assert!(matches!(error, HandoffError::HeadMoved { .. }));
}

#[test]
fn diff_carries_staged_unstaged_binary_and_selected_untracked_without_touching_the_index() {
    let fixture = fixture();
    let source = &fixture.source;
    std::fs::write(source.join("README.md"), "hello\nstaged\n").unwrap();
    git(source, &["add", "README.md"]);
    std::fs::write(source.join("README.md"), "hello\nstaged\nunstaged\n").unwrap();
    std::fs::write(source.join("tracked.bin"), [9u8, 0, 8, 0, 7]).unwrap();
    std::fs::write(source.join("notes.txt"), "keep me\n").unwrap();
    std::fs::write(source.join(".env"), "SECRET=1\n").unwrap();
    std::fs::write(source.join("ignored.log"), "never\n").unwrap();
    let index_before = std::fs::read(source.join(".git/index")).unwrap();

    let inspection = inspect_workspace(source).unwrap();
    let untracked: Vec<_> = inspection
        .untracked
        .iter()
        .map(|c| c.path.as_str())
        .collect();
    assert_eq!(untracked, vec![".env", "notes.txt"]);
    assert!(inspection
        .untracked
        .iter()
        .any(|c| c.path == ".env" && c.sensitive));
    assert!(!inspection.untracked.iter().any(|c| c.path == "ignored.log"));

    let exported = export_workspace(
        source,
        &inspection.head,
        &["notes.txt".to_owned()],
        &fixture.root.join("out"),
    )
    .unwrap();
    let diff = exported.diff.as_ref().expect("diff");
    let paths: Vec<_> = diff.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["README.md", "notes.txt", "tracked.bin"]);
    assert!(diff
        .files
        .iter()
        .any(|f| f.path == "tracked.bin" && f.binary));
    let patch = std::fs::read_to_string(&diff.path).unwrap();
    assert!(patch.contains("+unstaged"));
    assert!(patch.contains("+staged"));
    assert!(patch.contains("GIT binary patch"));
    assert!(!patch.contains("SECRET"));
    assert!(!patch.contains("never"));
    assert_eq!(exported.untracked.len(), 1);
    assert!(exported
        .omitted
        .iter()
        .any(|o| o.path == ".env" && o.reason == OmissionReason::NotSelected));
    assert_eq!(
        std::fs::read(source.join(".git/index")).unwrap(),
        index_before
    );
}

#[test]
fn round_trip_rebuilds_a_byte_identical_tree_and_leaves_the_source_alone() {
    let fixture = fixture();
    let source = &fixture.source;
    // Never contacted: the destination fetches from its own `origin`.
    git(
        source,
        &[
            "remote",
            "set-url",
            "origin",
            "https://example.invalid/org/repo.git",
        ],
    );
    commit_file(source, "local.txt", "local commit\n");
    std::fs::write(source.join("README.md"), "hello\nchanged\n").unwrap();
    std::fs::write(source.join("tracked.bin"), [7u8, 7, 0, 7]).unwrap();
    std::fs::remove_file(source.join(".gitignore")).unwrap();
    std::fs::create_dir_all(source.join("new/dir")).unwrap();
    std::fs::write(source.join("new/dir/file.txt"), "untracked\n").unwrap();
    let status_before = git(source, &["status", "--porcelain=v1"]);

    let inspection = inspect_workspace(source).unwrap();
    let exported = export_workspace(
        source,
        &inspection.head,
        &["new/dir/file.txt".to_owned()],
        &fixture.root.join("out"),
    )
    .unwrap();
    assert_eq!(git(source, &["status", "--porcelain=v1"]), status_before);

    let destination = clone_to(&fixture, "b", false);
    let commits = exported.commits.as_ref().expect("bundle");
    ensure_base(&destination, &commits.prerequisites).unwrap();
    let result = materialize(&exported, &destination, "handoff-1").unwrap();
    assert_eq!(result.branch, "handoff/thread-1");
    assert_eq!(tree(&result.worktree_path), tree(source));
    assert!(is_handoff_worktree(&result.worktree_path));
    assert!(!is_handoff_worktree(&destination));
    assert_eq!(
        git(&result.worktree_path, &["rev-parse", "HEAD"]),
        inspection.head
    );

    // A second materialize picks a fresh branch rather than reusing one.
    let again = materialize(&exported, &destination, "handoff-2").unwrap();
    assert_eq!(again.branch, "handoff/thread-1-2");
}

#[test]
fn shallow_clone_materializes_after_ensure_base() {
    let fixture = fixture();
    let source = &fixture.source;
    commit_file(source, "pushed.txt", "pushed\n");
    git(source, &["push", "--quiet", "origin", "main"]);
    let base = git(source, &["rev-parse", "HEAD~1"]);
    // Move the source back so its base is older than the remote tip.
    git(source, &["reset", "--quiet", "--hard", &base]);
    git(source, &["update-ref", "refs/remotes/origin/main", &base]);
    git(
        source,
        &[
            "remote",
            "set-url",
            "origin",
            "https://example.invalid/org/repo.git",
        ],
    );
    commit_file(source, "local.txt", "local\n");
    std::fs::write(source.join("README.md"), "edited\n").unwrap();

    let inspection = inspect_workspace(source).unwrap();
    let exported =
        export_workspace(source, &inspection.head, &[], &fixture.root.join("out")).unwrap();
    let commits = exported.commits.as_ref().expect("bundle");
    assert_eq!(commits.prerequisites, vec![base.clone()]);

    let destination = clone_to(&fixture, "shallow", true);
    assert_eq!(
        git(&destination, &["rev-parse", "--is-shallow-repository"]),
        "true"
    );
    // Without the base, the bundle cannot apply and says so.
    let missing = materialize(&exported, &destination, "early").unwrap_err();
    assert!(
        matches!(missing, HandoffError::MissingCommit(_)),
        "{missing:?}"
    );
    assert!(!destination.join(".ryu-worktrees/early").exists());

    ensure_base(&destination, &commits.prerequisites).unwrap();
    let result = materialize(&exported, &destination, "late").unwrap();
    assert_eq!(tree(&result.worktree_path), tree(source));
}

#[test]
fn missing_prerequisite_without_remote_gives_a_clear_error() {
    let fixture = fixture();
    let destination = fixture.root.join("empty");
    init_repository(&destination).unwrap();
    git(
        &destination,
        &[
            "remote",
            "add",
            "origin",
            fixture.root.join("nowhere.git").to_str().unwrap(),
        ],
    );
    let error = ensure_base(&destination, &["a".repeat(40)]).unwrap_err();
    assert!(matches!(
        error,
        HandoffError::Git(_) | HandoffError::MissingCommit(_)
    ));
}

#[test]
fn no_remote_ships_full_history_into_an_empty_repository() {
    let fixture = fixture();
    let source = &fixture.source;
    git(source, &["remote", "remove", "origin"]);
    commit_file(source, "only-here.txt", "x\n");
    let inspection = inspect_workspace(source).unwrap();
    assert_eq!(inspection.remote_url, None);
    assert_eq!(inspection.unpushed_commits, 2);
    let exported =
        export_workspace(source, &inspection.head, &[], &fixture.root.join("out")).unwrap();
    assert!(exported.commits.as_ref().unwrap().prerequisites.is_empty());
    let destination = fixture.root.join("fresh");
    init_repository(&destination).unwrap();
    configure(&destination);
    let result = materialize(&exported, &destination, "fresh").unwrap();
    assert_eq!(tree(&result.worktree_path), tree(source));
}

#[test]
fn repository_filters_and_textconv_never_execute() {
    let fixture = fixture();
    let source = &fixture.source;
    let canary = fixture.root.join("canary");
    let script = format!("touch '{}'", slash_path(&canary));
    std::fs::write(source.join(".gitattributes"), "*.txt diff=evil\n").unwrap();
    git(source, &["config", "diff.evil.textconv", &script]);
    git(source, &["config", "diff.external", &script]);
    std::fs::write(source.join("data.txt"), "data\n").unwrap();
    let inspection = inspect_workspace(source).unwrap();
    export_workspace(
        source,
        &inspection.head,
        &["data.txt".to_owned()],
        &fixture.root.join("out"),
    )
    .unwrap();
    assert!(!canary.exists(), "textconv or external diff ran");

    git(source, &["config", "filter.evil.clean", &script]);
    assert!(matches!(
        inspect_workspace(source).unwrap_err(),
        HandoffError::Refused(_)
    ));
    assert!(!canary.exists(), "clean filter ran");
}

#[test]
fn patch_outside_the_manifest_is_refused_before_apply() {
    let fixture = fixture();
    let source = &fixture.source;
    std::fs::write(source.join("README.md"), "changed\n").unwrap();
    let inspection = inspect_workspace(source).unwrap();
    let exported =
        export_workspace(source, &inspection.head, &[], &fixture.root.join("out")).unwrap();
    let destination = clone_to(&fixture, "b", false);
    let worktree_dir = destination.join(".ryu-worktrees/bad");
    let error = materialize_handoff(&MaterializeRequest {
        repo_root: destination.clone(),
        bundle: None,
        head: inspection.head.clone(),
        branch: "handoff/bad".to_owned(),
        worktree_dir: worktree_dir.clone(),
        diff: exported.diff.as_ref().map(|d| d.path.clone()),
        expected_paths: BTreeSet::from(["other.txt".to_owned()]),
        marker: "{}".to_owned(),
    })
    .unwrap_err();
    assert!(matches!(error, HandoffError::Refused(_)));
    assert!(!worktree_dir.exists());
    assert!(!crate::worktree::branch_exists(&destination, "handoff/bad"));
    assert_eq!(
        std::fs::read_to_string(destination.join("README.md")).unwrap(),
        "hello\n"
    );
}

#[test]
fn failed_apply_removes_the_worktree_and_branch() {
    let fixture = fixture();
    let source = &fixture.source;
    std::fs::write(source.join("README.md"), "changed\n").unwrap();
    let inspection = inspect_workspace(source).unwrap();
    let exported =
        export_workspace(source, &inspection.head, &[], &fixture.root.join("out")).unwrap();
    // Corrupt the patch so the cross-check passes but apply fails.
    let patch_path = exported.diff.as_ref().unwrap().path.clone();
    let patch = std::fs::read_to_string(&patch_path).unwrap();
    std::fs::write(&patch_path, patch.replace("-hello", "-goodbye")).unwrap();
    let destination = clone_to(&fixture, "b", false);
    let error = materialize(&exported, &destination, "broken").unwrap_err();
    assert!(matches!(error, HandoffError::Git(_)), "{error:?}");
    assert!(!destination.join(".ryu-worktrees/broken").exists());
    assert!(!crate::worktree::branch_exists(
        &destination,
        "handoff/thread-1"
    ));
}

#[test]
fn managed_worktrees_refuse_to_fork_a_handoff_worktree() {
    let fixture = fixture();
    let inspection = inspect_workspace(&fixture.source).unwrap();
    let exported = export_workspace(
        &fixture.source,
        &inspection.head,
        &[],
        &fixture.root.join("out"),
    )
    .unwrap();
    let destination = clone_to(&fixture, "b", false);
    let result = materialize(&exported, &destination, "h").unwrap();
    let error = crate::worktree::create_managed_worktree(
        &result.worktree_path,
        None,
        &crate::worktree::ManagedWorktreeOptions::default(),
    )
    .err()
    .expect("fork refused");
    assert!(error.to_string().contains("handed-off worktree"), "{error}");
}
