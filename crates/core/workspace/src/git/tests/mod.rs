use super::*;

mod edits;

#[test]
fn parse_ahead_behind_normal() {
    assert_eq!(parse_ahead_behind(Some("3\t1")), (3, 1));
}

#[test]
fn parse_ahead_behind_none() {
    assert_eq!(parse_ahead_behind(None), (0, 0));
}

#[test]
fn parse_ahead_behind_no_upstream() {
    assert_eq!(parse_ahead_behind(Some("")), (0, 0));
}

#[test]
fn remote_action_rejects_unknown_action() {
    let error = run_git_remote_action("/tmp", "fetch").unwrap_err();
    assert_eq!(error, "invalid git remote action");
}

#[test]
fn remote_action_requires_a_git_repository() {
    let dir = tempfile::tempdir().unwrap();
    let error = run_git_remote_action(dir.path().to_str().unwrap(), "pull").unwrap_err();
    assert_eq!(error, "not a git repository");
}

#[test]
fn remote_git_command_drains_output_larger_than_a_pipe_buffer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    initialize_repository(path).unwrap();
    test_git(dir.path(), &["config", "user.name", "Ryu Test"]);
    test_git(
        dir.path(),
        &["config", "user.email", "ryu-test@example.com"],
    );
    let line = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\n";
    let body = line.repeat(4096);
    std::fs::write(dir.path().join("big.txt"), &body).unwrap();
    test_git(dir.path(), &["add", "big.txt"]);
    test_git(dir.path(), &["commit", "-m", "big file"]);

    let started = Instant::now();
    let output = run_remote_git_command(path, &["show", "HEAD:big.txt"]).unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout.len(), body.len());
    assert!(started.elapsed() < REMOTE_GIT_TIMEOUT);
}

#[test]
fn initialize_repository_uses_main_and_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();

    let first = initialize_repository(path).unwrap();
    assert!(first.success);
    assert!(first.initialized);
    assert_eq!(first.branch.as_deref(), Some("main"));
    assert_eq!(query_git_state(path).branch.as_deref(), Some("main"));

    let second = initialize_repository(path).unwrap();
    assert!(second.success);
    assert!(!second.initialized);
    assert_eq!(second.branch.as_deref(), Some("main"));
}

#[test]
fn memory_trace_reads_only_configured_memory_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    initialize_repository(path).unwrap();
    test_git(dir.path(), &["config", "user.name", "Ryu Test"]);
    test_git(
        dir.path(),
        &["config", "user.email", "ryu-test@example.com"],
    );
    std::fs::create_dir_all(dir.path().join("memory/user")).unwrap();
    std::fs::write(dir.path().join("memory/user/fact.md"), "one\n").unwrap();
    std::fs::write(dir.path().join("README.md"), "outside\n").unwrap();
    test_git(dir.path(), &["add", "."]);
    test_git(dir.path(), &["commit", "-m", "initial memory"]);
    std::fs::write(dir.path().join("memory/user/fact.md"), "two\n").unwrap();
    test_git(dir.path(), &["add", "memory/user/fact.md"]);
    test_git(dir.path(), &["commit", "-m", "revise memory"]);

    let trace = query_memory_trace(path, "memory", 10).unwrap();
    assert_eq!(trace.len(), 2);
    assert_eq!(trace[0].subject, "revise memory");
    assert_eq!(trace[0].files, vec!["memory/user/fact.md"]);
    assert!(query_memory_trace(path, "README.md", 10).is_err());
}

#[test]
fn commit_action_creates_an_initial_commit_for_an_empty_repository() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    initialize_repository(path).unwrap();
    test_git(dir.path(), &["config", "user.name", "Ryu Test"]);
    test_git(
        dir.path(),
        &["config", "user.email", "ryu-test@example.com"],
    );

    let outcome = run_git_action(path, "Initial commit", "commit", true).unwrap();
    assert!(outcome.success);
    assert!(outcome.committed);
    assert!(!outcome.pushed);
    assert!(run_git(path, &["rev-parse", "--verify", "HEAD"]).is_some());
}

#[test]
fn remote_action_rejects_local_executable_filters() {
    let dir = tempfile::tempdir().unwrap();
    test_git(dir.path(), &["init"]);
    test_git(dir.path(), &["config", "user.name", "Ryu Test"]);
    test_git(
        dir.path(),
        &["config", "user.email", "ryu-test@example.com"],
    );
    std::fs::write(dir.path().join("tracked.txt"), "tracked\n").unwrap();
    test_git(dir.path(), &["add", "tracked.txt"]);
    test_git(dir.path(), &["commit", "-m", "initial"]);
    test_git(dir.path(), &["config", "filter.external.smudge", "cat"]);
    let error = run_git_remote_action(dir.path().to_str().unwrap(), "pull").unwrap_err();
    assert_eq!(
        error,
        "git mutation blocked: repository-local clean/smudge/process filters are not allowed"
    );
}

#[test]
fn remote_action_pulls_and_syncs_fast_forward_only() {
    let root = tempfile::tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let remote_path = remote.to_str().unwrap();

    test_git(root.path(), &["init", "--bare", remote_path]);
    test_git(root.path(), &["clone", remote_path, "seed"]);
    let seed = root.path().join("seed");
    test_git(&seed, &["config", "user.name", "Ryu Test"]);
    test_git(&seed, &["config", "user.email", "ryu-test@example.com"]);
    std::fs::write(seed.join("tracked.txt"), "one\n").unwrap();
    test_git(&seed, &["add", "tracked.txt"]);
    test_git(&seed, &["commit", "-m", "initial"]);
    test_git(&seed, &["push", "-u", "origin", "HEAD"]);

    test_git(root.path(), &["clone", remote_path, "local"]);
    test_git(root.path(), &["clone", remote_path, "peer"]);
    let peer = root.path().join("peer");
    test_git(&peer, &["config", "user.name", "Ryu Test"]);
    test_git(&peer, &["config", "user.email", "ryu-test@example.com"]);
    std::fs::write(peer.join("tracked.txt"), "one\ntwo\n").unwrap();
    test_git(&peer, &["add", "tracked.txt"]);
    test_git(&peer, &["commit", "-m", "remote update"]);
    test_git(&peer, &["push"]);

    let local = root.path().join("local");
    let local_path = local.to_str().unwrap();
    test_git(&local, &["config", "user.name", "Ryu Test"]);
    test_git(&local, &["config", "user.email", "ryu-test@example.com"]);
    let pulled = run_git_remote_action(local_path, "pull").unwrap();
    assert!(pulled.success);
    assert!(pulled.pulled);
    assert!(!pulled.pushed);
    let pulled_contents = std::fs::read_to_string(local.join("tracked.txt")).unwrap();
    assert_eq!(pulled_contents.replace("\r\n", "\n"), "one\ntwo\n");

    std::fs::write(local.join("local.txt"), "local\n").unwrap();
    test_git(&local, &["add", "local.txt"]);
    test_git(&local, &["commit", "-m", "local update"]);
    let local_head = run_git(local_path, &["rev-parse", "HEAD"]).unwrap();
    let synced = run_git_remote_action(local_path, "sync").unwrap();
    assert!(synced.success);
    assert!(synced.pulled);
    assert!(synced.pushed);
    let remote_head = String::from_utf8_lossy(
        &test_git(
            root.path(),
            &["--git-dir", remote_path, "rev-parse", "HEAD"],
        )
        .stdout,
    )
    .trim()
    .to_string();
    assert_eq!(remote_head, local_head);
}

fn test_git(cwd: &std::path::Path, args: &[&str]) -> std::process::Output {
    let output = Command::new("git")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgSign=false",
        ])
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

#[test]
fn untracked_paths_picks_only_untracked_rows() {
    let porcelain = " M src/lib.rs\nA  src/new.rs\n?? notes.md\n?? src/scratch.rs\n";
    assert_eq!(
        untracked_paths(porcelain),
        vec!["notes.md".to_string(), "src/scratch.rs".to_string()]
    );
}

#[test]
fn untracked_paths_unquotes_git_quoting() {
    assert_eq!(
        untracked_paths("?? \"a\\tb-\\303\\251.txt\"\n"),
        vec!["a\tb-é.txt"]
    );
}

#[test]
fn untracked_insertions_counts_every_line_of_a_new_file() {
    let dir = std::env::temp_dir().join(format!(
        "ryu-untracked-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    // Three lines, no trailing newline — git counts the last one too.
    std::fs::write(dir.join("new.txt"), b"a\nb\nc").unwrap();
    // Binary content contributes nothing, exactly like a numstat "-" row.
    std::fs::write(dir.join("blob.bin"), b"a\0b\n").unwrap();

    let counted = untracked_insertions(
        dir.to_str().unwrap(),
        &["new.txt".to_string(), "blob.bin".to_string()],
    );
    std::fs::remove_dir_all(&dir).ok();

    assert_eq!(counted, 3);
}

#[test]
fn clone_repository_finalizes_only_a_successful_checkout() {
    let source = tempfile::tempdir().unwrap();
    std::fs::write(source.path().join("README.md"), "hello\n").unwrap();
    test_git(source.path(), &["init", "-b", "main"]);
    test_git(source.path(), &["add", "README.md"]);
    test_git(
        source.path(),
        &[
            "-c",
            "user.name=Ryu Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "initial",
        ],
    );

    let destination_parent = tempfile::tempdir().unwrap();
    let destination = destination_parent.path().join("project");
    clone_repository(source.path().to_str().unwrap(), &destination).unwrap();

    let readme = std::fs::read_to_string(destination.join("README.md")).unwrap();
    assert_eq!(readme.replace("\r\n", "\n"), "hello\n");
    assert!(destination.join(".git").is_dir());
    let temporary_leftovers = std::fs::read_dir(destination_parent.path())
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".ryu-clone-")
        });
    assert!(!temporary_leftovers);
}

#[test]
fn clone_repository_does_not_overwrite_an_existing_destination() {
    let parent = tempfile::tempdir().unwrap();
    let destination = parent.path().join("project");
    std::fs::create_dir(&destination).unwrap();

    let error = clone_repository("git@github.com:owner/repo.git", &destination).unwrap_err();
    assert_eq!(error, "clone destination already exists");
}

#[test]
fn parse_git_version_reads_release_and_vendor_strings() {
    assert_eq!(parse_git_version("git version 2.34.1\n"), Some((2, 34)));
    assert_eq!(
        parse_git_version("git version 2.39.3 (Apple Git-146)"),
        Some((2, 39))
    );
    assert_eq!(
        parse_git_version("git version 2.45.1.windows.1"),
        Some((2, 45))
    );
    assert_eq!(parse_git_version("git version 2.37rc0"), Some((2, 37)));
    assert_eq!(parse_git_version("not git"), None);
    assert!((2, 34) < GIT_CURLOPT_RESOLVE_MIN);
    assert!((2, 37) >= GIT_CURLOPT_RESOLVE_MIN);
    assert!((3, 0) >= GIT_CURLOPT_RESOLVE_MIN);
}

#[test]
fn clone_public_repository_refuses_non_network_transports() {
    let source = branch_proof_repository();
    let parent = tempfile::tempdir().unwrap();
    let destination = parent.path().join("project");

    assert!(clone_public_repository(source.path().to_str().unwrap(), &destination, None).is_err());
    assert!(!destination.exists());
    clone_repository(source.path().to_str().unwrap(), &destination).unwrap();
    assert!(destination.join("tracked.txt").is_file());
}

#[test]
fn clone_repository_cleans_up_after_git_failure() {
    let parent = tempfile::tempdir().unwrap();
    let destination = parent.path().join("project");
    let missing_source = parent.path().join("missing-source");

    assert!(clone_repository(missing_source.to_str().unwrap(), &destination).is_err());
    assert!(!destination.exists());
    let temporary_leftovers = std::fs::read_dir(parent.path())
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".ryu-clone-")
        });
    assert!(!temporary_leftovers);
}

fn branch_proof_repository() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    initialize_repository(dir.path().to_str().unwrap()).unwrap();
    test_git(dir.path(), &["config", "user.name", "Ryu Branch Proof"]);
    test_git(
        dir.path(),
        &["config", "user.email", "branch-proof@example.invalid"],
    );
    // The test asserts exact checkout bytes, so pin line-ending conversion
    // instead of inheriting a host `core.autocrlf=true` (Git for Windows'
    // system default), which would check `\n` out as `\r\n`.
    test_git(dir.path(), &["config", "core.autocrlf", "false"]);
    std::fs::write(dir.path().join("tracked.txt"), b"main bytes\n").unwrap();
    test_git(dir.path(), &["add", "tracked.txt"]);
    test_git(dir.path(), &["commit", "-m", "initial"]);
    dir
}

#[test]
fn create_and_checkout_branches_reopen_actual_head_and_file_bytes() {
    let dir = branch_proof_repository();
    let cwd = dir.path().to_str().unwrap();
    let main_head = test_git(dir.path(), &["rev-parse", "HEAD"]).stdout;
    assert_eq!(
        create_branch(cwd, "feature-proof").unwrap(),
        "feature-proof"
    );
    assert_eq!(
        test_git(dir.path(), &["branch", "--show-current"]).stdout,
        b"feature-proof\n"
    );
    assert_eq!(
        test_git(dir.path(), &["rev-parse", "HEAD"]).stdout,
        main_head
    );
    std::fs::write(dir.path().join("tracked.txt"), b"feature bytes\n").unwrap();
    test_git(dir.path(), &["add", "tracked.txt"]);
    test_git(dir.path(), &["commit", "-m", "feature"]);
    let feature_head = test_git(dir.path(), &["rev-parse", "HEAD"]).stdout;
    assert_ne!(main_head, feature_head);
    assert_eq!(checkout_branch(cwd, "main").unwrap(), "main");
    assert_eq!(
        test_git(dir.path(), &["rev-parse", "HEAD"]).stdout,
        main_head
    );
    assert_eq!(
        std::fs::read(dir.path().join("tracked.txt")).unwrap(),
        b"main bytes\n"
    );
    assert_eq!(
        checkout_branch(cwd, "feature-proof").unwrap(),
        "feature-proof"
    );
    assert_eq!(
        test_git(dir.path(), &["rev-parse", "HEAD"]).stdout,
        feature_head
    );
    assert_eq!(
        std::fs::read(dir.path().join("tracked.txt")).unwrap(),
        b"feature bytes\n"
    );
    let reopened = list_branches(cwd);
    assert_eq!(reopened.current.as_deref(), Some("feature-proof"));
    assert!(reopened.branches.iter().any(|name| name == "main"));
    assert!(reopened.branches.iter().any(|name| name == "feature-proof"));
}

#[test]
fn branch_mutation_refusals_preserve_head_index_and_dirty_bytes_then_retry() {
    let dir = branch_proof_repository();
    let cwd = dir.path().to_str().unwrap();
    create_branch(cwd, "feature-proof").unwrap();
    std::fs::write(dir.path().join("tracked.txt"), b"feature bytes\n").unwrap();
    test_git(dir.path(), &["add", "tracked.txt"]);
    test_git(dir.path(), &["commit", "-m", "feature"]);
    checkout_branch(cwd, "main").unwrap();
    std::fs::write(dir.path().join("tracked.txt"), b"staged user bytes\n").unwrap();
    test_git(dir.path(), &["add", "tracked.txt"]);
    std::fs::write(dir.path().join("tracked.txt"), b"unstaged user bytes\n").unwrap();
    let head = test_git(dir.path(), &["rev-parse", "HEAD"]).stdout;
    let index_tree = test_git(dir.path(), &["write-tree"]).stdout;
    let index_bytes = test_git(dir.path(), &["show", ":tracked.txt"]).stdout;
    let file_bytes = std::fs::read(dir.path().join("tracked.txt")).unwrap();
    let error = checkout_branch(cwd, "feature-proof").unwrap_err();
    assert!(
        !error.trim().is_empty(),
        "real Git refusal must reach the caller"
    );
    let collision = create_branch(cwd, "feature-proof").unwrap_err();
    assert!(!collision.trim().is_empty());
    assert_eq!(
        test_git(dir.path(), &["branch", "--show-current"]).stdout,
        b"main\n"
    );
    assert_eq!(test_git(dir.path(), &["rev-parse", "HEAD"]).stdout, head);
    assert_eq!(test_git(dir.path(), &["write-tree"]).stdout, index_tree);
    assert_eq!(
        test_git(dir.path(), &["show", ":tracked.txt"]).stdout,
        index_bytes
    );
    assert_eq!(
        std::fs::read(dir.path().join("tracked.txt")).unwrap(),
        file_bytes
    );
    // Restore only this owned fixture's tracked file, then retry the same
    // requested checkout; no user repository or shared working tree is reset.
    test_git(
        dir.path(),
        &[
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            "tracked.txt",
        ],
    );
    checkout_branch(cwd, "feature-proof").unwrap();
    assert_eq!(
        test_git(dir.path(), &["branch", "--show-current"]).stdout,
        b"feature-proof\n"
    );
    assert_eq!(
        std::fs::read(dir.path().join("tracked.txt")).unwrap(),
        b"feature bytes\n"
    );
}
